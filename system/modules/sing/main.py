"""sing — speech-to-singing DSP: a score plus a spoken vocal in, a song out.

The trick is the old one from the speech-to-singing literature: a TTS take of the lyrics is cut
into syllables, each syllable is pitch-shifted to its note and time-stretched to its beat, and a
synthesized rhythm section is mixed underneath. The result is deliberately an autotune-robot
delivery — that is the aesthetic this exists for, not a defect to apologize for.

Backends: pure numpy is the floor (resample pitch shift + OLA time stretch — works everywhere,
metallic edge and all). pyworld, when importable, does the retune with a real vocoder (F0
replaced, spectral envelope kept) and simply wins when present. The selftest exercises the numpy
floor so CI needs nothing exotic.

S1 scope: file paths in, file path out. The chat-facing surface (TTS → this → media URL) is a
core-tool bridge that composes this module — the same split as run_ui_action: core owns the
round trip, the module owns the work.
"""

import hashlib
import json
import math
import os
import sys

import numpy as np

# 24000 cut everything above 12 kHz — cymbals, attack transients and the top of a synth patch all
# live up there, and the patches below are tuned by ear. Doubling costs render time and file size,
# both of which are a spike per render rather than anything resident.
SR = 44100  # mono, everything resampled here on load

# ── score ──────────────────────────────────────────────────────────────────────────────────────

NOTE_INDEX = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_freq(name):
    """'G4' / 'C#3' / 'Db3' -> Hz (A4 = 440). None if unreadable."""
    s = str(name or "").strip()
    if not s:
        return None
    letter = s[0].upper()
    if letter not in NOTE_INDEX:
        return None
    i = 1
    semi = NOTE_INDEX[letter]
    if i < len(s) and s[i] in "#b♯♭":
        semi += 1 if s[i] in "#♯" else -1
        i += 1
    try:
        octave = int(s[i:])
    except ValueError:
        return None
    midi = (octave + 1) * 12 + semi
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def parse_score(score):
    """Normalize {bpm, notes[], chords?, style?, band?, meter?, swing?, comp?, bassline?}
    -> (spb, events, chords, style, band, feel, err).

    An event is one SUNG syllable: consecutive '-' notes extend the previous syllable across
    pitches (a melisma) — for the MVP the extension keeps the first pitch's duration math simple:
    each event carries a list of (freq, beats) segments.
    """
    if not isinstance(score, dict):
        return None, None, None, None, None, None, "score 가 객체가 아닙니다"
    bpm = float(score.get("bpm") or 0)
    if not (20 <= bpm <= 300):
        return None, None, None, None, None, None, f"bpm {bpm} 은 20~300 이어야 합니다"
    spb = 60.0 / bpm
    notes = score.get("notes")
    if not isinstance(notes, list) or not notes:
        if score.get("drumPattern"):
            notes = []  # a drum solo — the kit alone is a legal piece (length from `bars`)
        else:
            return None, None, None, None, None, None, "notes 가 비었습니다"
    events = []
    for n in notes:
        if not isinstance(n, dict):
            return None, None, None, None, None, None, "notes 항목이 객체가 아닙니다"
        freq = note_freq(n.get("note"))
        beats = float(n.get("beats") or 1)
        if freq is None:
            return None, None, None, None, None, None, f"음이름을 읽을 수 없습니다: {n.get('note')!r}"
        if beats <= 0 or beats > 16:
            return None, None, None, None, None, None, f"beats {beats} 가 이상합니다 (0 < beats <= 16)"
        syl = str(n.get("syl") or "").strip()
        if syl == "-" and events:
            events[-1]["segments"].append((freq, beats))
        else:
            events.append({"syl": syl, "segments": [(freq, beats)]})
    chords = []
    for c in score.get("chords") or []:
        root = note_freq(c.get("root")) if isinstance(c, dict) else None
        beats = float(c.get("beats") or 4) if isinstance(c, dict) else 0
        if root and beats > 0:
            chords.append((root, beats, str(c.get("quality") or "").strip()))
    # No style asked = no opinion imposed: "none" plays the notes plainly (no drums, held
    # chords) instead of dressing every unlabeled score as a trot (실측: 알함브라가 뽕짝이 됐다).
    style = str(score.get("style") or "none").strip().lower()
    style = STYLE_ALIASES.get(style, style)
    if style not in DRUM_PATTERNS:
        return None, None, None, None, None, None, \
            f"style {style!r} 를 모릅니다 — 가능한 스타일: {' | '.join(sorted(DRUM_PATTERNS))} " \
            f"(별칭: {', '.join(f'{a}→{b}' for a, b in sorted(STYLE_ALIASES.items()))})"
    # band = per-part instrument override. An unknown name is refused WITH the full library in
    # the message — the error is the discovery surface here, nobody browses the module source.
    raw_band = score.get("band")
    if isinstance(raw_band, (list, tuple)):
        # Dialect (실측: the model wrote ["piano","drums"]): a flat list is assigned to
        # melody/chord/bass in order. Drum words are skipped, not refused — the kit belongs to
        # style/drumPattern, and a list that names it means "and drums", which style provides.
        mapped, open_parts = {}, ["melody", "chord", "bass"]
        for item in raw_band:
            nm = str(item or "").strip().lower()
            if nm in ("drum", "drums", "percussion", "kit", "드럼"):
                continue
            if open_parts:
                mapped[open_parts.pop(0)] = nm
        raw_band = mapped
    band = {}
    for part, name in (raw_band or {}).items() if isinstance(raw_band, dict) else []:
        part = str(part).strip().lower()
        name = str(name).strip().lower()
        if part not in ("melody", "chord", "bass"):
            return None, None, None, None, None, None, \
                f"band 의 파트 {part!r} 를 모릅니다 — melody | chord | bass 만 받습니다"
        if resolve_instrument(name) is None:
            return None, None, None, None, None, None,                 f"악기 {name!r} 가 라이브러리에 없습니다 — 모듈 악기: {', '.join(sorted(PATCHES))} / "                 f"GM(사운드폰트): {', '.join(sorted(GM_NAMES))}"
        band[part] = name
    # feel = how the band plays. Every knob has a style default, so a bare score still grooves.
    # meter absorbs the notation people actually write: "4/4" and "3/4" are the same declaration
    # in the field's native dialect (실측: 모델이 "4/4" 를 썼고 검증이 거부했다 — 흡수가 표준).
    raw_meter = score.get("meter")
    if isinstance(raw_meter, str):
        m = raw_meter.strip()
        raw_meter = {"4/4": 4, "3/4": 3, "3": 3, "4": 4}.get(m)
        if raw_meter is None:
            return None, None, None, None, None, None,                 f"meter {m!r} 를 모릅니다 — 4, 3, \"4/4\", \"3/4\" 만 받습니다"
    meter = int(raw_meter or 4)
    if meter not in (3, 4):
        return None, None, None, None, None, None, "meter 는 3 또는 4 만 받습니다 (4/4 · 3/4)"
    swing = score.get("swing")
    if swing is not None:
        try:
            swing = float(swing)
        except (TypeError, ValueError):
            return None, None, None, None, None, None, "swing 은 0~1 숫자입니다 (0 = 스트레이트, 1 = 셔플)"
        if not (0.0 <= swing <= 1.0):
            return None, None, None, None, None, None, "swing 은 0~1 사이여야 합니다"
    comp = str(score.get("comp") or "").strip().lower() or None
    if comp is not None and comp not in COMP_KINDS:
        return None, None, None, None, None, None, \
            f"comp {comp!r} 를 모릅니다 — 가능한 값: {' | '.join(COMP_KINDS)}"
    bassline = str(score.get("bassline") or "").strip().lower() or None
    if bassline is not None and bassline not in BASS_KINDS:
        return None, None, None, None, None, None, \
            f"bassline {bassline!r} 를 모릅니다 — 가능한 값: {' | '.join(BASS_KINDS)}"
    drums = score.get("drumPattern")
    drum_rows = None
    if drums is not None:
        # The shapes people (and models) actually write, all read deterministically:
        #   [[name, beat, vel?], …]                      the canonical rows
        #   [{"drum"/"name"/"instrument", "beat"/"at"/"offset"/"pos", "vel"/"velocity"}, …]
        #   {"kick": [0, 2], "snare": 1}                 a map of name -> beat(s)
        #   ["kick", [0, 2], …]                          a row whose beat is a LIST fans out
        # (실측: 두 턴 연속 행 모양 거부가 자작곡 도피의 방아쇠였다 — 거부는 마지막 수단.)
        if isinstance(drums, dict):
            flat = []
            for k, v in drums.items():
                for b in (v if isinstance(v, (list, tuple)) else [v]):
                    flat.append([k, b])
            drums = flat
        if not isinstance(drums, list):
            return None, None, None, None, None, None,                 "drumPattern 은 [[드럼이름, 마디내박, 세기0~1], …] 목록입니다 — "                 "예: [[\"kick\",0,0.9],[\"snare\",1]]"
        drum_rows = []
        for row in drums:
            if isinstance(row, dict):
                pick = lambda *ks: next((row[k] for k in ks if row.get(k) is not None), None)
                row = [pick("drum", "name", "instrument", "inst"),
                       pick("beat", "at", "offset", "pos", "time"),
                       pick("vel", "velocity", "v")]
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                return None, None, None, None, None, None,                     f"drumPattern 행은 [드럼이름, 마디내박(, 세기)] 입니다 — "                     f"예: [[\"kick\",0,0.9],[\"snare\",1]] (받은 행: {str(row)[:80]})"
            dname = str(row[0] or "").strip().lower()
            if dname not in DRUM_NOTE:
                return None, None, None, None, None, None,                     f"드럼 {dname!r} 를 모릅니다 — 가능한 드럼: {', '.join(sorted(DRUM_NOTE))}"
            offs = row[1] if isinstance(row[1], (list, tuple)) else [row[1]]
            for off_raw in offs:
                try:
                    off = float(off_raw)
                except (TypeError, ValueError):
                    return None, None, None, None, None, None,                         f"drumPattern 의 박은 숫자입니다 (받은 값: {str(off_raw)[:40]})"
                if not (0.0 <= off < meter):
                    return None, None, None, None, None, None,                         f"drumPattern 박 {off} 가 마디({meter}박) 밖입니다"
                vel = float(row[2]) if len(row) > 2 and row[2] is not None else 0.7
                drum_rows.append((dname, off, max(0.0, min(1.0, vel))))
    bars = score.get("bars")
    if bars is not None:
        try:
            bars = int(bars)
        except (TypeError, ValueError):
            return None, None, None, None, None, None, "bars 는 정수입니다"
        if not (1 <= bars <= 256):
            return None, None, None, None, None, None, "bars 는 1~256 마디입니다"
    feel = {"meter": meter, "swing": swing, "comp": comp, "bass": bassline,
            "drums": drum_rows, "bars": bars, "bpm": bpm}
    return spb, events, chords, style, band, feel, None


# ── synthesis (the rhythm section) ─────────────────────────────────────────────────────────────


def _env(n, decay):
    return np.exp(-np.arange(n) / (SR * decay))


def kick(dur=0.25):
    n = int(SR * dur)
    t = np.arange(n) / SR
    freq = 120.0 * np.exp(-t * 9.0) + 45.0
    return np.sin(2 * np.pi * np.cumsum(freq) / SR) * _env(n, 0.09)


def snare(dur=0.18):
    n = int(SR * dur)
    rng = np.random.default_rng(7)  # fixed seed: the same score renders the same bytes
    noise = rng.standard_normal(n) * _env(n, 0.05)
    tone = np.sin(2 * np.pi * 190.0 * np.arange(n) / SR) * _env(n, 0.04)
    return noise * 0.7 + tone * 0.4


def hat(dur=0.06):
    n = int(SR * dur)
    rng = np.random.default_rng(11)
    noise = rng.standard_normal(n)
    return np.diff(noise, prepend=0.0) * _env(n, 0.02) * 0.6  # differentiation ≈ high-pass


def ohat(dur=0.30):
    """Open hat — the same metal, left ringing."""
    n = int(SR * dur)
    rng = np.random.default_rng(17)
    return np.diff(rng.standard_normal(n), prepend=0.0) * _env(n, 0.10) * 0.5


def tom(freq0, dur=0.32, seed=5):
    """A tom is a kick that starts higher and keeps more of its skin — three sizes make 두구두구."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    freq = freq0 * np.exp(-t * 7.0) + freq0 * 0.55
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * _env(n, 0.12)
    skin = np.random.default_rng(seed).standard_normal(n) * _env(n, 0.012) * 0.25
    return body * 0.9 + skin


def crash(dur=1.2):
    """쨍 — wideband metal that rings. Two differentiations stack the energy where cymbals live."""
    n = int(SR * dur)
    rng = np.random.default_rng(13)
    noise = rng.standard_normal(n)
    bright = np.diff(noise, prepend=0.0)
    sheen = np.diff(bright, prepend=0.0)
    return (bright * 0.7 + sheen * 0.45) * _env(n, 0.38) * 0.35


def _metal(dur, decay, seed, sheen=0.0, gain=0.5):
    """Differentiated noise = cymbal metal; `sheen` stacks a second differentiation on top."""
    n = int(SR * dur)
    bright = np.diff(np.random.default_rng(seed).standard_normal(n), prepend=0.0)
    out = bright if not sheen else bright * (1 - sheen) + np.diff(bright, prepend=0.0) * sheen
    return out * _env(n, decay) * gain


def _ping(freq, dur, decay, partials=(), gain=0.5):
    """A struck resonance — triangle, claves, agogo, the bell of a ride."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t)
    for ratio, amp in partials:
        x += amp * np.sin(2 * np.pi * freq * ratio * t)
    return x * _env(n, decay) * gain


def _shaker(dur, seed, decay=0.03, gain=0.4):
    n = int(SR * dur)
    hp = np.diff(np.random.default_rng(seed).standard_normal(n), prepend=0.0)
    return hp * _env(n, decay) * gain


def _am_noise(dur, rate, seed, gain=0.4):
    """Ratchet — noise gated by a fast comb, which is all a guiro scrape is."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    gate_wave = (np.sin(2 * np.pi * rate * t) > 0).astype(float)
    return np.random.default_rng(seed).standard_normal(n) * gate_wave * _env(n, dur * 0.6) * gain


def _squeak(f0, f1, dur, gain=0.5):
    """Cuica — a pitched squeal that slides. Nasal shape from a touch of 2nd harmonic."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    freq = f0 + (f1 - f0) * (t / max(t[-1], 1e-9))
    ph = 2 * np.pi * np.cumsum(freq) / SR
    return (np.sin(ph) + 0.35 * np.sin(2 * ph)) * _env(n, dur * 0.5) * gain


def clap_hit(dur=0.25):
    """Three hands land ~11ms apart, then the room takes it."""
    n = int(SR * dur)
    rng = np.random.default_rng(19)
    out = np.zeros(n)
    for k, amp in ((0, 0.8), (int(SR * 0.011), 0.9), (int(SR * 0.023), 1.0)):
        m = n - k
        out[k:] += rng.standard_normal(m) * _env(m, 0.012) * amp
    out += rng.standard_normal(n) * _env(n, 0.05) * 0.35
    return out * 0.45


def cowbell_hit(dur=0.30):
    """Two detuned square-ish tones — the 8th-note cowbell of every latin chart."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    x = np.sign(np.sin(2 * np.pi * 555.0 * t)) + 0.8 * np.sign(np.sin(2 * np.pi * 835.0 * t))
    return x * _env(n, 0.05) * 0.22


def pluck_ks(freq, dur, damp=0.996, mellow=False):
    """Karplus-Strong plucked string — a noise burst run through its own reflection. This is the
    one acoustic instrument the numpy backend can be honest about: the algorithm IS the physics
    (a wave bouncing on a string), so an acoustic guitar lives here while a saxophone cannot.
    Iterates per string period, not per sample — a few hundred numpy ops for seconds of audio.
    `mellow` pre-smooths the pluck: a nylon string is struck by flesh, steel by a pick."""
    n = max(1, int(SR * dur))
    freq = max(20.0, freq)
    # The averaging reflection delays the wave half a sample per pass, so the string's true
    # period is P + 0.5 — pick P for that, then resample away the integer remainder. Without
    # both, notes land up to ~10 cents off and a tremolo rubs the error against the chords
    # for the whole bar (실측: "너무 시다").
    period = max(2, int(round(SR / freq - 0.5)))
    rng = np.random.default_rng(int(freq) + 3)
    prev = rng.standard_normal(period)
    if mellow:
        prev = np.convolve(prev, np.ones(4) / 4.0, "same")
    out = np.empty(n)
    filled = 0
    while filled < n:
        prev = 0.5 * (prev + np.roll(prev, 1)) * damp
        take = min(period, n - filled)
        out[filled:filled + take] = prev[:take]
        filled += take
    actual = SR / (period + 0.5)
    if abs(actual - freq) > 0.01:
        idx = np.linspace(0.0, n - 1, n) * (freq / actual)
        out = np.interp(np.clip(idx, 0, n - 1), np.arange(n), out)
    return out


# ── the synth backend ─────────────────────────────────────────────────────────────────────────
#
# What separates an instrument from a beep is mostly that its BRIGHTNESS falls while the note
# sounds: high harmonics die before low ones. A synthesiser normally gets that from a filter with
# its own envelope, which is a per-sample recursion — millions of Python iterations for one
# render. Giving each harmonic its own decay rate produces the same falling brightness and stays
# vectorised, so that is what runs here.
#
# The rest is the short list that buys the most identity per line: a noise transient at the attack
# (the first few ms are half of what a listener recognises), two oscillators detuned against each
# other (thickness), and velocity opening the timbre rather than only the volume — a harder note
# is a brighter note, not the same note louder.
#
# This is the electronic half of the instrument world and it is genuinely reachable: an organ, a
# synth bass, a pad ARE algorithms, which is why a trot backing track can live here. A saxophone
# cannot — its identity is reed noise and body formants no harmonic recipe reaches. That is the
# soundfont backend's half, and the two are a division of labour rather than a choice.

# The instrument library. One row per instrument, and the row carries everything the two
# renderers need — synthesis recipe for the numpy backend, `gm` program for the .mid — so an
# instrument added here reaches both outputs without being declared twice.
#
#   harm     = integer-harmonic amplitudes (1f, 2f, 3f ...)
#   partials = float (ratio, amp) pairs instead — bells and marimbas are OUT of tune with their
#              own fundamental, and that inharmonicity IS the timbre
#   odd      = keep odd harmonics only (a square wave — the 8-bit lead)
#   hdecay/hslope = how fast brightness falls · detune = 2nd osc spread · noise = attack transient
#   breath   = CONTINUOUS noise under the tone (a flute is half air)
#   vib      = (rate Hz, depth as fraction of f0) — an e-violin without vibrato is a test tone
#   shape    = tanh drive: the electric-guitar move, harmonics born from clipping
#   engine   = "ks" → Karplus-Strong pluck (acoustic string), recipe fields ignored
#   atk/rel/gain as before · gm = General MIDI program for the .mid
PATCHES = {
    # the original trio — names kept because arrangement events fall back to their part name.
    # "melody" is the trot lead standing in for a horn: it used to be a plain decaying synth,
    # which on short notes reads as 뿅뿅 (실측·사용자). A horn SUSTAINS — slow brightness fall,
    # vibrato easing in, a little breath — so now it sings held notes instead of chirping them.
    "melody":     {"harm": [1.0, 0.62, 0.48, 0.34, 0.22, 0.12], "hdecay": 0.5, "hslope": 0.9,
                   "detune": 0.004, "noise": 0.07, "breath": 0.04, "vib": (5.3, 0.006),
                   "atk": 0.05, "rel": 0.09, "gain": 0.30, "gm": 65},
    "chord":      {"harm": [1.0, 0.40, 0.16, 0.07], "hdecay": 0.9, "hslope": 1.2,
                   "detune": 0.010, "noise": 0.0, "atk": 0.035, "rel": 0.22, "gain": 0.15, "gm": 4},
    "bass":       {"harm": [1.0, 0.62, 0.28, 0.12], "hdecay": 2.4, "hslope": 1.5,
                   "detune": 0.0, "noise": 0.03, "atk": 0.006, "rel": 0.09, "gain": 0.50, "gm": 33},
    # keys / reeds
    "piano":      {"harm": [1.0, 0.52, 0.34, 0.20, 0.13, 0.08], "hdecay": 3.0, "hslope": 1.1,
                   "detune": 0.002, "noise": 0.05, "atk": 0.004, "rel": 0.14, "gain": 0.32, "gm": 0},
    "epiano":     {"harm": [1.0, 0.30, 0.55, 0.10, 0.16], "hdecay": 2.2, "hslope": 1.2,
                   "detune": 0.003, "noise": 0.02, "atk": 0.005, "rel": 0.18, "gain": 0.28, "gm": 4},
    "organ":      {"harm": [1.0, 0.85, 0.55, 0.45, 0.28, 0.18], "hdecay": 0.12, "hslope": 0.8,
                   "detune": 0.006, "noise": 0.0, "atk": 0.02, "rel": 0.06, "gain": 0.20, "gm": 19},
    "accordion":  {"harm": [1.0, 0.72, 0.65, 0.40, 0.33, 0.22, 0.14], "hdecay": 0.18, "hslope": 0.7,
                   "detune": 0.012, "noise": 0.03, "atk": 0.045, "rel": 0.09, "gain": 0.20, "gm": 21},
    # guitars — the acoustic ones are a physical model, the electric ones are clipping
    "aguitar":    {"engine": "ks", "damp": 0.9955, "atk": 0.002, "rel": 0.08, "gain": 0.34, "gm": 25},
    "cguitar":    {"engine": "ks", "damp": 0.994, "mellow": True, "atk": 0.003, "rel": 0.09,
                   "gain": 0.34, "gm": 24},
    "eguitar":    {"harm": [1.0, 0.58, 0.36, 0.22, 0.12, 0.07], "hdecay": 2.6, "hslope": 1.15,
                   "detune": 0.002, "noise": 0.04, "shape": 1.8, "atk": 0.003, "rel": 0.10,
                   "gain": 0.30, "gm": 27},
    "dguitar":    {"harm": [1.0, 0.62, 0.45, 0.30, 0.20, 0.12], "hdecay": 0.7, "hslope": 0.8,
                   "detune": 0.004, "noise": 0.06, "shape": 5.5, "atk": 0.004, "rel": 0.09,
                   "gain": 0.26, "gm": 30},
    # bowed / sustained
    "eviolin":    {"harm": [1.0, 0.62, 0.44, 0.32, 0.24, 0.17, 0.12, 0.08], "hdecay": 0.35,
                   "hslope": 0.9, "detune": 0.004, "noise": 0.02, "vib": (5.5, 0.007),
                   "atk": 0.09, "rel": 0.12, "gain": 0.26, "gm": 40},
    "strings":    {"harm": [1.0, 0.45, 0.25, 0.12, 0.06], "hdecay": 0.35, "hslope": 1.1,
                   "detune": 0.016, "noise": 0.0, "vib": (5.0, 0.004), "atk": 0.22, "rel": 0.45,
                   "gain": 0.13, "gm": 48},
    "brass":      {"harm": [1.0, 0.78, 0.62, 0.45, 0.30, 0.18], "hdecay": 0.9, "hslope": 0.85,
                   "detune": 0.003, "noise": 0.09, "atk": 0.035, "rel": 0.08, "gain": 0.28, "gm": 61},
    "flute":      {"harm": [1.0, 0.22, 0.09, 0.04], "hdecay": 0.4, "hslope": 1.0,
                   "detune": 0.0, "noise": 0.0, "breath": 0.10, "vib": (5.2, 0.004),
                   "atk": 0.06, "rel": 0.10, "gain": 0.26, "gm": 73},
    # mallets & bells — inharmonic partials, long ring
    "marimba":    {"partials": [(1.0, 1.0), (3.98, 0.42), (9.10, 0.14)], "hdecay": 4.5,
                   "hslope": 0.6, "detune": 0.0, "noise": 0.05, "atk": 0.002, "rel": 0.10,
                   "gain": 0.30, "gm": 12},
    "bell":       {"partials": [(1.0, 1.0), (2.76, 0.62), (5.40, 0.36), (8.93, 0.19)],
                   "hdecay": 1.1, "hslope": 0.5, "detune": 0.001, "noise": 0.02, "atk": 0.002,
                   "rel": 0.25, "gain": 0.24, "gm": 14},
    "musicbox":   {"partials": [(1.0, 1.0), (3.01, 0.35), (5.85, 0.15)], "hdecay": 2.8,
                   "hslope": 0.6, "detune": 0.0, "noise": 0.01, "atk": 0.001, "rel": 0.15,
                   "gain": 0.24, "gm": 10},
    # synths proper
    "synthlead":  {"harm": [1.0 / k for k in range(1, 9)], "hdecay": 0.5, "hslope": 0.9,
                   "detune": 0.007, "noise": 0.0, "atk": 0.01, "rel": 0.08, "gain": 0.26, "gm": 81},
    "squarelead": {"harm": [1.0, 0.0, 0.33, 0.0, 0.20, 0.0, 0.14], "hdecay": 0.4, "hslope": 0.9,
                   "detune": 0.003, "noise": 0.0, "atk": 0.004, "rel": 0.06, "gain": 0.24, "gm": 80},
    "synthbass":  {"harm": [1.0, 0.70, 0.45, 0.28, 0.16, 0.09], "hdecay": 1.6, "hslope": 1.1,
                   "detune": 0.005, "noise": 0.02, "shape": 1.5, "atk": 0.005, "rel": 0.08,
                   "gain": 0.46, "gm": 38},
}


def synth_note(freq, dur, patch="bass", vel=0.8):
    """One note of `patch` — float array of `dur` seconds, peak-normalised to the patch gain."""
    p = PATCHES.get(patch, PATCHES["bass"])
    n = max(1, int(SR * dur))
    t = np.arange(n) / SR
    if p.get("engine") == "ks":
        x = pluck_ks(freq, dur, p.get("damp", 0.996), p.get("mellow", False))
    else:
        x = np.zeros(n)
        # Velocity opens the timbre: the upper harmonics are the ones it reaches.
        bright = 0.55 + 0.45 * float(np.clip(vel, 0.0, 1.0))
        # One phase ramp, shared by every partial — this is what lets vibrato bend the whole
        # note as one instrument instead of detuning each harmonic separately.
        if p.get("vib"):
            rate, depth = p["vib"]
            # Vibrato that starts immediately sounds like a siren; players ease in.
            onset = np.minimum(1.0, t / 0.18)
            inst = freq * (1.0 + depth * onset * np.sin(2 * np.pi * rate * t))
            ph = 2 * np.pi * np.cumsum(inst) / SR
        else:
            ph = 2 * np.pi * freq * t
        partials = p.get("partials") or [(float(k), a) for k, a in enumerate(p.get("harm", []), 1)]
        for i, (ratio, amp) in enumerate(partials):
            if amp <= 0.0:
                continue
            f = freq * ratio
            if f > SR * 0.45:  # past Nyquist — would alias back as a wrong pitch
                continue
            a = amp * (bright ** i)
            if a < 0.005:
                continue
            # The brightness sweep, as a per-partial decay instead of a filter recursion.
            env_k = np.exp(-t * p["hdecay"] * (ratio ** p["hslope"]))
            if p.get("detune"):
                # Symmetric spread (±d/2): a one-sided detune dragged the pitch center up by
                # half the spread — organ and synthlead measured +15 cents sharp (FFT sweep).
                half = p["detune"] / 2.0
                wave = 0.5 * (np.sin(ratio * ph * (1.0 - half)) + np.sin(ratio * ph * (1.0 + half)))
            else:
                wave = np.sin(ratio * ph)
            x += a * env_k * wave
        if p.get("noise"):
            m = min(n, int(SR * 0.012))
            if m > 1:
                # Fixed seed: the same score has to render the same bytes.
                burst = np.random.default_rng(int(freq)).standard_normal(m)
                burst = np.convolve(burst, np.ones(8) / 8.0, "same")
                x[:m] += burst * p["noise"] * np.linspace(1.0, 0.0, m)
        if p.get("breath"):
            air = np.random.default_rng(int(freq) + 1).standard_normal(n)
            air = np.convolve(air, np.ones(24) / 24.0, "same")
            x += air * p["breath"]
        if p.get("shape"):
            # Clip BEFORE the amplitude envelope: distortion is in the string, decay is in the amp.
            drive = float(p["shape"])
            peak = float(np.max(np.abs(x))) or 1.0
            x = np.tanh(drive * (x / peak)) / math.tanh(drive)
    env = np.ones(n)
    a = min(n, int(SR * p.get("atk", 0.01)))
    if a > 1:
        env[:a] = np.linspace(0, 1, a)
    r = min(max(0, n - a), int(SR * min(p.get("rel", 0.1), dur * 0.35)))
    if r > 1:
        env[-r:] = np.linspace(1, 0, r)
    peak = float(np.max(np.abs(x))) or 1.0
    return x * env * (p.get("gain", 0.3) / peak)


# Per-style one-bar (4 beats) groove: (instrument, beat offset, velocity). The kit speaks
# Korean: kick 쿵 · snare 덕 · hat 칙 (ohat rings) · toms 두구두구 · crash 쨍.
# A genre here is a ROW — groove + feel + band — not code. classic/newage carry no drums on
# purpose (they are "none" with their own bands and comping).
_HATS8 = [("hat", o / 2.0, 0.4 if o % 2 else 0.45) for o in range(8)]
# The whole General MIDI melodic map — every name is a legal band member. On the sf2 engine
# these are the font's own instruments; the numpy engine borrows the nearest PATCHES timbre
# (FAMILY_FALLBACK by GM family of 8, a few programs overridden where the family lies).
GM_NAMES = {
    "grandpiano": 0, "brightpiano": 1, "electricgrand": 2, "honkytonk": 3, "rhodes": 4,
    "epiano2": 5, "harpsichord": 6, "clavinet": 7,
    "celesta": 8, "glockenspiel": 9, "vibraphone": 11, "vibes": 11, "xylophone": 13,
    "tubularbells": 14, "dulcimer": 15,
    "drawbarorgan": 16, "percorgan": 17, "rockorgan": 18, "churchorgan": 19, "reedorgan": 20,
    "harmonica": 22, "bandoneon": 23,
    "nylonguitar": 24, "steelguitar": 25, "jazzguitar": 26, "cleanguitar": 27, "mutedguitar": 28,
    "overdriveguitar": 29, "distortionguitar": 30, "guitarharmonics": 31,
    "uprightbass": 32, "acousticbass": 32, "fingerbass": 33, "pickbass": 34, "fretlessbass": 35,
    "slapbass": 36, "slapbass2": 37, "synthbass2": 39,
    "violin": 40, "viola": 41, "cello": 42, "contrabass": 43, "tremolostrings": 44,
    "pizzicato": 45, "harp": 46, "timpani": 47,
    "strings2": 49, "synthstrings": 50, "synthstrings2": 51, "choir": 52, "voice": 53,
    "synthvoice": 54, "orchestrahit": 55,
    "trumpet": 56, "trombone": 57, "tuba": 58, "mutedtrumpet": 59, "frenchhorn": 60, "horn": 60,
    "synthbrass": 62, "synthbrass2": 63,
    "sopranosax": 64, "altosax": 65, "sax": 65, "tenorsax": 66, "barisax": 67,
    "oboe": 68, "englishhorn": 69, "bassoon": 70, "clarinet": 71,
    "piccolo": 72, "recorder": 74, "panflute": 75, "bottle": 76, "shakuhachi": 77,
    "whistle": 78, "ocarina": 79,
    "sawlead": 81, "calliope": 82, "chiff": 83, "charang": 84, "voicelead": 85,
    "fifthslead": 86, "basslead": 87,
    "newagepad": 88, "warmpad": 89, "polysynth": 90, "choirpad": 91, "bowedpad": 92,
    "metallicpad": 93, "halopad": 94, "sweeppad": 95,
    "fxrain": 96, "soundtrack": 97, "crystal": 98, "atmosphere": 99, "brightness": 100,
    "goblins": 101, "echodrops": 102, "scifi": 103,
    "sitar": 104, "banjo": 105, "shamisen": 106, "koto": 107, "kalimba": 108, "bagpipe": 109,
    "fiddle": 110, "shanai": 111,
    "tinklebell": 112, "agogobell": 113, "steeldrum": 114, "woodblock": 115, "taiko": 116,
    "melodictom": 117, "synthdrum": 118, "reversecymbal": 119,
    "fretnoise": 120, "breathnoise": 121, "seashore": 122, "birds": 123, "telephone": 124,
    "helicopter": 125, "applause": 126, "gunshot": 127,
}
FAMILY_FALLBACK = ("piano", "bell", "organ", "aguitar", "bass", "eviolin", "strings", "brass",
                   "melody", "flute", "synthlead", "strings", "synthlead", "aguitar", "marimba",
                   "synthlead")
GM_BUILTIN_OVERRIDE = {13: "marimba", 24: "cguitar", 25: "aguitar", 26: "eguitar", 27: "eguitar",
                       43: "bass",
                       28: "eguitar", 29: "dguitar", 30: "dguitar", 31: "eguitar",
                       38: "synthbass", 39: "synthbass", 45: "cguitar", 46: "cguitar",
                       47: "marimba", 104: "cguitar", 105: "aguitar", 106: "cguitar",
                       107: "cguitar", 108: "musicbox"}


# The OFFICIAL GM instrument names, normalized — 실측 (turn at 03:32): the model wrote
# "acoustic grand piano", the spec's own spelling, and the short-name table refused it. The
# spec's names are the dialect most worth absorbing.
GM_OFFICIAL = {
    "acousticgrandpiano": 0, "brightacousticpiano": 1, "electricgrandpiano": 2,
    "honkytonkpiano": 3, "electricpiano1": 4, "electricpiano": 4, "electricpiano2": 5,
    "harpsichord": 6, "clavi": 7,
    "celesta": 8, "glockenspiel": 9, "musicbox": 10, "vibraphone": 11, "marimba": 12,
    "xylophone": 13, "tubularbells": 14, "dulcimer": 15,
    "drawbarorgan": 16, "percussiveorgan": 17, "rockorgan": 18, "churchorgan": 19,
    "reedorgan": 20, "accordion": 21, "harmonica": 22, "tangoaccordion": 23,
    "acousticguitarnylon": 24, "acousticguitarsteel": 25, "electricguitarjazz": 26,
    "electricguitarclean": 27, "electricguitarmuted": 28, "overdrivenguitar": 29,
    "distortionguitar": 30, "guitarharmonics": 31,
    "acousticbass": 32, "electricbassfinger": 33, "electricbasspick": 34, "fretlessbass": 35,
    "slapbass1": 36, "slapbass2": 37, "synthbass1": 38, "synthbass2": 39,
    "violin": 40, "viola": 41, "cello": 42, "contrabass": 43, "tremolostrings": 44,
    "pizzicatostrings": 45, "orchestralharp": 46, "timpani": 47,
    "stringensemble1": 48, "stringensemble": 48, "stringensemble2": 49, "synthstrings1": 50,
    "synthstrings2": 51, "choiraahs": 52, "voiceoohs": 53, "synthvoice": 54, "orchestrahit": 55,
    "trumpet": 56, "trombone": 57, "tuba": 58, "mutedtrumpet": 59, "frenchhorn": 60,
    "brasssection": 61, "synthbrass1": 62, "synthbrass2": 63,
    "sopranosax": 64, "altosax": 65, "tenorsax": 66, "baritonesax": 67, "oboe": 68,
    "englishhorn": 69, "bassoon": 70, "clarinet": 71,
    "piccolo": 72, "flute": 73, "recorder": 74, "panflute": 75, "blownbottle": 76,
    "shakuhachi": 77, "whistle": 78, "ocarina": 79,
    "lead1square": 80, "lead2sawtooth": 81, "lead3calliope": 82, "lead4chiff": 83,
    "lead5charang": 84, "lead6voice": 85, "lead7fifths": 86, "lead8basslead": 87,
    "pad1newage": 88, "pad2warm": 89, "pad3polysynth": 90, "pad4choir": 91, "pad5bowed": 92,
    "pad6metallic": 93, "pad7halo": 94, "pad8sweep": 95,
    "fx1rain": 96, "fx2soundtrack": 97, "fx3crystal": 98, "fx4atmosphere": 99,
    "fx5brightness": 100, "fx6goblins": 101, "fx7echoes": 102, "fx8scifi": 103,
    "sitar": 104, "banjo": 105, "shamisen": 106, "koto": 107, "kalimba": 108, "bagpipe": 109,
    "fiddle": 110, "shanai": 111,
    "tinklebell": 112, "agogo": 113, "steeldrums": 114, "woodblock": 115, "taikodrum": 116,
    "melodictom": 117, "synthdrum": 118, "reversecymbal": 119,
    "guitarfretnoise": 120, "breathnoise": 121, "seashore": 122, "birdtweet": 123,
    "telephonering": 124, "helicopter": 125, "applause": 126, "gunshot": 127,
}


def _norm_inst(s):
    """Spelling is not identity: 'acoustic grand piano' == 'AcousticGrandPiano' == our key."""
    return "".join(ch for ch in str(s or "").lower() if ch.isalnum())


_INST_LOOKUP = None


def resolve_instrument(name):
    """Band name -> (builtin patch, GM program). PATCHES names win (native on both engines),
    then our short GM names, then the spec's official names — all matched normalized.
    None = the name is not an instrument."""
    global _INST_LOOKUP
    if _INST_LOOKUP is None:
        lut = {}
        for k, v in GM_OFFICIAL.items():
            lut[k] = ("gm", v)
        for k, v in GM_NAMES.items():
            lut[_norm_inst(k)] = ("gm", v)
        for k in PATCHES:
            lut[_norm_inst(k)] = ("patch", k)
        _INST_LOOKUP = lut
    hit = _INST_LOOKUP.get(_norm_inst(name))
    if hit is None:
        return None
    if hit[0] == "patch":
        return hit[1], PATCHES[hit[1]].get("gm", 0)
    g = hit[1]
    return GM_BUILTIN_OVERRIDE.get(g, FAMILY_FALLBACK[g // 8]), g


# Styles whose drummer actually rolls into the turnaround — a ballad or a carol keeps its
# soft tom fill, jazz keeps its ride language. The roll is a color, not a metronome rule.
ROLL_STYLES = {"trot", "march", "rock", "metal", "punk", "rocknroll", "dance", "pop"}


def _snare_roll(meter):
    """다다다다다 — 16ths leaning into 32nds over the bar's back half, velocities rising the
    way a drummer leans into a fill. The style's tom fill alternates with this every 8 bars."""
    hits = []
    if meter == 3:
        steps = [1.5 + i * 0.25 for i in range(2)] + [2.0 + i * 0.125 for i in range(8)]
    else:
        steps = [2.0 + i * 0.25 for i in range(4)] + [3.0 + i * 0.125 for i in range(8)]
    lo, hi = 0.45, 0.95
    for k, off in enumerate(steps):
        hits.append(("snare", off, lo + (hi - lo) * k / max(1, len(steps) - 1)))
    start = steps[0]
    return start, hits


DRUM_PATTERNS = {
    # 쿵짝 쿵짜자 쿵짝 — the 네박자: beat 3 carries the 짜-자 double before the last 짝.
    "trot":      [("kick", 0.0, 0.9), ("hat", 0.5, 0.45), ("snare", 1.0, 0.8), ("hat", 1.5, 0.45),
                  ("kick", 2.0, 0.85), ("snare", 2.5, 0.45), ("snare", 2.75, 0.5),
                  ("snare", 3.0, 0.8), ("ohat", 3.5, 0.55)],
    "ballad":    [("kick", 0.0, 0.75), ("hat", 0.5, 0.3), ("hat", 1.0, 0.35), ("hat", 1.5, 0.3),
                  ("snare", 2.0, 0.6), ("hat", 2.5, 0.3), ("kick", 3.0, 0.5), ("hat", 3.5, 0.3)],
    "march":     [("kick", 0.0, 0.9), ("snare", 0.5, 0.4), ("snare", 1.0, 0.7), ("kick", 2.0, 0.85),
                  ("snare", 2.5, 0.4), ("snare", 3.0, 0.7), ("snare", 3.5, 0.45), ("snare", 3.75, 0.5)],
    "rock":      _HATS8 + [("kick", 0.0, 0.95), ("kick", 2.5, 0.8),
                           ("snare", 1.0, 0.85), ("snare", 3.0, 0.85)],
    "metal":     [("kick", o / 2.0, 0.85) for o in range(8)] +
                 [("snare", 1.0, 0.9), ("snare", 3.0, 0.9),
                  ("ohat", 0.0, 0.5), ("ohat", 1.0, 0.5), ("ohat", 2.0, 0.5), ("ohat", 3.0, 0.5)],
    "pop":       _HATS8 + [("kick", 0.0, 0.85), ("kick", 2.0, 0.75),
                           ("snare", 1.0, 0.75), ("snare", 3.0, 0.75)],
    "dance":     [("kick", 0.0, 0.95), ("kick", 1.0, 0.95), ("kick", 2.0, 0.95), ("kick", 3.0, 0.95),
                  ("ohat", 0.5, 0.5), ("ohat", 1.5, 0.5), ("ohat", 2.5, 0.5), ("ohat", 3.5, 0.5),
                  ("snare", 1.0, 0.6), ("clap", 1.0, 0.5), ("snare", 3.0, 0.6), ("clap", 3.0, 0.5)],
    "rnb":       [("hat", o / 2.0, 0.3) for o in range(8)] +
                 [("kick", 0.0, 0.8), ("kick", 2.5, 0.6), ("snare", 1.0, 0.7), ("snare", 3.0, 0.7)],
    "rocknroll": _HATS8 + [("kick", 0.0, 0.9), ("kick", 2.0, 0.85),
                           ("snare", 1.0, 0.8), ("snare", 3.0, 0.8)],
    "hiphop":    [("hat", o / 2.0, 0.35) for o in range(8)] +
                 [("kick", 0.0, 0.9), ("kick", 1.75, 0.6), ("kick", 2.5, 0.75),
                  ("snare", 1.0, 0.85), ("clap", 1.0, 0.45),
                  ("snare", 3.0, 0.85), ("clap", 3.0, 0.45)],
    "country":   [("kick", 0.0, 0.85), ("hat", 0.5, 0.35), ("snare", 1.0, 0.6), ("hat", 1.5, 0.35),
                  ("kick", 2.0, 0.8), ("hat", 2.5, 0.35), ("snare", 3.0, 0.6), ("hat", 3.5, 0.35)],
    "funk":      [("hat", o / 4.0, 0.42 if o % 4 == 0 else 0.28) for o in range(16)] +
                 [("kick", 0.0, 0.95), ("kick", 1.75, 0.65), ("kick", 2.5, 0.75),
                  ("snare", 1.0, 0.85), ("snare", 3.0, 0.85)],
    "punk":      _HATS8 + [("kick", 0.0, 0.95), ("kick", 2.0, 0.95),
                           ("snare", 1.0, 0.9), ("snare", 3.0, 0.9)],
    "jazz":      [("ride", 0.0, 0.5), ("ride", 1.0, 0.55), ("ride", 1.5, 0.3),
                  ("ride", 2.0, 0.5), ("ride", 3.0, 0.55), ("ride", 3.5, 0.3),
                  ("hat_pedal", 1.0, 0.4), ("hat_pedal", 3.0, 0.4),
                  ("kick", 0.0, 0.3), ("kick", 2.0, 0.3)],
    "blues":     _HATS8 + [("kick", 0.0, 0.85), ("kick", 2.0, 0.8),
                           ("snare", 1.0, 0.75), ("snare", 3.0, 0.75)],
    "carol":     [("hat", o / 2.0, 0.32) for o in range(8)] +
                 [("kick", 0.0, 0.6), ("kick", 2.0, 0.55),
                  ("tamb", 1.5, 0.3), ("tamb", 3.5, 0.3), ("triangle_open", 0.0, 0.25)],
    "folk":      [],
    "classic":   [],
    "newage":    [],
    "none":      [],
}

# Familiar names people actually say → the row that plays them. kpop/jpop are pop grooves here
# honestly: what makes them THEM is production this synth does not do.
STYLE_ALIASES = {"edm": "dance", "house": "dance", "kpop": "pop", "jpop": "pop",
                 "orchestra": "classic", "symphony": "classic",
                 "rock-ballad": "ballad", "rockballad": "ballad", "waltz": "ballad",
                 "rap": "hiphop", "boombap": "hiphop", "swing": "jazz",
                 "christmas": "carol", "xmas": "carol"}

# 쿵덕 for three bars, 두구두구 on the fourth, 쨍 on the downbeat after: every 4th bar keeps its
# groove up to the fill start and rolls down the toms; every 4-bar group opens on a crash.
# (start beat, [hits]) — velocities rise through the roll because a drummer leans into a fill.
DRUM_FILLS = {
    "trot":      (2.0, [("snare", 2.0, 0.55), ("tom_hi", 2.25, 0.5), ("tom_hi", 2.5, 0.55),
                        ("tom_mid", 2.75, 0.6), ("tom_mid", 3.0, 0.7), ("tom_lo", 3.25, 0.8),
                        ("tom_lo", 3.5, 0.9), ("tom_lo", 3.75, 0.95)]),
    "ballad":    (3.0, [("tom_hi", 3.0, 0.4), ("tom_mid", 3.25, 0.5), ("tom_lo", 3.5, 0.6),
                        ("tom_lo", 3.75, 0.7)]),
    "march":     (3.0, [("snare", 3.0, 0.5), ("snare", 3.25, 0.6), ("snare", 3.5, 0.75),
                        ("snare", 3.75, 0.9)]),
    # Each genre turns the corner in its own accent — a rock tom run is not a funk ghost bar,
    # and lending everyone the trot fill made a rock band 구르다 like a 뽕짝 밴드.
    "rock":      (3.0, [("snare", 3.0, 0.6), ("tom_hi", 3.25, 0.6), ("tom_mid", 3.5, 0.7),
                        ("tom_lo", 3.75, 0.85)]),
    "metal":     (3.0, [("kick", 3.0, 0.8), ("tom_hi", 3.0, 0.6), ("kick", 3.25, 0.8),
                        ("tom_mid", 3.25, 0.65), ("kick", 3.5, 0.8), ("tom_lo", 3.5, 0.7),
                        ("kick", 3.75, 0.85), ("tom_lo", 3.75, 0.9)]),
    "punk":      (3.0, [("snare", 3.0, 0.8), ("snare", 3.25, 0.8), ("snare", 3.5, 0.85),
                        ("snare", 3.75, 0.9)]),
    "pop":       (3.0, [("snare", 3.0, 0.55), ("snare", 3.25, 0.5), ("tom_mid", 3.5, 0.6),
                        ("tom_lo", 3.75, 0.7)]),
    "dance":     (2.0, [("clap", 2.0, 0.5), ("clap", 2.5, 0.55), ("clap", 3.0, 0.6),
                        ("clap", 3.25, 0.65), ("clap", 3.5, 0.7), ("clap", 3.75, 0.8)]),
    "rnb":       (3.25, [("rim", 3.25, 0.35), ("snare", 3.5, 0.4), ("tom_lo", 3.75, 0.5)]),
    "rocknroll": (3.0, [("snare", 3.0, 0.6), ("snare", 3.5, 0.7), ("snare", 3.75, 0.8)]),
    "hiphop":    (3.5, [("snare", 3.5, 0.5), ("snare", 3.625, 0.55), ("snare", 3.75, 0.7)]),
    "country":   (3.0, [("snare", 3.0, 0.5), ("snare", 3.25, 0.55), ("snare", 3.5, 0.65),
                        ("snare", 3.75, 0.75)]),
    "funk":      (3.0, [("snare", 3.0, 0.3), ("snare", 3.25, 0.5), ("snare", 3.5, 0.3),
                        ("tom_lo", 3.75, 0.6)]),
    "jazz":      (3.0, [("snare", 3.0, 0.4), ("tom_mid", 3.5, 0.45), ("kick", 3.75, 0.35)]),
    "blues":     (3.0, [("snare", 3.0, 0.55), ("snare", 3.5, 0.65), ("tom_lo", 3.75, 0.7)]),
    "carol":     (3.0, [("tamb", 3.0, 0.3), ("tamb", 3.25, 0.3), ("tamb", 3.5, 0.35),
                        ("tamb", 3.75, 0.4)]),
}

# GM percussion, the WHOLE map (notes 35-81) — every name is legal in patterns and in a score's
# `drumPattern`. The sf2 engine plays the real kit; _kit_bank() below is what the same names
# sound like when only numpy is in the room.
DRUM_NOTE = {
    "kick2": 35, "kick": 36, "rim": 37, "snare": 38, "clap": 39, "snare2": 40,
    "tom_floor_lo": 41, "hat": 42, "tom_floor_hi": 43, "hat_pedal": 44, "tom_lo": 45,
    "ohat": 46, "tom_mid": 47, "tom_himid": 48, "crash": 49, "tom_hi": 50,
    "ride": 51, "china": 52, "ridebell": 53, "tamb": 54, "splash": 55, "cowbell": 56,
    "crash2": 57, "vibraslap": 58, "ride2": 59,
    "bongo_hi": 60, "bongo_lo": 61, "conga_mute": 62, "conga_open": 63, "conga_lo": 64,
    "timbale_hi": 65, "timbale_lo": 66, "agogo_hi": 67, "agogo_lo": 68,
    "cabasa": 69, "maracas": 70, "whistle_short": 71, "whistle_long": 72,
    "guiro_short": 73, "guiro_long": 74, "claves": 75, "woodblock_hi": 76, "woodblock_lo": 77,
    "cuica_mute": 78, "cuica_open": 79, "triangle_mute": 80, "triangle_open": 81,
}


def _kit_bank():
    """One builtin sample per GM percussion name — coarse stand-ins, honest ones. The bank is
    rebuilt per render (47 short arrays, trivial) so a fixed seed keeps renders byte-stable."""
    return {
        "kick": kick(), "kick2": kick(0.32), "rim": _ping(900.0, 0.05, 0.008, gain=0.4),
        "snare": snare(), "snare2": snare(0.16), "clap": clap_hit(),
        "hat": hat(), "hat_pedal": hat(0.04) * 0.8, "ohat": ohat(),
        "tom_floor_lo": tom(85.0, 0.4, seed=3), "tom_floor_hi": tom(95.0, 0.38, seed=4),
        "tom_lo": tom(105.0, seed=8), "tom_mid": tom(150.0, seed=6),
        "tom_himid": tom(175.0, seed=7), "tom_hi": tom(210.0, seed=5),
        "crash": crash(), "crash2": _metal(1.2, 0.40, 37, sheen=0.5, gain=0.34),
        "splash": _metal(0.5, 0.18, 31, sheen=0.5, gain=0.34),
        "china": _metal(1.0, 0.30, 29, sheen=0.65, gain=0.36),
        "ride": _metal(0.9, 0.35, 23, sheen=0.4, gain=0.20)
                + _ping(5300.0, 0.9, 0.5, gain=0.10),
        "ride2": _metal(0.9, 0.30, 41, sheen=0.45, gain=0.18)
                 + _ping(4900.0, 0.9, 0.45, gain=0.09),
        "ridebell": _ping(6100.0, 0.5, 0.25, partials=((2.4, 0.4),), gain=0.22)
                    + _metal(0.5, 0.12, 43, gain=0.08),
        "tamb": _shaker(0.18, 47, decay=0.06, gain=0.5) + _ping(7600.0, 0.18, 0.05, gain=0.12),
        "cowbell": cowbell_hit(),
        "vibraslap": _am_noise(0.8, 28.0, 53, gain=0.3),
        "bongo_hi": tom(420.0, 0.12, seed=9), "bongo_lo": tom(320.0, 0.14, seed=10),
        "conga_mute": tom(260.0, 0.10, seed=12), "conga_open": tom(230.0, 0.28, seed=14),
        "conga_lo": tom(180.0, 0.30, seed=15),
        "timbale_hi": tom(340.0, 0.18, seed=16), "timbale_lo": tom(270.0, 0.20, seed=18),
        "agogo_hi": _ping(720.0, 0.25, 0.05, gain=0.25), "agogo_lo": _ping(540.0, 0.28, 0.05, gain=0.25),
        "cabasa": _shaker(0.09, 59, decay=0.035), "maracas": _shaker(0.07, 61, decay=0.025),
        "whistle_short": _squeak(2100.0, 2100.0, 0.15, gain=0.25),
        "whistle_long": _squeak(2050.0, 2150.0, 0.45, gain=0.25),
        "guiro_short": _am_noise(0.15, 55.0, 67), "guiro_long": _am_noise(0.4, 45.0, 71),
        "claves": _ping(1700.0, 0.06, 0.012, gain=0.4),
        "woodblock_hi": _ping(1100.0, 0.08, 0.015, gain=0.4),
        "woodblock_lo": _ping(800.0, 0.09, 0.018, gain=0.4),
        "cuica_mute": _squeak(680.0, 420.0, 0.15, gain=0.3),
        "cuica_open": _squeak(380.0, 700.0, 0.30, gain=0.3),
        "triangle_mute": _ping(4300.0, 0.10, 0.03, partials=((2.86, 0.5),), gain=0.22),
        "triangle_open": _ping(4300.0, 1.2, 0.45, partials=((2.86, 0.5), (5.4, 0.25)), gain=0.22),
    }

# Which band a style hires — part → instrument name in PATCHES. The score's own `band` field
# overrides per part, so any instrument in the library can front any style.
STYLE_BAND = {
    "trot":      {"melody": "melody", "chord": "accordion", "bass": "bass"},
    "ballad":    {"melody": "piano", "chord": "strings", "bass": "bass"},
    "march":     {"melody": "brass", "chord": "organ", "bass": "bass"},
    "rock":      {"melody": "eguitar", "chord": "dguitar", "bass": "bass"},
    "metal":     {"melody": "dguitar", "chord": "dguitar", "bass": "synthbass"},
    "pop":       {"melody": "piano", "chord": "epiano", "bass": "synthbass"},
    "dance":     {"melody": "synthlead", "chord": "strings", "bass": "synthbass"},
    "rnb":       {"melody": "epiano", "chord": "epiano", "bass": "bass"},
    "rocknroll": {"melody": "eguitar", "chord": "eguitar", "bass": "bass"},
    "hiphop":    {"melody": "epiano", "chord": "epiano", "bass": "synthbass"},
    "country":   {"melody": "aguitar", "chord": "aguitar", "bass": "bass"},
    "funk":      {"melody": "eguitar", "chord": "eguitar", "bass": "synthbass"},
    "punk":      {"melody": "dguitar", "chord": "dguitar", "bass": "bass"},
    "jazz":      {"melody": "piano", "chord": "epiano", "bass": "bass"},
    "blues":     {"melody": "eguitar", "chord": "organ", "bass": "bass"},
    "carol":     {"melody": "bell", "chord": "strings", "bass": "bass"},
    "folk":      {"melody": "aguitar", "chord": "aguitar", "bass": "bass"},
    "classic":   {"melody": "violin", "chord": "strings", "bass": "contrabass"},
    "newage":    {"melody": "piano", "chord": "strings", "bass": "bass"},
    "none":      {"melody": "melody", "chord": "chord", "bass": "bass"},
}

# How a style PLAYS — the arrangement was static before this: the chord part held whole notes
# like a pad and the bass hit one root per chord, so swapping instruments still sounded slow.
# comp = how the chord part moves · bass = how the bass moves · swing = how far the offbeat
# eighths lean (0 straight, 1 full triplet; drums/comp/bass only — the melody stays straight
# because the vocal is cut to the written grid). Every knob is score-overridable.
STYLE_FEEL = {
    "trot":      {"comp": "stabs", "bass": "twobeat", "swing": 0.3, "gate": 0.8},
    "ballad":    {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "march":     {"comp": "quarters", "bass": "alt", "swing": 0.0, "gate": 0.7},
    "rock":      {"comp": "eighths", "bass": "alt", "swing": 0.0, "gate": 0.8},
    "metal":     {"comp": "eighths", "bass": "alt", "swing": 0.0, "gate": 0.7},
    "pop":       {"comp": "eighths", "bass": "alt", "swing": 0.0, "gate": 0.85},
    "dance":     {"comp": "stabs", "bass": "alt", "swing": 0.0, "gate": 0.7},
    "rnb":       {"comp": "arp", "bass": "hold", "swing": 0.55, "gate": 0.9},
    "rocknroll": {"comp": "quarters", "bass": "alt", "swing": 0.6, "gate": 0.75},
    "hiphop":    {"comp": "pad", "bass": "hold", "swing": 0.45, "gate": 0.85},
    "country":   {"comp": "stabs", "bass": "twobeat", "swing": 0.0, "gate": 0.8},
    "funk":      {"comp": "stabs", "bass": "alt", "swing": 0.0, "gate": 0.55},
    "punk":      {"comp": "eighths", "bass": "alt", "swing": 0.0, "gate": 0.6},
    "jazz":      {"comp": "stabs", "bass": "walk", "swing": 0.65, "gate": 0.85},
    "blues":     {"comp": "quarters", "bass": "walk", "swing": 0.6, "gate": 0.85},
    "carol":     {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 0.95},
    "folk":      {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "classic":   {"comp": "pad", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "newage":    {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "none":      {"comp": "pad", "bass": "hold", "swing": 0.0, "gate": 0.95},
}
COMP_KINDS = ("pad", "stabs", "arp", "quarters", "eighths")
BASS_KINDS = ("hold", "twobeat", "alt", "walk")

# 3/4 grooves — a waltz bar is not a trimmed 4/4 bar, so the tables are their own.
DRUM_PATTERNS_3 = {
    "trot":   [("kick", 0.0, 0.9), ("hat", 0.5, 0.4), ("snare", 1.0, 0.65), ("hat", 1.5, 0.4),
               ("snare", 2.0, 0.7), ("hat", 2.5, 0.4)],
    "ballad": [("kick", 0.0, 0.75), ("hat", 1.0, 0.4), ("hat", 2.0, 0.4)],
    "march":  [("kick", 0.0, 0.9), ("snare", 1.0, 0.6), ("snare", 2.0, 0.65)],
    "none":   [],
}
DRUM_FILLS_3 = {
    "trot":   (2.0, [("tom_hi", 2.0, 0.55), ("tom_mid", 2.25, 0.65), ("tom_lo", 2.5, 0.75),
                     ("tom_lo", 2.75, 0.9)]),
    "ballad": (2.0, [("tom_mid", 2.0, 0.45), ("tom_lo", 2.5, 0.6)]),
    "march":  (2.0, [("snare", 2.0, 0.5), ("snare", 2.25, 0.6), ("snare", 2.5, 0.75),
                     ("snare", 2.75, 0.9)]),
}


# ── arrangement — one event list, several renderers ───────────────────────────────────────────
#
# The score says what the song IS; this says what the band PLAYS. Both renderers below read this
# list and nothing else, so a part added here (melody, chord voicing, a counter-line later) shows
# up in the wav and in the .mid without being written twice — and a third renderer (a real
# synthesiser reading the .mid) is a reader of the same list, not a rewrite of the arrangement.
#
# `program` is a General MIDI program number so the meaning survives the trip to any synth; the
# numpy renderer maps it onto the timbre it has. Drums carry a name instead, since they are a kit
# and not a pitch.

def midi_number(name):
    """'G4' -> 67. None if unreadable — same spelling rules as `note_freq`."""
    f = note_freq(name)
    return None if f is None else int(round(69 + 12 * math.log2(f / 440.0)))


def freq_of_midi(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


# Semitones above the root. An unknown spelling plays major rather than failing the render: a
# wrong third is audible and fixable, a refused chord is silence the caller has to debug.
CHORD_QUALITY = {
    "": [0, 4, 7], "maj": [0, 4, 7], "major": [0, 4, 7],
    "m": [0, 3, 7], "min": [0, 3, 7], "minor": [0, 3, 7],
    "7": [0, 4, 7, 10], "dom7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10], "min7": [0, 3, 7, 10],
    "dim": [0, 3, 6], "aug": [0, 4, 8],
    "sus2": [0, 2, 7], "sus4": [0, 5, 7],
    "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9],
}


def chord_voicing(root_midi, quality=""):
    """Root-position chord above the written root. Trot lives on minor and dominant sevenths, so
    a score that could only say "root" was stuck in major whatever the song actually was."""
    semis = CHORD_QUALITY.get(str(quality or "").strip(), CHORD_QUALITY[""])
    return [root_midi + s for s in semis]


def smooth_voicing(notes, prev):
    """Voice-leading: move each chord tone to the octave nearest the previous voicing's center.
    Root-position jumps are what makes a progression sound typed; a player's hand stays put."""
    if not prev:
        return sorted(notes)
    center = sum(prev) / len(prev)
    return sorted(min((n - 12, n, n + 12), key=lambda c: abs(c - center)) for n in notes)


def _comp_hits(kind, beats, meter):
    """(offset, dur, vel) strokes for ONE chord segment — how the chord part moves.
    stabs = the 짝 of 쿵-짝(offbeats) · quarters = a march's on-beats · pad = the old whole note.
    (arp is built in the caller: it needs the voicing, not just a rhythm.)"""
    if kind == "stabs":
        step = 2.0 if meter == 4 else 1.0
        return [(float(off), 0.9, 0.7) for off in np.arange(1.0, beats, step)]
    if kind == "quarters":
        return [(float(b), 0.9, 0.74 if b % 2 == 0 else 0.64) for b in range(int(beats))]
    if kind == "eighths":  # driving on-and-off strokes — the rock/pop rhythm guitar hand
        return [(s * 0.5, 0.5, 0.68 if s % 2 == 0 else 0.55) for s in range(int(beats * 2))]
    return [(0.0, float(beats), 0.6)]  # pad


def _bass_line(kind, root_midi, beats, next_root_midi, meter, semis=None):
    """(offset, dur, pitch, vel) for one chord segment. The bass register is root-12 as before.
    twobeat = root/5th alternation (the 뽕짝 walk) · alt = marching quarters · walk = the jazz
    floor (root, third, fifth in quarters, a dominant pickup into the next chord — quality-aware,
    so a minor chord walks a minor third) · hold = whole note + pickup."""
    b = root_midi - 12
    fifth = b + 7
    if kind == "walk":
        s = semis or [0, 4, 7]
        steps = [b, b + (s[1] if len(s) > 1 else 4), b + (s[2] if len(s) > 2 else 7)]
        out = []
        n = max(1, int(beats))
        for i in range(n):
            last = i == n - 1
            if last and next_root_midi is not None and next_root_midi != root_midi:
                nb = next_root_midi - 12
                out.append((float(i), 0.9, nb + 7 if nb + 7 < b + 10 else nb - 5, 0.64))
            else:
                out.append((float(i), 0.9, steps[i % len(steps)], 0.72 if i % 2 == 0 else 0.64))
        return out
    if kind == "twobeat":
        step = 1.0 if beats <= 2 else 2.0
        out, on_fifth = [], False
        for off in np.arange(0.0, beats, step):
            out.append((float(off), step * 0.85, fifth if on_fifth else b,
                        0.68 if on_fifth else 0.78))
            on_fifth = not on_fifth
        return out
    if kind == "alt":
        return [(float(i), 0.9, fifth if i % 2 else b, 0.62 if i % 2 else 0.78)
                for i in range(int(beats))]
    # hold — and walk into the next chord instead of teleporting there. The pickup is the
    # NEXT chord's fifth (its dominant), never a chromatic neighbour: a half-step approach
    # put F under an A-minor bar and B♭ under the Canon's D major, and both were plainly sour.
    if next_root_midi is not None and next_root_midi != root_midi and beats >= 2:
        nb = next_root_midi - 12
        approach = nb + 7 if nb + 7 < b + 10 else nb - 5
        return [(0.0, float(beats) - 0.5, b, 0.72), (float(beats) - 0.5, 0.5, approach, 0.6)]
    return [(0.0, float(beats), b, 0.72)]


def build_arrangement(events, chords, style, total_beats, band=None, feel=None):
    """Score -> flat list of {beat, beats, part, patch, pitch|drum, program, vel}. Beats, not
    samples: the renderers turn them into whatever they count in (samples here, MIDI ticks there).
    `band` = per-part instrument override ({part: PATCHES name}) on top of the style's own.
    `feel` = {meter, swing, comp, bass} from parse_score; None = the style's own defaults."""
    hire = dict(STYLE_BAND.get(style, STYLE_BAND["trot"]))
    for part, name in (band or {}).items():
        if part in hire and resolve_instrument(name) is not None:
            hire[part] = name
    # Two faces per instrument: the GM program (what the .mid and the sf2 engine mean) and the
    # builtin patch (what numpy can play). PATCHES names are native to both; GM names degrade.
    patch_of, prog = {}, {}
    for part, name in hire.items():
        patch_of[part], prog[part] = resolve_instrument(name)
    defaults = STYLE_FEEL.get(style, STYLE_FEEL["trot"])
    feel = feel or {}
    meter = int(feel.get("meter") or 4)
    swing = float(feel.get("swing") if feel.get("swing") is not None else defaults["swing"])
    comp = feel.get("comp") or defaults["comp"]
    bassline = feel.get("bass") or defaults["bass"]
    # Articulation: how much of a written note actually SOUNDS. Velocity alone made every
    # style press notes the same shape — funk clips, a ballad sings through (실측·사용자:
    # "리듬에 어울리게 안 나오냐").
    gate = float(defaults.get("gate", 0.9))
    # A machine-gun roll belongs to uptempo music: a slow piece keeps its soft fill even in a
    # rolling genre (실측: pop-style 캐논 at a slow bpm rolled, and it fit nothing).
    bpm = float(feel.get("bpm") or 120.0)
    out = []
    # Melody — the notes the voice sings, also given to an instrument. Without this an
    # instrumental render (no vocalPath) had rhythm and bass and no tune at all.
    # Velocity is a phrase shape, not a constant: downbeats lean, offbeats step back.
    beat = 0.0
    for ev in events:
        for freq, beats in ev["segments"]:
            m = int(round(69 + 12 * math.log2(freq / 440.0)))
            on_down = (beat % meter) < 1e-6
            on_beat = (beat % 1.0) < 1e-6
            vel = 0.82 if on_down else (0.74 if on_beat else 0.64)
            out.append({"beat": beat, "beats": beats, "part": "melody", "patch": patch_of["melody"],
                        "pitch": m, "program": prog["melody"], "vel": vel, "gate": gate})
            beat += beats
    pos = 0.0
    prev_voicing = None
    for idx, (root, beats, quality) in enumerate(chords):
        rm = int(round(69 + 12 * math.log2(root / 440.0)))
        voicing = smooth_voicing(chord_voicing(rm, quality), prev_voicing)
        prev_voicing = voicing
        if comp == "arp":
            # Eighths rippling up-and-down the voicing — needs the notes, not just a rhythm.
            order = voicing + voicing[-2:0:-1]
            for slot in range(int(beats * 2)):
                off = slot * 0.5
                if pos + off >= total_beats:
                    break
                out.append({"beat": pos + off, "beats": 0.55, "part": "chord",
                            "patch": patch_of["chord"], "pitch": order[slot % len(order)],
                            "program": prog["chord"],
                            "vel": 0.58 if slot % 2 == 0 else 0.48})
        else:
            for off, dur, vel in _comp_hits(comp, beats, meter):
                if pos + off >= total_beats:
                    break
                for p in voicing:
                    out.append({"beat": pos + off, "beats": dur, "part": "chord",
                                "patch": patch_of["chord"], "pitch": p,
                                "program": prog["chord"], "vel": vel})
        next_rm = None
        if idx + 1 < len(chords):
            next_rm = int(round(69 + 12 * math.log2(chords[idx + 1][0] / 440.0)))
        semis = CHORD_QUALITY.get(str(quality or "").strip(), CHORD_QUALITY[""])
        for off, dur, pitch, vel in _bass_line(bassline, rm, beats, next_rm, meter, semis):
            if pos + off < total_beats:
                out.append({"beat": pos + off, "beats": dur, "part": "bass",
                            "patch": patch_of["bass"], "pitch": pitch,
                            "program": prog["bass"], "vel": vel})
        pos += beats
        if pos >= total_beats:
            break
    patterns = DRUM_PATTERNS_3 if meter == 3 else DRUM_PATTERNS
    fills = DRUM_FILLS_3 if meter == 3 else DRUM_FILLS
    # A score's own drumPattern replaces the style's bar loop; fills and crashes still apply,
    # so a custom groove keeps a drummer (다다다다 included) instead of becoming a metronome.
    custom = feel.get("drums")
    base = list(custom) if custom else patterns.get(style, patterns["trot"])
    fill = fills.get(style if style in fills else "trot")
    bar, bar_i = 0.0, 0
    while bar < total_beats:
        hits = list(base)
        if hits and style in ROLL_STYLES and bpm >= 96 and bar_i % 8 == 7:
            # Every 8th bar the tom fill yields to the snare roll — 다다다다다 into the crash.
            start, roll = _snare_roll(meter)
            hits = [h for h in hits if h[1] < start] + roll
        elif hits and fill and bar_i % 4 == 3:
            start, roll = fill
            hits = [h for h in hits if h[1] < start] + roll
        if hits and bar_i % 4 == 0:
            hits = [("crash", 0.0, 0.85 if bar_i == 0 else 0.7)] + hits
        for inst, off, vel in hits:
            if bar + off < total_beats:
                out.append({"beat": bar + off, "beats": 0.25, "part": "drum",
                            "drum": inst, "vel": vel})
        bar += float(meter)
        bar_i += 1
    # Swing — the offbeat eighths of the rhythm section lean late. The melody stays straight:
    # the vocal is cut to the written grid, and a straight voice over a shuffling band is the
    # trot sound anyway.
    if swing > 0:
        shift = swing / 6.0
        for e in out:
            if e["part"] != "melody" and abs(e["beat"] % 1.0 - 0.5) < 1e-6:
                e["beat"] += shift
    out.sort(key=lambda e: (e["beat"], e["part"]))
    return out


def render_arrangement(arr, spb, total_beats):
    """The numpy backend — (stereo (n,2) array, mono reverb-send bus). The band is panned onto
    a stage and each voice contributes to one shared room (add_room applies it at the end)."""
    n_total = int(SR * spb * total_beats) + int(SR * 0.5)
    out = np.zeros((n_total, 2))
    send = np.zeros(n_total)
    hits = _kit_bank()
    for e in arr:
        i = int(SR * spb * e["beat"])
        if i >= n_total:
            continue
        if e["part"] == "drum":
            seg = hits[e["drum"]] * float(e.get("vel", 0.8))
            key = e["drum"]
        else:
            seg = synth_note(freq_of_midi(e["pitch"]),
                             spb * e["beats"] * float(e.get("gate", 1.0)),
                             e.get("patch", e["part"]), vel=float(e.get("vel", 0.8)))
            key = e["part"]
        m = min(len(seg), n_total - i)
        seg = seg[:m]
        # Constant-power pan: the band sits on a stage, not a point.
        theta = (PAN.get(key, 0.0) + 1.0) * np.pi / 4.0
        out[i:i + m, 0] += seg * np.cos(theta)
        out[i:i + m, 1] += seg * np.sin(theta)
        send[i:i + m] += seg * SEND.get(key, 0.1)
    return out, send


# Where each voice sits (−1 left … +1 right) and how much of it goes to the room. The dry mix
# was mono and bone-dry, which doubled the synth-ness of everything: a stage and a little air
# are half of "sounds like a record".
PAN = {"melody": 0.0, "chord": -0.25, "bass": 0.0, "vocal": 0.0,
       "kick": 0.0, "kick2": 0.0, "snare": 0.08, "snare2": 0.08, "rim": 0.05, "clap": 0.12,
       "hat": 0.32, "hat_pedal": 0.32, "ohat": 0.32,
       "tom_hi": -0.28, "tom_himid": -0.15, "tom_mid": 0.0, "tom_lo": 0.28,
       "tom_floor_hi": 0.32, "tom_floor_lo": 0.36,
       "crash": -0.32, "crash2": 0.42, "splash": -0.22, "china": -0.45,
       "ride": 0.38, "ride2": 0.38, "ridebell": 0.38,
       "tamb": -0.35, "cowbell": -0.22, "vibraslap": -0.30,
       "bongo_hi": 0.44, "bongo_lo": 0.44, "conga_mute": -0.44, "conga_open": -0.44,
       "conga_lo": -0.44, "timbale_hi": 0.26, "timbale_lo": 0.26,
       "agogo_hi": -0.30, "agogo_lo": -0.30, "cabasa": 0.34, "maracas": 0.30,
       "guiro_short": -0.26, "guiro_long": -0.26, "claves": 0.18,
       "woodblock_hi": 0.18, "woodblock_lo": 0.18, "cuica_mute": 0.15, "cuica_open": 0.15,
       "triangle_mute": -0.18, "triangle_open": -0.18,
       "whistle_short": -0.10, "whistle_long": -0.10}
SEND = {"melody": 0.22, "chord": 0.16, "bass": 0.04,
        "kick": 0.05, "kick2": 0.05, "snare": 0.14, "snare2": 0.14, "rim": 0.08, "clap": 0.16,
        "hat": 0.08, "hat_pedal": 0.06, "ohat": 0.10,
        "tom_hi": 0.16, "tom_himid": 0.16, "tom_mid": 0.16, "tom_lo": 0.16,
        "tom_floor_hi": 0.16, "tom_floor_lo": 0.16,
        "crash": 0.30, "crash2": 0.30, "splash": 0.26, "china": 0.28,
        "ride": 0.18, "ride2": 0.18, "ridebell": 0.16,
        "triangle_mute": 0.20, "triangle_open": 0.28}


def _reverb_ir(seconds, seed):
    """Exponentially decaying noise = a perfectly serviceable room. Two seeds = a stereo room."""
    n = int(SR * seconds)
    ir = np.random.default_rng(seed).standard_normal(n) * np.exp(-np.arange(n) / (SR * 0.28))
    ir[:int(SR * 0.018)] = 0.0  # predelay — keeps the dry attack in front of the wash
    energy = float(np.sqrt(np.sum(ir * ir))) or 1.0
    return ir / energy


def _fft_convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << max(1, (n - 1).bit_length())
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:len(x)]


def add_room(stereo, send, wet=0.9):
    """One room for the whole band — the send bus decides who stands close to it."""
    if len(send) == 0 or not np.any(send):
        return stereo
    stereo[:, 0] += _fft_convolve(send, _reverb_ir(0.9, 21)) * wet
    stereo[:, 1] += _fft_convolve(send, _reverb_ir(0.9, 22)) * wet
    return stereo


def write_midi(arr, bpm, path):
    """The MIDI backend — the same arrangement as a .mid, for any synth worth more than ours.

    Optional dependency on purpose: this is the one output that needs no audio stack at all, so a
    missing `mido` must degrade to "no .mid this time" rather than failing the render.
    """
    try:
        import mido
    except ImportError:
        return None, "mido 미설치 — .mid 산출은 건너뜁니다 (wav 는 정상)"
    tpb = 480
    mid = mido.MidiFile(ticks_per_beat=tpb)
    # One track per part: a synth that lets you pick instruments per track can, and the drum
    # channel (9) is fixed by the standard rather than by us.
    for part in ("melody", "chord", "bass", "drum"):
        rows = [e for e in arr if e["part"] == part]
        if not rows:
            continue
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name=part, time=0))
        if part == "drum":
            ch = 9
        else:
            ch = {"melody": 0, "chord": 1, "bass": 2}[part]
            tr.append(mido.Message("program_change", channel=ch,
                                   program=rows[0]["program"], time=0))
            pan = PAN.get(part, 0.0)
            tr.append(mido.Message("control_change", channel=ch, control=10,
                                   value=max(0, min(127, int(round(64 + pan * 63)))), time=0))
        # (tick, on/off) pairs, then one pass in time order — MIDI deltas are relative, so the
        # note-offs have to be interleaved rather than appended per note.
        marks = []
        for e in rows:
            start = int(round(e["beat"] * tpb))
            pitch = DRUM_NOTE.get(e["drum"], 42) if part == "drum" else e["pitch"]
            vel = int(round(127 * float(e.get("vel", 0.71))))
            length = e["beats"] * float(e.get("gate", 1.0))
            marks.append((start, 1, pitch, vel))
            marks.append((start + max(1, int(round(length * tpb))), 0, pitch, 0))
        marks.sort(key=lambda m: (m[0], m[1]))
        prev = 0
        for tick, on, pitch, vel in marks:
            tr.append(mido.Message("note_on" if on else "note_off", channel=ch,
                                   note=max(0, min(127, pitch)),
                                   velocity=max(1, min(127, vel)) if on else 0,
                                   time=tick - prev))
            prev = tick
    mid.tracks[0].insert(0, mido.MetaMessage("set_tempo",
                                             tempo=mido.bpm2tempo(bpm), time=0))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    mid.save(path)
    return path, None


# ── SF2 backend (system fluidsynth) ─────────────────────────────────────────────────────────────

SF2_DIRS = ("/usr/share/sounds/sf2", "/usr/local/share/sounds/sf2")


def sf2_backend():
    """The OS synth, if the OS has one: `apt install fluidsynth fluid-soundfont-gm`.

    Both halves come from apt and both are FOUND, not configured — the engine on PATH, the GM
    font at the distro's standard sf2 directory (default-GM.sf2 = the alternatives symlink, so the
    admin can retarget it without touching us). Returns (fluidsynth_bin, font_path, why_not);
    why_not names the missing half so a forced engine:"sf2" fails with the next move.
    """
    import shutil
    binp = shutil.which("fluidsynth")
    font = None
    for d in SF2_DIRS:
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        sf2s = [n for n in names if n.lower().endswith(".sf2")]
        if sf2s:
            pref = [n for n in sf2s if n.lower().startswith("default")]
            font = os.path.join(d, (pref or sf2s)[0])
            break
    if not binp:
        return None, font, "fluidsynth 미설치 — `apt install fluidsynth fluid-soundfont-gm`"
    if not font:
        return binp, None, ("사운드폰트(.sf2)가 없습니다 — "
                            "`apt install fluid-soundfont-gm` (/usr/share/sounds/sf2)")
    return binp, font, None


def render_sf2(arr, spb, binp, font):
    """The arrangement through fluidsynth: the same .mid midiOut writes, played on the GM font.

    Returns (stereo, why_not) — any why_not drops the render back to the builtin synth, so a
    broken font or a killed process degrades the tone, never the turn.
    """
    import subprocess
    os.makedirs("data/sing", exist_ok=True)
    tag = f"{os.getpid()}-{hashlib.sha1(f'{spb}:{len(arr)}'.encode()).hexdigest()[:8]}"
    mid_path = f"data/sing/tmp-{tag}.mid"
    wav_path = f"data/sing/tmp-{tag}.wav"
    try:
        written, note = write_midi(arr, 60.0 / spb, mid_path)
        if not written:
            return None, note or "mido unavailable — the sf2 engine goes through a .mid"
        # Stock settings on purpose (사용자: "우리가 임의적으로 하지 말고 미디 기본값으로") —
        # the reference sound is what any GM player makes of the same .mid, reverb included.
        r = subprocess.run([binp, "-ni", "-g", "0.5", "-r", str(SR), "-F", wav_path, font,
                            mid_path],
                           capture_output=True, timeout=600)
        if r.returncode != 0 or not os.path.isfile(wav_path) or os.path.getsize(wav_path) < 1024:
            tail = (r.stderr or r.stdout or b"")[-300:].decode("utf-8", "replace").strip()
            return None, f"fluidsynth exit {r.returncode}: {tail}"
        import soundfile as sf
        data, sr = sf.read(wav_path, dtype="float64", always_2d=True)
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        data = data[:, :2]
        if sr != SR:
            data = np.stack([resample_linear(data[:, 0], SR / sr),
                             resample_linear(data[:, 1], SR / sr)], axis=1)
        peak = np.max(np.abs(data)) or 1.0
        return data / peak, None
    except subprocess.TimeoutExpired:
        return None, "fluidsynth timed out"
    finally:
        for pth in (mid_path, wav_path):
            try:
                os.remove(pth)
            except OSError:
                pass


# ── vocal retune (numpy floor; pyworld when available) ─────────────────────────────────────────


def detect_f0(x, lo=70.0, hi=420.0):
    """Autocorrelation F0 of a mono snippet. None when nothing periodic is there."""
    if len(x) < int(SR * 0.03):
        return None
    seg = x[: int(SR * 0.08)] * np.hanning(min(len(x), int(SR * 0.08)))[: len(x[: int(SR * 0.08)])]
    seg = seg - seg.mean()
    if not np.any(seg):
        return None
    ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
    if ac[0] <= 0:
        return None
    lag_lo, lag_hi = int(SR / hi), int(SR / lo)
    if lag_hi >= len(ac):
        lag_hi = len(ac) - 1
    if lag_lo >= lag_hi:
        return None
    lag = lag_lo + int(np.argmax(ac[lag_lo:lag_hi]))
    if ac[lag] < 0.25 * ac[0]:  # weak periodicity = unvoiced
        return None
    return SR / lag


def resample_linear(x, ratio):
    """Length × ratio by linear interpolation (playback-rate change: shorter = higher)."""
    n_out = max(1, int(round(len(x) * ratio)))
    idx = np.linspace(0, len(x) - 1, n_out)
    return np.interp(idx, np.arange(len(x)), x)


def stretch_ola(x, factor, win_s=0.05):
    """Time-stretch by `factor` with plain overlap-add. Metallic on big factors — the floor."""
    if len(x) == 0 or abs(factor - 1.0) < 1e-3:
        return x.copy()
    win = int(SR * win_s)
    hop_out = win // 2
    hop_in = max(1, int(round(hop_out / factor)))
    w = np.hanning(win)
    n_frames = max(1, (len(x) - win) // hop_in + 1)
    out = np.zeros(n_frames * hop_out + win)
    norm = np.zeros_like(out)
    for f in range(n_frames):
        a = f * hop_in
        chunk = x[a:a + win]
        if len(chunk) < win:
            chunk = np.pad(chunk, (0, win - len(chunk)))
        b = f * hop_out
        out[b:b + win] += chunk * w
        norm[b:b + win] += w
    norm[norm < 1e-6] = 1.0
    return out / norm


def retune_syllable_numpy(x, target_freq, target_len):
    """One syllable to one note: shift pitch to the note, stretch to the beat."""
    f0 = detect_f0(x) or 180.0
    k = target_freq / f0
    k = float(np.clip(k, 0.25, 4.0))  # a two-octave leap is a wrong detection, not a melody
    shifted = resample_linear(x, 1.0 / k)  # pitch × k, duration ÷ k
    factor = target_len / max(1, len(shifted))
    fitted = stretch_ola(shifted, factor)
    if len(fitted) < target_len:
        fitted = np.pad(fitted, (0, target_len - len(fitted)))
    return fitted[:target_len]


def try_pyworld():
    try:
        import pyworld  # noqa: F401
        return pyworld
    except Exception:
        return None


def retune_syllable_world(pw, x, target_freq, target_len):
    """WORLD backend: replace F0 with the note (plus a light vibrato), keep the envelope."""
    x64 = np.ascontiguousarray(x, dtype=np.float64)
    f0, t = pw.harvest(x64, SR, f0_floor=60.0, f0_ceil=500.0)
    sp = pw.cheaptrick(x64, f0, t, SR)
    ap = pw.d4c(x64, f0, t, SR)
    voiced = f0 > 0
    new_f0 = np.full_like(f0, float(target_freq))
    vib = 1.0 + 0.02 * np.sin(2 * np.pi * 5.5 * t)  # a singer's hand, not a synth's line
    new_f0 = new_f0 * vib
    new_f0[~voiced] = 0.0
    y = pw.synthesize(new_f0, sp, ap, SR)
    factor = target_len / max(1, len(y))
    fitted = stretch_ola(np.asarray(y), factor)
    if len(fitted) < target_len:
        fitted = np.pad(fitted, (0, target_len - len(fitted)))
    return fitted[:target_len]


def split_vocal(x, count):
    """Cut the spoken take into `count` syllable chunks.

    MVP: trim edge silence, then equal split. Korean is syllable-timed enough that this lands
    within the autotune aesthetic; onset detection is the known upgrade and is written down as
    such rather than half-built.
    """
    if count <= 0:
        return []
    env = np.abs(x)
    win = max(1, int(SR * 0.01))
    smooth = np.convolve(env, np.ones(win) / win, "same")
    loud = np.where(smooth > smooth.max() * 0.05)[0]
    core = x[loud[0]:loud[-1] + 1] if len(loud) else x
    edges = np.linspace(0, len(core), count + 1).astype(int)
    return [core[edges[i]:edges[i + 1]] for i in range(count)]


def render_vocal(vocal, events, spb):
    """The whole take, syllable by syllable, onto the score's pitches and beats."""
    pw = try_pyworld()
    chunks = split_vocal(vocal, len(events))
    out = []
    for ev, chunk in zip(events, chunks):
        for i, (freq, beats) in enumerate(ev["segments"]):
            target_len = int(SR * spb * beats)
            # A melisma re-sings the same chunk on each pitch; plain syllables use it once.
            src = chunk if len(chunk) else np.zeros(target_len)
            if pw is not None and len(src) > int(SR * 0.05):
                out.append(retune_syllable_world(pw, src, freq, target_len))
            else:
                out.append(retune_syllable_numpy(src, freq, target_len))
    return np.concatenate(out) if out else np.zeros(0)


# ── MIDI -> score ──────────────────────────────────────────────────────────────────────────────

MIDI_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _midi_name(n):
    return f"{MIDI_NAMES[n % 12]}{n // 12 - 1}"


def _fix_lyric_text(s):
    """mido decodes meta text as latin-1; Korean karaoke MIDIs carry CP949 bytes, so the
    round-trip through latin-1 yields mojibake we can reverse exactly. Real unicode (a file
    saved with a proper charset) fails the latin-1 re-encode and passes through untouched."""
    try:
        raw = s.encode("latin-1")
    except UnicodeEncodeError:
        return s
    for enc in ("cp949", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return s


def _track_events(track):
    """One track -> [[note, start_tick, dur_tick], ...] sorted by start."""
    events, t, on = [], 0, {}
    for msg in track:
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            on[msg.note] = t
        elif (msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0)) \
                and msg.note in on:
            start = on.pop(msg.note)
            events.append([msg.note, start, t - start])
    events.sort(key=lambda e: e[1])
    return events


def midi_to_score(path, lyrics=None):
    """Karaoke/simple MIDI file -> {bpm, notes[], chords?} or (None, err).

    Melody pick: the track carrying lyric meta events wins; otherwise the busiest
    mostly-monophonic non-drum track. Syllables come from the file's own lyric events when
    present (karaoke MIDIs stamp one per note), else from the `lyrics` string in note order,
    else '라'. Chords are read off the lowest-pitched track, lowest note per 2-beat window —
    the anthem prototype's exact recipe, generalized.
    """
    import mido
    try:
        mf = mido.MidiFile(path)
    except Exception as e:  # noqa: BLE001 — a broken upload should name itself, not crash
        return None, f"MIDI parse failed: {e}"
    tpb = mf.ticks_per_beat or 480

    bpm = 120.0
    for tr in mf.tracks:
        for msg in tr:
            if msg.type == "set_tempo":
                bpm = round(mido.tempo2bpm(msg.tempo), 1)
                break
        else:
            continue
        break

    # Lyric events: absolute tick -> text, per track (so we can prefer the lyric-bearing track).
    lyric_by_track = []
    for tr in mf.tracks:
        t, out = 0, []
        for msg in tr:
            t += msg.time
            if msg.type in ("lyrics", "text"):
                txt = _fix_lyric_text(msg.text or "").strip()
                if txt and txt not in ("\\", "/", "\r", "\n"):
                    out.append((t, txt))
        lyric_by_track.append(out)

    # Candidate tracks: enough notes, not the drum channel, mostly monophonic.
    cands = []
    for idx, tr in enumerate(mf.tracks):
        ev = _track_events(tr)
        if len(ev) < 8:
            continue
        channels = {m.channel for m in tr if hasattr(m, "channel")}
        if channels and channels <= {9}:  # GM drums
            continue
        overlap = sum(
            1 for i in range(len(ev) - 1) if ev[i + 1][1] < ev[i][1] + ev[i][2] * 0.5
        ) / max(1, len(ev) - 1)
        mean_pitch = sum(e[0] for e in ev) / len(ev)
        cands.append({"idx": idx, "ev": ev, "overlap": overlap, "mean": mean_pitch,
                      "lyrics": len(lyric_by_track[idx])})
    if not cands:
        return None, "no playable track found in the MIDI (need >= 8 notes on a non-drum track)"

    with_lyrics = [c for c in cands if c["lyrics"] >= 8]
    mono = [c for c in cands if c["overlap"] < 0.3]
    melody = max(with_lyrics, key=lambda c: c["lyrics"]) if with_lyrics \
        else max(mono or cands, key=lambda c: (len(c["ev"]), c["mean"]))

    # Monophonize (karaoke files sometimes double a note) and quantize beats.
    mel = []
    for e in melody["ev"]:
        if mel and e[1] < mel[-1][1] + 2:  # same-start double: keep the higher note
            if e[0] > mel[-1][0]:
                mel[-1] = e
            continue
        mel.append(e)
    seq = []
    for i, (note, start, dur) in enumerate(mel):
        span = (mel[i + 1][1] - start) if i + 1 < len(mel) else dur
        beats = max(0.25, round(span / tpb * 4) / 4)
        seq.append({"note": _midi_name(note), "beats": beats, "tick": start})

    # Syllables: file lyric events matched to note starts, else the caller's string, else 라.
    file_lyrics = lyric_by_track[melody["idx"]]
    notes = []
    if file_lyrics:
        li = 0
        for s in seq:
            syl = "-"
            while li < len(file_lyrics) and file_lyrics[li][0] <= s["tick"] + tpb // 8:
                syl = file_lyrics[li][1]
                li += 1
            notes.append({"syl": syl if notes or syl != "-" else "라",
                          "note": s["note"], "beats": s["beats"]})
    else:
        syls = [ch for ch in str(lyrics or "") if not ch.isspace()]
        for i, s in enumerate(seq):
            syl = syls[i] if i < len(syls) else ("-" if syls else "라")
            notes.append({"syl": syl, "note": s["note"], "beats": s["beats"]})

    # Chords off the lowest track (if any candidate besides the melody).
    chords = []
    others = [c for c in cands if c["idx"] != melody["idx"]]
    if others:
        bass = min(others, key=lambda c: c["mean"])["ev"]
        total_beats = sum(n["beats"] for n in notes)
        w = 0.0
        while w < total_beats:
            lo, hi = w * tpb, (w + 2) * tpb
            window = [n for n, s, d in bass if lo <= s < hi]
            if window:
                chords.append({"root": _midi_name(min(window)), "beats": 2})
            elif chords:
                chords[-1]["beats"] += 2
            w += 2

    score = {"bpm": bpm, "notes": notes}
    if chords:
        score["chords"] = chords
    return score, None


def score_library():
    """The module's own score shelf — the `scores` files-setting, as [{url, name, alias}]."""
    try:
        rows = json.loads(os.environ.get("MODULE_SCORES") or "[]")
        return [r for r in rows if isinstance(r, dict) and r.get("url")]
    except (ValueError, TypeError):
        return []


def _media_to_path(raw):
    """Media URL (/user/media/<slug>.<ext>) or workspace path -> readable relative path."""
    path = raw
    if "://" in path:
        path = "/" + path.split("://", 1)[1].split("/", 1)[1] if "/" in path.split("://", 1)[1] else ""
    path = path.lstrip("/")
    if ".." in path.split("/"):
        return None, f"scoreMediaPath escapes the workspace: {raw}"
    if not os.path.isfile(path):
        return None, f"score file not found: {path} (workspace-relative)"
    return path, None


def _norm_name(s):
    """Alias comparison key — case and spacing are not identity ("캐논 변주곡" == "캐논변주곡")."""
    return "".join(str(s or "").split()).casefold()


def action_scores(inp=None):
    """The shelf as a first-class action — the model LOOKS UP what is shelved instead of
    guessing an alias and fishing the list out of an error (사용자: 낚시는 계단이 아니다).
    `query` filters by normalized substring (alias or filename); omitted = the whole shelf."""
    shelf = score_library()
    q = _norm_name((inp or {}).get("query"))
    rows = [{"alias": r.get("alias") or r.get("name"), "name": r.get("name")} for r in shelf
            if not q or q in _norm_name(r.get("alias")) or q in _norm_name(r.get("name"))]
    return {"success": True, "data": {
        "count": len(rows), "scores": rows,
        "note": "pass one alias as render's scoreMediaPath to play it — style/band/drumPattern "
                "may ride in the SAME render call to re-instrument the piece (no need to "
                "compose a score for an existing song)"}}


def resolve_score_media(inp):
    """scoreMediaPath input = a media URL, a workspace path, or the ALIAS of a shelved score.

    Matching ignores case and spacing, and tries alias, filename and filename-without-extension.
    Misses point to the `scores` action rather than dumping the shelf into the error.
    """
    raw = str(inp.get("scoreMediaPath") or "").strip()
    shelf = score_library()
    if raw:
        wanted = _norm_name(raw)
        for row in shelf:
            name = str(row.get("name") or "")
            stem = name.rsplit(".", 1)[0]
            if wanted in (_norm_name(row.get("alias")), _norm_name(name), _norm_name(stem)):
                return _media_to_path(str(row["url"]))
        if "/" not in raw and "." not in raw and shelf:
            return None, (f"악보 별칭 {raw!r} 이 보관함에 없습니다 — "
                          f"action 'scores' 로 목록({len(shelf)}개)을 확인하세요")
        return _media_to_path(raw)
    if shelf:
        # Same procedure at every shelf size (사용자: "몇 개 되든 안 되든 동일 쿼리 로직") —
        # no single-item autopick: look the shelf up, pass the alias.
        return None, (f"scoreMediaPath 가 없습니다 — action 'scores' 로 보관함({len(shelf)}개)을 "
                      "확인하고 별칭을 주세요")
    return None, None


# ── file IO + top-level actions ────────────────────────────────────────────────────────────────


def _slug_name(raw):
    """A filename stem from what the user actually called the piece — alias, file, whatever.
    Hangul survives (it is a name); path junk and extensions do not."""
    base = str(raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    if "." in base:
        head, ext = base.rsplit(".", 1)
        if len(ext) <= 4 and head:
            base = head
    out = "".join(ch if (ch.isalnum() or ch in "-_") else "-" for ch in base)
    return "-".join(t for t in out.split("-") if t)[:40]


def _movement_bounds(n_samples, spb, meter):
    """[(start, end)] sample slices, bar-aligned, each expected to fit the media door."""
    cap = 48 * 1024 * 1024
    est = int(n_samples * 4 * 0.65)  # conservative flac size guess
    k = max(1, -(-est // cap))
    if k == 1:
        return [(0, n_samples)]
    bar = max(1, int(SR * spb * meter))
    bars_total = -(-n_samples // bar)
    per = max(1, -(-bars_total // k))
    bounds, i = [], 0
    while i < n_samples:
        j = min(n_samples, i + per * bar)
        bounds.append((i, j))
        i = j
    return bounds


def _out_path_for(requested, score, engine_used, n_samples, base=None):
    """Media import caps a file at ~50MB, and a full piece as 16-bit wav crosses it (실측:
    353s = 62MB, import refused with mediaExportError, and the model's rational recovery was
    a 42-second piece). FLAC is the same audio at ~60% under the cap — so length changes the
    CONTAINER, never the length. The engine also salts the default name: a builtin re-render
    of the same score must not overwrite the sf2 take (실측: it did, and the sf2 take died)."""
    big = n_samples * 4 > 48 * 1024 * 1024
    path = str(requested or "").strip()
    if not path:
        h = hashlib.sha1((json.dumps(score, sort_keys=True) + ":" + engine_used)
                         .encode()).hexdigest()[:6]
        style = str((score or {}).get("style") or "").strip().lower()
        stem = "-".join(x for x in (_slug_name(base) or "sing",
                                    style if style and style != "none" else "", h) if x)
        return f"data/sing/{stem}." + ("flac" if big else "wav")
    if big and path.lower().endswith(".wav"):
        return path[:-4] + ".flac"
    return path


def read_wav_mono(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype="float64", always_2d=True)
    x = data.mean(axis=1)
    if sr != SR:
        x = resample_linear(x, SR / sr)
    return x


def write_wav(path, x):
    # soundfile picks the container from the extension — .wav and .flac both PCM_16.
    import soundfile as sf
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    peak = np.max(np.abs(x)) or 1.0
    sf.write(path, (x / peak * 0.95).astype(np.float32), SR, subtype="PCM_16")


def action_render(inp):
    score = inp.get("score")
    parsed_from = None
    if not score:
        # No inline score — the uploaded one (input path or the module's own setting) steps in.
        media_path, err = resolve_score_media(inp)
        if err:
            return {"success": False, "error": err}
        if not media_path:
            return {"success": False,
                    "error": "no score: pass `score`, or `scoreMediaPath` (URL, path, or a shelf "
                             "alias), or upload one in the module settings (악보 보관함)"}
        ext = media_path.rsplit(".", 1)[-1].lower()
        if ext in ("mid", "midi"):
            score, err = midi_to_score(media_path, lyrics=inp.get("lyrics"))
            if err:
                return {"success": False, "error": err}
            # Every feel knob rides the top level too: a shelved MIDI plus new instruments is
            # ONE call. While band lived only inside `score`, composing a fresh score was the
            # only one-call path to "피아노로" — measured: the model did exactly that (turn 31,
            # 48s 자작 while the shelf held the real piece and scores had just listed it).
            for knob in ("style", "band", "drumPattern", "swing", "comp", "bassline"):
                if inp.get(knob) is not None:
                    score[knob] = inp[knob]
            parsed_from = media_path
        else:
            return {"success": False,
                    "error": f"score media must be MIDI for now (.mid/.midi, got .{ext}) — "
                             "hum-to-score is a later slice"}
    spb, events, chords, style, band, feel, err = parse_score(score)
    if err:
        return {"success": False, "error": err}
    # vocal:true with no take yet — ask the framework for one. A declaration, not a call: the
    # framework performs the TTS and runs this action again with vocalPath filled (the old core
    # bridge did this by hand; retiring it removed the last sing vocabulary from core).
    if bool(inp.get("vocal")) and not str(inp.get("vocalPath") or "").strip():
        syls = [ev["syl"] for ev in events if ev["syl"] and ev["syl"] != "-"]
        if not syls:
            return {"success": False,
                    "error": "vocal:true 인데 부를 음절이 없습니다 — notes[].syl 을 채우거나 "
                             "vocal 없이(연주곡) 부르세요"}
        if len(syls) > 64:
            return {"success": False,
                    "error": f"{len(syls)} 음절 — 노래는 64음절(한 절)까지입니다. "
                             "연주곡(vocal 없이)은 제한이 없습니다"}
        return {"success": True, "data": {"_prepare": {
            "service": "tts",
            "text": " ".join(syls),
            "style": "또박또박, 음절 하나하나를 또렷하게, 일정한 속도로 읽어 주세요.",
            "into": "vocalPath",
        }}}
    total_beats = sum(b for ev in events for _, b in ev["segments"])
    chord_beats = sum(c[1] for c in chords)
    total_beats = max(total_beats, chord_beats)
    if feel.get("bars"):
        total_beats = max(total_beats, feel["bars"] * feel["meter"])
    if total_beats <= 0:
        return {"success": False,
                "error": "빈 곡입니다 — notes/chords 를 채우거나, 드럼 솔로면 drumPattern 과 "
                         "bars 를 함께 주세요"}
    arr = build_arrangement(events, chords, style, total_beats, band, feel)
    vocal_path = str(inp.get("vocalPath") or "").strip()
    # The melody doubles the voice when there is one, so it steps aside; with no vocal it IS the
    # tune, and dropping it was why an instrumental render came out as rhythm and bass only.
    if vocal_path:
        arr = [e for e in arr if e["part"] != "melody"]
    engine = str(inp.get("engine") or "").strip().lower()
    if engine not in ("", "auto", "sf2", "builtin"):
        return {"success": False,
                "error": "engine must be sf2 | builtin (omit = auto: sf2 when installed)"}
    engine_used, engine_note, sf2_font = "builtin", None, None
    mix = send = None
    if engine != "builtin":
        binp, font, why = sf2_backend()
        if engine == "sf2" and why:
            return {"success": False, "error": f"engine:sf2 사용 불가 — {why}"}
        if not why:
            stereo, err = render_sf2(arr, spb, binp, font)
            if stereo is None:
                engine_note = f"sf2 렌더 실패 — 내장 신디로 강등: {err}"
            else:
                engine_used, sf2_font = "sf2", os.path.basename(font)
                # The engine's own space is the MIDI default — we add no room of ours on top.
                # (The vocal overlay still sends to add_room below: that voice is OUR sound.)
                mix, send = stereo * 0.45, np.zeros(len(stereo))
    if mix is None:
        mix, send = render_arrangement(arr, spb, total_beats)
        mix, send = mix * 0.45, send * 0.45
    if vocal_path:
        if not os.path.isfile(vocal_path):
            return {"success": False,
                    "error": f"vocalPath 파일이 없습니다: {vocal_path} (workspace 기준 상대 경로)"}
        vocal = render_vocal(read_wav_mono(vocal_path), events, spb)
        n = max(len(mix), len(vocal))
        mix = np.pad(mix, ((0, n - len(mix)), (0, 0)))
        send = np.pad(send, (0, n - len(send)))
        v = np.pad(vocal, (0, n - len(vocal))) * 0.9
        mix[:, 0] += v * 0.707  # the singer stands center stage
        mix[:, 1] += v * 0.707
        send += v * 0.18
    if np.any(send):
        mix = add_room(mix, send)
    out_path = _out_path_for(inp.get("outPath"), score, engine_used, len(mix),
                             base=inp.get("scoreMediaPath"))
    # ── ② movements: even FLAC crosses the ~50MB media door near the 9-10 minute mark. A piece
    # that long ships as several flacs in one _mediaImport array (the door is already plural),
    # cut on bar lines. Lossless and playable everywhere — ogg is free but Safari will not play
    # it, so splitting beats transcoding.
    part_paths = []
    bounds = _movement_bounds(len(mix), spb, feel["meter"])
    if len(bounds) > 1:
        stem0, ext0 = out_path.rsplit(".", 1)
        for i, (a, b) in enumerate(bounds, 1):
            pp = f"{stem0}-{i}of{len(bounds)}.{ext0}"
            write_wav(pp, mix[a:b])
            part_paths.append(pp)
        out_path = part_paths[0]
    else:
        write_wav(out_path, mix)
    # The .mid beside the wav — same arrangement, played by whatever the listener owns. Our one
    # tone generator is the ceiling on the wav; it is not a ceiling on this.
    midi_out = str(inp.get("midiOutPath") or "").strip()
    if not midi_out and inp.get("midiOut"):
        midi_out = out_path.rsplit(".", 1)[0] + ".mid"
    midi_written, midi_note = (None, None)
    if midi_out:
        midi_written, midi_note = write_midi(arr, 60.0 / spb, midi_out)
    data = {
        "outPath": out_path,
        "seconds": round(len(mix) / SR, 2),
        "events": len(events),
        "parts": sorted({e["part"] for e in arr}),
        "style": style,
        "vocal": bool(vocal_path),
        "backend": "pyworld" if (vocal_path and try_pyworld()) else "numpy",
        "engine": engine_used,
    }
    if sf2_font:
        data["soundfont"] = sf2_font
    if engine_note:
        data["engineNote"] = engine_note
    if midi_written:
        data["midiPath"] = midi_written
    if midi_note:
        data["midiNote"] = midi_note
    # Consumption-point note — the channel that actually lands. Both live canon turns composed
    # a fresh score while the user's uploaded MIDI sat on the shelf: the schema said so, the
    # search row said so, and the model read neither at decision time. This arrives WITH the
    # render it may have gotten wrong, in the same turn, while correction is still one call away.
    if not parsed_from and not vocal_path:
        shelf = score_library()
        if shelf:
            data["shelfNote"] = (
                f"NOTE: {len(shelf)} score(s) are shelved in this module's settings. If the user "
                "meant an EXISTING piece (an uploaded MIDI) rather than a new composition, call "
                "action 'scores' and re-render with the alias as scoreMediaPath — the full piece, "
                "not a summary.")
    # The framework carries the products into media storage (data.media, with urls) — the same
    # declared door every module's files leave through. The wav and its .mid are one product in
    # two forms, so they travel as one array.
    stem = os.path.basename(out_path).rsplit(".", 1)[0]
    audio_type = "audio/flac" if out_path.lower().endswith(".flac") else "audio/wav"
    if part_paths:
        imports = [{"path": pp, "contentType": audio_type,
                    "filenameHint": os.path.basename(pp).rsplit(".", 1)[0]} for pp in part_paths]
        data["movements"] = len(part_paths)
    else:
        imports = [{"path": out_path, "contentType": audio_type, "filenameHint": stem}]
    if midi_written:
        imports.append({"path": midi_written, "contentType": "audio/midi", "filenameHint": stem})
    data["_mediaImport"] = imports if len(imports) > 1 else imports[0]
    if parsed_from:
        # The caller composed nothing — show what the MIDI became so the bridge (TTS lyric
        # order) and the user can see and correct the parse.
        data["scoreSource"] = parsed_from
        data["score"] = score
    return {"success": True, "data": data}


def action_selftest():
    checks = []

    def ck(name, want, got, ok):
        checks.append({"name": name, "want": want, "got": got, "ok": bool(ok)})

    ck("A4 is 440", 440.0, note_freq("A4"), abs(note_freq("A4") - 440.0) < 1e-6)
    ck("C4 is middle C", 261.63, round(note_freq("C4"), 2), abs(note_freq("C4") - 261.626) < 0.01)
    ck("sharps and flats meet", note_freq("C#3"), note_freq("Db3"),
       abs(note_freq("C#3") - note_freq("Db3")) < 1e-6)
    ck("garbage note names are refused", None, note_freq("H9x"), note_freq("H9x") is None)

    score = {"bpm": 120, "style": "trot",
             "notes": [{"syl": "가", "note": "C4", "beats": 1},
                       {"syl": "나", "note": "E4", "beats": 1},
                       {"syl": "-", "note": "G4", "beats": 1},
                       {"syl": "다", "note": "C5", "beats": 1}],
             "chords": [{"root": "C3", "beats": 4}]}
    spb, events, chords, style, band, feel, err = parse_score(score)
    ck("score parses", None, err, err is None)
    ck("a '-' note extends the previous syllable (melisma)", 3, len(events), len(events) == 3)
    ck("feel carries the style's defaults", True, feel is not None and feel["meter"] == 4,
       feel is not None and feel["meter"] == 4)

    # The whole render, not just the pieces: unpacking `chords` changed shape and every caller had
    # to follow, but the selftest only reached `build_arrangement` — so `action_render` broke where
    # nothing was looking. A check that exercises the parts and not the path is not a net.
    demo = action_render({"action": "render", "score": score, "midiOut": True,
                          "outPath": "data/sing/selftest-render.wav"})
    ck("a full render succeeds end to end", True, demo.get("error") or True,
       bool(demo.get("success")))
    for p in ("data/sing/selftest-render.wav", "data/sing/selftest-render.mid"):
        if os.path.exists(p):
            os.remove(p)

    arr = build_arrangement(events, chords, style, 4)
    parts = sorted({e["part"] for e in arr})
    ck("the arrangement plays a tune, not just a rhythm section",
       ["bass", "chord", "drum", "melody"], parts,
       parts == ["bass", "chord", "drum", "melody"])
    # A chord written as one root has to reach the ear as a chord — comping repeats the strokes,
    # so count distinct pitches, not events.
    triad = sorted({e["pitch"] for e in arr if e["part"] == "chord"})
    ck("one written root becomes a triad", 3, len(triad), len(triad) == 3)
    ck("quality shapes the chord: a minor third where the score says so", [0, 3, 7],
       [p - 60 for p in chord_voicing(60, "m")],
       [p - 60 for p in chord_voicing(60, "m")] == [0, 3, 7])
    ck("an unknown quality plays major rather than refusing", [0, 4, 7],
       [p - 60 for p in chord_voicing(60, "weird9")],
       [p - 60 for p in chord_voicing(60, "weird9")] == [0, 4, 7])
    # Brightness falling over the note is what separates an instrument from a beep — measured on
    # a DECAYING patch (piano). The trot lead moved to the sustained family (vibrato horn), so it
    # no longer proves this mechanism; the mechanism itself is unchanged.
    tone = synth_note(220.0, 0.8, "piano")
    head = float(np.mean(np.abs(np.diff(tone[: SR // 8]))))
    tail = float(np.mean(np.abs(np.diff(tone[-(SR // 8):]))))
    ck("the synth note darkens as it decays", True, f"head={head:.4f} tail={tail:.4f}",
       head > tail * 1.5)
    ck("bass sits an octave under the written root", midi_number("C2"),
       next(e["pitch"] for e in arr if e["part"] == "bass"),
       next(e["pitch"] for e in arr if e["part"] == "bass") == midi_number("C2"))

    audio, room = render_arrangement(arr, spb, 4)
    ck("accompaniment covers the bar", int(SR * spb * 4), len(audio),
       abs(len(audio) - SR * spb * 4) <= SR)
    ck("accompaniment is not silence and not NaN", True,
       bool(np.max(np.abs(audio)) > 0.01), np.max(np.abs(audio)) > 0.01 and not np.any(np.isnan(audio)))
    ck("the band plays on a stereo stage", (len(audio), 2), audio.shape,
       audio.ndim == 2 and audio.shape[1] == 2)
    ck("panning actually separates the channels", True,
       not np.allclose(audio[:, 0], audio[:, 1]), not np.allclose(audio[:, 0], audio[:, 1]))
    wet = add_room(audio.copy(), room)
    ck("the room adds energy the dry mix did not have", True,
       float(np.sum(np.abs(wet))) > float(np.sum(np.abs(audio))),
       float(np.sum(np.abs(wet))) > float(np.sum(np.abs(audio))))

    # The arrangement moves now: trot comping strikes offbeats (and swings them late), the
    # bass alternates root and fifth, and voice-leading keeps adjacent chords under one hand.
    ck("trot comping is strokes, not one held pad", True,
       sum(1 for e in arr if e["part"] == "chord") > 3,
       sum(1 for e in arr if e["part"] == "chord") > 3)
    swung = [e for e in arr if e["part"] == "drum" and abs(e["beat"] % 1.0 - 0.55) < 0.01]
    ck("trot offbeats lean late (swing)", True, len(swung) > 0, len(swung) > 0)
    two = build_arrangement(events, [(note_freq("C3"), 4.0, ""), (note_freq("G3"), 4.0, "")],
                            "ballad", 8)
    c1 = [e["pitch"] for e in two if e["part"] == "chord" and e["beat"] < 4]
    c2 = [e["pitch"] for e in two if e["part"] == "chord" and e["beat"] >= 4]
    drift = abs(sum(set(c2)) / len(set(c2)) - sum(set(c1)) / len(set(c1)))
    ck("voice-leading keeps the next chord under the same hand", True,
       round(drift, 1) <= 4.0, drift <= 4.0)
    waltz = build_arrangement(events, [(note_freq("C3"), 3.0, "")] * 2, "ballad", 6,
                              None, {"meter": 3, "swing": 0.0, "comp": None, "bass": None})
    kicks = [e["beat"] for e in waltz if e["part"] == "drum" and e["drum"] == "kick"]
    ck("3/4 bars advance by three beats", [0.0, 3.0], kicks, kicks == [0.0, 3.0])

    # A genre is a row — so every row must be complete: groove ∧ feel ∧ band, one key set.
    ck("every style has a feel and a band (no half-declared genre)", True,
       set(DRUM_PATTERNS) == set(STYLE_FEEL) == set(STYLE_BAND),
       set(DRUM_PATTERNS) == set(STYLE_FEEL) == set(STYLE_BAND))
    edm = parse_score({"bpm": 124, "style": "edm",
                       "notes": [{"syl": "라", "note": "C4", "beats": 4}]})
    ck("aliases resolve (edm plays the dance row)", "dance", edm[3], edm[3] == "dance")
    plain = parse_score({"bpm": 100, "notes": [{"syl": "라", "note": "C4", "beats": 1}]})
    ck("no style asked = none (plain), not a trot by surprise", "none", plain[3],
       plain[3] == "none")
    floor = build_arrangement(events, [(note_freq("C3"), 4.0, "")], "dance", 4)
    dance_kicks = [e["beat"] for e in floor if e["part"] == "drum" and e["drum"] == "kick"]
    ck("dance is four-on-the-floor", [0.0, 1.0, 2.0, 3.0], dance_kicks,
       dance_kicks == [0.0, 1.0, 2.0, 3.0])
    nostyle = parse_score({"bpm": 120, "style": "폴카아",
                           "notes": [{"syl": "라", "note": "C4", "beats": 1}]})
    ck("an unknown style is refused WITH the list", True, (nostyle[-1] or "")[:50],
       bool(nostyle[-1]) and "dance" in (nostyle[-1] or ""))
    # The walking bass knows the chord: C major walks C-E-G, and steps on the next chord's
    # fifth to get there — the jazz floor, quality-aware.
    walk = _bass_line("walk", 48, 4.0, 55, 4, [0, 4, 7])
    ck("the bass walks root-third-fifth into the next chord's fifth",
       [36, 40, 43, 38], [w[2] for w in walk], [w[2] for w in walk] == [36, 40, 43, 38])
    # Articulation follows the style: the same written note sounds clipped in funk and sung
    # through in a ballad — length, not just velocity.
    fk = build_arrangement(events, chords, "funk", 4)
    bl = build_arrangement(events, chords, "ballad", 4)
    gf = next(e["gate"] for e in fk if e["part"] == "melody")
    gb = next(e["gate"] for e in bl if e["part"] == "melody")
    ck("funk clips where a ballad sings through (gate)", True,
       f"funk={gf} ballad={gb}", gf < 0.7 <= gb)

    # vocal:true with no take = a _prepare declaration, not a render — the framework's half
    # of the contract starts from exactly this envelope.
    prep = action_render({"action": "render", "vocal": True,
                          "score": {"bpm": 120, "notes": [
                              {"syl": "가", "note": "C4", "beats": 1},
                              {"syl": "나", "note": "E4", "beats": 1}]}})
    decl = (prep.get("data") or {}).get("_prepare") or {}
    ck("vocal without a take declares _prepare (service/text/into)", True,
       {k: decl.get(k) for k in ("service", "into")},
       decl.get("service") == "tts" and decl.get("into") == "vocalPath"
       and decl.get("text") == "가 나")

    # The score shelf resolves by alias, and its errors carry the shelf — both directions.
    os.environ["MODULE_SCORES"] = json.dumps([
        {"url": "/user/media/a.mid", "name": "canon.mid", "alias": "캐논"},
        {"url": "/user/media/b.mid", "name": "alhambra.mid", "alias": "알함브라"}])
    try:
        miss = resolve_score_media({"scoreMediaPath": "월광"})
        ck("a mistyped score alias points to the scores action", True, (miss[1] or "")[:60],
           bool(miss[1]) and "scores" in (miss[1] or ""))
        ambig = resolve_score_media({})
        ck("several shelved scores and no name points to the scores action", True,
           (ambig[1] or "")[:60], bool(ambig[1]) and "scores" in (ambig[1] or ""))
        listed = action_scores()
        ck("the shelf is a first-class action (scores lists aliases)", 2,
           listed["data"]["count"], listed["data"]["count"] == 2
           and listed["data"]["scores"][0]["alias"] == "캐논")
        spaced = resolve_score_media({"scoreMediaPath": "캐 논"})
        ck("alias matching ignores spacing and case", True,
           spaced[1] or "matched", spaced[1] is None or "찾" not in (spaced[1] or ""))
    finally:
        del os.environ["MODULE_SCORES"]

    # The sf2 engine is FOUND, not configured — and when a half is missing it names the apt
    # package instead of failing mute (제1장 ③: 그 순간의 응답이 다음 한 수를 말한다).
    bogus = action_render({"action": "render", "score": score, "engine": "bogus"})
    ck("an unknown engine is refused with the choices", True, (bogus.get("error") or "")[:40],
       not bogus.get("success") and "engine" in (bogus.get("error") or ""))
    e_bin, e_font, e_why = sf2_backend()
    ck("sf2_backend answers ready-or-next-move", True,
       e_why or f"ready: {os.path.basename(e_font)}", bool(e_why) or bool(e_bin and e_font))
    if e_why:
        forced = action_render({"action": "render", "score": score, "engine": "sf2"})
        ck("engine:sf2 forced while unavailable names the missing half", True,
           (forced.get("error") or "")[:60],
           not forced.get("success") and e_why[:12] in (forced.get("error") or ""))

    # The whole GM world: any GM name fronts a band (native on sf2, nearest-family on numpy),
    # the kit is the full percussion map, and a score can write its own bar loop.
    s2 = dict(score); s2["band"] = {"melody": "cello"}
    _, ev2, ch2, _, bd2, fl2, err2 = parse_score(s2)
    ck("a GM name is a legal band member", None, err2, err2 is None)
    arr2 = build_arrangement(ev2, ch2, "trot", 4, bd2, fl2)
    mel2 = [e for e in arr2 if e["part"] == "melody"][0]
    ck("a GM member carries its real program to the .mid", 42, mel2["program"],
       mel2["program"] == 42)
    ck("...and a patch the numpy engine can play", True, mel2["patch"], mel2["patch"] in PATCHES)
    s3 = dict(score); s3["band"] = ["piano", "drums"]
    _, _, _, _, bd3, _, err3 = parse_score(s3)
    ck("a flat band list is a dialect, not an error (drums word skipped)",
       {"melody": "piano"}, bd3, err3 is None and bd3 == {"melody": "piano"})
    s4 = dict(score); s4["band"] = {"melody": "kazoo9000"}
    err4 = parse_score(s4)[6]
    ck("an unknown instrument still refuses with both libraries", True, (err4 or "")[:40],
       bool(err4) and "GM" in err4)
    ck("the kit is the whole GM percussion map", 47, len(DRUM_NOTE),
       len(DRUM_NOTE) == 47 and set(DRUM_NOTE.values()) == set(range(35, 82)))
    bank = _kit_bank()
    ck("every kit name has a builtin sample", 0,
       sum(1 for k in DRUM_NOTE if k not in bank or not len(bank[k])),
       all(k in bank and len(bank[k]) for k in DRUM_NOTE))
    s5 = dict(score); s5["drumPattern"] = [["conga_open", 0.0, 0.8], ["clap", 1.0]]
    _, ev5, ch5, st5, bd5, fl5, err5 = parse_score(s5)
    arr5 = build_arrangement(ev5, ch5, st5, 4, bd5, fl5) if err5 is None else []
    ck("a score writes its own bar loop (drumPattern)", True,
       err5 or sorted({e["drum"] for e in arr5 if e["part"] == "drum"} - {"crash"}),
       err5 is None and any(e.get("drum") == "conga_open" for e in arr5))
    s6 = dict(score); s6["drumPattern"] = [["기관총", 0.0]]
    err6 = parse_score(s6)[6]
    ck("an unknown drum refuses with the whole kit", True, (err6 or "")[:30],
       bool(err6) and "conga_open" in (err6 or ""))
    arr8 = build_arrangement(ev2, ch2 * 8, "pop", 32, None, {"meter": 4})
    rolls = [e for e in arr8 if e["part"] == "drum" and e["drum"] == "snare"
             and 28 <= e["beat"] < 32 and abs(e["beat"] * 8 - round(e["beat"] * 8)) < 1e-6
             and abs(e["beat"] * 4 - round(e["beat"] * 4)) > 1e-6]
    ck("every 8th bar rolls the snare in 32nds (다다다다)", True, len(rolls), len(rolls) >= 4)
    ck("jazz rides on a ride now, not an open hat", "ride", DRUM_PATTERNS["jazz"][0][0],
       DRUM_PATTERNS["jazz"][0][0] == "ride")
    arr9 = build_arrangement(ev2, ch2 * 8, "ballad", 32, None, {"meter": 4})
    soft = [e for e in arr9 if e["part"] == "drum" and e["drum"] == "snare"
            and abs(e["beat"] * 4 - round(e["beat"] * 4)) > 1e-6]
    ck("a ballad keeps its soft fill — no machine-gun roll", 0, len(soft), not soft)
    off_style = parse_score(dict(score, style="orchestra"))[3]
    ck("orchestra answers to classic", "classic", off_style, off_style == "classic")
    s7 = dict(score); s7["band"] = {"melody": "Acoustic Grand Piano"}
    err7 = parse_score(s7)[6]
    ck("the spec's own instrument spelling is absorbed", None, err7, err7 is None)
    ck("contrabass degrades to a bass, not a violin", ("bass", 43),
       resolve_instrument("contrabass"), resolve_instrument("contrabass") == ("bass", 43))
    drummed = {k for k, v in DRUM_PATTERNS.items() if v}
    ck("every drummed style owns its fill", sorted(drummed), sorted(DRUM_FILLS),
       set(DRUM_FILLS) == drummed)
    slow = build_arrangement(ev2, ch2 * 8, "pop", 32, None, {"meter": 4, "bpm": 70})
    slow_rolls = [e for e in slow if e["part"] == "drum" and e["drum"] == "snare"
                  and abs(e["beat"] * 8 - round(e["beat"] * 8)) < 1e-6
                  and abs(e["beat"] * 4 - round(e["beat"] * 4)) > 1e-6]
    ck("a slow piece keeps its soft fill even in a rolling genre", 0, len(slow_rolls),
       not slow_rolls)
    solo = action_render({"action": "render", "outPath": "data/sing/selftest-solo.wav",
                          "score": {"bpm": 120, "bars": 2, "style": "rock",
                                    "drumPattern": [["kick", 0.0, 0.9], ["snare", 1.0],
                                                    ["conga_open", 2.5, 0.6]]}})
    ck("a drum solo renders from drumPattern + bars alone", ["drum"],
       (solo.get("data") or {}).get("parts"),
       solo.get("success") and (solo.get("data") or {}).get("parts") == ["drum"])
    if os.path.exists("data/sing/selftest-solo.wav"):
        os.remove("data/sing/selftest-solo.wav")
    small = _out_path_for(None, score, "builtin", SR * 60)
    huge = _out_path_for(None, score, "builtin", SR * 400)
    ck("an hour under the cap stays wav, a full piece goes flac", (".wav", ".flac"),
       (small[-4:], huge[-5:]), small.endswith(".wav") and huge.endswith(".flac"))
    ck("the engine salts the default name (no cross-engine overwrite)", True,
       _out_path_for(None, score, "sf2", SR * 60) != small,
       _out_path_for(None, score, "sf2", SR * 60) != small)
    forced = _out_path_for("data/sing/x.wav", score, "sf2", SR * 400)
    ck("an explicit .wav over the cap is re-containered, same stem", "data/sing/x.flac",
       forced, forced == "data/sing/x.flac")
    named = _out_path_for(None, dict(score, style="pop"), "sf2", SR * 60, base="캐논 변주곡.mid")
    ck("the default filename reads as the piece, not a hash", True, named,
       "캐논-변주곡" in named and "-pop-" in named and named.endswith(".wav"))
    ck("a short piece is one movement", 1, len(_movement_bounds(SR * 60, 0.5, 4)),
       len(_movement_bounds(SR * 60, 0.5, 4)) == 1)
    mb = _movement_bounds(SR * 60 * 15, 0.5, 4)
    bar_n = int(SR * 0.5 * 4)
    ck("a 15-minute piece ships as bar-aligned movements", True,
       [len(mb), mb[0][1] % bar_n], len(mb) >= 2 and mb[0][0] == 0
       and mb[-1][1] == SR * 60 * 15 and all(a % bar_n == 0 for a, _ in mb)
       and all(mb[i][1] == mb[i + 1][0] for i in range(len(mb) - 1)))
    s8 = dict(score); s8["drumPattern"] = {"kick": [0, 2], "snare": 1}
    fl8 = parse_score(s8)[5]
    ck("a name->beats map is a drumPattern dialect", 3,
       len((fl8 or {}).get("drums") or []), fl8 is not None and len(fl8["drums"]) == 3)
    s9 = dict(score)
    s9["drumPattern"] = [{"name": "kick", "at": 0, "velocity": 0.9}, ["snare", [1, 3]]]
    fl9 = parse_score(s9)[5]
    ck("dict-key aliases and beat lists fan out", 3,
       len((fl9 or {}).get("drums") or []), fl9 is not None and len(fl9["drums"]) == 3)
    err10 = parse_score(dict(score, drumPattern=[["kick"]]))[6]
    ck("a short row is refused WITH an example and the received row", True,
       (err10 or "")[:50], bool(err10) and "예:" in err10 and "받은 행" in err10)

    # The plucked string plays IN TUNE — the integer-period detune (up to ~10 cents up high)
    # is exactly what a listener calls 시다, and a tremolo holds the error against the chords.
    tone = synth_note(554.37, 1.0, "cguitar")  # C#5 — the worst integer-period offender
    spec = np.abs(np.fft.rfft(tone * np.hanning(len(tone)), 8 * len(tone)))
    lo, hi = int(400 * 8 * len(tone) / SR), int(700 * 8 * len(tone) / SR)
    peak_hz = (lo + int(np.argmax(spec[lo:hi]))) * SR / (8 * len(tone))
    ck("the KS string lands within 1.5Hz of the written pitch", True,
       f"peak={peak_hz:.2f}Hz want=554.37Hz", abs(peak_hz - 554.37) < 1.5)
    # And EVERY instrument's center lands within 8 cents — a one-sided detune once dragged
    # organ/synthlead +15 cents sharp, which no other net could see (valid values, no NaN).
    # Center = energy centroid of the band around the fundamental, NOT the FFT argmax: a
    # detuned pair has two lobes and the ear hears their middle, which argmax never lands on.
    off_pitch = []
    for name in PATCHES:
        t220 = synth_note(220.0, 0.8, name)
        sp = np.abs(np.fft.rfft(t220 * np.hanning(len(t220)), 8 * len(t220))) ** 2
        res = SR / (8 * len(t220))
        a, b = int(200.0 / res), int(242.0 / res)  # ±~160 cents around 220
        band = sp[a:b]
        if float(band.sum()) <= 0:
            off_pitch.append(f"{name}:silent")
            continue
        centroid = float((np.arange(a, b) * band).sum() / band.sum()) * res
        cents = 1200.0 * math.log2(centroid / 220.0)
        if abs(cents) >= 8.0:
            off_pitch.append(f"{name}:{cents:+.1f}c")
    ck("every instrument centers within 8 cents of the written pitch", [], off_pitch,
       not off_pitch)
    # And the bass pickup is the next chord's fifth, never a chromatic neighbour.
    walk = _bass_line("hold", 62, 4.0, 57, 4)  # D -> A: the Canon join that exposed it
    ck("the walk into A major is E (its fifth), not B♭", 52, walk[-1][2], walk[-1][2] == 52)

    # The kit is a kit, not a lone kick: 4 bars in, the 4th bar rolls down the toms (두구두구)
    # and every 4-bar group opens on a crash (쨍).
    arr16 = build_arrangement(events, [(note_freq("C3"), 4.0, "")] * 4, "trot", 16)
    dr = [e["drum"] for e in arr16 if e["part"] == "drum"]
    ck("every 4th bar rolls down the toms", True, any(d.startswith("tom") for d in dr),
       any(d.startswith("tom") for d in dr))
    ck("a 4-bar group opens on a crash", True, "crash" in dr, "crash" in dr)
    ck("drum hits carry velocity", True,
       all("vel" in e for e in arr16 if e["part"] == "drum"),
       all("vel" in e for e in arr16 if e["part"] == "drum"))

    # The band changes with the style, and the score can overrule it per part.
    ballad = build_arrangement(events, chords, "ballad", 4)
    ck("the ballad band is not the trot band (piano fronts it)", 0,
       next(e["program"] for e in ballad if e["part"] == "melody"),
       next(e["program"] for e in ballad if e["part"] == "melody") == 0)
    egtr = build_arrangement(events, chords, "trot", 4, {"melody": "eguitar"})
    ck("score.band puts an electric guitar in front of a trot", 27,
       next(e["program"] for e in egtr if e["part"] == "melody"),
       next(e["program"] for e in egtr if e["part"] == "melody") == 27)
    bad = parse_score({"bpm": 120, "notes": [{"syl": "가", "note": "C4", "beats": 1}],
                       "band": {"melody": "kazoo"}})
    ck("an unknown instrument is refused WITH the library in the message", True,
       (bad[-1] or "")[:60], bool(bad[-1]) and "aguitar" in (bad[-1] or ""))

    # Every instrument in the library renders sound, not NaN — the KS string and the vibrato
    # path included. One sweep so a new patch cannot ship silent.
    quiet = [name for name in PATCHES
             if not (lambda s: float(np.max(np.abs(s))) > 0.01 and not np.any(np.isnan(s)))
             (synth_note(220.0, 0.5, name))]
    ck("every instrument in the library makes sound (no NaN, no silence)", [], quiet, not quiet)

    # The .mid is the point of the arrangement layer — a missing `mido` degrades, never fails.
    mid_path = os.path.join("data", "sing", "selftest.mid")
    written, note = write_midi(arr, 60.0 / spb, mid_path)
    ck("midi written (or cleanly skipped when mido is absent)", True,
       f"{written or note}", bool(written) or bool(note))
    if written:
        ck("midi file is non-empty", True, os.path.getsize(written) > 0,
           os.path.getsize(written) > 0)
        os.remove(written)

    t = np.arange(int(SR * 0.4)) / SR
    tone = np.sin(2 * np.pi * 220.0 * t)
    f0 = detect_f0(tone)
    ck("autocorrelation hears 220Hz as 220Hz", 220, round(f0 or 0),
       f0 is not None and abs(f0 - 220) < 11)
    ck("silence is not given a pitch", None, detect_f0(np.zeros(SR // 2)),
       detect_f0(np.zeros(SR // 2)) is None)

    target_len = int(SR * 0.5)
    up = retune_syllable_numpy(tone, 330.0, target_len)
    f0_up = detect_f0(up)
    ck("retune moves 220 to 330", 330, round(f0_up or 0),
       f0_up is not None and abs(f0_up - 330) < 20)
    ck("retune lands on the beat's exact length", target_len, len(up), len(up) == target_len)

    vocal = np.concatenate([np.sin(2 * np.pi * 180.0 * np.arange(int(SR * 0.3)) / SR)] * 3)
    sung = render_vocal(vocal, events, spb)
    want_len = int(SR * spb * 4)
    ck("a sung take covers every note of the score", want_len, len(sung),
       abs(len(sung) - want_len) <= SR // 10)

    # MIDI parser — build a two-track file in memory and read it back as a score.
    try:
        import mido
        # charset='cp949' writes the lyrics as the bytes a Korean karaoke MIDI really carries;
        # reading back with mido's latin-1 default then exercises _fix_lyric_text for real.
        mf = mido.MidiFile(ticks_per_beat=480, charset="cp949")
        mel = mido.MidiTrack()
        mel.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(100), time=0))
        for i, (n, syl) in enumerate(zip((60, 64, 67, 72, 67, 64, 60, 64), "가나다라마바사아")):
            mel.append(mido.MetaMessage("lyrics", text=syl, time=0))
            mel.append(mido.Message("note_on", note=n, velocity=80, time=0))
            mel.append(mido.Message("note_off", note=n, velocity=0, time=480))
        mf.tracks.append(mel)
        bass = mido.MidiTrack()
        for n in (36, 43, 36, 43, 36, 43, 36, 43):  # >= 8 notes — the candidate floor
            bass.append(mido.Message("note_on", note=n, velocity=80, time=0))
            bass.append(mido.Message("note_off", note=n, velocity=0, time=480))
        mf.tracks.append(bass)
        tmp = "data/sing/selftest.mid"
        os.makedirs("data/sing", exist_ok=True)
        mf.save(tmp)
        parsed, perr = midi_to_score(tmp)
        os.remove(tmp)
        ck("midi parses to a score", None, perr, perr is None)
        if parsed:
            ck("midi melody keeps its 8 notes", 8, len(parsed["notes"]), len(parsed["notes"]) == 8)
            ck("midi lyric events become syllables", "가", parsed["notes"][0]["syl"],
               parsed["notes"][0]["syl"] == "가")
            ck("midi tempo survives", 100.0, parsed["bpm"], abs(parsed["bpm"] - 100.0) < 0.5)
            ck("bass track becomes chords", True, bool(parsed.get("chords")),
               bool(parsed.get("chords")))
    except ImportError:
        ck("midi parser (mido not installed — skipped)", "mido", None, True)

    failed = [c for c in checks if not c["ok"]]
    return {"success": not failed, "data": {"checks": checks, "total": len(checks),
                                            "failed": len(failed),
                                            "pyworld": try_pyworld() is not None}}


def main():
    # Bytes, decoded as UTF-8 explicitly — the locale default turns Korean into lone
    # surrogates on some hosts (measured on Windows), and the envelope is UTF-8 by contract.
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        envelope = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        sys.stdout.buffer.write((json.dumps({"success": False, "error": f"input JSON: {e}"})).encode("utf-8"))
        return
    inp = envelope.get("data") or envelope
    action = str(inp.get("action") or "").strip()
    if action == "selftest":
        out = action_selftest()
    elif action == "render":
        out = action_render(inp)
    elif action == "scores":
        out = action_scores(inp)
    else:
        out = {"success": False,
               "error": f"unknown action {action!r} — one of: render, scores, selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts,
    # and the envelope is UTF-8 by contract on both ends.
    sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False)).encode("utf-8"))


if __name__ == "__main__":
    main()
