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
import struct
import sys

import numpy as np

# 24000 cut everything above 12 kHz — cymbals, attack transients and the top of a synth patch all
# live up there, and the patches below are tuned by ear. Doubling costs render time and file size,
# both of which are a spike per render rather than anything resident.
SR = 48000  # everything resampled here on load. 48k is Opus's ONLY supported rate (libsndfile
# refuses 44.1k outright), fluidsynth's own default, and what every browser decodes to anyway —
# so the render, the engine and the container finally agree on one clock.

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
    pending_gap = 0.0
    for n in notes:
        if not isinstance(n, dict):
            return None, None, None, None, None, None, "notes 항목이 객체가 아닙니다"
        beats = float(n.get("beats") or 1)
        if n.get("rest") or (n.get("note") is None and not str(n.get("syl") or "").strip()):
            # Silence carried as a gap on the note that follows, so `events` stays what it has
            # always been — one entry per SUNG syllable — and every consumer that counts
            # syllables (the vocal take, the .lrc) keeps counting the same things.
            if beats <= 0 or beats > 256:
                return None, None, None, None, None, None, f"rest beats {beats} 가 이상합니다"
            pending_gap += beats
            continue
        freq = note_freq(n.get("note"))
        if freq is None:
            return None, None, None, None, None, None, f"음이름을 읽을 수 없습니다: {n.get('note')!r}"
        if beats <= 0 or beats > 64:
            return None, None, None, None, None, None, f"beats {beats} 가 이상합니다 (0 < beats <= 64)"
        syl = str(n.get("syl") or "").strip()
        vel = n.get("vel")
        if vel is not None:
            try:
                vel = max(0.05, min(1.0, float(vel)))
            except (TypeError, ValueError):
                return None, None, None, None, None, None, "notes[].vel 은 0~1 숫자입니다"
        if syl == "-" and events:
            events[-1]["segments"].append((freq, beats))
            events[-1]["vels"].append(vel)
        else:
            events.append({"syl": syl, "segments": [(freq, beats)], "vels": [vel],
                           "gap": pending_gap})
            pending_gap = 0.0
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
    doubles = None
    if isinstance(raw_band, dict) and "doubles" in raw_band:
        rows = raw_band.pop("doubles")
        if not isinstance(rows, list):
            return None, None, None, None, None, None,                 'band.doubles 는 [{"part","instrument","octave"(-2~2),"vel"?}, …] 목록입니다'
        doubles = []
        for row in rows:
            if isinstance(row, (list, tuple)):
                row = {"part": row[0] if len(row) > 0 else None,
                       "instrument": row[1] if len(row) > 1 else None,
                       "octave": row[2] if len(row) > 2 else 0}
            if not isinstance(row, dict):
                return None, None, None, None, None, None,                     "band.doubles 행은 객체 또는 [파트, 악기, 옥타브] 입니다"
            dpart = str(row.get("part") or "melody").strip().lower()
            if dpart not in ("melody", "chord", "bass"):
                return None, None, None, None, None, None,                     f"doubles 의 파트 {dpart!r} 를 모릅니다 — melody | chord | bass"
            inst = str(row.get("instrument") or row.get("inst") or "").strip().lower()
            if resolve_instrument(inst) is None:
                return None, None, None, None, None, None,                     f"악기 {inst!r} 가 라이브러리에 없습니다 — 모듈 악기: {', '.join(sorted(PATCHES))} / "                     f"GM(사운드폰트): {', '.join(sorted(GM_NAMES))}"
            try:
                octv = int(row.get("octave") or 0)
            except (TypeError, ValueError):
                return None, None, None, None, None, None, "doubles 의 octave 는 -2~2 정수입니다"
            if not (-2 <= octv <= 2):
                return None, None, None, None, None, None, "doubles 의 octave 는 -2~2 정수입니다"
            try:
                dvel = max(0.1, min(1.0, float(row.get("vel") or 0.85)))
            except (TypeError, ValueError):
                return None, None, None, None, None, None, "doubles 의 vel 은 0~1 숫자입니다"
            doubles.append((dpart, inst, octv, dvel))
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
        num = m.split("/", 1)[0].strip() if "/" in m else m
        raw_meter = int(num) if num.isdigit() else None
        if raw_meter is None:
            return None, None, None, None, None, None,                 f"meter {m!r} 를 모릅니다 — 숫자(박수) 또는 \"5/4\"·\"6/8\" 표기(분자를 읽습니다)"
    meter = int(raw_meter or 4)
    if not (2 <= meter <= 12):
        return None, None, None, None, None, None,             "meter 는 2~12 박입니다 — 3·4 는 장르 관용 그루브, 그 외는 그룹 파생 그루브(5=3+2 등)"
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
    orn = str(score.get("orn") or "").strip().lower() or None
    if orn is not None and orn not in ORN_KINDS:
        return (None, None, None, None, None, None,
                f"orn {orn!r} 를 모릅니다 — 가능한 값: {' | '.join(ORN_KINDS)}")
    chord_shape = str(score.get("chordShape") or "").strip().lower() or None
    if chord_shape is not None and chord_shape not in CHORD_SHAPES:
        return (None, None, None, None, None, None,
                f"chordShape {chord_shape!r} 를 모릅니다 — 가능한 값: {' | '.join(CHORD_SHAPES)}")
    # The numeric axes share one gate because they share one shape: a 0~N dial with a reason.
    axes = {}
    for key, hi, why in (("laidback", 0.5, "0 = 격자 위, 0.05 = R&B 의 그 여유"),
                         ("gate", 1.0, "0.55 = 끊어 치기, 1.0 = 이어 붙이기"),
                         ("double", 1.0, "0 = 한 대, 0.7 = 좌우로 벌린 두 대"),
                         ("fill", 1.0, "0 = 안 받아침, 0.7 = 트로트 아코디언처럼 대답")):
        raw = score.get(key)
        if raw is None:
            continue
        try:
            axes[key] = float(raw)
        except (TypeError, ValueError):
            return (None, None, None, None, None, None,
                    f"{key} 는 0~{hi} 숫자입니다 ({why})")
        if not (0.0 <= axes[key] <= hi):
            return (None, None, None, None, None, None,
                    f"{key} 는 0~{hi} 사이여야 합니다 ({why})")
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
            dname = _drum_of(row[0])
            if dname is None:
                return None, None, None, None, None, None,                     f"드럼 {str(row[0])!r} 를 모릅니다 — 가능한 드럼: {', '.join(sorted(DRUM_NOTE))}"
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
    mixmap = score.get("mix")
    if mixmap is not None:
        if not isinstance(mixmap, dict):
            return (None, None, None, None, None, None,
                    'mix 는 {"파트": 0~1} 입니다 — 예: {"chord": 0.4}')
        clean = {}
        for k, v in mixmap.items():
            try:
                clean[str(k)] = float(v)
            except (TypeError, ValueError):
                return (None, None, None, None, None, None, f"mix.{k} 는 0~1 숫자입니다")
            if not (0.0 <= clean[str(k)] <= 1.0):
                return (None, None, None, None, None, None, f"mix.{k} 는 0~1 사이여야 합니다")
        mixmap = clean
    voicing = score.get("voicing")
    if voicing is not None:
        try:
            voicing = float(voicing)
        except (TypeError, ValueError):
            return None, None, None, None, None, None, "voicing 은 0~1 숫자입니다"
        if not (0.0 <= voicing <= 1.0):
            return None, None, None, None, None, None, "voicing 은 0~1 사이여야 합니다"
    humanize = score.get("humanize")
    if humanize is not None:
        try:
            humanize = float(humanize)
        except (TypeError, ValueError):
            return None, None, None, None, None, None, "humanize 는 0~1 숫자입니다"
        if not (0.0 <= humanize <= 1.0):
            return None, None, None, None, None, None, "humanize 는 0~1 사이여야 합니다"
    pedal = score.get("pedal")
    if pedal is not None and not isinstance(pedal, bool):
        return None, None, None, None, None, None, "pedal 은 true/false 입니다"
    bars = score.get("bars")
    if bars is not None:
        try:
            bars = int(bars)
        except (TypeError, ValueError):
            return None, None, None, None, None, None, "bars 는 정수입니다"
        if not (1 <= bars <= 256):
            return None, None, None, None, None, None, "bars 는 1~256 마디입니다"
    feel = {"meter": meter, "swing": swing, "comp": comp, "bass": bassline,
            "drums": drum_rows, "bars": bars, "bpm": bpm, "doubles": doubles,
            "humanize": humanize, "pedal": pedal, "voicing": voicing,
            "orn": orn, "voicing_kind": chord_shape, "laidback": axes.get("laidback"),
            "gate": axes.get("gate"), "double": axes.get("double"),
            "fill": axes.get("fill"), "mix": mixmap}
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
    # 리드 기타 — 리듬(dguitar)과 **다른 소리여야 한다**. 같은 파형으로 리프도 치고 가락도
    # 치면 가락이 벽에 묻힌다. 게인은 그대로 높되 덜 부서지고(shape↓) 더 길게 남는다(hdecay↑):
    # 오버드라이브(GM 29)가 리드를, 디스토션(30)이 리듬을 맡는 그 배치다.
    "lguitar":    {"harm": [1.0, 0.70, 0.42, 0.26, 0.16, 0.09], "hdecay": 2.2, "hslope": 0.95,
                   "detune": 0.003, "noise": 0.04, "shape": 3.2, "atk": 0.004, "rel": 0.16,
                   "gain": 0.30, "gm": 29},
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


def synth_note(freq, dur, patch="bass", vel=0.8, bend=None, vib=None):
    """One note of `patch` — float array of `dur` seconds, peak-normalised to the patch gain.

    `bend` = BEND_CURVES 의 한 줄. 음 하나 안에서 음정이 움직인다(벤딩). 물리모델(ks) 패치는
    줄 길이가 곧 음정이라 이 경로로는 못 휘고, 가산합성 패치만 휜다 — 일렉/디스토션 기타가
    거기 있으니 정작 필요한 자리는 덮인다."""
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
        # 벤딩과 비브라토는 같은 자리에서 만난다 — 둘 다 순간 주파수를 흔드는 일이라,
        # 하나의 위상 램프에 곱해 두면 서로를 지우지 않는다.
        curve = np.ones(n)
        if bend or vib:
            semis = np.zeros(n)
            if bend:
                fr = t / max(1e-6, dur)
                semis += np.array([bend_at(bend, float(x)) for x in fr])
            if vib:
                rate, depth, onset = vib
                start = onset * dur
                ease = np.clip((t - start) / 0.12, 0.0, 1.0)
                semis += depth * ease * np.sin(2 * np.pi * rate * np.maximum(0.0, t - start))
            curve = np.power(2.0, semis / 12.0)
        if p.get("vib"):
            rate, depth = p["vib"]
            # Vibrato that starts immediately sounds like a siren; players ease in.
            onset = np.minimum(1.0, t / 0.18)
            inst = freq * curve * (1.0 + depth * onset * np.sin(2 * np.pi * rate * t))
            ph = 2 * np.pi * np.cumsum(inst) / SR
        elif bend or vib:
            ph = 2 * np.pi * np.cumsum(freq * curve) / SR
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
_FONT_ALIASES = {}


def load_font_aliases(font_path):
    """Fill _FONT_ALIASES from the installed font. Called once per render, before the band is
    hired — never at import, because the font can be swapped under us between runs."""
    inv = font_inventory(font_path) if font_path else None
    if not inv:
        return
    for prog, name in inv["programs"].items():
        k = _norm_inst(name)
        if k:
            _FONT_ALIASES.setdefault(k, prog)


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
    key = _norm_inst(name)
    hit = _INST_LOOKUP.get(key)
    if hit is None and _FONT_ALIASES:
        # The font names its own presets ("French Horns", "Grand Piano"), and those names differ
        # from the GM spelling by design. Spec names win; the font's own words are a free layer
        # underneath, so whatever is installed can be asked for the way it calls itself.
        g = _FONT_ALIASES.get(key)
        if g is not None:
            hit = ("gm", g)
    if hit is None:
        return None
    if hit[0] == "patch":
        return hit[1], PATCHES[hit[1]].get("gm", 0)
    g = hit[1]
    return GM_BUILTIN_OVERRIDE.get(g, FAMILY_FALLBACK[g // 8]), g


def _meter_groups(meter):
    """How an odd bar is actually counted: threes lead (5 = 3+2 — Take Five's own grouping),
    compound meters are all threes (6 = 3+3, 9 = 3+3+3), plain even bars are twos."""
    if meter % 3 == 0:
        return [3] * (meter // 3)
    if meter % 2 == 0:
        return [2] * (meter // 2)
    return [3] + [2] * ((meter - 3) // 2)


def _generic_pattern(style, meter):
    """A derived groove for any meter the hand tables don't cover: kick on group heads, the
    backbeat on alternating groups, eighth hats (a ride for jazz/blues). One rule instead of a
    table per meter × style — 3/4 and 4/4 keep their idiomatic hand-written rows."""
    if style in ("folk", "classic", "newage", "strings", "none"):
        return []
    cym = "ride" if style in ("jazz", "blues") else "hat"
    hits = [(cym, sub * 0.5, 0.32) for sub in range(meter * 2)]
    starts, at = [], 0.0
    for g in _meter_groups(meter):
        starts.append(at)
        at += g
    for i, st in enumerate(starts):
        hits.append(("kick", st, 0.9 if i == 0 else 0.7))
        if i % 2 == 1:
            hits.append(("snare", st, 0.75))
    return hits


def _generic_fill(meter):
    """The last group rolls down the toms — the same corner-turning gesture at any bar length."""
    last = _meter_groups(meter)[-1]
    start = float(meter - last)
    toms = ["tom_hi", "tom_mid", "tom_lo", "tom_lo"]
    n = max(2, last * 2)
    return start, [(toms[min(len(toms) - 1, k * len(toms) // n)], start + k * 0.5,
                    0.45 + 0.5 * k / max(1, n - 1)) for k in range(n)]


# Styles whose drummer actually rolls into the turnaround — a ballad or a carol keeps its
# soft tom fill, jazz keeps its ride language. The roll is a color, not a metronome rule.
# How often a style opens a phrase on a crash, and how hard. Every 4 bars at 0.7 was applied
# to EVERYONE — but a ballad marks sections (8), and a jazz drummer says it on the ride, not
# the crash. (bar 0 stays the piece's opening accent everywhere.)
CRASH_STYLE = {"metal": (2, 0.9), "punk": (2, 0.85), "ballad": (8, 0.5), "rnb": (8, 0.5), "jazz": (8, 0.45), "blues": (8, 0.55),
               "carol": (8, 0.45), "country": (8, 0.55), "hiphop": (8, 0.55)}

ROLL_STYLES = {"trot", "march", "rock", "metal", "punk", "rocknroll", "dance", "pop"}


def _snare_roll(meter):
    """다다다다다 — 16ths leaning into 32nds over the bar's back half, velocities rising the
    way a drummer leans into a fill. The style's tom fill alternates with this every 8 bars."""
    hits = []
    steps = ([meter - 2 + i * 0.25 for i in range(4)] if meter >= 3 else [])         + [meter - 1 + i * 0.125 for i in range(8)]
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
                  ("hat", 0.0, 0.5), ("hat", 1.0, 0.5), ("hat", 2.0, 0.5), ("hat", 3.0, 0.5)],
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
    "strings":   [],
    "newage":    [],
    "none":      [],
}

# Familiar names people actually say → the row that plays them. kpop/jpop are pop grooves here
# honestly: what makes them THEM is production this synth does not do.
# Section doublings a style brings on its own — 8할 of "full orchestra" is the same line in
# unison octaves (flute above, cello below), so classic/orchestra sounds like a SECTION without
# anyone asking. A score's explicit band.doubles replaces these (선언이 이긴다).
STYLE_DOUBLES = {
    # 관현악 (full orchestra): strings + woodwinds (flute above, oboe in unison) + horns on the
    # pad. Percussion arrives separately, following the dynamics.
    # The horn reinforces the BASS an octave up (its classical seat), not the whole pad in
    # unison — strings-pad + horn-pad on the same mid-low notes was a blanket (실측: "웅웅…
    # 호른 같기도", "먹먹") and two sustained layers on one voicing is mud, not warmth.
    "classic": [("melody", "flute", 1, 0.45), ("melody", "oboe", 0, 0.35),
                ("melody", "cello", -1, 0.55), ("bass", "frenchhorn", 1, 0.4)],
    # 현악 합주 (string orchestra): violins + viola in unison + cello an octave down. No winds,
    # no percussion — the ensemble IS the color.
    "strings": [("melody", "viola", 0, 0.45), ("melody", "cello", -1, 0.55)],
    "march":   [("melody", "piccolo", 1, 0.5)],
}

STYLE_ALIASES = {"edm": "dance", "house": "dance", "kpop": "pop", "jpop": "pop",
                 "orchestra": "classic", "symphony": "classic", "관현악": "classic",
                 "오케스트라": "classic", "현악": "strings", "현악합주": "strings",
                 "stringorchestra": "strings", "stringensemble": "strings",
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
    # 35~81 above is General MIDI Level 1 — the floor every GM font has. Below and above it lies
    # the GS/GM2 extension, and the fonts people actually install do carry it: Arachno's kits run
    # 26~87 (실측 8/20). Naming them is the difference between "the font has castanets" and "you
    # can ask for castanets". A font WITHOUT them is handled, not assumed — DRUM_GM1_SUB below.
    "fingersnap": 26, "highq": 27, "slap": 28, "scratch_push": 29, "scratch_pull": 30,
    "sticks": 31, "square_click": 32, "metronome_click": 33, "metronome_bell": 34,
    "shaker": 82, "jingle_bell": 83, "belltree": 84, "castanets": 85,
    "surdo_mute": 86, "surdo_open": 87,
}

# What each extension key becomes on a font that stops at GM1. Silence is the one wrong answer:
# a drum that is simply absent reads as a mixing choice, not as a missing sample.
DRUM_GM1_SUB = {
    "fingersnap": "clap", "highq": "rim", "slap": "clap",
    "scratch_push": "cabasa", "scratch_pull": "cabasa", "sticks": "claves",
    "square_click": "rim", "metronome_click": "rim", "metronome_bell": "triangle_mute",
    "shaker": "maracas", "jingle_bell": "tamb", "belltree": "triangle_open",
    "castanets": "claves", "surdo_mute": "tom_floor_lo", "surdo_open": "tom_floor_lo",
}


# The names people (and models) actually write for the kit — bare families map to their open/
# lead variant, GM-spec spellings map home. Resolution is normalized (case/space/hyphen blind).
DRUM_ALIASES = {
    "triangle": "triangle_open", "conga": "conga_open", "bongo": "bongo_hi",
    "timbale": "timbale_hi", "woodblock": "woodblock_hi", "agogo": "agogo_hi",
    "guiro": "guiro_short", "cuica": "cuica_open", "whistle": "whistle_short",
    "tom": "tom_mid", "floortom": "tom_floor_hi",
    "castanet": "castanets", "jinglebell": "jingle_bell", "sleighbell": "jingle_bell",
    "belltree2": "belltree", "surdo": "surdo_open", "stick": "sticks", "snap": "fingersnap",
    "scratch": "scratch_push", "metronome": "metronome_click", "click": "metronome_click",
    "tambourine": "tamb", "handclap": "clap", "sidestick": "rim", "rimshot": "rim",
    "hihat": "hat", "closedhihat": "hat", "openhihat": "ohat", "openhat": "ohat",
    "pedalhihat": "hat_pedal", "ridecymbal": "ride", "ridebell2": "ride2",
    "crashcymbal": "crash", "chinacymbal": "china", "splashcymbal": "splash",
    "bassdrum": "kick", "bass": "kick", "acousticbassdrum": "kick2",
    "acousticsnare": "snare", "electricsnare": "snare2", "claps": "clap",
}


# The GM2 kit programs — a published spec, stable across fonts. Which of them the INSTALLED font
# actually carries is a different question, and only the font can answer it (font_inventory).
KIT_PROGRAMS = {"standard": 0, "room": 8, "power": 16, "electronic": 24, "tr808": 25,
                "jazz": 32, "brush": 40, "orchestra": 48}


def kits_available(font_path):
    """{name: program} for the kits this font really has — the spec names it carries, plus the
    font's OWN preset names as aliases. A font that ships a kit we never enumerated becomes
    callable the moment it is installed, with no table of ours to edit."""
    inv = font_inventory(font_path) if font_path else None
    if not inv or not inv["kits"]:
        return dict(KIT_PROGRAMS)
    out = {n: pr for n, pr in KIT_PROGRAMS.items() if pr in inv["kits"]}
    for pr, meta in inv["kits"].items():
        alias = _norm_inst(meta["name"].replace("Drum Kit", ""))
        if alias and alias not in out:
            out[alias] = pr
    return out or dict(KIT_PROGRAMS)


def _drum_of(raw):
    """Kit name -> canonical DRUM_NOTE key, or None. Normalized, alias-aware."""
    n = "".join(ch for ch in str(raw or "").casefold() if ch.isalnum())
    if not n:
        return None
    canon = {"".join(ch for ch in k if ch.isalnum()): k for k in DRUM_NOTE}
    if n in canon:
        return canon[n]
    return DRUM_ALIASES.get(n)


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
        # The GS extension, in the same coarse-but-honest register as the rest. A name that only
        # sounds on sf2 would be a name that behaves differently depending on the engine, and
        # that is the kind of difference nobody can debug by ear.
        "fingersnap": _ping(2400.0, 0.07, 0.014, partials=((2.2, 0.4),), gain=0.32)
                      + _shaker(0.07, 73, decay=0.02, gain=0.25),
        "highq": _squeak(3100.0, 1250.0, 0.10, gain=0.30),
        "slap": _am_noise(0.10, 95.0, 75, gain=0.34),
        "scratch_push": _am_noise(0.12, 72.0, 77, gain=0.30),
        "scratch_pull": _am_noise(0.14, 54.0, 79, gain=0.30),
        "sticks": _ping(2200.0, 0.045, 0.009, gain=0.38),
        "square_click": _ping(1000.0, 0.03, 0.006, partials=((3.0, 0.5), (5.0, 0.3)), gain=0.35),
        "metronome_click": _ping(1300.0, 0.04, 0.008, gain=0.35),
        "metronome_bell": _ping(2600.0, 0.35, 0.12, partials=((2.7, 0.4),), gain=0.28),
        "shaker": _shaker(0.11, 63, decay=0.04),
        "jingle_bell": _shaker(0.25, 65, decay=0.08, gain=0.30)
                       + _ping(5200.0, 0.25, 0.08, partials=((2.1, 0.5),), gain=0.18),
        "belltree": _ping(6000.0, 1.4, 0.6,
                          partials=((1.7, 0.5), (2.9, 0.35), (4.3, 0.2)), gain=0.20),
        "castanets": _ping(3200.0, 0.05, 0.008, partials=((1.6, 0.6),), gain=0.40),
        "surdo_mute": tom(72.0, 0.18, seed=33),
        "surdo_open": tom(68.0, 0.55, seed=35),
    }

# Which band a style hires — part → instrument name in PATCHES. The score's own `band` field
# overrides per part, so any instrument in the library can front any style.
STYLE_BAND = {
    "trot":      {"melody": "melody", "chord": "accordion", "bass": "bass"},
    "ballad":    {"melody": "piano", "chord": "strings", "bass": "bass"},
    "march":     {"melody": "brass", "chord": "brass", "bass": "bass"},  # 군악대에 오르간은 없다
    "rock":      {"melody": "eguitar", "chord": "dguitar", "bass": "bass"},
    "metal":     {"melody": "lguitar", "chord": "dguitar", "bass": "pickbass"},  # 메탈은 피크 베이스
    "pop":       {"melody": "piano", "chord": "epiano", "bass": "synthbass"},
    "dance":     {"melody": "synthlead", "chord": "strings", "bass": "synthbass"},
    "rnb":       {"melody": "epiano", "chord": "epiano", "bass": "bass"},
    "rocknroll": {"melody": "eguitar", "chord": "eguitar", "bass": "bass"},
    "hiphop":    {"melody": "epiano", "chord": "epiano", "bass": "synthbass"},
    "country":   {"melody": "aguitar", "chord": "aguitar", "bass": "bass"},
    "funk":      {"melody": "eguitar", "chord": "eguitar", "bass": "slapbass"},  # 펑크는 슬랩
    "punk":      {"melody": "dguitar", "chord": "dguitar", "bass": "bass"},
    "jazz":      {"melody": "piano", "chord": "piano", "bass": "uprightbass"},  # 피아노 트리오 + 업라이트
    "blues":     {"melody": "eguitar", "chord": "organ", "bass": "bass"},
    "carol":     {"melody": "bell", "chord": "strings", "bass": "bass"},
    "folk":      {"melody": "aguitar", "chord": "aguitar", "bass": "bass"},
    "classic":   {"melody": "violin", "chord": "strings", "bass": "contrabass"},
    "strings":   {"melody": "violin", "chord": "strings", "bass": "contrabass"},
    "newage":    {"melody": "piano", "chord": "strings", "bass": "bass"},
    "none":      {"melody": "melody", "chord": "chord", "bass": "bass"},
}

# How a style PLAYS — the arrangement was static before this: the chord part held whole notes
# like a pad and the bass hit one root per chord, so swapping instruments still sounded slow.
# comp = how the chord part moves · bass = how the bass moves · swing = how far the offbeat
# eighths lean (0 straight, 1 full triplet; drums/comp/bass only — the melody stays straight
# because the vocal is cut to the written grid). Every knob is score-overridable.
STYLE_FEEL = {
    "trot":      {"orn": "kkeokgi", "comp": "stabs", "bass": "twobeat", "swing": 0.3, "gate": 0.8},
    "ballad":    {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "march":     {"comp": "quarters", "bass": "alt", "swing": 0.0, "gate": 0.7},
    "rock":      {"orn": "bendin", "voicing_kind": "power", "comp": "eighths", "bass": "drive", "swing": 0.0, "gate": 0.8},
    "metal":     {"orn": "bendin", "voicing_kind": "power", "comp": "chug", "bass": "drive",
                  "double": 0.7, "swing": 0.0, "gate": 1.0},
    "pop":       {"comp": "eighths", "bass": "alt", "swing": 0.0, "gate": 0.85},
    "dance":     {"comp": "stabs", "bass": "offbeat", "swing": 0.0, "gate": 0.7},
    "rnb":       {"laidback": 0.04, "comp": "arp", "bass": "hold", "swing": 0.45, "gate": 0.9},
    "rocknroll": {"comp": "quarters", "bass": "boogie", "swing": 0.6, "gate": 0.75},
    "hiphop":    {"laidback": 0.05, "comp": "pad", "bass": "hold", "swing": 0.45, "gate": 0.85},
    "country":   {"orn": "grace", "comp": "stabs", "bass": "twobeat", "swing": 0.0, "gate": 0.8},
    "funk":      {"comp": "chank", "bass": "funk16", "swing": 0.0, "gate": 0.55},
    "punk":      {"voicing_kind": "power", "comp": "eighths", "bass": "drive", "swing": 0.0, "gate": 0.6},
    "jazz":      {"comp": "charleston", "bass": "walk", "swing": 0.65, "gate": 0.85},
    "blues":     {"orn": "scoop", "comp": "quarters", "bass": "walk", "swing": 0.6, "gate": 0.85},
    "carol":     {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 0.95},
    "folk":      {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "classic":   {"comp": "pad", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "strings":   {"comp": "pad", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "newage":    {"comp": "arp", "bass": "hold", "swing": 0.0, "gate": 1.0},
    "none":      {"comp": "pad", "bass": "hold", "swing": 0.0, "gate": 0.95},
}
# The gate has to reach as far as the engine does. `_comp_hits`/`_bass_line` branch on these
# names and STYLE_FEEL rows set them directly, so a mode the engine plays but the tuple omits is
# reachable by genre name and **unreachable by argument** — and since the schema prints the tuple,
# the model picks from the short list and quietly loses the genre's own hand. 실측 8/19: metal's
# row asked for `chug`+`drive`, a caller could only say `stabs`+`alt`, and one override took the
# wall off the metal render. selftest audits STYLE_FEEL against these.
# How much the band ANSWERS. Comping is what a chord part does while the singer sings; a fill is
# what it does while the singer does not. We had only the first, so a melody instrument like the
# accordion spent a whole trot playing block chords on a grid — 사용자 8/20: "아코디언은 멜로디가
# 있는 악기잖아 왜 뺘악~ 뺘악만 해". The material for the second only arrived with rests: until the
# reader kept them, nothing in the data said where the singer stops.
# 0 = never answer. The rows below are the genres whose face this is.
FILL_STYLES = {"trot": 0.7, "blues": 0.6, "rocknroll": 0.55, "jazz": 0.45, "country": 0.4,
               "rnb": 0.3}
COMP_KINDS = ("pad", "stabs", "arp", "quarters", "eighths", "chug", "charleston", "chank")
BASS_KINDS = ("hold", "twobeat", "alt", "walk", "drive", "offbeat", "funk16", "boogie")
# How the lead hand shapes a long note, and what a chord actually contains. A genre IS these axes
# together — naming them is what lets a caller assemble one we never listed instead of asking us
# for another row.
ORN_KINDS = ("none", "scoop", "bend", "bendin", "grace", "kkeokgi")
CHORD_SHAPES = ("full", "power")

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


def chord_voicing(root_midi, quality="", kind=""):
    """Root-position chord above the written root. Trot lives on minor and dominant sevenths, so
    a score that could only say "root" was stuck in major whatever the song actually was.

    `kind="power"` = root + fifth + octave, no third. That is what a distorted guitar plays and
    why it stays clear: distortion multiplies every interval, and a third in there turns the
    chord into mud. Rock, punk and metal are written that way, not as a taste choice."""
    if kind == "power":
        while root_midi < 40:
            root_midi += 12
        return [root_midi, root_midi + 7, root_midi + 12]
    semis = CHORD_QUALITY.get(str(quality or "").strip(), CHORD_QUALITY[""])
    # Low-interval limit (관현악법 그대로): close-position chords below ~C3 blur into a hum,
    # so the voicing lifts by octaves until its root clears C3. The bass line still owns the
    # true low register — one voice down there is pitch, three is mud.
    while root_midi < 48:
        root_midi += 12
    return [root_midi + s for s in semis]


def smooth_voicing(notes, prev):
    """Voice-leading: move each chord tone to the octave nearest the previous voicing's center.
    Root-position jumps are what makes a progression sound typed; a player's hand stays put."""
    if not prev:
        return sorted(notes)
    center = sum(prev) / len(prev)
    return sorted(min((n - 12, n, n + 12), key=lambda c: abs(c - center)) for n in notes)


BEND_CURVES = {
    # (음 길이의 몇 %, 반음 단위 편차) — 음 안에서 음정이 움직이는 길. 기타리스트가 목표음을
    # 곧게 짚지 않고 **아래에서 밀어 올려 도착**하는 그 손이고, 록 솔로와 블루스의 얼굴이다.
    # 도착 뒤에는 0 이라 가락은 악보 그대로 남는다 — 표현이지 이조가 아니다.
    "scoop":  [(0.0, -1.0), (0.18, 0.0), (1.0, 0.0)],   # 블루스 — 반음
    "bendin": [(0.0, -2.0), (0.22, 0.0), (1.0, 0.0)],   # 록 솔로 — 온음("띠요오옹")
    # 트로트의 꺾기 — **한 음절 안에서** 목을 꺾었다 돌아온다. 사용자 8/20 정정: "소쩍새 슬피
    # 우는" 이 "소~오쩍새 슬피이~ 우~느흔~" 이 되는 그것이고, 음이 **제자리로 돌아온다.**
    # 옛 구현은 음을 둘로 쪼개 뒤쪽을 온음 아래에 두고 끝냈다 — 돌아오지 않으니 한 음절이 아니라
    # 뒤에 붙은 별개의 짧은 음, 즉 "삐융" 으로 들렸다. 벤딩 통로가 생겼으니 이제 제 모양이 된다.
    "kkeokgi": [(0.0, 0.0), (0.44, 0.0), (0.54, -2.0), (0.66, 0.0), (1.0, 0.0)],
}

# 장식마다 필요한 최소 길이. 꺾을 시간이 없는 음에 걸면 음정이 틀린 것처럼 들린다.
ORN_MIN = {"scoop": 1.0, "bendin": 1.5, "kkeokgi": 2.0, "bend": 0.5, "grace": 0.5}


# (Hz, 반음 깊이, 언제부터) — 손가락 비브라토. 벤딩이 **도착**이라면 이건 **머무는 동안**이고,
# 기타 솔로에서 긴 음이 살아 있는 이유가 이것이다. 곧게 뻗은 롱톤은 신디사이저처럼 들린다.
# 속도는 시간(Hz)이지 박이 아니다 — 느린 곡이라고 천천히 떨지 않는다.
VIB_STYLES = {
    "rock":  (5.5, 0.28, 0.35),   # 노래하는 비브라토 — 얕고 고르게
    "metal": (5.5, 0.48, 0.22),  # 더 넓고 더 일찍 — 노래가 아니라 울음이다
    "blues": (5.0, 0.42, 0.30),   # 더 넓고 느리게 — 블루스의 그 울음
}


def vib_at(vib, t, dur):
    """t초에서의 흔들림(반음). onset 전에는 0, 그 뒤로 서서히 열린다 — 처음부터 떨면 사이렌."""
    rate, depth, onset = vib
    start = onset * dur
    if t <= start:
        return 0.0
    ease = min(1.0, (t - start) / max(1e-6, 0.12))
    return depth * ease * math.sin(2 * math.pi * rate * (t - start))


def bend_at(curve, frac):
    """곡선 위 한 점 — 브레이크포인트 사이를 직선으로 잇는다."""
    prev = curve[0]
    for pt in curve:
        if frac <= pt[0]:
            if pt[0] == prev[0]:
                return pt[1]
            r = (frac - prev[0]) / (pt[0] - prev[0])
            return prev[1] + (pt[1] - prev[1]) * r
        prev = pt
    return curve[-1][1]


def _comp_hits(kind, beats, meter, spb=0.5):
    """(offset, dur, vel) strokes for ONE chord segment — how the chord part moves.
    stabs = the 짝 of 쿵-짝(offbeats) · quarters = a march's on-beats · pad = the old whole note.
    (arp is built in the caller: it needs the voicing, not just a rhythm.)"""
    # A stroke's length is a TIME, not a fraction of a beat. The chug branch below already said
    # so and the rest of this table never got the message: "stabs" held 0.9 beats, which is 450ms
    # at 120bpm and worse as the tempo drops. On an instrument that does not decay — accordion,
    # organ, strings — 450ms of triad is not a chop, it is a honk, and it is what the user heard
    # all through a trot render (8/20: "뺘악~ 뺘악~ 하는 소리가 어떤 노래라도 안 어울려").
    # Compare the funk chank at 60ms. So every stroke is capped in milliseconds and never gets
    # longer than the beat-based value it used to have: fast tempos are untouched, slow ones stop
    # smearing.
    def _short(beat_len, ms):
        return max(0.02, min(beat_len, (ms / 1000.0) / max(1e-6, spb)))

    if kind == "stabs":
        step = 2.0 if meter == 4 else 1.0
        d = _short(0.9, 170)
        return [(float(off), d, 0.7) for off in np.arange(1.0, beats, step)]
    if kind == "quarters":
        d = _short(0.9, 240)
        return [(float(b), d, 0.74 if b % 2 == 0 else 0.64) for b in range(int(beats))]
    if kind == "eighths":  # driving on-and-off strokes — the rock/pop rhythm guitar hand
        d = _short(0.5, 200)
        return [(s * 0.5, d, 0.68 if s % 2 == 0 else 0.55) for s in range(int(beats * 2))]
    if kind == "charleston":
        # 재즈 컴핑은 박을 짚지 않는다 — 1박과 2박 뒤(찰스턴)에 짧게 놓고 비운다. 정박에 코드를
        # 깔면 워킹 베이스와 라이드가 이미 하고 있는 일을 세 번째로 반복하게 된다.
        hits = []
        for bar0 in np.arange(0.0, beats, 4.0):
            for off, vel in ((0.0, 0.62), (1.5, 0.7)):
                if bar0 + off < beats:
                    hits.append((float(bar0 + off), _short(0.7, 200), vel))
        return hits
    if kind == "chug":
        # 팜뮤트 — 지지직. 손날로 줄을 눌러 아주 짧게 끊어 치는 소리이고, 울림이 없어서 화음이
        # 아니라 엔진이 된다. **속도는 박이 아니라 귀가 정한다**: 메탈의 청킹은 대략 5초당
        # 스무 번 언저리(≈200ms 간격)로 촘촘해야 벽이 되고, 그보다 성기면 짧은 스탭 = 펑키한
        # 커팅으로 들린다(8/19 실측: bpm 62 에서 8분 = 484ms 간격, 사용자 "펑키/컨트리 같다").
        # 그래서 마디를 나누는 눈금을 템포에서 고른다 — 느린 곡은 16분, 빠른 곡은 8분.
        step = 0.5
        while step * spb > 0.30 and step > 0.125:
            step /= 2.0
        # 뮤트 길이는 초로 고정한다 — 박으로 잡으면 느린 곡에서 늘어져 뭉갠다.
        dur = min(step * 0.6, 0.095 / max(1e-6, spb))
        n = int(beats / step)
        return [(k * step, dur, 0.74 if (k * step) % 1.0 < 1e-6 else 0.58) for k in range(n)]
    if kind == "chank":
        # 펑크 기타의 커팅 — 16분 뒷박을 아주 짧게 긁는다. 길이가 짧은 것이 핵심이라
        # 화음이 울리지 않고 리듬이 된다.
        return [(s * 0.25, 0.12, 0.6 if s % 4 == 2 else 0.4)
                for s in range(int(beats * 4)) if s % 4 != 0]
    return [(0.0, float(beats), 0.6)]  # pad


def _bass_line(kind, root_midi, beats, next_root_midi, meter, semis=None):
    """(offset, dur, pitch, vel) for one chord segment. The bass register is root-12 as before.
    twobeat = root/5th alternation (the 뽕짝 walk) · alt = marching quarters · walk = the jazz
    floor (root, third, fifth in quarters, a dominant pickup into the next chord — quality-aware,
    so a minor chord walks a minor third) · hold = whole note + pickup ·
    drive = straight eighths on the root, doubling the guitar riff (rock/punk/metal) ·
    offbeat = the house pump (eighth offbeats, out of the four-on-the-floor kick's way) ·
    funk16 = stabbed sixteenths with octave pops · boogie = 1-3-5-6-5-3 under a shuffle."""
    b = root_midi - 12
    # Register floor (실측: 비발디 사계가 "저주파처럼 웅웅" — the file's roots are already low,
    # and our octave-down shove landed the hold line at 30-40Hz). A real double bass bottoms
    # at E1; below that the line is felt as rumble, not heard as pitch.
    while b < 28:
        b += 12
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
    if kind == "drive":
        # 록·메탈 베이스는 화성을 설명하지 않는다 — **기타 리프를 그대로 겹쳐** 근음을 8분으로
        # 민다. 4분 근음-5음 행진(alt)을 깔면 그 순간 장르가 펑키록 쪽으로 미끄러진다
        # (8/19 실측: "메탈이라기보다 펑키락 같다").
        return [(i * 0.5, 0.46, b, 0.82 if i % 2 == 0 else 0.7)
                for i in range(int(beats * 2))]
    if kind == "offbeat":
        # 하우스·EDM 의 펌프 — 킥이 정박을 다 먹으니 베이스는 그 사이 8분 뒷박에만 선다.
        # 정박에 같이 서면 킥과 겹쳐 저역이 뭉치고, 비켜서면 곡이 앞으로 밀린다.
        return [(i * 0.5 + 0.5, 0.42, b, 0.74) for i in range(int(beats * 2))
                if i * 0.5 + 0.5 < beats]
    if kind == "funk16":
        # 펑크 베이스는 걷지 않고 **찌른다** — 근음을 16분으로 끊어 치고 옥타브로 튕긴다(팝).
        # 마디를 채우는 게 아니라 구멍을 남기는 것이 이 장르의 문법이다.
        slots = [(0.0, b, 0.9), (0.75, b, 0.6), (1.5, b + 12, 0.72), (1.75, b, 0.55),
                 (2.5, b, 0.85), (3.25, b + 12, 0.7), (3.5, b, 0.6)]
        return [(o, 0.22, pit, v) for o, pit, v in slots if o < beats]
    if kind == "boogie":
        # 로큰롤·부기우기의 그 손 — 근음 3음 5음 6음을 올라갔다 내려온다(1-3-5-6-5-3).
        # 셔플(swing)과 짝이라 8분이 길고-짧게 흔들린다.
        seq = [b, b + 4, b + 7, b + 9, b + 7, b + 4]
        return [(i * 0.5, 0.45, seq[i % len(seq)], 0.76 if i % 2 == 0 else 0.6)
                for i in range(int(beats * 2))]
    # hold — and walk into the next chord instead of teleporting there. The pickup is the
    # NEXT chord's fifth (its dominant), never a chromatic neighbour: a half-step approach
    # put F under an A-minor bar and B♭ under the Canon's D major, and both were plainly sour.
    if next_root_midi is not None and next_root_midi != root_midi and beats >= 2:
        nb = next_root_midi - 12
        approach = nb + 7 if nb + 7 < b + 10 else nb - 5
        return [(0.0, float(beats) - 0.5, b, 0.72), (float(beats) - 0.5, 0.5, approach, 0.6)]
    return [(0.0, float(beats), b, 0.72)]


def events_beats(events):
    """Total written length of a melody: its notes AND the silence between them. Two callers used
    to sum only the segments, which is the song minus its rests."""
    return sum(float(ev.get("gap") or 0.0) + sum(b for _, b in ev["segments"]) for ev in events)


def build_arrangement(events, chords, style, total_beats, band=None, feel=None):
    """Score -> flat list of {beat, beats, part, patch, pitch|drum, program, vel}. Beats, not
    samples: the renderers turn them into whatever they count in (samples here, MIDI ticks there).
    `band` = per-part instrument override ({part: PATCHES name}) on top of the style's own.
    `feel` = {meter, swing, comp, bass} from parse_score; None = the style's own defaults."""
    hire = dict(STYLE_BAND.get(style, STYLE_BAND["trot"]))
    # The answering voice defaults to whoever is comping — in trot that is the accordion, which
    # is the instrument the ear expects to hear reply. `band.fill` names someone else.
    hire.setdefault("fill", hire.get("chord", "piano"))
    for part, name in (band or {}).items():
        if part in hire and resolve_instrument(name) is not None:
            hire[part] = name
    if not (band or {}).get("fill"):
        hire["fill"] = hire["chord"]
    # Two faces per instrument: the GM program (what the .mid and the sf2 engine mean) and the
    # builtin patch (what numpy can play). PATCHES names are native to both; GM names degrade.
    patch_of, prog = {}, {}
    for part, name in hire.items():
        patch_of[part], prog[part] = resolve_instrument(name)
    defaults = STYLE_FEEL.get(style, STYLE_FEEL["trot"])
    feel = feel or {}
    # Caller first, genre second — for every axis. A genre row is a bundle of defaults, not a
    # locked kit: naming one different hand has to leave the other five where the genre put them.
    voicing_kind = feel.get("voicing_kind") or defaults.get("voicing_kind", "")
    if voicing_kind == "full":       # an explicit "not power" is the plain quality voicing
        voicing_kind = ""
    lead_orn = feel.get("orn") or defaults.get("orn", "")
    if lead_orn == "none":           # ditto — an explicit "play it straight"
        lead_orn = ""
    laidback = float(feel["laidback"] if feel.get("laidback") is not None
                     else defaults.get("laidback", 0.0))
    meter = int(feel.get("meter") or 4)
    swing = float(feel.get("swing") if feel.get("swing") is not None else defaults["swing"])
    comp = feel.get("comp") or defaults["comp"]
    bassline = feel.get("bass") or defaults["bass"]
    # Articulation: how much of a written note actually SOUNDS. Velocity alone made every
    # style press notes the same shape — funk clips, a ballad sings through (실측·사용자:
    # "리듬에 어울리게 안 나오냐").
    gate = float(feel["gate"] if feel.get("gate") is not None else defaults.get("gate", 0.9))
    fill_amt = float(feel["fill"] if feel.get("fill") is not None
                     else FILL_STYLES.get(style, 0.0))
    # Thickness is its own axis. It used to ride on `comp == "chug"`, so a caller who changed the
    # strumming hand silently lost the second guitar — the one thing that makes a wall a wall
    # (실측 8/19: `comp:"stabs"` on a metal render, and `chord2` was gone from the part list).
    double = float(feel["double"] if feel.get("double") is not None
                   else defaults.get("double", 0.0))
    # A machine-gun roll belongs to uptempo music: a slow piece keeps its soft fill even in a
    # rolling genre (실측: pop-style 캐논 at a slow bpm rolled, and it fit nothing).
    bpm = float(feel.get("bpm") or 120.0)
    out = []
    # Melody — the notes the voice sings, also given to an instrument. Without this an
    # instrumental render (no vocalPath) had rhythm and bass and no tune at all.
    # Velocity is a phrase shape, not a constant: downbeats lean, offbeats step back.
    beat = 0.0
    mel_gaps = []
    for ei, ev in enumerate(events):
        # 꺾기 belongs at the end of a line — where the singer breathes — and on notes long
        # enough to hold. At the old 1.0-beat threshold it fired on 101 of 443 notes (실측
        # 아로하): one flick every 2.4 seconds is a tic, not a 창법.
        nxt = events[ei + 1] if ei + 1 < len(events) else None
        phrase_end = nxt is None or float(nxt.get("gap") or 0.0) >= 1.0
        g_here = float(ev.get("gap") or 0.0)
        if g_here >= 1.0:
            mel_gaps.append((beat, g_here))
        beat += g_here                        # the rests the score actually wrote
        vels = ev.get("vels") or []
        for si, (freq, beats) in enumerate(ev["segments"]):
            m = int(round(69 + 12 * math.log2(freq / 440.0)))
            on_down = (beat % meter) < 1e-6
            on_beat = (beat % 1.0) < 1e-6
            # The note's own dynamic (MIDI velocity / notes[].vel) is the truth; the phrase
            # curve only shapes notes that never declared one.
            own = vels[si] if si < len(vels) else None
            vel = own if own is not None else (0.82 if on_down else (0.74 if on_beat else 0.64))
            # 꺾기는 소절 끝에서도 걸린다 — 창법이 사는 자리가 거기다. 다른 장식은 길이만 본다.
            orn_ok = beats >= ORN_MIN.get(lead_orn, 1.5) or (
                lead_orn == "kkeokgi" and phrase_end and beats >= 1.0)
            if lead_orn in BEND_CURVES and orn_ok:
                # 진짜 벤딩 — 음을 둘로 쪼개지 않고 음정이 음 안에서 움직인다.
                row = {"beat": beat, "beats": beats, "part": "melody",
                       "patch": patch_of["melody"], "pitch": m,
                       "program": prog["melody"], "vel": vel, "gate": gate,
                       "bend": BEND_CURVES[lead_orn]}
                # 흔들림은 **긴 음에만** — 짧은 음에 걸면 떨 시간이 없어 음정만 흔들린 것처럼
                # 들린다. 기타리스트도 롱톤에서만 손목을 쓴다.
                if style in VIB_STYLES and beats >= 1.5:
                    row["vib"] = VIB_STYLES[style]
                out.append(row)
            elif lead_orn == "bend" and beats >= ORN_MIN["bend"]:
                # 블루스의 스쿠프 — 반음 아래에서 밀어 올려 음에 도착한다. 기타·하모니카의
                # 그 손이고, 곧게 시작하면 블루스로 안 들린다.
                lead = min(0.14, beats * 0.2)
                out.append({"beat": beat, "beats": lead, "part": "melody",
                            "patch": patch_of["melody"], "pitch": max(0, m - 1),
                            "program": prog["melody"], "vel": round(vel * 0.7, 3), "gate": gate})
                out.append({"beat": beat + lead, "beats": beats - lead, "part": "melody",
                            "patch": patch_of["melody"], "pitch": m,
                            "program": prog["melody"], "vel": vel, "gate": gate})
            elif lead_orn == "grace" and beats >= ORN_MIN["grace"]:
                # 컨트리의 해머온 — 온음 아래를 스치고 본음을 때린다.
                lead = min(0.12, beats * 0.18)
                out.append({"beat": beat, "beats": lead, "part": "melody",
                            "patch": patch_of["melody"], "pitch": max(0, m - 2),
                            "program": prog["melody"], "vel": round(vel * 0.72, 3), "gate": gate})
                out.append({"beat": beat + lead, "beats": beats - lead, "part": "melody",
                            "patch": patch_of["melody"], "pitch": m,
                            "program": prog["melody"], "vel": vel, "gate": gate})
            else:
                out.append({"beat": beat, "beats": beats, "part": "melody", "patch": patch_of["melody"],
                            "pitch": m, "program": prog["melody"], "vel": vel, "gate": gate})
            beat += beats
    pos = 0.0
    prev_voicing = None
    for idx, (root, beats, quality) in enumerate(chords):
        rm = int(round(69 + 12 * math.log2(root / 440.0)))
        voicing = smooth_voicing(chord_voicing(rm, quality, voicing_kind), prev_voicing)
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
            # 팜뮤트는 제일 낮은 줄 하나만 눌러 끊는다 — 세 음을 다 그으면 스트로크가 된다.
            struck = voicing[:1] if comp == "chug" else voicing
            spb_a = 60.0 / bpm
            for hi, (off, dur, vel) in enumerate(_comp_hits(comp, beats, meter, spb=spb_a)):
                if pos + off >= total_beats:
                    break
                for p in struck:
                    row = {"beat": pos + off, "beats": dur, "part": "chord",
                           "patch": patch_of["chord"], "pitch": p,
                           "program": prog["chord"], "vel": vel}
                    if double > 0:
                        row["pan"] = -double   # 벽의 왼쪽 절반
                    out.append(row)
                    if double <= 0:
                        continue
                    # 더블트래킹 — 메탈의 두께는 게인이 아니라 **같은 리프를 두 번 따로 쳐서
                    # 좌우 끝으로 벌리는 것**에서 나온다. 한 대는 아무리 세게 쳐도 얇다.
                    # 두 번째 손은 사람이라 몇 밀리초씩 어긋나고 세기도 다르다 — 그 어긋남이
                    # 두께의 정체라, 완전히 같은 음을 복사하면 그냥 볼륨만 커진다.
                    nudge = ((hi % 3) - 1) * (0.007 / spb_a)
                    out.append({"beat": max(0.0, pos + off + nudge), "beats": dur,
                                "part": "chord2", "patch": patch_of["chord"], "pitch": p,
                                "program": prog["chord"], "pan": double,
                                "vel": round(vel * (0.94 if hi % 2 else 1.0), 3)})
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
    if fill_amt > 0 and mel_gaps and chords:
        # Where the harmony is, so the answer belongs to the song and not to a scale we picked.
        spans, cpos = [], 0.0
        for c_root, c_beats, c_qual in chords:
            spans.append((cpos, cpos + c_beats, c_root, c_qual))
            cpos += c_beats
        step = 0.5
        for gi, (g_at, g_len) in enumerate(mel_gaps):
            # A fill answers INTO the next entry: it sits at the END of the breath and stops
            # just short of it. Landing early leaves a hole; overrunning steps on the singer.
            room = g_len - 0.5
            if room < 1.0:
                continue
            span = min(room, 1.0 + 3.0 * fill_amt)
            at = g_at + g_len - 0.5 - span
            # Up on one breath, down on the next — a player does not repeat the same shape all
            # night, and alternating is the cheapest honest variety (no randomness to reproduce).
            climb = (gi % 2 == 0)
            i = 0
            limit = g_at + g_len - 0.5
            # The whole note has to fit, not just its onset: a fill that ends ON the entry is a
            # fill that steps on the singer.
            while at + step <= limit + 1e-9 and at < total_beats:
                cs = next((sp for sp in spans if sp[0] <= at < sp[1]), None)
                if cs is None:
                    break
                rm_f = int(round(69 + 12 * math.log2(cs[2] / 440.0)))
                tones = chord_voicing(rm_f + 12, cs[3], voicing_kind)
                pick = tones[(i if climb else len(tones) - 1 - i) % len(tones)]
                out.append({"beat": round(at, 4), "beats": step * 0.9, "part": "fill",
                            "patch": patch_of["fill"], "pitch": pick,
                            "program": prog["fill"], "gate": gate,
                            "vel": round(0.42 + 0.22 * fill_amt, 3)})
                at += step
                i += 1
    doubles = feel.get("doubles")
    if doubles is None:
        doubles = STYLE_DOUBLES.get(style, [])
    for di, (src_part, inst, octv, dvel) in enumerate(doubles):
        dpatch, dprog = resolve_instrument(inst)
        pan = 0.35 if di % 2 == 0 else -0.35
        for e in [x for x in out if x["part"] == src_part]:
            out.append({**e, "part": f"double{di + 1}", "double_of": src_part,
                        "patch": dpatch, "program": dprog,
                        "pitch": max(0, min(127, e["pitch"] + 12 * octv)),
                        "vel": e["vel"] * dvel, "pan": pan})
    # 손으로 쓴 행이 있으면 그것, 없으면 **그 장르에서 파생**한다. 예전엔 표에 없는 장르가
    # trot 으로 떨어졌는데, 3박 표에는 ballad·march·none·trot 넷뿐이라 **3/4 클래식·포크·뉴에이지·
    # 현악이 전부 뽕짝 드럼을 달고 나왔다**(그리고 4마디마다 트로트 톰 필까지). 파생은 조용해야
    # 할 장르를 알고 있으므로(_generic_pattern) 드럼이 없어야 할 곡은 그대로 조용하다.
    if meter == 3:
        base = DRUM_PATTERNS_3[style] if style in DRUM_PATTERNS_3 else _generic_pattern(style, 3)
        fill = DRUM_FILLS_3.get(style) or (_generic_fill(3) if base else None)
    elif meter == 4:
        base = DRUM_PATTERNS[style] if style in DRUM_PATTERNS else _generic_pattern(style, 4)
        fill = DRUM_FILLS.get(style) or (_generic_fill(4) if base else None)
    else:
        base = _generic_pattern(style, meter)
        fill = _generic_fill(meter) if base else None
    # A score's own drumPattern replaces the style's bar loop; fills and crashes still apply,
    # so a custom groove keeps a drummer (다다다다 included) instead of becoming a metronome.
    custom = feel.get("drums")
    if custom:
        base = list(custom)
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
        every, cvel = CRASH_STYLE.get(style, (4, 0.7))
        if hits and bar_i % every == 0:
            hits = [("crash", 0.0, 0.85 if bar_i == 0 else cvel)] + hits
        for inst, off, vel in hits:
            if bar + off < total_beats:
                out.append({"beat": bar + off, "beats": 0.25, "part": "drum",
                            "drum": inst, "vel": vel})
        bar += float(meter)
        bar_i += 1
    # Orchestral percussion is punctuation, not groove (사용자: "북도 치고 심벌즈도") — the
    # bass drum and cymbal mark the LOUD phrases and stay silent through the quiet ones,
    # which is exactly what the carried dynamics now let us read. A pp piece (짐노페디) keeps
    # its silence; a forte group opens on a crash the way the hall expects.
    if style == "classic" and not custom:
        mel_rows = [e for e in out if e["part"] == "melody"]
        grp_len = float(meter * 4)
        g = 0.0
        while g < total_beats:
            grp = [e for e in mel_rows if g <= e["beat"] < g + grp_len]
            if grp:
                avg = sum(e["vel"] for e in grp) / len(grp)
                if avg >= 0.72:
                    out.append({"beat": g, "beats": 0.25, "part": "drum", "drum": "crash",
                                "vel": min(0.9, avg)})
                    out.append({"beat": g, "beats": 0.25, "part": "drum", "drum": "kick2",
                                "vel": round(avg * 0.85, 3)})
                elif avg >= 0.6:
                    out.append({"beat": g, "beats": 0.25, "part": "drum", "drum": "kick2",
                                "vel": 0.4})
            g += grp_len
    # Swing — the offbeat eighths of the rhythm section lean late. The melody stays straight:
    # the vocal is cut to the written grid, and a straight voice over a shuffling band is the
    # trot sound anyway.
    if swing > 0:
        shift = swing / 6.0
        for e in out:
            if e["part"] != "melody" and e.get("double_of") != "melody"                     and abs(e["beat"] % 1.0 - 0.5) < 1e-6:
                e["beat"] += shift
    _lay_back(out, laidback)
    out.sort(key=lambda e: (e["beat"], e["part"]))
    return out


def _lay_back(rows, amount):
    """R&B·힙합의 그 느낌 — **가락만** 박 뒤로 조금 눕는다. 리듬 섹션은 격자에 그대로 있고
    노래가 그 뒤를 걷기 때문에 생기는 여유라, 전부 같이 밀면 그냥 느린 곡이 된다."""
    if amount <= 0:
        return rows
    for r in rows:
        if r.get("part") == "melody":
            r["beat"] = round(r["beat"] + amount, 4)
    return rows


def reinstrument(rows, band):
    """Faithful mode + band = the same performance on another instrument ("월광 기타로") —
    NOT a collapse into the 3-part arrangement. 실측 (15:15 월광): the model helpfully passed
    band {melody: piano} and the whole texture fell to ONE melody line ("1/3만 나오는 느낌"
    — 시간이 아니라 성부가 1/3 이었다). One named instrument dresses every pitched part;
    real re-arrangement still belongs to style/drums/vocal."""
    inst = (band or {}).get("melody") or next(iter(band.values()), None) if band else None
    if not inst:
        return rows, None
    resolved = resolve_instrument(inst)
    if resolved is None:
        return rows, None
    patch, prog = resolved
    for r in rows:
        if "pitch" in r and not r.get("pedal"):
            r["patch"], r["program"] = patch, prog
    return rows, inst


def assimilate_triplets(arr):
    """Two-against-three, resolved the way pianists resolve it: when a beat carries a LIVE
    triplet grid (onsets at +1/3 AND +2/3), a dotted-figure sixteenth written at +3/4 snaps
    onto the triplet's third note, and the dotted note ahead of it gives up the 1/12 beat.

    실측 (월광 32s·54s 절뚝임): literal 3:1 put the sixteenth 113ms after the triplet note —
    a mechanical flam the ear reads as 엇박 ("따↓단" vs the recordings' "따→단"). humanize was
    0, so this was deterministic interpretation, not jitter. Beats with no triplet grid stay
    literal 3:1 — a French-overture score keeps its dotting."""
    eps = 0.02
    thirds, two_thirds = set(), set()
    for r in arr:
        if r.get("pedal") or "pitch" not in r:
            continue
        k = math.floor(r["beat"] + eps)
        f = r["beat"] - k
        if r["beats"] <= 0.5 + eps:
            if abs(f - 1 / 3) < eps:
                thirds.add(k)
            elif abs(f - 2 / 3) < eps:
                two_thirds.add(k)
    live = thirds & two_thirds
    if not live:
        return 0
    moved = 0
    for r in arr:
        if r.get("pedal") or "pitch" not in r:
            continue
        k = math.floor(r["beat"] + eps)
        if k in live and abs(r["beat"] - k - 0.75) < eps and r["beats"] <= 0.5 + eps:
            delta = r["beat"] - (k + 2 / 3)
            r["beat"] = k + 2 / 3
            r["beats"] += delta  # the release stays where it was written
            moved += 1
    if moved:
        for r in arr:
            if r.get("pedal") or "pitch" not in r:
                continue
            end = r["beat"] + r["beats"]
            ke = math.floor(end + eps)
            if ke in live and abs(end - ke - 0.75) < eps and r["beats"] >= 0.5:
                # the dotted note that led into the moved sixteenth ends with it
                r["beats"] = max(0.06, r["beats"] - (end - (ke + 2 / 3)))
    return moved


def apply_performance(arr, feel, spb, total_beats):
    """The asked-for performance layer, applied to ANY arr (faithful or arranged).

    pedal:true — when the score carries no pedal marks of its own, generate the pianist's
    default: press at每 bar, release at the barline (re-pedal — the standard way to keep the
    wash without smearing harmonies; 월광's own marks are famously absent from transcriptions).
    humanize 0-1 — deterministic micro jitter: timing (~12ms at 1.0), velocity (~7%), and
    chord-stack rolls (~10ms per voice). 사람처럼, but the same request renders the same bytes.
    """
    meter = int((feel or {}).get("meter") or 4)
    if (feel or {}).get("pedal") is False:
        # "페달 빼고" — even a marked score plays dry. true adds the default where marks are
        # absent; None (unasked) plays exactly what is written.
        arr[:] = [e for e in arr if not e.get("pedal")]
    if (feel or {}).get("pedal") and not any(e.get("pedal") for e in arr):
        pitched_parts = {e["part"] for e in arr if "pitch" in e and not e.get("pedal")}
        bar = 0.0
        while bar < total_beats:
            span = min(float(meter), total_beats - bar)
            for part in pitched_parts:
                arr.append({"beat": bar, "beats": span, "part": part, "pedal": True})
            bar += meter
    # Voicing — the pianist's balance (실측 월광: 저음 0.44 > 반주 0.375 > 멜로디 0.36, 정확히
    # 거꾸로. 그 소리가 "좌절 절망"이었다). The top line sings, inner voices step back, the
    # bass supports. A GM player's flat balance stays the default; the knob is the human.
    v_amt = float((feel or {}).get("voicing") or 0.0)
    if v_amt > 0:
        vb = {}
        for e in arr:
            if "pitch" in e and not e.get("pedal"):
                vb.setdefault(int(e["beat"] * 2), []).append(e)
        for rs in vb.values():
            if len(rs) < 2:
                continue
            top = max(rs, key=lambda r: r["pitch"])
            low = min(rs, key=lambda r: r["pitch"])
            for r in rs:
                if r is top:
                    r["vel"] = min(1.0, r["vel"] * (1 + 0.18 * v_amt))
                elif r is low and len(rs) > 2:
                    r["vel"] = max(0.08, r["vel"] * (1 - 0.30 * v_amt))
                else:
                    r["vel"] = max(0.08, r["vel"] * (1 - 0.22 * v_amt))
    amount = float((feel or {}).get("humanize") or 0.0)
    if amount > 0:
        rng = np.random.default_rng(1729 + len(arr))
        jt = 0.012 * amount / spb
        # Rubato is a DRIFT, not noise: adjacent moments carry almost the same offset and the
        # push-pull happens over phrases (random walk, decayed, clipped). Independent offsets
        # per moment limped on an even triplet pulse (실측: 간격 438↔473ms 널뜀, "절름발이");
        # a 20ms bucket also merges ghost moments a few ms apart so voices stay glued.
        pitched = sorted((x for x in arr if not x.get("pedal")),
                         key=lambda x: (x["beat"], x.get("pitch", 0)))
        # One musical instant = one cluster (onsets chained within 0.03 beats), sharing one
        # offset — fixed buckets split ghost pairs straddling an edge (실측: 5-7ms 유령 간격).
        uniq = sorted({x["beat"] for x in pitched})
        cluster_of, anchor = {}, None
        for b in uniq:
            if anchor is None or b - anchor > 0.03:
                anchor = b
            cluster_of[b] = anchor
        # No synthetic chord rolls at all: written arpeggio signs already roll in the parser,
        # and a few-ms smear on unmarked chords reads as a flam, not a pianist (실측 3연속:
        # 독립 지터 → 순간 널뜀 → 스택 롤, 셋 다 "절름발이"의 얼굴이었다). Humanize is now
        # ONLY the shared drift and the touch (velocity) — nothing that splits an instant.
        moments = {}
        walk = 0.0
        for a in sorted(set(cluster_of.values())):
            walk = walk * 0.9 + float(rng.normal(0, jt * 0.45))
            moments[a] = max(-2.2 * jt, min(2.2 * jt, walk))
        for e in pitched:
            e["beat"] = max(0.0, e["beat"] + moments[cluster_of[e["beat"]]])
            e["vel"] = float(min(1.0, max(0.08,
                                          e.get("vel", 0.7)
                                          * (1 + float(rng.normal(0, 0.07)) * amount))))
        arr.sort(key=lambda x: (x["beat"], x["part"]))
    return arr


def render_arrangement(arr, spb, total_beats, mixmap=None):
    """The numpy backend — (stereo (n,2) array, mono reverb-send bus). The band is panned onto
    a stage and each voice contributes to one shared room (add_room applies it at the end)."""
    n_total = int(SR * spb * total_beats) + int(SR * 0.5)
    # float32, in place: a five-minute float64 stereo buffer alone is ~250MB and every `x * k`
    # copy doubles it — the sum OOM-killed the 월광 render on the small server.
    out = np.zeros((n_total, 2), dtype=np.float32)
    send = np.zeros(n_total, dtype=np.float32)
    hits = _kit_bank()
    # Damper realization for the synth that has no pedal: a note inside a pedal span rings
    # until the release (the .mid says the same thing with CC64 instead).
    pedal_spans = {}
    for e in arr:
        if e.get("pedal"):
            pedal_spans.setdefault(e["part"], []).append((e["beat"], e["beat"] + e["beats"]))
    for e in arr:
        if e.get("pedal"):
            continue
        i = int(SR * spb * e["beat"])
        if i >= n_total:
            continue
        lvl = mix_of(e["part"], mixmap)     # the same balance the .mid asks for with CC7
        if e["part"] == "drum":
            seg = hits[e["drum"]] * float(e.get("vel", 0.8)) * lvl
            key = e["drum"]
        else:
            held = e["beats"]
            for a, b in pedal_spans.get(e["part"], ()):  # noqa: B007
                if a <= e["beat"] < b:
                    held = max(held, b - e["beat"])
                    break
            seg = synth_note(freq_of_midi(e["pitch"]),
                             spb * held * float(e.get("gate", 1.0)),
                             e.get("patch", e["part"]), vel=float(e.get("vel", 0.8)),
                             bend=e.get("bend"), vib=e.get("vib")) * lvl
            key = e["part"]
        m = min(len(seg), n_total - i)
        seg = seg[:m]
        # Constant-power pan: the band sits on a stage, not a point.
        pan_v = e.get("pan")
        if pan_v is None:
            pan_v = PAN.get(key, 0.0)
        theta = (pan_v + 1.0) * np.pi / 4.0
        out[i:i + m, 0] += seg * np.cos(theta)
        out[i:i + m, 1] += seg * np.sin(theta)
        send[i:i + m] += seg * SEND.get(key, 0.1)
    return out, send


# Where each voice sits (−1 left … +1 right) and how much of it goes to the room. The dry mix
# was mono and bone-dry, which doubled the synth-ness of everything: a stage and a little air
# are half of "sounds like a record".
# 리듬 기타 두 대는 좌우 **끝**으로, 리드와 베이스와 킥은 센터. 저역과 가락이 가운데 서고
# 벽이 양옆에 서는 것이 이 장르의 그림이다(팬은 파트 단위 = MIDI CC10 이라 두 대가 서로 다른
# 파트여야 갈린다 — 그래서 두 번째 손이 `chord2` 라는 제 이름을 갖는다).
# Who sits on top. The arrangement had roles and no BALANCE: the only MIDI controls we ever
# wrote were pan and sustain, so on the sf2 engine the mix was whatever velocity and polyphony
# happened to produce — and a comping part playing three notes at once beat a single-note lead
# every time (실측 8/20 트로트: chord 3.00 voices at vel 0.70 vs melody 1.00 at 0.63; the user
# heard accordion, then vocal, then drums, which is upside down). These are channel volumes:
# the tune on top, the bass holding the floor, the comping underneath, and the fill up with the
# lead because while it answers it IS the lead. `mix` overrides any of them.
MIX = {"melody": 1.0, "vocal": 1.0, "fill": 0.82, "bass": 0.80, "drum": 0.76,
       "chord": 0.58, "chord2": 0.58}
MIX_TOP = 110          # GM's own default is 100; 110 leaves the lead room without clipping


def mix_of(part, over=None):
    base = MIX.get(part, MIX.get(part.rstrip("0123456789"), 0.85))
    if over and part in over:
        base = float(over[part])
    return max(0.0, min(1.0, base))


PAN = {"melody": 0.0, "chord": -0.25, "chord2": 0.7, "fill": 0.30, "bass": 0.0, "vocal": 0.0,
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
SEND = {"melody": 0.22, "chord": 0.16, "chord2": 0.16, "fill": 0.20, "bass": 0.04,
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
    """Overlap-add in fixed blocks — a whole-piece FFT allocated complex128 at FULL length,
    which on a five-minute piece is hundreds of MB and what OOM-killed the 월광 render on the
    949MB server (실측 dmesg: python3 killed, rss 668MB). Peak memory is now a constant."""
    n_ir = len(ir)
    block = 1 << 20
    size = 1 << max(1, (block + n_ir - 2).bit_length())
    f_ir = np.fft.rfft(ir, size)
    out = np.zeros(len(x), dtype=np.float32)
    for a in range(0, len(x), block):
        seg = x[a:a + block]
        conv = np.fft.irfft(np.fft.rfft(seg, size) * f_ir, size)
        keep = min(len(seg) + n_ir - 1, len(x) - a)
        out[a:a + keep] += conv[:keep].astype(np.float32)
    return out


def add_room(stereo, send, wet=0.9):
    """One room for the whole band — the send bus decides who stands close to it."""
    if len(send) == 0 or not np.any(send):
        return stereo
    stereo[:, 0] += _fft_convolve(send, _reverb_ir(0.9, 21)) * wet
    stereo[:, 1] += _fft_convolve(send, _reverb_ir(0.9, 22)) * wet
    return stereo


def write_midi(arr, bpm, path, mix=None):
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
    seen = []
    for e in arr:
        if e["part"] not in seen and not (e.get("pedal") and not any(
                x["part"] == e["part"] and not x.get("pedal") for x in arr)):
            seen.append(e["part"])
    order = [q for q in ("melody", "chord", "bass") if q in seen] \
        + [q for q in seen if q not in ("melody", "chord", "bass", "drum")] \
        + (["drum"] if "drum" in seen else [])
    next_ch = 0
    for part in order:
        rows = [e for e in arr if e["part"] == part]
        if not rows:
            continue
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name=part, time=0))
        if part == "drum":
            ch = 9
            # A kit is chosen by program change like any other instrument — GM only fixes WHICH
            # channel it sits on. Without this line the drum track was always Standard, whatever
            # else the font carried (Arachno ships ten kits; we could reach one).
            kp = int(rows[0].get("program") or 0)
            if kp:
                tr.append(mido.Message("program_change", channel=ch, program=kp, time=0))
        else:
            ch = min(15, next_ch)
            next_ch += 1
            if next_ch == 9:  # the GM drum channel belongs to the kit alone
                next_ch = 10
            # The first row of a part is not always a NOTE: a humanize jitter can nudge the
            # first note past 0.0 and sort a pedal row (which has no program) to the front —
            # 실측: 월광 pedal+humanize 가 여기서 KeyError 로 죽었다.
            first_note = next((e for e in rows if not e.get("pedal")), None)
            tr.append(mido.Message("program_change", channel=ch,
                                   program=int((first_note or {}).get("program", 0)), time=0))
            pan = (first_note or {}).get("pan")
            if pan is None:
                pan = PAN.get(part, 0.0)
            tr.append(mido.Message("control_change", channel=ch, control=10,
                                   value=max(0, min(127, int(round(64 + pan * 63)))), time=0))
        tr.append(mido.Message("control_change", channel=ch, control=7,
                               value=max(1, min(127, int(round(MIX_TOP * mix_of(part, mix))))),
                               time=0))
        # (tick, kind) marks in one time-ordered pass — MIDI deltas are relative, so note-offs
        # and pedal changes have to be interleaved rather than appended per event. kind: 0 =
        # note_off, 1 = note_on, 2 = CC64 (sustain — fluidsynth and every GM synth honor it),
        # 3 = pitch wheel (벤딩 — sf2 가 기본 엔진이라 여기에도 실려야 실제로 들린다).
        marks = []
        for e in rows:
            if e.get("pedal"):
                start = int(round(e["beat"] * tpb))
                end = start + max(1, int(round(e["beats"] * tpb)))
                marks.append((start, 2, 127, 0))
                marks.append((end, 2, 0, 0))
                continue
            curve, vib = e.get("bend"), e.get("vib")
            if (curve or vib) and part != "drum":
                # GM 의 휠 기본 범위는 ±2반음 — 록의 온음 벤딩이 마침 그 끝이다. 끝나면 0 으로
                # 돌려 다음 음을 오염시키지 않는다. **시간 격자로** 훑는 이유는 비브라토가
                # 박이 아니라 초로 떨기 때문 — 음을 n등분하면 느린 곡에서 흔들림이 늘어진다.
                spb_w = 60.0 / max(1e-6, bpm)
                dur_s = e["beats"] * spb_w
                b0 = int(round(e["beat"] * tpb))
                b1 = b0 + max(1, int(round(e["beats"] * tpb)))
                steps = max(8, min(240, int(dur_s / 0.025)))
                for k in range(steps + 1):
                    frac = k / steps
                    semis = bend_at(curve, frac) if curve else 0.0
                    if vib:
                        semis += vib_at(vib, frac * dur_s, dur_s)
                    val = max(-8192, min(8191, int(round(semis / 2.0 * 8192))))
                    marks.append((b0 + int((b1 - b0) * frac), 3, val, 0))
                marks.append((b1, 3, 0, 0))
            start = int(round(e["beat"] * tpb))
            pitch = DRUM_NOTE.get(e["drum"], 42) if part == "drum" else e["pitch"]
            vel = int(round(127 * float(e.get("vel", 0.71))))
            length = e["beats"] * float(e.get("gate", 1.0))
            marks.append((start, 1, pitch, vel))
            marks.append((start + max(1, int(round(length * tpb))), 0, pitch, 0))
        marks.sort(key=lambda m: (m[0], m[1]))
        prev = 0
        for tick, kind, a, b in marks:
            if kind == 3:
                tr.append(mido.Message("pitchwheel", channel=ch, pitch=a, time=tick - prev))
            elif kind == 2:
                tr.append(mido.Message("control_change", channel=ch, control=64, value=a,
                                       time=tick - prev))
            else:
                tr.append(mido.Message("note_on" if kind == 1 else "note_off", channel=ch,
                                       note=max(0, min(127, a)),
                                       velocity=max(1, min(127, b)) if kind == 1 else 0,
                                       time=tick - prev))
            prev = tick
    mid.tracks[0].insert(0, mido.MetaMessage("set_tempo",
                                             tempo=mido.bpm2tempo(bpm), time=0))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    mid.save(path)
    return path, None


# ── SF2 backend (system fluidsynth) ─────────────────────────────────────────────────────────────

SF2_DIRS = ("/usr/share/sounds/sf2", "/usr/local/share/sounds/sf2")


# ── what the installed font can actually play ─────────────────────────────────────────────────
# We used to assume. The font is the original for "which sounds exist" — it says so in its own
# table of contents — and asking it is cheap: the chunk walk SEEKS past the sample data, so a
# 155 MB SoundFont costs 0.36 MB of reads and 1.8 ms (실측 8/20, Arachno). Cheap enough to ask
# every render, which means we never ship a name the current font cannot sound. Swap the font and
# the answer changes with it; no table of ours has to be edited to keep up.
_FONT_CACHE = {}


def font_inventory(path):
    """{'programs': {program: preset name}, 'kits': {program: {'name', 'keys'}}} for the font at
    `path`, or None if it cannot be read. Melodic = bank 0, kits = bank 128 (the GM convention).
    Keys are the notes a kit actually answers to — that is the difference between a drum that
    sounds and one that is silently nothing."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    ck = (path, st.st_mtime_ns, st.st_size)
    if ck in _FONT_CACHE:
        return _FONT_CACHE[ck]
    try:
        raw = {}
        with open(path, "rb") as f:
            f.seek(12)
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    break
                cid = hdr[:4].decode("latin1")
                sz = struct.unpack("<I", hdr[4:])[0]
                if cid == "LIST":
                    if f.read(4) == b"pdta":
                        end = f.tell() + sz - 4
                        while f.tell() < end - 8:
                            h = f.read(8)
                            sid = h[:4].decode("latin1")
                            ssz = struct.unpack("<I", h[4:])[0]
                            raw[sid] = f.read(ssz)
                            if ssz & 1:
                                f.read(1)
                        break
                    f.seek(sz - 4 + (sz & 1), 1)
                else:
                    f.seek(sz + (sz & 1), 1)
        if not {"phdr", "pbag", "pgen", "inst", "ibag", "igen"} <= set(raw):
            return None

        def recs(name, fmt, size):
            b = raw[name]
            return [struct.unpack_from(fmt, b, i * size) for i in range(len(b) // size)]

        phdr = [(n.split(bytes([0]))[0].decode("latin1", "replace"), pr, bk, bg)
                for n, pr, bk, bg, *_ in recs("phdr", "<20sHHHIII", 38)]
        pbag, pgen = recs("pbag", "<HH", 4), recs("pgen", "<HH", 4)
        inst = [(n, bg) for n, bg in recs("inst", "<20sH", 22)]
        ibag, igen = recs("ibag", "<HH", 4), recs("igen", "<HH", 4)

        def inst_keys(ix):
            keys, start = set(), inst[ix][1]
            end = inst[ix + 1][1] if ix + 1 < len(inst) else len(ibag)
            for bi in range(start, min(end, len(ibag))):
                gs = ibag[bi][0]
                ge = ibag[bi + 1][0] if bi + 1 < len(ibag) else len(igen)
                for gi in range(gs, min(ge, len(igen))):
                    op, amt = igen[gi]
                    if op == 43:                                  # keyRange
                        keys.update(range(amt & 0xFF, ((amt >> 8) & 0xFF) + 1))
            return keys

        programs, kits = {}, {}
        for pi, (name, preset, bank, bagndx) in enumerate(phdr):
            if bank not in (0, 128):
                continue
            if bank == 0:
                programs[preset] = name
                continue
            end = phdr[pi + 1][3] if pi + 1 < len(phdr) else len(pbag)
            keys = set()
            for bi in range(bagndx, min(end, len(pbag))):
                gs = pbag[bi][0]
                ge = pbag[bi + 1][0] if bi + 1 < len(pbag) else len(pgen)
                for gi in range(gs, min(ge, len(pgen))):
                    op, amt = pgen[gi]
                    if op == 41 and amt < len(inst):              # instrument
                        keys |= inst_keys(amt)
            kits[preset] = {"name": name, "keys": keys}
        out = {"programs": programs, "kits": kits} if programs or kits else None
    except (OSError, ValueError, struct.error, IndexError):
        out = None
    _FONT_CACHE[ck] = out
    return out


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


def render_sf2(arr, spb, binp, font, mixmap=None):
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
        written, note = write_midi(arr, 60.0 / spb, mid_path, mix=mixmap)
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
        data, sr = sf.read(wav_path, dtype="float32", always_2d=True)
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        data = data[:, :2]
        if sr != SR:
            data = np.stack([resample_linear(data[:, 0], SR / sr),
                             resample_linear(data[:, 1], SR / sr)], axis=1).astype(np.float32)
        peak = float(np.max(np.abs(data))) or 1.0
        data /= peak
        return data, None
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


def vocal_octave_shift(vocal, events):
    """How many octaves the tune has to move to be **singable by this voice**.

    A singer given a song out of their range transposes it; they do not squeak through it.
    We were doing the squeaking: the melody's written pitches went straight to the retuner, so
    a score composed up in the fifth octave (실측 8/19: the model wrote one by hand) dragged a
    speaking-voice take an octave or more above where it lives, and the result was a thin
    chipmunk over a normal backing — 사용자: "보컬음이 아니고 더 높게 부른다".

    Whole octaves only: the tune, the intervals and the key all survive; only the register
    moves. The reference is the take's own measured pitch, not a table of voice types, because
    the take is what has to do the singing."""
    freqs = [f for ev in events for f, _ in ev["segments"] if f and f > 0]
    if not freqs or vocal is None or len(vocal) < int(SR * 0.2):
        return 0
    med_target = sorted(freqs)[len(freqs) // 2]
    # The speaker's own pitch, read off a middle slice (the ends hold breath and silence).
    a, b = int(len(vocal) * 0.25), int(len(vocal) * 0.75)
    natural = detect_f0(vocal[a:b])
    if not natural or natural <= 0:
        return 0
    # 노래는 말보다 **위에서** 한다 — 평상 음높이 그 자리를 겨누면 정상적인 멜로디까지 끌어
    # 내린다(첫 판에서 C4~G4 가 한 옥타브 내려갔다). 중심은 말소리의 한 옥타브 위로 둔다.
    dev = math.log2((natural * 2.0) / med_target)
    # 그리고 **한 옥타브 넘게 벗어났을 때만** 움직인다. 노래는 원래 넓게 쓰는 것이고, 여기서
    # 고치려는 건 부를 수 없는 자리에 적힌 악보 하나지 음역 취향이 아니다.
    if abs(dev) < 1.0:
        return 0
    return int(max(-2, min(2, round(dev))))


def render_vocal(vocal, events, spb):
    """The whole take, syllable by syllable, onto the score's pitches and beats."""
    pw = try_pyworld()
    chunks = split_vocal(vocal, len(events))
    shift = vocal_octave_shift(vocal, events)
    out = []
    for ev, chunk in zip(events, chunks):
        gap = float(ev.get("gap") or 0.0)
        if gap > 0:
            out.append(np.zeros(int(SR * spb * gap), dtype=np.float32))
        for i, (freq, beats) in enumerate(ev["segments"]):
            freq = freq * (2.0 ** shift)
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
    """One track -> [[note, start_tick, dur_tick, velocity], ...] sorted by start."""
    events, t, on = [], 0, {}
    for msg in track:
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            on[msg.note] = (t, msg.velocity)
        elif (msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0)) \
                and msg.note in on:
            start, vel = on.pop(msg.note)
            events.append([msg.note, start, t - start, vel])
    events.sort(key=lambda e: e[1])
    return events


def _track_meta(track):
    """(channel, program) a track plays on — first note_on's channel, first program_change."""
    ch, prog = None, None
    for msg in track:
        if prog is None and msg.type == "program_change":
            prog = int(msg.program)
        if ch is None and msg.type == "note_on":
            ch = int(getattr(msg, "channel", 0))
        if ch is not None and prog is not None:
            break
    return (0 if ch is None else ch), (0 if prog is None else prog)


_NOTE_DRUM = {v: k for k, v in DRUM_NOTE.items()}


def _patch_for_program(g):
    """GM program -> the nearest builtin patch (the sf2 engine uses the program itself)."""
    return GM_BUILTIN_OVERRIDE.get(g, FAMILY_FALLBACK[max(0, min(127, int(g))) // 8])


def midi_to_parts(path):
    """The WHOLE file as playable rows — every track, its own instrument, its own dynamics.
    This is the faithful mode's source: 실측 (월광), reducing a piano piece to one line left
    the tune buried in its own accompaniment. Returns (rows, bpm, err)."""
    import mido
    try:
        mf = mido.MidiFile(path)
    except Exception as e:  # noqa: BLE001
        return None, None, f"MIDI parse failed: {e}"
    tpb = mf.ticks_per_beat or 480
    tempo_events = []
    for tr in mf.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                tempo_events.append((t / tpb, round(mido.tempo2bpm(msg.tempo), 3)))
    tempo_events.sort()
    bpm = round(tempo_events[0][1], 1) if tempo_events else 120.0
    warp = _warp_fn(tempo_events, bpm)
    rows, pidx = [], 0
    for tr in mf.tracks:
        ev = _track_events(tr)
        if not ev:
            continue
        ch, prog = _track_meta(tr)
        if ch == 9:
            for note, start, dur, vel in ev:
                name = _NOTE_DRUM.get(note)
                if name:
                    rows.append({"beat": warp(start / tpb), "beats": 0.25, "part": "drum",
                                 "drum": name, "vel": round(vel / 127.0, 3)})
            continue
        pidx += 1
        part = f"p{pidx}"
        patch = _patch_for_program(prog)
        for note, start, dur, vel in ev:
            b0 = warp(start / tpb)
            rows.append({"beat": b0, "beats": max(0.125, warp((start + dur) / tpb) - b0),
                         "part": part, "patch": patch, "program": prog, "pitch": int(note),
                         "vel": round(vel / 127.0, 3), "gate": 1.0})
    if not rows:
        return None, None, "MIDI 에서 음표를 못 읽었습니다"
    return rows, bpm, None



def midi_to_score(path, lyrics=None, want_part=None):
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

    # The WHOLE tempo map, not the first mark (실측 구멍: a ballad's rit. drifted ever further
    # behind its own file). Same warp as MusicXML: time bends onto one master tempo.
    tempo_events = []
    for tr in mf.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                tempo_events.append((t / tpb, round(mido.tempo2bpm(msg.tempo), 3)))
    tempo_events.sort()
    bpm = round(tempo_events[0][1], 1) if tempo_events else 120.0
    warp = _warp_fn(tempo_events, bpm)

    # The file's own meter (실측: Take Five parsed as 4/4 — the 5 was in the file, unread).
    meter = None
    for tr in mf.tracks:
        for msg in tr:
            if msg.type == "time_signature":
                if 2 <= int(msg.numerator) <= 12:
                    meter = int(msg.numerator)
                break
        if meter is not None:
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
        tname = next((str(msg.name).strip() for msg in tr
                      if getattr(msg, "type", "") == "track_name"), "")
        cands.append({"idx": idx, "ev": ev, "overlap": overlap, "mean": mean_pitch,
                      "id": str(idx), "name": tname,
                      "lyrics": len(lyric_by_track[idx])})
    if not cands:
        return None, "no playable track found in the MIDI (need >= 8 notes on a non-drum track)"

    with_lyrics = [c for c in cands if c["lyrics"] >= 8]
    mono = [c for c in cands if c["overlap"] < 0.3]
    # Same order as the MusicXML reader: lyrics, then what the track calls itself, then size.
    # A track name is the arranger's own label ("Voice", "MELODY", "Gtr1"), and it beats counting
    # notes — counting hands the tune to the busiest accompaniment.
    melody = _wanted_part(cands, want_part)
    if melody is None:
        melody = (max(with_lyrics, key=lambda c: c["lyrics"]) if with_lyrics
                  else max(mono or cands, key=lambda c: (part_is_vocal(c.get("name")),
                                                         len(c["ev"]), c["mean"])))

    # Monophonize (karaoke files sometimes double a note) and quantize beats.
    mel = []
    for e in melody["ev"]:
        if mel and e[1] < mel[-1][1] + 2:  # same-start double: keep the higher note
            if e[0] > mel[-1][0]:
                mel[-1] = e
            continue
        mel.append(e)
    seq = []
    for i, (note, start, dur, vel) in enumerate(mel):
        span = (mel[i + 1][1] - start) if i + 1 < len(mel) else dur
        # Real performances hold notes for bars (pedal, pads — 실측: 34.5·37 박). A recorded
        # length is a fact to absorb, not a typo to refuse: clamp to the score cap.
        w_span = warp((start + span) / tpb) - warp(start / tpb)
        beats = min(64.0, max(0.25, round(w_span * 4) / 4))
        # The recorded dynamics ARE the score (실측: 짐노페디가 우리 일률 곡선 때문에 다
        # 세게 나왔다 — pp 를 mf 로 덮어 쓰고 있었다). 0-1 scale, our vel language.
        seq.append({"note": _midi_name(note), "beats": beats, "tick": start,
                    "vel": round(vel / 127.0, 3)})

    # Syllables: file lyric events matched to note starts, else the caller's string, else 라.
    file_lyrics = lyric_by_track[melody["idx"]]
    spb_m = 60.0 / bpm
    notes, lyric_rows = [], []
    if file_lyrics:
        li = 0
        for s in seq:
            syl = "-"
            while li < len(file_lyrics) and file_lyrics[li][0] <= s["tick"] + tpb // 8:
                syl = file_lyrics[li][1]
                li += 1
            if syl != "-":
                lyric_rows.append({"t": round(warp(s["tick"] / tpb) * spb_m, 3),
                                   "d": round(s["beats"] * spb_m, 3), "syl": syl})
            notes.append({"syl": syl if notes or syl != "-" else "라",
                          "note": s["note"], "beats": s["beats"], "vel": s.get("vel")})
    else:
        syls = [ch for ch in str(lyrics or "") if not ch.isspace()]
        for i, s in enumerate(seq):
            syl = syls[i] if i < len(syls) else ("-" if syls else "라")
            if i < len(syls):
                lyric_rows.append({"t": round(warp(s["tick"] / tpb) * spb_m, 3),
                                   "d": round(s["beats"] * spb_m, 3), "syl": syl})
            notes.append({"syl": syl, "note": s["note"], "beats": s["beats"], "vel": s.get("vel")})

    # Chords off the lowest track (if any candidate besides the melody).
    chords = []
    others = [c for c in cands if c["idx"] != melody["idx"]]
    if others:
        bass = min(others, key=lambda c: c["mean"])["ev"]
        total_beats = sum(n["beats"] for n in notes)
        w = 0.0
        while w < total_beats:
            lo, hi = w * tpb, (w + 2) * tpb
            window = [n for n, s, d, _v in bass if lo <= s < hi]
            if window:
                chords.append({"root": _midi_name(min(window)), "beats": 2})
            elif chords:
                chords[-1]["beats"] += 2
            w += 2

    score = {"bpm": bpm, "notes": notes}
    if lyric_rows:
        score["_lyrics"] = lyric_rows
    if meter is not None and meter != 4:
        score["meter"] = meter
    if chords:
        score["chords"] = chords
    return score, None


# ── MusicXML (전자악보) ────────────────────────────────────────────────────────────────────────

_XML_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_XML_KIND = {"major": "", "minor": "m", "dominant": "7", "dominant-seventh": "7",
             "major-seventh": "maj7", "minor-seventh": "m7", "diminished": "dim",
             "augmented": "aug", "suspended-second": "sus2", "suspended-fourth": "sus4",
             "major-sixth": "6", "minor-sixth": "m6", "": ""}
_XML_DYN = {"ppp": 0.2, "pp": 0.3, "p": 0.45, "mp": 0.55, "mf": 0.65,
            "f": 0.78, "ff": 0.9, "fff": 0.97}


def _strip_ns(tag):
    return tag.rsplit("}", 1)[-1]


def score_media_kind(path):
    """What a score file IS, by content first, extension second. 실측 (월광): the browser did
    not know .mxl's MIME, the upload saved it as .bin, and the extension gate refused a
    perfectly good score. Bytes do not lie: MThd = MIDI, PK = mxl (zip), <?xml = MusicXML."""
    ext = str(path).rsplit(".", 1)[-1].lower() if "." in str(path) else ""
    if ext in ("mid", "midi"):
        return "midi"
    if ext in ("musicxml", "xml", "mxl"):
        return "musicxml"
    try:
        with open(path, "rb") as fh:
            head = fh.read(64)
    except OSError:
        return None
    if head[:4] == b"MThd":
        return "midi"
    if head[:2] == b"PK":
        return "musicxml"  # .mxl is a zip; the reader unzips whatever the name says
    if head.lstrip()[:5] in (b"<?xml", b"<scor"):
        return "musicxml"
    return None


def _xk(el, name):
    return [c for c in el if _strip_ns(c.tag) == name]


def _xk1(el, name):
    k = _xk(el, name)
    return k[0] if k else None


def _xt(el, name, default=None):
    k = _xk1(el, name) if el is not None else None
    return k.text if k is not None and k.text is not None else default


_XML_ART_GATE = {"staccato": 0.4, "staccatissimo": 0.25, "tenuto": 1.05}
_XML_ART_VEL = {"accent": 0.12, "strong-accent": 0.18, "marcato": 0.18}
_XML_UNIT = {"whole": 4.0, "half": 2.0, "quarter": 1.0, "eighth": 0.5, "16th": 0.25}


def _measure_flags(meas):
    """One measure's STRUCTURE marks — repeats, voltas, segno/coda/fine and the jumps. The
    MusicXML spec carries the jumps machine-readably in <sound> attributes."""
    f = {"fwd": False, "bwd": 0, "end_start": set(), "end_stop": False, "segno": False,
         "coda": False, "dacapo": False, "dalsegno": False, "tocoda": False, "fine": False}
    for el in meas:
        tag = _strip_ns(el.tag)
        if tag == "barline":
            rp = _xk1(el, "repeat")
            if rp is not None:
                if rp.get("direction") == "forward":
                    f["fwd"] = True
                elif rp.get("direction") == "backward":
                    f["bwd"] = max(2, int(float(rp.get("times") or 2)))
            for en in _xk(el, "ending"):
                if en.get("type") == "start":
                    for tok in str(en.get("number") or "1").replace(" ", "").split(","):
                        if tok.isdigit():
                            f["end_start"].add(int(tok))
                else:
                    f["end_stop"] = True
        sounds = [el] if tag == "sound" else []
        if tag == "direction":
            sounds += _xk(el, "sound")
            dt = _xk1(el, "direction-type")
            if dt is not None:
                if _xk1(dt, "segno") is not None:
                    f["segno"] = True
                if _xk1(dt, "coda") is not None:
                    f["coda"] = True
        for sn in sounds:
            if sn.get("segno") is not None:
                f["segno"] = True
            if sn.get("coda") is not None:
                f["coda"] = True
            if sn.get("dacapo") == "yes":
                f["dacapo"] = True
            if sn.get("dalsegno") is not None:
                f["dalsegno"] = True
            if sn.get("tocoda") is not None:
                f["tocoda"] = True
            if sn.get("fine") == "yes":
                f["fine"] = True
    return f


def _playback_order(flags):
    """Measure indices in playback order — repeats (times honored), voltas, D.C./D.S. al
    Fine/Coda. Post-jump convention: repeats are not retaken, the LAST volta plays, fine and
    to-coda are honored. Without structure marks this is simply range(n)."""
    n = len(flags)
    order, i, start, pass_no = [], 0, 0, 1
    bwd_taken = {}
    post = seek_coda = False
    while 0 <= i < n and len(order) < 4096:
        f = flags[i]
        if seek_coda:
            if not f["coda"]:
                i += 1
                continue
            seek_coda = False
        if f["fwd"] and not post:
            start = i
        if f["end_start"]:
            want = max(f["end_start"]) if post else pass_no
            if want not in f["end_start"]:
                j = i
                while j < n and not flags[j]["end_stop"]:
                    j += 1
                i = j + 1
                continue
        order.append(i)
        if f["fine"] and post:
            break
        if f["tocoda"] and post:
            seek_coda = True
            i += 1
            continue
        if f["bwd"] and not post:
            cnt = bwd_taken.get(i, 0) + 1
            bwd_taken[i] = cnt
            if cnt < f["bwd"]:
                pass_no = cnt + 1
                i = start
                continue
            pass_no = 1
            start = i + 1
        if (f["dacapo"] or f["dalsegno"]) and not post:
            post = True
            i = 0 if f["dacapo"] else next((j for j, g in enumerate(flags) if g["segno"]), 0)
            continue
        i += 1
    return order


def _warp_fn(tempo_events, master):
    """raw quarter-beats -> beats at the master tempo, piecewise linear. This is how one
    constant-tempo renderer plays a piece whose tempo CHANGES: time itself is pre-bent."""
    evs = sorted((t, b) for t, b in tempo_events if b > 0)
    if not evs or all(abs(b - master) < 1e-9 for _, b in evs):
        return lambda raw: raw
    segs, wpos, prev_t, prev_b = [], 0.0, 0.0, master
    for t, b in evs:
        if t > prev_t:
            segs.append((prev_t, wpos, master / prev_b))
            wpos += (t - prev_t) * (master / prev_b)
            prev_t = t
        prev_b = b
    segs.append((prev_t, wpos, master / prev_b))

    def warp(raw):
        lo = segs[0]
        for seg in segs:
            if seg[0] <= raw:
                lo = seg
            else:
                break
        return lo[1] + (raw - lo[0]) * lo[2]
    return warp


def _diatonic_neighbors(fifths, pitch):
    """Upper/lower neighbor in semitones for this pitch IN THIS KEY — what players and every
    notation program's playback use. A fixed whole tone was OUR number: in E major (월광's
    signature) a G# trill alternates with A, a semitone, not A#."""
    tonic = (7 * (fifths or 0)) % 12
    scale = {(tonic + step) % 12 for step in (0, 2, 4, 5, 7, 9, 11)}
    pc = pitch % 12
    up = 1 if (pc + 1) % 12 in scale else 2
    down = 1 if (pc - 1) % 12 in scale else 2
    return up, down


def _ornament_rows(row, kind, up=2, down=2):
    """A trill/mordent/turn written as the little notes it means. Neighbors are diatonic
    (the caller passes them from the key signature); the mordent direction follows the sign —
    <mordent> beats DOWN, <inverted-mordent> beats UP (the Pralltriller)."""
    beat, dur, pitch = row["beat"], row["beats"], row["pitch"]
    mk = lambda b, d, pt: dict(row, beat=b, beats=d, pitch=max(0, min(127, pt)))
    if kind == "trill":
        step = 0.125
        n = max(4, min(16, int(dur / step)))
        d = dur / n
        return [mk(beat + k * d, d, pitch + (up if k % 2 else 0)) for k in range(n)]
    if kind in ("mordent", "mordent_up"):
        d = min(0.1, dur / 4)
        nb = pitch + up if kind == "mordent_up" else pitch - down
        return [mk(beat, d, pitch), mk(beat + d, d, nb),
                mk(beat + 2 * d, dur - 2 * d, pitch)]
    if kind == "turn":
        d = dur / 4
        return [mk(beat, d, pitch + up), mk(beat + d, d, pitch),
                mk(beat + 2 * d, d, pitch - down), mk(beat + 3 * d, d, pitch)]
    return [row]


# A part that says what it is. A multi-part score names its staves, and "Voice" is not a hint we
# are guessing at — it is the arranger telling us which line is the song. Before this the lead was
# picked by note COUNT among the lyric-less parts, so an accompaniment that plays more notes than
# the singer sings won: 실측 8/20, 아로하 (Voice 536 notes vs Piano 968) came out with the piano's
# right hand as the lead, in every style, and the melody wandered above and below the vocal line
# because it was never the vocal line.
VOCAL_PART_HINTS = ("voice", "vocal", "vox", "lead", "melody", "sing", "singer", "song", "tune",
                    "노래", "보컬", "가창", "멜로디", "주선율", "리드")
ACCOMP_PART_HINTS = ("piano", "guitar", "gtr", "bass", "drum", "perc", "strings", "synth",
                     "organ", "pad", "accomp", "반주", "피아노", "기타", "베이스", "드럼")


def part_is_vocal(name):
    """2 = the part says it is the song · 1 = it says nothing · 0 = it names an instrument."""
    n = "".join(ch for ch in str(name or "").casefold() if ch.isalnum() or ord(ch) > 127)
    if not n:
        return 1
    if any(h in n for h in VOCAL_PART_HINTS):
        return 2
    if any(h in n for h in ACCOMP_PART_HINTS):
        return 0
    return 1


def _wanted_part(parts, want):
    """The caller naming a part by id or by (part of) its name. None = not asked, or no match."""
    w = "".join(ch for ch in str(want or "").casefold() if ch.isalnum() or ord(ch) > 127)
    if not w:
        return None
    for pp in parts:
        pid = str(pp.get("id") or "").casefold()
        nm = "".join(ch for ch in str(pp.get("name") or "").casefold()
                     if ch.isalnum() or ord(ch) > 127)
        if w == pid or (nm and (w in nm or nm in w)):
            return pp
    return None


def _pitched(rows):
    """Rows that are notes. A rest carries length, not a voice, so nothing that measures how much
    a part PLAYS may count it — least of all the tiebreak that decides which part is the tune."""
    return [r for r in rows if not r.get("rest")]


def musicxml_to_score(path, lyrics=None, parts_out=None, want_part=None):
    """MusicXML (.musicxml/.xml/.mxl) -> score. The whole notation plays (사용자: "악보에 있는
    건 다 구현해줘"): repeats/voltas/D.C./D.S./coda/fine expand the playback order; tempo
    changes and metronome marks bend time onto one master tempo; 8va and transposing
    instruments correct the sounding pitch; wedges ramp the dynamics between steps;
    staccato/accent/tenuto shape gate and weight; grace notes steal their moment; trills,
    mordents and turns play as the notes they mean; fermatas hold; arpeggios roll; pedal
    marks become real CC64 downstream. Melody part = the one carrying lyrics, else the
    busiest; chord symbols come from <harmony>."""
    import xml.etree.ElementTree as ET
    import zipfile
    try:
        with open(path, "rb") as fh:
            is_zip = fh.read(2) == b"PK"
        if is_zip:
            with zipfile.ZipFile(path) as z:
                inner = [n for n in z.namelist()
                         if n.lower().endswith((".xml", ".musicxml"))
                         and not n.startswith("META-INF")]
                if not inner:
                    return None, "mxl 안에 악보 xml 이 없습니다"
                root = ET.fromstring(z.read(inner[0]))
        else:
            root = ET.parse(path).getroot()
    except Exception as e:  # noqa: BLE001 — a broken upload should name itself, not crash
        return None, f"MusicXML parse failed: {e}"
    if _strip_ns(root.tag) == "score-timewise":
        return None, "score-timewise 형은 아직 안 받습니다 — MuseScore 에서 partwise 로 저장하세요"

    kids, kid, text_of = _xk, _xk1, _xt
    parts = kids(root, "part")
    if not parts:
        return None, "MusicXML 에 part 가 없습니다"

    prog_of, unp_of = {}, {}
    pl = kid(root, "part-list")
    name_of = {}
    for sp in (kids(pl, "score-part") if pl is not None else []):
        name_of[sp.get("id")] = (text_of(sp, "part-name") or "").strip()
        for mi2 in kids(sp, "midi-instrument"):
            mp = text_of(mi2, "midi-program")
            mu = text_of(mi2, "midi-unpitched")
            if mp and sp.get("id") and sp.get("id") not in prog_of:
                try:
                    prog_of[sp.get("id")] = max(0, min(127, int(mp) - 1))
                except ValueError:
                    pass
            if mu and mi2.get("id"):
                try:
                    unp_of[mi2.get("id")] = int(mu) - 1  # spec: 1-based MIDI note
                except ValueError:
                    pass
    skipped = {}

    def skip_mark(what):
        skipped[what] = skipped.get(what, 0) + 1

    order = _playback_order([_measure_flags(m) for m in kids(parts[0], "measure")])

    meter = None
    tempo_events = []  # (raw beats, bpm) — collected on part 0's walk
    parsed_parts = []
    for pi, part in enumerate(parts):
        divisions = 1.0
        vel_by_staff = {}  # dynamics are written PER STAFF (실측 월광: pp 는 오른손 보표의
        # 것인데 문서 순서대로 전 성부에 들러붙어 왼손이 더 커졌다 — 악보가 아니라 우리
        # 부산물). staff 없는 지시는 "1" 로.
        notes, harmonies, pos = [], [], 0.0
        lead_voice = None
        f_prog = prog_of.get(part.get("id"), 0)
        f_part = f"p{pi + 1}"
        last_onset, stack_n, arp_here = 0.0, 0, False
        pedal_down = None
        shift = 0      # octave-shift (8va/8vb), in semitones
        cur_fifths = 0  # key signature — ornament neighbors are DIATONIC, not fixed intervals
        transpose = 0  # transposing instruments, in semitones
        graces = []    # pending grace pitches awaiting their host note
        wedges = []    # (raw pos, "c"|"d"|"stop")
        dyn_events = []  # (raw pos, vel)
        measures = kids(part, "measure")
        for mi_idx in (order if len(order) else range(len(measures))):
            meas = measures[mi_idx]
            m_base, cur, m_len = pos, 0.0, 0.0
            for el in meas:
                tag = _strip_ns(el.tag)
                if tag == "attributes":
                    d = text_of(el, "divisions")
                    if d:
                        divisions = float(d)
                    k_el = kid(el, "key")
                    if k_el is not None:
                        try:
                            cur_fifths = int(text_of(k_el, "fifths") or 0)
                        except ValueError:
                            pass
                    t = kid(el, "time")
                    if t is not None and meter is None:
                        try:
                            nnum = int(text_of(t, "beats") or 0)
                            meter = nnum if 2 <= nnum <= 12 else meter
                        except ValueError:
                            pass
                    tr_el = kid(el, "transpose")
                    if tr_el is not None:
                        transpose = int(float(text_of(tr_el, "chromatic") or 0))                             + 12 * int(float(text_of(tr_el, "octave-change") or 0))
                elif tag == "direction":
                    d_staff = _xt(el, "staff", "1") or "1"
                    snd = kid(el, "sound")
                    if snd is not None and snd.get("tempo") and pi == 0:
                        tempo_events.append((m_base + cur, float(snd.get("tempo"))))
                    dt = kid(el, "direction-type")
                    if dt is not None:
                        dyn = kid(dt, "dynamics")
                        if dyn is not None and len(dyn):
                            v_new = _XML_DYN.get(_strip_ns(dyn[0].tag),
                                                 vel_by_staff.get(d_staff))
                            vel_by_staff[d_staff] = v_new
                            dyn_events.append((m_base + cur, v_new, d_staff))
                        met = kid(dt, "metronome")
                        if met is not None and pi == 0 and snd is None:
                            unit = _XML_UNIT.get((text_of(met, "beat-unit") or "quarter"), 1.0)
                            if kid(met, "beat-unit-dot") is not None:
                                unit *= 1.5
                            try:
                                pm = float(text_of(met, "per-minute") or 0)
                                if pm > 0:
                                    tempo_events.append((m_base + cur, pm * unit))
                            except ValueError:
                                pass
                        wd = kid(dt, "words")
                        if wd is not None and wd.text:
                            import re as _re
                            if _re.search(r"\b(rit|rall|accel)", wd.text.lower()):
                                skip_mark(f"문자 템포({wd.text.strip()[:12]})")
                        wg = kid(dt, "wedge")
                        if wg is not None:
                            wt = (wg.get("type") or "").lower()
                            wedges.append((m_base + cur,
                                           "c" if wt == "crescendo"
                                           else "d" if wt == "diminuendo" else "stop",
                                           d_staff))
                        osh = kid(dt, "octave-shift")
                        if osh is not None:
                            ot = (osh.get("type") or "").lower()
                            size = int(float(osh.get("size") or 8))
                            semis = 12 if size <= 8 else 24
                            # spec: type="down" = 8va bracket, notes SOUND higher
                            shift = semis if ot == "down" else (-semis if ot == "up" else 0)
                        ped = kid(dt, "pedal") if dt is not None else None
                        if ped is not None and parts_out is not None:
                            ptype = (ped.get("type") or "start").lower()
                            now = m_base + cur
                            if ptype in ("start", "resume", "sostenuto"):
                                if pedal_down is None:
                                    pedal_down = now
                            elif ptype in ("stop", "discontinue", "change"):
                                if pedal_down is not None and now > pedal_down:
                                    parts_out.append({"beat": pedal_down,
                                                      "beats": now - pedal_down,
                                                      "part": f_part, "pedal": True})
                                pedal_down = now if ptype == "change" else None
                elif tag == "sound" and el.get("tempo") and pi == 0:
                    tempo_events.append((m_base + cur, float(el.get("tempo"))))
                elif tag == "harmony":
                    hr = kid(el, "root")
                    if hr is not None:
                        step = (text_of(hr, "root-step") or "C").strip().upper()
                        alter = int(float(text_of(hr, "root-alter") or 0))
                        kind_t = (text_of(el, "kind") or "").strip()
                        harmonies.append((m_base + cur, _XML_STEP.get(step, 0) + alter,
                                          _XML_KIND.get(kind_t, "")))
                elif tag in ("backup", "forward"):
                    d = float(text_of(el, "duration") or 0) / divisions
                    cur += d if tag == "forward" else -d
                    cur = max(0.0, cur)
                elif tag == "note":
                    dur = float(text_of(el, "duration") or 0) / divisions
                    is_grace = kid(el, "grace") is not None
                    unp = kid(el, "unpitched")
                    if unp is not None:
                        # A drum staff writes unpitched notes; the score-part's midi-unpitched
                        # map says which GM drum each one IS (밴드스코어의 드럼 채보).
                        inst = kid(el, "instrument")
                        nn = unp_of.get(inst.get("id")) if inst is not None else None
                        dname = _NOTE_DRUM.get(nn) if nn is not None else None
                        st = kid(el, "chord") is not None
                        onset = last_onset if st else m_base + cur
                        if not st:
                            last_onset = onset
                        uly = kid(el, "lyric")
                        usyl = (text_of(uly, "text") or "").strip() if uly is not None else ""
                        u_staff = _xt(el, "staff", "1") or "1"
                        uv = vel_by_staff.get(u_staff, vel_by_staff.get("1"))
                        if usyl:
                            # A rhythm-lyric lead sheet (실측 아로하: 가사 344개가 슬래시 음표에
                            # 얹혀 멜로디 음고가 없다): the slash carries WHEN, the lyric carries
                            # WHAT. The display pitch keeps the row nominally renderable; the
                            # real product is timing + syllable, which the LRC lane reads.
                            uvoice = text_of(el, "voice")
                            if lead_voice is None:
                                lead_voice = uvoice
                            already = st and notes and notes[-1].get("_at") == onset
                            if uvoice == lead_voice and not already:
                                d_step = (text_of(unp, "display-step") or "B").strip().upper()
                                d_oct = int(text_of(unp, "display-octave") or 4)
                                nom = (12 * (d_oct + 1) + _XML_STEP.get(d_step, 0)
                                       + shift + transpose)
                                notes.append({"midi": nom, "beats": dur, "syl": usyl,
                                              "vel": uv if uv is not None else 0.65,
                                              "_at": onset, "_st": u_staff, "_sung": dur,
                                              "_unp": True})
                        elif dname and parts_out is not None:
                            parts_out.append({"beat": onset, "beats": 0.25, "part": "drum",
                                              "drum": dname,
                                              "vel": uv if uv is not None else 0.7})
                        elif parts_out is not None:
                            skip_mark("드럼(매핑 없음)")
                        if not st:
                            cur += dur
                            m_len = max(m_len, cur)
                        continue
                    if kid(el, "rest") is not None:
                        # A rest is silence, not a longer note. Folding it into the previous note
                        # held every phrase through its own breath, and a rest with NO previous
                        # note — the intro — disappeared entirely, taking the timeline with it
                        # (실측 8/20: 아로하 lost its 간주 and ran 13s short the moment the lead
                        # became the Voice part, which is the part that actually rests).
                        if notes and notes[-1].get("rest"):
                            notes[-1]["beats"] += dur
                        else:
                            notes.append({"rest": True, "beats": dur, "syl": "", "_at": cur})
                        cur += dur
                        m_len = max(m_len, cur)
                        continue
                    p2 = kid(el, "pitch")
                    if p2 is None or (dur <= 0 and not is_grace):
                        cur += max(dur, 0.0)
                        m_len = max(m_len, cur)
                        continue
                    step = (text_of(p2, "step") or "C").strip().upper()
                    octave = int(text_of(p2, "octave") or 4)
                    alter = int(float(text_of(p2, "alter") or 0))
                    midi = 12 * (octave + 1) + _XML_STEP.get(step, 0) + alter                         + shift + transpose
                    if is_grace:
                        graces.append(midi)
                        continue
                    nots = kid(el, "notations")
                    arts = kid(nots, "articulations") if nots is not None else None
                    gate, vboost = 1.0, 0.0
                    if arts is not None:
                        for a in arts:
                            gate = min(gate, _XML_ART_GATE.get(_strip_ns(a.tag), 1.0))
                            vboost = max(vboost, _XML_ART_VEL.get(_strip_ns(a.tag), 0.0))
                    orn = kid(nots, "ornaments") if nots is not None else None
                    orn_kind = None
                    if orn is not None:
                        for o in orn:
                            ot = _strip_ns(o.tag)
                            if ot == "trill-mark":
                                orn_kind = "trill"
                            elif ot == "inverted-mordent":
                                orn_kind = "mordent_up"
                            elif "mordent" in ot:
                                orn_kind = "mordent"
                            elif ot == "turn":
                                orn_kind = "turn"
                            elif ot == "tremolo":
                                skip_mark("트레몰로")
                    if nots is not None and (_xk1(nots, "glissando") is not None
                                             or _xk1(nots, "slide") is not None):
                        skip_mark("글리산도")
                    fermata = nots is not None and _xk1(nots, "fermata") is not None
                    if fermata:
                        dur *= 1.75
                    arp = nots is not None and _xk1(nots, "arpeggiate") is not None
                    ly = kid(el, "lyric")
                    syl = (text_of(ly, "text") or "").strip() if ly is not None else ""
                    tie = any(t.get("type") == "stop" for t in kids(el, "tie"))
                    is_stack = kid(el, "chord") is not None
                    if is_stack:
                        stack_n += 1
                    else:
                        stack_n = 0
                        arp_here = arp
                    onset = last_onset if is_stack else m_base + cur
                    roll_n = stack_n if (is_stack and (arp_here or arp)) else 0
                    if not is_stack:
                        last_onset = onset
                    n_staff = _xt(el, "staff", "1") or "1"
                    st_vel = vel_by_staff.get(n_staff, vel_by_staff.get("1"))
                    nvel = min(1.0, (st_vel if st_vel is not None else 0.65) + vboost)
                    if parts_out is not None:
                        stolen = 0.0
                        if graces and not is_stack:
                            take = min(0.1 * len(graces), dur * 0.4)
                            per = take / len(graces)
                            for gi, gp in enumerate(graces):
                                parts_out.append({"beat": onset + gi * per, "beats": per,
                                                  "part": f_part,
                                                  "patch": _patch_for_program(f_prog),
                                                  "program": f_prog, "pitch": gp,
                                                  "vel": max(0.1, nvel - 0.1), "gate": 0.9})
                            stolen = take
                        base_row = {"beat": onset + stolen, "beats": max(0.125, dur - stolen),
                                    "part": f_part, "patch": _patch_for_program(f_prog),
                                    "program": f_prog, "pitch": midi, "vel": nvel,
                                    "gate": gate, "staff": n_staff}
                        if roll_n:
                            # A rolled chord is a hand gesture — constant in TIME. The old
                            # 0.04-beat step made 월광 (bpm 44) roll 55ms per voice; applied
                            # after the warp below, in seconds.
                            base_row["_roll"] = roll_n
                        if (tie and parts_out and parts_out[-1]["part"] == f_part
                                and parts_out[-1].get("pitch") == midi
                                and not parts_out[-1].get("pedal")):
                            parts_out[-1]["beats"] += dur
                        elif orn_kind:
                            parts_out.extend(_ornament_rows(
                                base_row, orn_kind,
                                *_diatonic_neighbors(cur_fifths, midi)))
                        else:
                            parts_out.append(base_row)
                    graces = [] if not is_stack else graces
                    if is_stack:
                        continue
                    cur += float(text_of(el, "duration") or 0) / divisions
                    m_len = max(m_len, cur)
                    voice = text_of(el, "voice")
                    if lead_voice is None:
                        lead_voice = voice
                    if voice != lead_voice:
                        continue
                    if tie and notes and notes[-1].get("midi") == midi:
                        notes[-1]["beats"] += dur
                        notes[-1]["_sung"] = notes[-1].get("_sung", 0.0) + dur
                    else:
                        notes.append({"midi": midi, "beats": dur, "syl": syl, "vel": nvel,
                                      "_at": onset, "_st": n_staff, "_sung": dur})
            pos = m_base + m_len
        if pedal_down is not None and parts_out is not None and pos > pedal_down:
            parts_out.append({"beat": pedal_down, "beats": pos - pedal_down,
                              "part": f_part, "pedal": True})
        # wedges ramp between the stepped dynamics on either side
        for wi, (wstart, wkind, wstaff) in enumerate(wedges):
            if wkind == "stop":
                continue
            wstop = next((t for t, k, st in wedges[wi + 1:] if k == "stop" and st == wstaff),
                         wstart + 4.0)
            v0 = 0.65
            for t, v, st in dyn_events:
                if t <= wstart and st == wstaff:
                    v0 = v
            v1 = next((v for t, v, st in dyn_events
                       if t >= wstop - 0.25 and st == wstaff),
                      min(1.0, max(0.1, v0 + (0.15 if wkind == "c" else -0.15))))
            span = max(1e-9, wstop - wstart)
            for row in (parts_out or []):
                if (row.get("part") == f_part and not row.get("pedal")
                        and row.get("staff") == wstaff and wstart <= row["beat"] < wstop):
                    row["vel"] = round(v0 + (v1 - v0) * (row["beat"] - wstart) / span, 3)
            for nrow in notes:
                if nrow.get("_st") == wstaff and wstart <= nrow.get("_at", -1) < wstop:
                    nrow["vel"] = round(v0 + (v1 - v0) * (nrow["_at"] - wstart) / span, 3)
        if notes:
            parsed_parts.append({"notes": notes, "harmonies": harmonies,
                                 "id": part.get("id"), "name": name_of.get(part.get("id"), ""),
                                 "lyrics": sum(1 for n in notes if n["syl"]),
                                 "unp": sum(1 for n in notes if n.get("_unp"))})
    if not parsed_parts:
        return None, "MusicXML 에서 음표를 못 읽었습니다"

    master = tempo_events[0][1] if tempo_events else 120.0
    warp = _warp_fn(tempo_events, master)
    if parts_out is not None:
        spb_w = 60.0 / max(20.0, min(300.0, master))
        for row in parts_out:
            b0, b1 = row["beat"], row["beat"] + row["beats"]
            row["beat"] = round(warp(b0), 4)
            row["beats"] = max(0.06, round(warp(b1) - warp(b0), 4))
            rl = row.pop("_roll", 0)
            if rl:
                row["beat"] = round(row["beat"] + rl * (0.022 / spb_w), 4)
    # Lyrics first (a part with words IS the song), then what the part CALLS itself, and only
    # then the note count. Count alone hands the tune to whoever plays the most notes.
    best = (_wanted_part(parsed_parts, want_part)
            or max(parsed_parts, key=lambda pp: (pp["lyrics"], part_is_vocal(pp["name"]),
                                                 len(_pitched(pp["notes"])))))

    lyr = list(str(lyrics or "").replace(" ", "").replace("\n", ""))
    has_own = best["lyrics"] > 0
    has_caller = bool(lyr)
    lyric_only = bool(best.get("unp")) and best["unp"] == len(_pitched(best["notes"]))
    spb_m = 60.0 / max(20.0, min(300.0, master))
    out_notes, lyric_rows = [], []
    for n in best["notes"]:
        at = n.pop("_at", None)
        if n.get("rest"):
            # Silence travels as its own row: it has a length and no pitch, and the reader that
            # consumes this list turns it into the gap before the next sung note.
            span = n["beats"]
            if at is not None:
                span = max(0.0625, warp(at + span) - warp(at))
            if out_notes and out_notes[-1].get("rest"):
                out_notes[-1]["beats"] = min(256.0, out_notes[-1]["beats"] + span)
            else:
                out_notes.append({"rest": True, "beats": min(256.0, round(span * 4) / 4)})
            continue
        sung = n.pop("_sung", n["beats"])
        n.pop("_st", None)
        n.pop("_unp", None)
        beats = n["beats"]
        if at is not None:
            beats = max(0.25, warp(at + beats) - warp(at))
        if has_own:
            syl = n["syl"] or "-"
        elif lyr:
            syl = lyr.pop(0) if lyr else "-"
        else:
            syl = "라"
        if at is not None and syl != "-" and (has_own or has_caller):
            # The LRC lane: absolute seconds on the warped clock, sung length only (a rest
            # extends the row's beats for playback but is silence to a lyric line).
            lyric_rows.append({"t": round(warp(at) * spb_m, 3),
                               "d": round(max(0.0, warp(at + sung) - warp(at)) * spb_m, 3),
                               "syl": syl})
        row = {"syl": syl, "note": _midi_name(n["midi"]),
               "beats": min(64.0, round(beats * 4) / 4)}
        if n["vel"] is not None:
            row["vel"] = n["vel"]
        out_notes.append(row)
    score = {"bpm": max(20.0, min(300.0, master)), "notes": out_notes}
    # Which line became the tune, and what else was on offer. A wrong pick used to be silent —
    # the render just sounded like a different song and nothing in the reply said why.
    if len(parsed_parts) > 1:
        score["_leadPart"] = best.get("name") or best.get("id") or ""
        score["_partsSeen"] = [
            f"{pp.get('name') or pp.get('id') or '?'}({len(_pitched(pp['notes']))})"
            for pp in parsed_parts]
    if lyric_rows:
        score["_lyrics"] = lyric_rows
    if lyric_only:
        score["_unpitchedMelody"] = True
    if skipped:
        score["_notation_skipped"] = skipped
    if meter is not None and meter != 4:
        score["meter"] = meter
    hs = best["harmonies"] or next((pp["harmonies"] for pp in parsed_parts
                                    if pp["harmonies"]), [])
    if not hs and len(parsed_parts) > 1:
        # No chord symbols written — read the harmony off the lowest part, lowest note per
        # 2-beat window, the exact recipe the MIDI reader has always used. Without this an
        # arranged render of a symbol-less score was a naked melody (실측: 월광 15:15).
        low = min((pp for pp in parsed_parts if pp is not best and _pitched(pp["notes"])),
                  key=lambda pp: (sum(n["midi"] for n in _pitched(pp["notes"]))
                                  / len(_pitched(pp["notes"]))))
        buckets = {}
        for n in _pitched(low["notes"]):
            at = n.get("_at")
            if at is None:
                continue
            buckets.setdefault(int(warp(at) // 2), []).append(n["midi"])
        chords, prev_root = [], None
        for k in range(min(buckets), max(buckets) + 1) if buckets else []:
            root = min(buckets[k]) if buckets.get(k) else prev_root
            if root is None:
                continue
            if chords and root == prev_root:
                chords[-1]["beats"] += 2
            else:
                chords.append({"root": _midi_name(root), "beats": 2})
            prev_root = root
        if chords:
            score["chords"] = chords
    if hs:
        chords, total = [], sum(n["beats"] for n in out_notes)
        for i, (at, pc, qual) in enumerate(hs):
            end = hs[i + 1][0] if i + 1 < len(hs) else max(total, at + 4)
            b0, b1 = warp(at), warp(end)
            beats = round((b1 - b0) * 4) / 4
            if beats > 0:
                chords.append({"root": _midi_name(36 + pc), "beats": beats, "quality": qual})
        if chords:
            score["chords"] = chords
    return score, None


def _lrc_ts(t):
    t = max(0.0, t)
    m = int(t // 60)
    return f"{m:02d}:{t - 60 * m:05.2f}"


def build_lrc(lyric_rows, spb, offset=0.0, title=None):
    """Enhanced LRC (a line tag plus per-syllable <..> tags) from parsed syllable rows.

    Lines break on musical gaps (~a beat of silence between sung notes). Korean scores carry
    no word boundaries (실측 아로하: syllabic 전부 single, 공백 0), so syllables join bare —
    timing is the product here; pretty spacing belongs to imported .lrc files."""
    gap = max(0.45, spb * 0.9)
    lines, cur = [], []
    for r in lyric_rows:
        if cur and r["t"] - (cur[-1]["t"] + cur[-1]["d"]) >= gap:
            lines.append(cur)
            cur = []
        cur.append(r)
    if cur:
        lines.append(cur)
    out = []
    if title:
        out.append(f"[ti:{title}]")
    for line in lines:
        head = _lrc_ts(line[0]["t"] + offset)
        body = "".join(f"<{_lrc_ts(r['t'] + offset)}>{r['syl']}" for r in line)
        out.append(f"[{head}]{body}")
    return "\n".join(out) + "\n"


def shift_lrc(text, offset):
    """Re-stamp every [mm:ss.xx] / <mm:ss.xx> tag by offset seconds — the 전체 땡기기: MP3
    versions differ by intro/outro length, the body timing holds. Metadata tags ([ti:] etc.)
    have no digit:digit shape, so they pass untouched."""
    import re as _re

    def _sub(m):
        t = max(0.0, int(m.group(2)) * 60 + float(m.group(3)) + offset)
        mm = int(t // 60)
        return f"{m.group(1)}{mm:02d}:{t - 60 * mm:05.2f}{m.group(4)}"

    return _re.sub(r"([\[<])(\d+):(\d+(?:\.\d+)?)([\]>])", _sub, text)


def read_lrc_text(path):
    """Korean LRC files in the wild are as often CP949 as UTF-8 — decode both, emit UTF-8."""
    b = open(path, "rb").read()
    if b.startswith(b"\xef\xbb\xbf"):
        b = b[3:]
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp949", "replace")


def _lrclib_search(query):
    """lrclib.net — the open synced-lyrics well (the modern heir of the Winamp lyric
    plugins). No key, one GET."""
    import urllib.parse
    import urllib.request
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": str(query)})
    req = urllib.request.Request(url, headers={"User-Agent": "firebat-sing/0.1"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _rank_lrc(rows, duration=None):
    """Synced entries only; closest duration first when a target is known — the version
    question (the same song exists in several cuts) is a duration question."""
    synced = [r for r in rows if isinstance(r, dict) and r.get("syncedLyrics")]
    if duration:
        synced.sort(key=lambda r: abs(float(r.get("duration") or 0) - float(duration)))
    return synced


def _fetch_lrc(query, duration=None):
    """query -> (path, meta, err), cached by query slug: the same karaoke re-renders
    offline, and '가사 밀어줘' never waits on the network twice."""
    os.makedirs("data/sing/lrc", exist_ok=True)
    slug = _slug_name(query) or "lyrics"
    path = f"data/sing/lrc/{slug}.lrc"
    meta_p = f"data/sing/lrc/{slug}.json"
    if os.path.isfile(path) and os.path.isfile(meta_p):
        try:
            return path, json.load(open(meta_p, encoding="utf-8")), None
        except ValueError:
            pass
    try:
        rows = _lrclib_search(query)
    except Exception as e:  # URLError/timeout/bad JSON — the caller's note says the next move
        return None, None, f"lrclib 검색 실패: {e} — lyricsMediaPath 로 직접 주셔도 됩니다"
    best = (_rank_lrc(rows, duration) or [None])[0]
    if not best:
        return None, None, (f"lrclib 에 {query!r} 의 싱크 가사가 없습니다 — 표기를 바꿔 보거나 "
                            ".lrc 를 lyricsMediaPath 로 직접 주세요")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(str(best["syncedLyrics"]).strip() + "\n")
    meta = {"artist": best.get("artistName"), "track": best.get("trackName"),
            "duration": best.get("duration"), "source": "lrclib"}
    with open(meta_p, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    return path, meta, None


def lrc_from_file(lpath, offset, title=None):
    """A lyrics FILE -> finished .lrc text: MusicXML/MIDI parse to syllable timing; a
    ready-made .lrc keeps its own lines (they carry word spacing our scores do not) and is
    re-stamped only. Shared by render's lane and the lyrics action — one reader, two doors."""
    head = open(lpath, "rb").read(64)
    kind = score_media_kind(lpath)
    if kind == "midi":
        sc, e = midi_to_score(lpath)
    elif kind:
        sc, e = musicxml_to_score(lpath)
    elif head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"["):
        return shift_lrc(read_lrc_text(lpath), offset), None
    else:
        return None, (f"lyricsMediaPath 를 읽을 수 없습니다: {lpath} — MusicXML/MIDI 악보나 "
                      ".lrc 텍스트만 받습니다")
    if e:
        return None, f"lyricsMediaPath parse: {e}"
    rows = sc.pop("_lyrics", None) if isinstance(sc, dict) else None
    if not rows:
        return None, ("lyricsMediaPath 악보에 가사가 없습니다 — lyric 이 달린 악보(리듬-가사 "
                      "리드시트, 노래방 MIDI)나 .lrc 파일을 주세요")
    return build_lrc(rows, 60.0 / float(sc.get("bpm") or 120.0),
                     offset=offset, title=title), None


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
    """Alias comparison key — only letters and digits are identity: case, spacing, hyphens and
    underscores are all spelling ("take-five" == "take five" == "TakeFive", 실측 미스)."""
    return "".join(ch for ch in str(s or "").casefold() if ch.isalnum())


def action_scores(inp=None):
    """The shelf as a first-class action — the model LOOKS UP what is shelved instead of
    guessing an alias and fishing the list out of an error (사용자: 낚시는 계단이 아니다).
    `query` filters by normalized substring (alias or filename); omitted = the whole shelf."""
    shelf = score_library()
    q = _norm_name((inp or {}).get("query"))
    rows = [{"alias": r.get("alias") or r.get("name"), "name": r.get("name")} for r in shelf
            if not q or q in _norm_name(r.get("alias")) or q in _norm_name(r.get("name"))]
    note = ("pass one alias as render's scoreMediaPath to play it — style/band/drumPattern "
            "may ride in the SAME render call to re-instrument the piece (no need to "
            "compose a score for an existing song)")
    sem = ((inp or {}).get("_collectionMatches") or {}).get("query") or []
    if q and not rows and sem:
        rows = [{"alias": r.get("alias") or r.get("name"), "name": r.get("name"),
                 "score": r.get("score")} for r in sem]
        note = ("semantic matches — the spelling differed but the meaning matched (한↔영 포함); "
                + note)
    elif q and not rows and shelf:
        # A missed query must not read as an empty shelf: matching is by CHARACTERS, and a
        # Korean request for an English alias ("테이크 파이브" vs "take five") misses every
        # time. The miss carries the whole shelf, so "no match" is a discovery, not a verdict.
        rows = [{"alias": r.get("alias") or r.get("name"), "name": r.get("name")}
                for r in shelf][:50]
        note = ("no match for that query — matching is by characters, and Korean/English "
                "spellings differ. The WHOLE shelf is listed above; if the user means one of "
                "these (any language), " + note)
    return {"success": True, "data": {"count": len(rows), "scores": rows, "note": note}}


def resolve_score_media(inp, key="scoreMediaPath"):
    """scoreMediaPath input = a media URL, a workspace path, or the ALIAS of a shelved score.

    Matching ignores case and spacing, and tries alias, filename and filename-without-extension.
    Misses point to the `scores` action rather than dumping the shelf into the error.
    `key` widens the same lane to lyricsMediaPath — one shelf, one matching, two doors.
    """
    raw = str(inp.get(key) or "").strip()
    shelf = score_library()
    if raw:
        wanted = _norm_name(raw)
        for row in shelf:
            name = str(row.get("name") or "")
            stem = name.rsplit(".", 1)[0]
            if wanted in (_norm_name(row.get("alias")), _norm_name(name), _norm_name(stem)):
                return _media_to_path(str(row["url"]))
        sem = ((inp.get("_collectionMatches") or {}).get(key) or [])
        if sem and sem[0].get("url"):
            # The framework's semantic lane: characters missed ("테이크 파이브" vs "take five")
            # but meaning matched. Top row only — deterministic, and the shelf error below stays
            # the floor when the lane is absent (old binary, no embedder, empty shelf).
            return _media_to_path(str(sem[0]["url"]))
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


# Bytes per sample-frame once encoded — measured on a 245s render (43.2MB wav → 23.8MB flac →
# 4.5MB mp3). The mp3 number is why a full piece no longer has to be split at all.
_FMT_BYTES = {"wav": 4.0, "flac": 2.2, "mp3": 0.42, "opus": 0.30}


def _movement_bounds(n_samples, spb, meter, fmt="flac"):
    """[(start, end)] sample slices, bar-aligned, each expected to fit the media door."""
    cap = 48 * 1024 * 1024
    est = int(n_samples * _FMT_BYTES.get(fmt, 2.2))
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


def _display_name(stem):
    """The name a person reads in the media library — the file's stem without the hash we
    salted it with. The hash keeps two takes of one piece from overwriting each other on disk;
    in a list it only pushes the title out of view (실측 8/19: four renders of 아로하 all read
    as "아로" in the gallery, because a narrow cell fills up before the hash ends)."""
    parts = stem.split("-")
    while len(parts) > 1 and len(parts[-1]) in (4, 6, 10) and all(
            ch in "0123456789abcdef" for ch in parts[-1].lower()):
        parts.pop()
    return "-".join(parts) or stem


def _out_path_for(requested, score, engine_used, n_samples, base=None, fmt="flac"):
    """The render's file name and container.

    `fmt` is the caller's choice; flac is the default. Measured on a 245s MR at 48k: wav 47.1MB
    · flac 24.4MB in 0.4s · opus 3.7MB in 7.9s · mp3 4.6MB in 8.3s. The lossy pair is far smaller
    but costs twenty times the CPU to write, and this server is small — flac halves the disk for
    almost no compute and plays everywhere. opus/mp3 stay one word away when the bytes on the
    wire matter more than the seconds spent making them.

    Length still changes the CONTAINER, never the music: a lossless render past the ~50MB media
    door becomes flac (실측: 353s wav = 62MB, refused, and the model's rational recovery was to
    compose a 42-second piece instead). The engine salts the name so a builtin re-render cannot
    overwrite the sf2 take (실측: it did, and the sf2 take died)."""
    if fmt == "wav" and n_samples * 4 > 48 * 1024 * 1024:
        fmt = "flac"  # the same audio, still lossless, under the door
    path = str(requested or "").strip()
    if not path:
        h = hashlib.sha1((json.dumps(score, sort_keys=True) + ":" + engine_used)
                         .encode()).hexdigest()[:6]
        style = str((score or {}).get("style") or "").strip().lower()
        stem = "-".join(x for x in (_slug_name(base) or "sing",
                                    style if style and style != "none" else "", h) if x)
        return f"data/sing/{stem}.{fmt}"
    return path


def read_wav_mono(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype="float64", always_2d=True)
    x = data.mean(axis=1)
    if sr != SR:
        x = resample_linear(x, SR / sr)
    return x


def write_wav(path, x):
    # soundfile picks the container from the extension — wav/flac ride PCM_16, mp3 goes through
    # libsndfile's LAME encoder (subtype MPEG_LAYER_III, its own default rate ~150 kbps VBR).
    # Scaled IN PLACE: at five minutes the old `x / peak * 0.95` copy was another quarter-GB.
    import soundfile as sf
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    x = np.asarray(x, dtype=np.float32)
    peak = float(np.max(np.abs(x))) or 1.0
    x *= 0.95 / peak
    ext = path.rsplit(".", 1)[-1].lower()
    if ext == "opus":
        sf.write(path, x, SR, format="OGG", subtype="OPUS")
    else:
        sf.write(path, x, SR, subtype="MPEG_LAYER_III" if ext == "mp3" else "PCM_16")


def action_lyrics(inp):
    """Fetch synced lyrics from the internet (lyricsQuery -> lrclib) or re-stamp an existing
    lyrics file (lyricsMediaPath + lrcOffset) — no audio render: "가사 0.5초 밀어줘" must not
    cost minutes of synthesis. The product ships through the same media door as the render."""
    try:
        offset = float(inp.get("lrcOffset") or 0.0)
    except (TypeError, ValueError):
        return {"success": False, "error": "lrcOffset must be a number of seconds"}
    q = str(inp.get("lyricsQuery") or "").strip()
    src = str(inp.get("lyricsMediaPath") or "").strip()
    meta = None
    if src:
        lpath, lerr = resolve_score_media(inp, key="lyricsMediaPath")
        if lerr:
            return {"success": False, "error": lerr}
        text, err = lrc_from_file(lpath, offset, title=src)
        if err:
            return {"success": False, "error": err}
        base = _slug_name(src) or "lyrics"
    elif q:
        lpath, meta, err = _fetch_lrc(q, duration=inp.get("durationSec"))
        if err:
            return {"success": False, "error": err}
        text = shift_lrc(read_lrc_text(lpath), offset)
        base = _slug_name(q) or "lyrics"
    else:
        return {"success": False, "error": (
            "lyricsQuery('가수 곡명') 또는 lyricsMediaPath(가사 악보 · .lrc · 별칭) 를 주세요")}
    tag = f"-{offset:+.2f}s" if offset else ""
    out = f"data/sing/lrc/{base}{tag}.lrc"
    os.makedirs("data/sing/lrc", exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    # 가사 **본문을 응답에 싣는다.** 전엔 모듈 작업 경로(data/sing/lrc/…)만 돌려줬는데, 그 주소는
    # 부르는 쪽이 읽을 수 없다(AI 파일 접근은 user/ 안으로 갇혀 있다). 실측 8/19: 한 절만 잘라
    # 쓰려던 턴이 read_file→network_request(상대 URL 실패)→cache_grep→write_file 로 헤매다
    # 결국 가사를 손으로 다시 썼다. 텍스트는 몇 KB고, 그걸 주면 그 우회가 통째로 사라진다.
    data = {"lrc": text, "offsetSec": offset,
            "lrcLines": sum(1 for ln in text.splitlines()
                            if ln[:1] == "[" and ln[1:2].isdigit()),
            "_mediaImport": {"path": out, "contentType": "application/x-lrc",
                             "filenameHint": base + tag},
            "note": ("가사 본문은 이 응답의 `lrc` 에 있습니다 — 그대로(또는 원하는 절만 잘라) "
                     "render 의 `lrc` 로 넘기면 됩니다. 파일째 쓰려면 `media.url` 을 render 의 "
                     "`lyricsMediaPath` 로 넘기세요. 타이밍이 밀리면 lrcOffset 으로 전체를 "
                     "밀고 당깁니다(+ = 늦게).")}
    if meta:
        data["identity"] = (f"{meta.get('artist')} - {meta.get('track')} "
                            f"({int(meta.get('duration') or 0)}s, lrclib)")
    return {"success": True, "data": data}


def action_render(inp):
    score = inp.get("score")
    parsed_from = None
    own_lyrics = None
    voice = str(inp.get("voice") or "").strip()
    if not score:
        # No inline score — the uploaded one (input path or the module's own setting) steps in.
        media_path, err = resolve_score_media(inp)
        if err:
            return {"success": False, "error": err}
        if not media_path:
            return {"success": False,
                    "error": "no score: pass `score`, or `scoreMediaPath` (URL, path, or a shelf "
                             "alias), or upload one in the module settings (악보 보관함)"}
        kind = score_media_kind(media_path)
        if kind:
            faithful_rows = []
            if kind == "midi":
                score, err = midi_to_score(media_path, lyrics=inp.get("lyrics"),
                                           want_part=inp.get("melodyPart"))
                if not err:
                    fr, fb, ferr = midi_to_parts(media_path)
                    if not ferr:
                        faithful_rows = fr
            else:
                score, err = musicxml_to_score(media_path, want_part=inp.get("melodyPart"),
                                               lyrics=inp.get("lyrics"),
                                               parts_out=faithful_rows)
            if err:
                return {"success": False, "error": err}
            notation_skipped = score.pop("_notation_skipped", None) \
                if isinstance(score, dict) else None
            own_lyrics = score.pop("_lyrics", None) if isinstance(score, dict) else None
            if isinstance(score, dict) and score.pop("_unpitchedMelody", False):
                return {"success": False, "error": (
                    "리듬-가사 리드시트입니다 — 슬래시 리듬에 가사만 있고 멜로디 음고가 없어 "
                    "연주할 수 없습니다. 반주 악보(밴드스코어)를 scoreMediaPath 로 주고, 이 "
                    "파일을 lyricsMediaPath 로 주면 오디오와 함께 가사 타이밍(.lrc)이 나옵니다")}
            # A file score with no chord symbols still deserves harmony when RE-ARRANGED:
            # read it off the faithful rows (lowest pitch per 2-beat window — the MIDI
            # recipe, source-agnostic). 실측: 한 파트 두 성부인 월광은 파트 단위 파생이
            # 못 잡았고, style 재편곡이 멜로디 한 줄로 헐벗었다.
            if isinstance(score, dict) and not score.get("chords") and faithful_rows:
                buckets = {}
                for r in faithful_rows:
                    if "pitch" in r and not r.get("pedal"):
                        buckets.setdefault(int(r["beat"] // 2), []).append(r["pitch"])
                d_chords, prev_root = [], None
                for k in (range(min(buckets), max(buckets) + 1) if buckets else []):
                    root = min(buckets[k]) if buckets.get(k) else prev_root
                    if root is None:
                        continue
                    if d_chords and root == prev_root:
                        d_chords[-1]["beats"] += 2
                    else:
                        d_chords.append({"root": _midi_name(root), "beats": 2})
                    prev_root = root
                if d_chords:
                    score["chords"] = d_chords
            # Every feel knob rides the top level too: a shelved MIDI plus new instruments is
            # ONE call. While band lived only inside `score`, composing a fresh score was the
            # only one-call path to "피아노로" — measured: the model did exactly that (turn 31,
            # 48s 자작 while the shelf held the real piece and scores had just listed it).
            for knob in ("style", "band", "drumPattern", "swing", "comp", "bassline",
                         "bpm", "humanize", "pedal", "voicing"):
                if inp.get(knob) is not None:
                    score[knob] = inp[knob]
            parsed_from = media_path
        else:
            ext = media_path.rsplit(".", 1)[-1].lower() if "." in media_path else "?"
            return {"success": False,
                    "error": f"score media must be MIDI or MusicXML (got .{ext}, and the bytes "
                             "are neither MThd, zip nor XML) — hum-to-score is a later slice"}
    # Lift the reader's report off the score before it is parsed — it is about the FILE, not
    # about the music, and the caller needs it whether or not the parse succeeds.
    lead_part = score.pop("_leadPart", None) if isinstance(score, dict) else None
    parts_seen = score.pop("_partsSeen", None) if isinstance(score, dict) else None
    spb, events, chords, style, band, feel, err = parse_score(score)
    if err:
        return {"success": False, "error": err}
    # ── LRC lane: lyricsMediaPath = lyric score (rhythm-lyric lead sheet, karaoke MIDI) or a
    # ready-made .lrc; lrc:true reads the main score's own syllables. Built BEFORE the render
    # so a bad lyrics input refuses in milliseconds, not after minutes of synthesis.
    lrc_text, lrc_meta, lrc_miss = None, None, None
    lyr_src = str(inp.get("lyricsMediaPath") or "").strip()
    lyr_q = str(inp.get("lyricsQuery") or "").strip()
    if lyr_src or lyr_q or inp.get("lrc"):
        try:
            lrc_offset = float(inp.get("lrcOffset") or 0.0)
        except (TypeError, ValueError):
            return {"success": False, "error": "lrcOffset must be a number of seconds"}
        if lyr_src:
            lpath, lerr = resolve_score_media(inp, key="lyricsMediaPath")
            if lerr:
                return {"success": False, "error": lerr}
            lrc_text, lerr = lrc_from_file(lpath, lrc_offset, title=lyr_src)
            if lerr:
                return {"success": False, "error": lerr}
        elif lyr_q:
            # The Winamp move: synced lyrics fetched by name while the MR renders. A miss is
            # a NOTE, not a failure — the track is still worth having; the real accident
            # would be the WRONG song's lyrics attached silently, so the pick is reported
            # (data.lrcSource) for the ear to veto.
            hint = events_beats(events) * spb
            lpath, lrc_meta, ferr = _fetch_lrc(lyr_q, duration=hint if hint > 30 else None)
            if ferr:
                lrc_miss = ferr
            else:
                lrc_text = shift_lrc(read_lrc_text(lpath), lrc_offset)
        else:
            if not own_lyrics:
                return {"success": False, "error": (
                    "lrc:true 인데 이 악보에는 가사가 없습니다 — 가사 악보나 .lrc 파일을 "
                    "lyricsMediaPath 로 주세요")}
            lrc_text = build_lrc(own_lyrics, spb, offset=lrc_offset,
                                 title=str(inp.get("scoreMediaPath") or "") or None)
    # ── faithful mode: "그대로 연주해줘" plays the FILE — every part, its own instrument, its
    # own dynamics — instead of reducing it to one line plus a style's backing. 실측 (월광):
    # the reduction buried the tune in its own accompaniment (따다단만 들린다). Any style/band/
    # groove request switches back to the arrangement path: re-instrumenting IS that path's job.
    wants_arrangement = bool(style != "none" or (feel or {}).get("drums")
                             or inp.get("vocal") or str(inp.get("vocalPath") or "").strip())
    faithful = (parsed_from is not None and not wants_arrangement
                and len(locals().get("faithful_rows") or []) > 0)
    reinst_name = None
    if faithful and band:
        faithful_rows, reinst_name = reinstrument(faithful_rows, band)
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
            # 목소리는 곡이 고른다 — 프레임워크는 원래 이 칸을 넘겨 주고 있었는데(module.rs 의
            # `_prepare.voice`) 우리가 안 보내서 늘 서버 기본값으로 불렀다. 음역을 옥타브로 접는
            # 것은 키가 안 맞을 때의 응급처치고, 애초에 맞는 목소리로 부르는 것이 본래 순서다.
            **({"voice": voice} if voice else {}),
            "into": "vocalPath",
        }}}
    total_beats = events_beats(events)
    chord_beats = sum(c[1] for c in chords)
    total_beats = max(total_beats, chord_beats)
    if faithful:
        # The rows' own end, REPLACING the melody sum: a multi-voice part (월광 실측) made the
        # naive sum 2-3x the real length — a 15-minute canvas around 6 minutes of music, split
        # into "movements" of silence.
        total_beats = max(r["beat"] + r["beats"] for r in faithful_rows)
    if feel.get("bars"):
        total_beats = max(total_beats, feel["bars"] * feel["meter"])
    if total_beats <= 0:
        return {"success": False,
                "error": "빈 곡입니다 — notes/chords 를 채우거나, 드럼 솔로면 drumPattern 과 "
                         "bars 를 함께 주세요"}
    # The last fuse after the memory diet: length itself is the resource. A malformed or
    # absurd score must refuse here, not fight the OOM killer on a 949MB box (실측: 월광).
    if total_beats * spb > 1800:
        return {"success": False,
                "error": f"렌더 길이 {round(total_beats * spb / 60)}분 — 30분을 넘는 렌더는 "
                         "거부합니다. bars/score 를 줄이거나 구간을 나눠 주세요"}
    # Ask the font what it can play BEFORE hiring the band: its own preset names become
    # instrument aliases, and the kit list in an error message is then the truth for THIS box.
    _fbin, _ffont, _fwhy = sf2_backend()
    font_path = None if _fwhy else _ffont
    load_font_aliases(font_path)
    kit_name = str(inp.get("kit") or "").strip().lower()
    kit_prog, kit_label = 0, None
    if kit_name:
        avail = kits_available(font_path)
        pick = avail.get(_norm_inst(kit_name))
        if pick is None:
            return {"success": False,
                    "error": f"kit {kit_name!r} 를 모릅니다 — 이 폰트가 가진 킷: "
                             + " | ".join(sorted(avail))}
        kit_prog, kit_label = pick, kit_name
    arr = (sorted(faithful_rows, key=lambda r: (r["beat"], r["part"])) if faithful
           else build_arrangement(events, chords, style, total_beats, band, feel))
    if kit_prog:
        for e in arr:
            if e.get("part") == "drum":
                e["program"] = kit_prog
    assim = assimilate_triplets(arr)
    arr = apply_performance(arr, feel, spb, total_beats)
    vocal_path = str(inp.get("vocalPath") or "").strip()
    # The melody doubles the voice when there is one, so it steps aside; with no vocal it IS the
    # tune, and dropping it was why an instrumental render came out as rhythm and bass only.
    if vocal_path:
        arr = [e for e in arr if e["part"] != "melody"]
    # A drum whose note this font's kit does not answer to would come out as nothing at all, and
    # silence reads as a mixing decision rather than a missing sample. Substitute the GM1 stand-in
    # and SAY which ones moved (the module knows; the listener cannot).
    swapped = {}
    inv = font_inventory(font_path) if font_path else None
    if inv:
        have = (inv["kits"].get(kit_prog) or inv["kits"].get(0) or {}).get("keys") or set()
        if have:
            for e in arr:
                if e.get("part") != "drum":
                    continue
                d = e.get("drum")
                if DRUM_NOTE.get(d, 42) in have:
                    continue
                sub = DRUM_GM1_SUB.get(d)
                if sub and DRUM_NOTE[sub] in have:
                    swapped[d] = sub
                    e["drum"] = sub
    engine = str(inp.get("engine") or "").strip().lower()
    if engine not in ("", "auto", "sf2", "builtin"):
        return {"success": False,
                "error": "engine must be sf2 | builtin (omit = auto: sf2 when installed)"}
    engine_used, engine_note, sf2_font = "builtin", None, None
    mix = send = None
    if engine != "builtin":
        binp, font, why = _fbin, _ffont, _fwhy
        if engine == "sf2" and why:
            return {"success": False, "error": f"engine:sf2 사용 불가 — {why}"}
        if not why:
            stereo, err = render_sf2(arr, spb, binp, font, mixmap=feel.get("mix"))
            if stereo is None:
                engine_note = f"sf2 렌더 실패 — 내장 신디로 강등: {err}"
            else:
                engine_used, sf2_font = "sf2", os.path.basename(font)
                # The engine's own space is the MIDI default — we add no room of ours on top.
                # (The vocal overlay still sends to add_room below: that voice is OUR sound.)
                stereo *= 0.45
                mix, send = stereo, np.zeros(len(stereo), dtype=np.float32)
    if mix is None:
        mix, send = render_arrangement(arr, spb, total_beats, mixmap=feel.get("mix"))
        mix *= 0.45
        send *= 0.45
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
    fmt = str(inp.get("audioFormat") or "flac").strip().lower()
    if fmt not in _FMT_BYTES:
        return {"success": False,
                "error": "audioFormat must be flac | mp3 | opus | wav (omit = flac)"}
    out_path = _out_path_for(inp.get("outPath"), score, engine_used, len(mix),
                             base=inp.get("scoreMediaPath"), fmt=fmt)
    lrc_path = None
    if lrc_text:
        lrc_path = out_path.rsplit(".", 1)[0] + ".lrc"
        # The lyrics we were GIVEN must not be the file we write: same stem = the source is
        # overwritten, and the framework deletes imported files that sit under data/ (실측: an
        # e2e run clobbered its own input). Same name, different file.
        src_lyr = str(locals().get("lpath") or "")
        if src_lyr and os.path.abspath(src_lyr) == os.path.abspath(lrc_path):
            lrc_path = out_path.rsplit(".", 1)[0] + "-sync.lrc"
        with open(lrc_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(lrc_text)
    # ── ② movements: even FLAC crosses the ~50MB media door near the 9-10 minute mark. A piece
    # that long ships as several flacs in one _mediaImport array (the door is already plural),
    # cut on bar lines. Lossless and playable everywhere — ogg is free but Safari will not play
    # it, so splitting beats transcoding.
    part_paths = []
    bounds = _movement_bounds(len(mix), spb, feel["meter"],
                              out_path.rsplit(".", 1)[-1].lower())
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
    # No workspace paths here. `data/sing/x.flac` is an address the CALLER cannot open — AI file
    # access is confined to `user/` — so handing one over invites a detour that ends in a wrong
    # answer (실측 8/19: the lyrics action led with such a path and the model burned 17 calls
    # before rewriting the words by hand). Every product leaves through `_mediaImport` below and
    # comes back as a url the caller CAN open. The paths stay in this process's stdout, which is
    # where a readout wants them anyway.
    data = {
        "seconds": round(len(mix) / SR, 2),
        "events": len(events),
        "parts": sorted({e["part"] for e in arr}),
        "style": style,
        "vocal": bool(vocal_path),
        "backend": "pyworld" if (vocal_path and try_pyworld()) else "numpy",
        "engine": engine_used,
        "mode": "faithful" if faithful else "arranged",
    }
    if faithful and reinst_name:
        data["reInstrument"] = reinst_name
    if parsed_from and locals().get("notation_skipped"):
        # Silence is not consent: what the parser could not play is SAID, next to the render.
        data["notationNote"] = ("연주하지 못한 기호: " + ", ".join(
            f"{k}×{v}" for k, v in notation_skipped.items()) + " — 파서 미구현분입니다")
    if assim:
        data["performanceNote"] = (f"셋잇단 동화: 점리듬 16분음표 {assim}개를 같은 박의 "
                                   "셋잇단 셋째 음(2/3)에 정렬했습니다 — 관례적 2:3 처리")
    if sf2_font:
        data["soundfont"] = sf2_font
    if kit_label:
        data["kit"] = kit_label
    if swapped and engine_used == "sf2":
        data["kitNote"] = ("이 사운드폰트에 없는 드럼을 GM1 소리로 바꿔 연주했습니다: "
                           + ", ".join(f"{k}→{v}" for k, v in sorted(swapped.items())))
    if engine_note:
        data["engineNote"] = engine_note
    if midi_note:
        data["midiNote"] = midi_note
    if lrc_path:
        data["lrcLines"] = sum(1 for ln in lrc_text.splitlines()
                               if ln[:1] == "[" and ln[1:2].isdigit())
        if lrc_meta:
            data["lrcSource"] = (f"{lrc_meta.get('artist')} - {lrc_meta.get('track')} "
                                 f"({lrc_meta.get('duration')}s, lrclib)")
    if lrc_miss:
        data["lrcNote"] = lrc_miss
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
    hint = _display_name(stem)
    audio_type = {"flac": "audio/flac", "mp3": "audio/mpeg", "opus": "audio/ogg"}.get(
        out_path.rsplit(".", 1)[-1].lower(), "audio/wav")
    if part_paths:
        # 악장은 몇 번째인지가 이름의 일부다 — 그건 해시가 아니라 사람이 읽는 정보다.
        imports = [{"path": pp, "contentType": audio_type,
                    "filenameHint": f"{hint}-{i}of{len(part_paths)}"}
                   for i, pp in enumerate(part_paths, 1)]
        data["movements"] = len(part_paths)
    else:
        imports = [{"path": out_path, "contentType": audio_type, "filenameHint": hint}]
    if midi_written:
        imports.append({"path": midi_written, "contentType": "audio/midi", "filenameHint": hint})
    if lrc_path:
        imports.append({"path": lrc_path, "contentType": "application/x-lrc",
                        "filenameHint": hint})
    data["_mediaImport"] = imports if len(imports) > 1 else imports[0]
    if lrc_path:
        # A backing track plus its synced lyrics IS a karaoke stage — the module is the only one
        # that knows that, so it declares the component and the framework draws it (`_render`,
        # the same underscore channel as `_mediaImport`). Addresses are not ours to know: the
        # files are pointed at by the position we imported them in. 실측 8/19: both files came
        # back and the answer was two markdown links, because nothing said a component existed.
        data["_render"] = {"component": "karaoke", "props": {
            "title": _slug_name(inp.get("scoreMediaPath") or "") or "노래방",
            "audioUrl": {"$media": 0},
            "lrcUrl": {"$media": len(imports) - 1},
        }}
    if lead_part:
        data["leadPart"] = lead_part
        data["partsSeen"] = parts_seen
    if parsed_from:
        # The caller composed nothing — show what the MIDI became so the bridge (TTS lyric
        # order) and the user can see and correct the parse.
        data["scoreSource"] = parsed_from
        data["score"] = score
    return {"success": True, "data": data}


def action_preview(inp):
    """Hear a score. The browser has no MIDI synthesiser, so a .mid in the library is a file
    nobody can play — the sound has to be made on this side, by the same engine that renders
    everything else, so what you hear IS what a render would give you.

    Rendered once per file and then found again: the name carries a hash of the bytes, so the
    second press is a directory lookup, not a minute of synthesis. Nothing is composed and no
    taste knob is applied — this is the score as written."""
    src = str(inp.get("path") or inp.get("scoreMediaPath") or "").strip()
    if not src:
        return {"success": False, "error": "path 가 필요합니다 — 악보 파일의 경로·URL·별칭"}
    media_path, err = resolve_score_media({"scoreMediaPath": src})
    if err:
        return {"success": False, "error": err}
    if not media_path or not os.path.isfile(media_path):
        return {"success": False, "error": f"악보 파일을 찾지 못했습니다: {src}"}
    with open(media_path, "rb") as fh:
        h = hashlib.sha1(fh.read()).hexdigest()[:10]
    # 이미 구워 둔 것이 있으면 그것 — 미디어 보관함이 곧 캐시다(모듈이 따로 장부를 안 든다).
    tag = f"preview-{h}"
    try:
        for fn in sorted(os.listdir("user/media")):
            if tag in fn and not fn.endswith(".meta.json"):
                return {"success": True, "data": {"url": f"/user/media/{fn}", "cached": True}}
    except OSError:
        pass
    stem = _slug_name(os.path.basename(media_path)) or "score"
    out = action_render({"scoreMediaPath": media_path})
    if not out.get("success"):
        return out
    data = out.get("data") or {}
    imports = data.get("_mediaImport")
    if isinstance(imports, list):
        imports = next((i for i in imports if not str(i.get("path", "")).endswith(".mid")), None)
    if not isinstance(imports, dict):
        return {"success": False, "error": "미리듣기 렌더가 파일을 내놓지 않았습니다"}
    # 이름이 곧 색인 — 다음 호출이 이 해시로 이 파일을 찾는다.
    # 여기서만 해시가 이름에 남는다 — 다음 호출이 이 이름으로 구운 것을 찾기 때문이다.
    imports["filenameHint"] = f"{_display_name(stem)}-{tag}"
    return {"success": True, "data": {"_mediaImport": imports, "cached": False,
                                      "note": "악보를 소리로 구웠습니다 — 브라우저는 MIDI 를 "
                                              "직접 재생하지 못합니다"}}


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
    # …and every value a row asks for must be a value a CALLER may ask for. This is the audit
    # that was missing: the metal row said `chug`/`drive` while COMP_KINDS/BASS_KINDS still
    # listed four each, so the genre could play a hand no argument could name, and the model —
    # reading the short list — picked something else and took the genre apart (실측 8/19).
    row_comps = sorted({r["comp"] for r in STYLE_FEEL.values() if r.get("comp")})
    row_bass = sorted({r["bass"] for r in STYLE_FEEL.values() if r.get("bass")})
    stray = ([c for c in row_comps if c not in COMP_KINDS]
             + [b for b in row_bass if b not in BASS_KINDS])
    ck("every hand a genre plays can be asked for by name", [], stray, not stray)
    # And the schema has to print them, or the model chooses from a list that is not the truth.
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            props = (json.load(fh).get("input") or {}).get("properties") or {}
    except (OSError, ValueError):
        props = {}
    missing_doc = [k for k in COMP_KINDS if k not in str(props.get("comp", {}).get("description"))]
    missing_doc += [k for k in BASS_KINDS
                    if k not in str(props.get("bassline", {}).get("description"))]
    ck("the schema prints every value the gate accepts", [], missing_doc, not missing_doc)
    undeclared = [k for k in ("orn", "chordShape", "laidback", "gate", "double")
                  if k not in props]
    ck("every feel axis is an argument, not a genre-only secret", [], undeclared,
       not undeclared)

    # Caller first, genre second: naming ONE hand must not strip the others. Thickness used to
    # ride on comp, so asking for a different strum silently removed the second guitar.
    wall = build_arrangement(events, [(note_freq("E2"), 4.0, "")], "metal", 4,
                             feel={"comp": "stabs"})
    ck("a metal render keeps its double-tracked wall when the strum changes", True,
       any(e["part"] == "chord2" for e in wall),
       any(e["part"] == "chord2" for e in wall))
    thin = build_arrangement(events, [(note_freq("E2"), 4.0, "")], "metal", 4,
                             feel={"double": 0.0})
    ck("…and drops it when the caller asks for one guitar", False,
       any(e["part"] == "chord2" for e in thin),
       not any(e["part"] == "chord2" for e in thin))
    long_ev = [{"syl": "라", "segments": [(note_freq("C5"), 3.0)], "vels": [None]}]
    straight = build_arrangement(long_ev, [(note_freq("C3"), 4.0, "")], "trot", 4,
                                 feel={"orn": "none"})
    kkeok = build_arrangement(long_ev, [(note_freq("C3"), 4.0, "")], "trot", 4)
    bent = [e for e in kkeok if e["part"] == "melody" and e.get("bend")]
    ck("orn is a knob: 'none' plays the tune straight where the genre would flick it",
       [0, 1], [len([e for e in straight if e["part"] == "melody" and e.get("bend")]), len(bent)],
       not [e for e in straight if e.get("bend")] and len(bent) == 1)
    # 꺾기 is one syllable whose pitch moves and COMES BACK. The old one split the note and left
    # the tail a whole step down, which is a second short note — 사용자: "삐융".
    ck("꺾기 bends inside the note and returns to it", True,
       (len([e for e in kkeok if e["part"] == "melody"]), BEND_CURVES["kkeokgi"][-1]),
       len([e for e in kkeok if e["part"] == "melody"]) == 1
       and BEND_CURVES["kkeokgi"][-1] == (1.0, 0.0) and BEND_CURVES["kkeokgi"][0] == (0.0, 0.0))
    ck("…and every curve we own ends where the score wrote it", [],
       [k for k, c in BEND_CURVES.items() if c[-1][1] != 0.0],
       all(c[-1][1] == 0.0 for c in BEND_CURVES.values()))
    badorn = parse_score({"bpm": 120, "orn": "웩", "notes": [{"syl": "라", "note": "C4",
                                                             "beats": 1}]})
    ck("an unknown orn is refused WITH the list", True, (badorn[-1] or "")[:40],
       bool(badorn[-1]) and "kkeokgi" in (badorn[-1] or ""))
    chug = parse_score({"bpm": 120, "comp": "chug", "bassline": "drive",
                        "notes": [{"syl": "라", "note": "C4", "beats": 1}]})
    ck("the new hands are callable by argument", ("chug", "drive"),
       (chug[5] or {}).get("comp") if chug[5] else None,
       bool(chug[5]) and chug[5]["comp"] == "chug" and chug[5]["bass"] == "drive")
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
        sem_rows = [{"alias": "take five", "name": "takefive.mid",
                     "url": "data/sing/selftest-tf.mid", "score": 0.91}]
        with open("data/sing/selftest-tf.mid", "wb") as fh:
            fh.write(b"MThd")
        semmed = resolve_score_media({"scoreMediaPath": "테이크 파이브",
                                      "_collectionMatches": {"scoreMediaPath": sem_rows}})
        ck("the framework's semantic lane resolves a cross-lingual alias", True,
           semmed[0], semmed[1] is None and semmed[0] == "data/sing/selftest-tf.mid")
        os.remove("data/sing/selftest-tf.mid")
        semq = action_scores({"query": "테이크", "_collectionMatches": {"query": sem_rows}})
        ck("a query miss prefers semantic matches over the full dump", "take five",
           semq["data"]["scores"][0]["alias"],
           semq["data"]["scores"][0]["alias"] == "take five"
           and "semantic" in semq["data"]["note"])
        missed = action_scores({"query": "테이크 파이브"})
        ck("a missed query carries the whole shelf, not an empty verdict", 2,
           missed["data"]["count"], missed["data"]["count"] == 2
           and "no match" in missed["data"]["note"])
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

    # What the font can play is a fact we can check, not a thing to assume. On a box with no
    # SoundFont these skip — the audit belongs where the font is.
    if not e_why:
        inv = font_inventory(e_font)
        ck("the font answers what it can play", True, bool(inv and inv["programs"]),
           bool(inv and inv["programs"]))
        if inv:
            missing_prog = [g for g in range(128) if g not in inv["programs"]]
            ck("every GM program we may name exists in this font", [], missing_prog[:8],
               not missing_prog)
            kit_keys = (inv["kits"].get(0) or {}).get("keys") or set()
            unsounded = sorted(n for n, k in DRUM_NOTE.items() if k not in kit_keys)
            ck("every drum we name has a sample in this font", [], unsounded[:8], not unsounded)
            ck("the font's own preset names are callable", True,
               bool(_FONT_ALIASES) or bool(load_font_aliases(e_font)) or bool(_FONT_ALIASES),
               bool(_FONT_ALIASES))
    # The one link nothing else watches: a kit is only chosen if the program change actually
    # reaches channel 9. Read it back out of the bytes — a response that SAYS "kit: jazz" while
    # the .mid stays on Standard is exactly the kind of quiet wrong we keep paying for.
    # (Skips where mido is absent, like the sf2 checks skip where no font is installed.)
    krow = [{"beat": 0.0, "beats": 1.0, "part": "drum", "drum": "kick", "vel": 0.9,
             "program": 32}]
    kpath = "data/sing/selftest-kit.mid"
    os.makedirs("data/sing", exist_ok=True)
    kwritten, _ = write_midi(krow, 120, kpath)
    if kwritten:
        import mido as _mido
        msgs = [m for t in _mido.MidiFile(kpath).tracks for m in t
                if m.type == "program_change"]
        ck("the chosen kit reaches channel 9 as a program change", [(9, 32)],
           [(m.channel, m.program) for m in msgs],
           any(m.channel == 9 and m.program == 32 for m in msgs))
        plain = [dict(krow[0])]
        plain[0].pop("program")
        write_midi(plain, 120, kpath)
        msgs2 = [m for t in _mido.MidiFile(kpath).tracks for m in t
                 if m.type == "program_change" and m.channel == 9]
        ck("…and no kit asked for means no program change (Standard)", [], msgs2, not msgs2)
        if os.path.isfile(kpath):
            os.remove(kpath)
    # The answer in the breath. A melody that rests gets replied to; one that never rests does
    # not, and no genre answers unless its row says it does.
    fscore = {"bpm": 120,
              "notes": [{"syl": "라", "note": "C5", "beats": 2},
                        {"rest": True, "beats": 6},
                        {"syl": "라", "note": "E5", "beats": 2}],
              "chords": [{"root": "C3", "beats": 5}, {"root": "G2", "beats": 5}]}
    _, fev, fch, _, fbd, ffl, ferr = parse_score(dict(fscore, style="trot"))
    farr = build_arrangement(fev, fch, "trot", 10, fbd, ffl)
    fills = [r for r in farr if r["part"] == "fill"]
    ck("trot answers the singer in the gap", True, len(fills) > 0, bool(fills))
    if fills:
        lo, hi = min(r["beat"] for r in fills), max(r["beat"] + r["beats"] for r in fills)
        ck("…inside the breath, and out of the way before the next entry", True,
           (round(lo, 2), round(hi, 2)),
           lo >= 2.0 - 1e-6 and hi <= 8.0 - 0.5 + 1e-6)
        ck("…on chord tones of the harmony under it", [],
           sorted({r["pitch"] % 12 for r in fills} - {0, 4, 7, 2, 11}),
           {r["pitch"] % 12 for r in fills} <= {0, 4, 7, 2, 11})
    _, bev, bch, _, bbd, bfl, _ = parse_score(dict(fscore, style="ballad"))
    ck("a genre that does not answer stays quiet", 0,
       len([r for r in build_arrangement(bev, bch, "ballad", 10, bbd, bfl)
            if r["part"] == "fill"]),
       not [r for r in build_arrangement(bev, bch, "ballad", 10, bbd, bfl)
            if r["part"] == "fill"])
    _, oev, och, _, obd, ofl, _ = parse_score(dict(fscore, style="ballad", fill=0.8))
    ck("…until the caller asks it to", True,
       bool([r for r in build_arrangement(oev, och, "ballad", 10, obd, ofl)
             if r["part"] == "fill"]),
       bool([r for r in build_arrangement(oev, och, "ballad", 10, obd, ofl)
             if r["part"] == "fill"]))
    _, qev, qch, _, qbd, qfl, _ = parse_score(dict(fscore, style="trot", fill=0.0))
    ck("…and off means off", 0,
       len([r for r in build_arrangement(qev, qch, "trot", 10, qbd, qfl)
            if r["part"] == "fill"]),
       not [r for r in build_arrangement(qev, qch, "trot", 10, qbd, qfl)
            if r["part"] == "fill"])
    _, nev, nch, _, nbd, nfl, _ = parse_score({"bpm": 120, "style": "trot",
                                               "notes": [{"syl": "라", "note": "C5", "beats": 1}] * 8,
                                               "chords": [{"root": "C3", "beats": 8}]})
    ck("a singer who never breathes is never answered over", 0,
       len([r for r in build_arrangement(nev, nch, "trot", 8, nbd, nfl)
            if r["part"] == "fill"]),
       not [r for r in build_arrangement(nev, nch, "trot", 8, nbd, nfl)
            if r["part"] == "fill"])
    fb = build_arrangement(fev, fch, "trot", 10, {"fill": "piano"}, ffl)
    ck("band.fill names who answers", True,
       any(r["part"] == "fill" and r["program"] == 0 for r in fb),
       any(r["part"] == "fill" and r["program"] == 0 for r in fb))
    # A stroke is a time. The same comp at half the tempo must not hold twice as long.
    fast = _comp_hits("stabs", 4.0, 4, spb=0.5)[0][1] * 0.5
    slow = _comp_hits("stabs", 4.0, 4, spb=1.0)[0][1] * 1.0
    ck("a stab lasts the same MILLISECONDS at any tempo", True,
       (round(fast * 1000), round(slow * 1000)),
       abs(fast - slow) < 0.01 and fast < 0.25)
    ck("…and it is a chop, not a held chord", True, round(fast * 1000),
       0.05 <= fast <= 0.25)
    # Balance: the tune on top. Read it back out of the bytes, like the kit.
    mrow = [{"beat": 0.0, "beats": 1.0, "part": "melody", "pitch": 72, "program": 0, "vel": 0.8},
            {"beat": 0.0, "beats": 1.0, "part": "chord", "pitch": 60, "program": 21, "vel": 0.8}]
    mpath = "data/sing/selftest-mix.mid"
    os.makedirs("data/sing", exist_ok=True)
    if write_midi(mrow, 120, mpath):
        import mido as _md
        vol = {}
        for t in _md.MidiFile(mpath).tracks:
            nm = next((x.name for x in t if x.type == "track_name"), "")
            v = next((x.value for x in t if x.type == "control_change" and x.control == 7), None)
            if v is not None:
                vol[nm] = v
        ck("every part carries a channel volume, and the tune is the loudest",
           True, vol,
           len(vol) == 2 and vol.get("melody", 0) > vol.get("chord", 999))
        write_midi(mrow, 120, mpath, mix={"chord": 1.0, "melody": 0.3})
        vol2 = {}
        for t in _md.MidiFile(mpath).tracks:
            nm = next((x.name for x in t if x.type == "track_name"), "")
            v = next((x.value for x in t if x.type == "control_change" and x.control == 7), None)
            if v is not None:
                vol2[nm] = v
        ck("…and `mix` turns it upside down when asked", True, vol2,
           vol2.get("chord", 0) > vol2.get("melody", 999))
        if os.path.isfile(mpath):
            os.remove(mpath)
    # 꺾기 at the end of a line, not every fourth note.
    kk = {"bpm": 120, "chords": [{"root": "C3", "beats": 8}],
          "notes": [{"syl": "라", "note": "C5", "beats": 1}] * 4
                   + [{"syl": "라", "note": "E5", "beats": 1}, {"rest": True, "beats": 2},
                      {"syl": "라", "note": "G5", "beats": 2}]}
    _, kev, kch, _, kbd, kfl, _ = parse_score(dict(kk, style="trot"))
    karr = build_arrangement(kev, kch, "trot", 11, kbd, kfl)
    kmel = [r for r in karr if r["part"] == "melody"]
    ck("꺾기 lands on the line's end and the long note, not on every beat-long note",
       2, sum(1 for r in kmel if r.get("bend")),
       sum(1 for r in kmel if r.get("bend")) == 2 and len(kmel) == len(kev))
    badkit = action_render({"action": "render", "score": score, "kit": "웩킷"})
    ck("an unknown kit is refused WITH this font's list", True, (badkit.get("error") or "")[:44],
       not badkit.get("success") and "standard" in (badkit.get("error") or ""))
    for name in ("castanets", "shaker", "belltree", "sticks"):
        ck(f"the GS extension is callable and sounds on both engines ({name})", True,
           bool(_drum_of(name)) and name in _kit_bank() and name in DRUM_GM1_SUB,
           bool(_drum_of(name)) and name in _kit_bank() and name in DRUM_GM1_SUB)
    ck("castanet resolves to castanets (the way people spell it)", "castanets",
       _drum_of("castanet"), _drum_of("castanet") == "castanets")
    ck("every extension key declares a GM1 stand-in", [],
       sorted(n for n, k in DRUM_NOTE.items() if k not in range(35, 82) and n not in DRUM_GM1_SUB),
       all(n in DRUM_GM1_SUB for n, k in DRUM_NOTE.items() if k not in range(35, 82)))
    ck("…and every stand-in is itself GM1", [],
       sorted(v for v in DRUM_GM1_SUB.values() if DRUM_NOTE[v] not in range(35, 82)),
       all(DRUM_NOTE[v] in range(35, 82) for v in DRUM_GM1_SUB.values()))

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
    # Contiguity, not a count. The old assertion hard-coded 47 and had to be edited the day the
    # kit grew past GM1 — a number typed by hand is a copy of the table, and copies drift.
    notes = sorted(DRUM_NOTE.values())
    ck("the kit is a contiguous percussion map with no repeats", [],
       [b for a, b in zip(notes, notes[1:]) if b != a + 1],
       len(set(notes)) == len(notes) and notes == list(range(notes[0], notes[-1] + 1)))
    ck("…and it covers General MIDI Level 1 whole", [],
       sorted(set(range(35, 82)) - set(notes)), set(range(35, 82)) <= set(notes))
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
    jarr = build_arrangement(ev2, ch2 * 4, "jazz", 16, None, {"meter": 4})
    jb = [e for e in jarr if e["part"] == "bass"]
    ck("jazz walks on an upright (GM 32), not an electric", 32, jb[0]["program"],
       bool(jb) and jb[0]["program"] == 32)
    ballad16 = build_arrangement(ev2, ch2 * 8, "ballad", 32, None, {"meter": 4})
    rock16 = build_arrangement(ev2, ch2 * 8, "rock", 32, None, {"meter": 4})
    b_crash = len([e for e in ballad16 if e.get("drum") == "crash"])
    r_crash = len([e for e in rock16 if e.get("drum") == "crash"])
    ck("a ballad marks sections (8-bar crash), rock marks phrases (4)", (1, 2),
       (b_crash, r_crash), b_crash == 1 and r_crash == 2)
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
    vc = [{"beat": 0.0, "beats": 1.0, "part": "p1", "patch": "piano", "program": 0,
           "pitch": 76, "vel": 0.4, "gate": 1.0},
          {"beat": 0.0, "beats": 1.0, "part": "p1", "patch": "piano", "program": 0,
           "pitch": 64, "vel": 0.4, "gate": 1.0},
          {"beat": 0.0, "beats": 1.0, "part": "p1", "patch": "piano", "program": 0,
           "pitch": 40, "vel": 0.44, "gate": 1.0}]
    vc = apply_performance(vc, {"meter": 4, "voicing": 0.8}, 0.5, 1)
    by_pitch = {r["pitch"]: r["vel"] for r in vc}
    ck("voicing puts the top line in front and the bass behind (월광 실측 처방)", True,
       {k: round(v, 2) for k, v in by_pitch.items()},
       by_pitch[76] > 0.4 and by_pitch[40] < 0.44 and by_pitch[64] < 0.4)
    pfirst = [{"beat": 0.0, "beats": 4.0, "part": "p1", "pedal": True},
              {"beat": 0.01, "beats": 1.0, "part": "p1", "patch": "piano", "program": 0,
               "pitch": 60, "vel": 0.5, "gate": 1.0}]
    ok_pf, _ = write_midi(pfirst, 120, "data/sing/selftest-pf.mid")
    ck("a pedal row sorted first cannot crash the .mid writer (월광 실측)", True,
       bool(ok_pf), bool(ok_pf))
    if ok_pf and os.path.exists("data/sing/selftest-pf.mid"):
        os.remove("data/sing/selftest-pf.mid")
        dry = apply_performance([{"beat": 0.0, "beats": 2.0, "part": "p1", "patch": "piano",
                              "program": 0, "pitch": 60, "vel": 0.5, "gate": 1.0},
                             {"beat": 0.0, "beats": 4.0, "part": "p1", "pedal": True}],
                            {"meter": 4, "pedal": False}, 0.5, 4)
    ck("pedal:false plays a marked score dry", 0, len([e for e in dry if e.get("pedal")]),
       not [e for e in dry if e.get("pedal")])
    perf = parse_score(dict(score, pedal=True, humanize=0.5))
    ck("pedal/humanize are legal performance knobs", None, perf[6], perf[6] is None)
    parr = build_arrangement(perf[1], perf[2], "none", 4, None, perf[5])
    parr = apply_performance(parr, perf[5], 0.5, 4)
    ck("pedal:true lays a bar-long damper span per pitched part", True,
       len([e for e in parr if e.get("pedal")]),
       any(e.get("pedal") and e["beats"] == 4.0 for e in parr))
    h1 = apply_performance(build_arrangement(perf[1], perf[2], "none", 4, None, perf[5]),
                           perf[5], 0.5, 4)
    h2 = apply_performance(build_arrangement(perf[1], perf[2], "none", 4, None, perf[5]),
                           perf[5], 0.5, 4)
    duo = apply_performance(
        [{"beat": 1.0, "beats": 1.0, "part": "p1", "patch": "piano", "program": 0,
          "pitch": 72, "vel": 0.5, "gate": 1.0},
         {"beat": 1.0, "beats": 1.0, "part": "p2", "patch": "piano", "program": 0,
          "pitch": 48, "vel": 0.5, "gate": 1.0}],
        {"meter": 4, "humanize": 0.7}, 0.5, 2)
    ck("human hands wobble TOGETHER — same moment, same drift (절뚝임 실측 처방)",
       True, [round(e["beat"], 4) for e in duo],
       abs(duo[0]["beat"] - duo[1]["beat"]) < 1e-9 and duo[0]["beat"] != 1.0)
    ck("humanize is deterministic — same ask, same bytes",
       True, h1 == h2, h1 == h2)
    ck("...and actually moves off the grid", True,
       any(abs(e["beat"] * 4 - round(e["beat"] * 4)) > 1e-9
           for e in h1 if not e.get("pedal")),
       any(abs(e["beat"] * 4 - round(e["beat"] * 4)) > 1e-9
           for e in h1 if not e.get("pedal")))
    huge_len = action_render({"action": "render",
                              "score": {"bpm": 20, "bars": 256,
                                        "drumPattern": [["kick", 0.0]]}})
    ck("a 30-minute-plus render refuses instead of fighting the OOM killer", True,
       (huge_len.get("error") or "")[:30],
       not huge_len.get("success") and "30분" in (huge_len.get("error") or ""))
    ck("a drum solo renders from drumPattern + bars alone", ["drum"],
       (solo.get("data") or {}).get("parts"),
       solo.get("success") and (solo.get("data") or {}).get("parts") == ["drum"])
    if os.path.exists("data/sing/selftest-solo.wav"):
        os.remove("data/sing/selftest-solo.wav")
    small = _out_path_for(None, score, "builtin", SR * 60)
    huge = _out_path_for(None, score, "builtin", SR * 400)
    ck("length no longer changes the default container — flac either way", (".flac", ".flac"),
       (small[-5:], huge[-5:]), small.endswith(".flac") and huge.endswith(".flac"))
    ck("the engine salts the default name (no cross-engine overwrite)", True,
       _out_path_for(None, score, "sf2", SR * 60) != small,
       _out_path_for(None, score, "sf2", SR * 60) != small)
    forced = _out_path_for(None, score, "sf2", SR * 400, fmt="wav")
    ck("a LOSSLESS render past the media door becomes flac, never a shorter piece",
       ".flac", forced[-5:], forced.endswith(".flac"))
    kept = _out_path_for(None, score, "sf2", SR * 400, fmt="mp3")
    ck("a lossy container has no door to cross, so it is left alone",
       ".mp3", kept[-4:], kept.endswith(".mp3"))
    named = _out_path_for(None, dict(score, style="pop"), "sf2", SR * 60, base="캐논 변주곡.mid")
    ck("the default filename reads as the piece, not a hash", True, named,
       "캐논-변주곡" in named and "-pop-" in named and named.endswith(".flac"))
    five = parse_score(dict(score, meter="5/4", style="jazz"))
    ck("5/4 reads the numerator and parses", 5, (five[5] or {}).get("meter"),
       five[6] is None and five[5]["meter"] == 5)
    arr5 = build_arrangement(five[1], five[2] * 3, "jazz", 15, None, five[5])
    d5 = [e for e in arr5 if e["part"] == "drum" and e["beat"] < 5]
    kicks5 = sorted(e["beat"] for e in d5 if e["drum"] == "kick")
    ck("an odd bar kicks on its group heads (5 = 3+2)", [0.0, 3.0], kicks5,
       kicks5 == [0.0, 3.0])
    ck("jazz in five rides a ride", True, sorted({e["drum"] for e in d5}),
       any(e["drum"] == "ride" for e in d5))
    ck("meter groups: compound is threes, odd leads with three",
       ([3, 3], [3, 2], [3, 2, 2]), (_meter_groups(6), _meter_groups(5), _meter_groups(7)),
       (_meter_groups(6), _meter_groups(5), _meter_groups(7)) == ([3, 3], [3, 2], [3, 2, 2]))
    bad_meter = parse_score(dict(score, meter=13))[6]
    ck("a 13-beat bar is refused with the range", True, (bad_meter or "")[:20],
       bool(bad_meter) and "2~12" in bad_meter)
    ck("a short piece is one movement", 1, len(_movement_bounds(SR * 60, 0.5, 4)),
       len(_movement_bounds(SR * 60, 0.5, 4)) == 1)
    mb = _movement_bounds(SR * 60 * 15, 0.5, 4)
    bar_n = int(SR * 0.5 * 4)
    ck("a 15-minute piece ships as bar-aligned movements", True,
       [len(mb), mb[0][1] % bar_n], len(mb) >= 2 and mb[0][0] == 0
       and mb[-1][1] == SR * 60 * 15 and all(a % bar_n == 0 for a, _ in mb)
       and all(mb[i][1] == mb[i + 1][0] for i in range(len(mb) - 1)))
    dbl = parse_score(dict(score, style="classic",
                            band={"melody": "violin",
                                  "doubles": [{"part": "melody", "instrument": "flute",
                                               "octave": 1}]}))
    ck("band.doubles parses and validates", None, dbl[6], dbl[6] is None)
    darr2 = build_arrangement(dbl[1], dbl[2], "classic", 4, dbl[4], dbl[5])
    d1 = [e for e in darr2 if e["part"] == "double1"]
    mel1 = [e for e in darr2 if e["part"] == "melody"]
    ck("a double is the same line an octave up on its own instrument", True,
       (len(d1), d1[0]["program"] if d1 else None),
       len(d1) == len(mel1) and bool(d1) and d1[0]["program"] == 73
       and d1[0]["pitch"] == mel1[0]["pitch"] + 12)
    darr3 = build_arrangement(dbl[1], dbl[2], "classic", 4, None, dict(dbl[5], doubles=None))
    ck("classic carries its own section doublings unasked", 4,
       len({e["part"] for e in darr3 if e["part"].startswith("double")}),
       len({e["part"] for e in darr3 if e["part"].startswith("double")}) == 4)
    P = '<score-partwise><part-list/><part id="P1">'
    E = '</part></score-partwise>'

    def _n(step, octv, dur, extra="", pre=""):
        return (pre + '<note>' + '<pitch><step>' + step + '</step><octave>' + str(octv)
                + '</octave></pitch><duration>' + str(dur) + '</duration>' + extra + '</note>')

    rep_doc = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               + _n("C", 4, 4)
               + '</measure><measure number="2">'
               '<barline location="left"><ending number="1" type="start"/></barline>'
               + _n("D", 4, 4)
               + '<barline location="right"><ending number="1" type="stop"/>'
               '<repeat direction="backward"/></barline></measure>'
               '<measure number="3">'
               '<barline location="left"><ending number="2" type="start"/></barline>'
               + _n("E", 4, 4)
               + '<barline location="right"><ending number="2" type="stop"/></barline>'
               '</measure>' + E)
    with open("data/sing/selftest-rep.musicxml", "w", encoding="utf-8") as fh:
        fh.write(rep_doc)
    # Which part is the song. Counting notes gave the tune to whoever plays the most of them:
    # 실측 8/20, 아로하's "Voice" (536 notes) lost to its "Piano" (968) and the lead was the
    # piano's right hand in every style. The part names itself; we only had to read it.
    def _mxpart(pid, pname, notes):
        body = "".join(f'<note><pitch><step>{st}</step><octave>{oc}</octave></pitch>'
                       f'<duration>1</duration><type>quarter</type></note>' for st, oc in notes)
        return (f'<score-part id="{pid}"><part-name>{pname}</part-name></score-part>',
                f'<part id="{pid}"><measure number="1"><attributes><divisions>1</divisions>'
                f'</attributes>{body}</measure></part>')
    v_hdr, v_body = _mxpart("P1", "Voice", [("C", 5), ("D", 5), ("E", 5)])
    p_hdr, p_body = _mxpart("P2", "Piano", [("C", 3), ("D", 3), ("E", 3), ("F", 3),
                                            ("G", 3), ("A", 3), ("B", 3), ("C", 4)])
    two = ("<score-partwise><part-list>" + v_hdr + p_hdr + "</part-list>"
           + v_body + p_body + "</score-partwise>")
    with open("data/sing/selftest-parts.musicxml", "w", encoding="utf-8") as fh:
        fh.write(two)
    tsc, terr = musicxml_to_score("data/sing/selftest-parts.musicxml")
    lead = (tsc or {}).get("_leadPart")
    ck("the part that calls itself the song gets the tune, not the busiest one",
       "Voice", lead, terr is None and lead == "Voice")
    ck("…and the reply says what else was on offer", True, (tsc or {}).get("_partsSeen"),
       bool(tsc) and len(tsc.get("_partsSeen") or []) == 2)
    osc, _ = musicxml_to_score("data/sing/selftest-parts.musicxml", want_part="Piano")
    ck("melodyPart overrides the pick by name", "Piano", (osc or {}).get("_leadPart"),
       bool(osc) and osc.get("_leadPart") == "Piano")
    osc2, _ = musicxml_to_score("data/sing/selftest-parts.musicxml", want_part="P2")
    ck("…and by id", "Piano", (osc2 or {}).get("_leadPart"),
       bool(osc2) and osc2.get("_leadPart") == "Piano")
    ck("an unmatched melodyPart falls back rather than failing", "Voice",
       (musicxml_to_score("data/sing/selftest-parts.musicxml", want_part="Tuba")[0] or {}
        ).get("_leadPart"),
       (musicxml_to_score("data/sing/selftest-parts.musicxml", want_part="Tuba")[0] or {}
        ).get("_leadPart") == "Voice")
    ck("part_is_vocal reads the label, not the note count", [2, 0, 1],
       [part_is_vocal("Voice"), part_is_vocal("Gtr1"), part_is_vocal("Staff 3")],
       [part_is_vocal("Voice"), part_is_vocal("Gtr1"), part_is_vocal("Staff 3")] == [2, 0, 1])
    if os.path.isfile("data/sing/selftest-parts.musicxml"):
        os.remove("data/sing/selftest-parts.musicxml")

    rsc, rerr = musicxml_to_score("data/sing/selftest-rep.musicxml")
    ck("repeats and voltas expand the playback order (1,2,1,3)",
       ["C4", "D4", "C4", "E4"], [n["note"] for n in (rsc or {}).get("notes", [])],
       rerr is None and [n["note"] for n in rsc["notes"]] == ["C4", "D4", "C4", "E4"])

    tempo_doc = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
                 '<direction><sound tempo="120"/></direction>'
                 + _n("C", 4, 2)
                 + '</measure><measure number="2">'
                 '<direction><sound tempo="60"/></direction>'
                 + _n("D", 4, 2) + '</measure>' + E)
    with open("data/sing/selftest-tempo.musicxml", "w", encoding="utf-8") as fh:
        fh.write(tempo_doc)
    tsc, terr = musicxml_to_score("data/sing/selftest-tempo.musicxml")
    ck("a mid-piece tempo change bends time onto one master tempo",
       (120.0, 2.0, 4.0),
       (tsc and tsc["bpm"], tsc and tsc["notes"][0]["beats"], tsc and tsc["notes"][1]["beats"]),
       terr is None and tsc["bpm"] == 120.0 and tsc["notes"][0]["beats"] == 2.0
       and tsc["notes"][1]["beats"] == 4.0)

    met_doc = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               '<direction><direction-type><metronome><beat-unit>half</beat-unit>'
               '<per-minute>60</per-minute></metronome></direction-type></direction>'
               + _n("C", 4, 2) + '</measure>' + E)
    with open("data/sing/selftest-met.musicxml", "w", encoding="utf-8") as fh:
        fh.write(met_doc)
    msc, merr = musicxml_to_score("data/sing/selftest-met.musicxml")
    ck("a metronome mark without sound tempo still sets the tempo (half=60 -> 120)",
       120.0, msc and msc["bpm"], merr is None and msc["bpm"] == 120.0)

    perf_doc = (P + '<measure number="1"><attributes><divisions>4</divisions></attributes>'
                '<direction><direction-type><octave-shift type="down" size="8"/>'
                '</direction-type></direction>'
                + _n("C", 4, 4, extra='<notations><articulations><staccato/></articulations>'
                                      '</notations>')
                + '<direction><direction-type><octave-shift type="stop" size="8"/>'
                '</direction-type></direction>'
                + _n("G", 4, 2, pre='<grace/>'.join(["", ""]))
                + '</measure>' + E)
    perf_doc = perf_doc.replace('<note><pitch><step>G</step>',
                                '<note><grace/><pitch><step>G</step>', 1)
    perf_doc = perf_doc.replace('</measure>' + E,
                                _n("A", 4, 8, extra='<notations><ornaments><trill-mark/>'
                                                    '</ornaments></notations>')
                                + '</measure>' + E)
    with open("data/sing/selftest-perf.musicxml", "w", encoding="utf-8") as fh:
        fh.write(perf_doc)
    prows = []
    psc, perr = musicxml_to_score("data/sing/selftest-perf.musicxml", parts_out=prows)
    c5 = [r for r in prows if r.get("pitch") == 72]
    trill = [r for r in prows if r.get("pitch") in (69, 71) and r["beats"] <= 0.5]
    ck("8va sounds an octave up, staccato shortens the gate",
       True, (len(c5), c5[0]["gate"] if c5 else None),
       perr is None and c5 and c5[0]["gate"] == 0.4)
    ck("a grace note steals its moment, a trill plays as the notes it means",
       True, (any(r["beats"] <= 0.15 and r.get("pitch") == 67 for r in prows), len(trill)),
       any(r["beats"] <= 0.15 and r.get("pitch") == 67 for r in prows) and len(trill) >= 4)

    tv_rows = []
    tv_sc, _ = musicxml_to_score("data/sing/selftest-x.musicxml", parts_out=tv_rows)         if os.path.exists("data/sing/selftest-x.musicxml") else (None, None)
    ri_rows = [{"beat": 0.0, "beats": 1.0, "part": "p1", "patch": "piano", "program": 0,
                "pitch": 60, "vel": 0.5, "gate": 1.0},
               {"beat": 0.0, "beats": 4.0, "part": "p1", "pedal": True}]
    ri_out, ri_name = reinstrument(ri_rows, {"melody": "eguitar"})
    ck("band on a file re-instruments the faithful parts, never collapses them",
       ("eguitar", 27, True),
       (ri_name, ri_out[0]["program"], "program" not in ri_out[1]),
       ri_name == "eguitar" and ri_out[0]["program"] == 27
       and "program" not in ri_out[1])
    drum_doc = ('<score-partwise><part-list><score-part id="P1">'
                '<midi-instrument id="P1-I36"><midi-unpitched>39</midi-unpitched>'
                '</midi-instrument></score-part></part-list><part id="P1">'
                '<measure number="1"><attributes><divisions>1</divisions></attributes>'
                '<note><unpitched><display-step>C</display-step>'
                '<display-octave>5</display-octave></unpitched>'
                '<instrument id="P1-I36"/><duration>1</duration></note>'
                '<note><unpitched/><duration>1</duration></note>'
                '<note><pitch><step>C</step><octave>4</octave></pitch>'
                '<duration>2</duration>'
                '<notations><glissando type="start"/></notations></note>'
                '</measure></part></score-partwise>')
    with open("data/sing/selftest-drum.musicxml", "w", encoding="utf-8") as fh:
        fh.write(drum_doc)
    drows = []
    dsc, derr = musicxml_to_score("data/sing/selftest-drum.musicxml", parts_out=drows)
    hit = [r for r in drows if r.get("drum")]
    ck("a band score's drum staff plays (midi-unpitched -> the kit)", "snare",
       hit[0]["drum"] if hit else None,
       derr is None and hit and hit[0]["drum"] == "snare")
    ck("what the parser cannot play is SAID, not swallowed", True,
       (dsc or {}).get("_notation_skipped"),
       bool((dsc or {}).get("_notation_skipped"))
       and any("글리산도" in k for k in dsc["_notation_skipped"]))
    os.remove("data/sing/selftest-drum.musicxml")

    import mido as _mido
    _mf = _mido.MidiFile(ticks_per_beat=480)
    _tr = _mido.MidiTrack(); _mf.tracks.append(_tr)
    _tr.append(_mido.MetaMessage("set_tempo", tempo=_mido.bpm2tempo(120), time=0))
    _tr.append(_mido.Message("note_on", note=60, velocity=80, time=0))
    _tr.append(_mido.Message("note_off", note=60, velocity=0, time=960))
    _tr.append(_mido.MetaMessage("set_tempo", tempo=_mido.bpm2tempo(60), time=0))
    _tr.append(_mido.Message("note_on", note=62, velocity=80, time=0))
    _tr.append(_mido.Message("note_off", note=62, velocity=0, time=960))
    _mf.save("data/sing/selftest-warp.mid")
    wrows, wbpm, werr = midi_to_parts("data/sing/selftest-warp.mid")
    ck("a MIDI tempo map bends time like MusicXML does (2 beats @60 = 4 @120)",
       (120.0, 2.0, 4.0),
       (wbpm, wrows[0]["beats"] if wrows else None, wrows[1]["beats"] if wrows else None),
       werr is None and wbpm == 120.0 and abs(wrows[0]["beats"] - 2.0) < 1e-6
       and abs(wrows[1]["beats"] - 4.0) < 1e-6)
    os.remove("data/sing/selftest-warp.mid")

    lyr_doc = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               '<note><unpitched><display-step>F</display-step>'
               '<display-octave>4</display-octave></unpitched><duration>1</duration>'
               '<lyric><syllabic>single</syllabic><text>아</text></lyric></note>'
               '<note><unpitched><display-step>F</display-step>'
               '<display-octave>4</display-octave></unpitched><duration>1</duration>'
               '<lyric><text>로</text></lyric></note>'
               '<note><rest/><duration>2</duration></note>'
               '<note><unpitched><display-step>G</display-step>'
               '<display-octave>4</display-octave></unpitched><duration>1</duration>'
               '<lyric><text>하</text></lyric></note>'
               '</measure>' + E)
    with open("data/sing/selftest-lyr.musicxml", "w", encoding="utf-8") as fh:
        fh.write(lyr_doc)
    lsc, lerr = musicxml_to_score("data/sing/selftest-lyr.musicxml")
    lrows = (lsc or {}).get("_lyrics") or []
    ck("a rhythm-lyric lead sheet parses: unpitched+lyric = the song line",
       (True, 3, 0.5),
       (bool((lsc or {}).get("_unpitchedMelody")), len(lrows),
        lrows[1]["t"] if len(lrows) > 1 else None),
       lerr is None and (lsc or {}).get("_unpitchedMelody") is True and len(lrows) == 3
       and lrows[1]["t"] == 0.5)
    lrc = build_lrc(lrows, 0.5)
    llines = [ln for ln in lrc.splitlines() if ln[:1] == "["]
    ck("LRC lines break on the musical gap, syllables carry their own clock",
       2, len(llines),
       len(llines) == 2 and llines[0].startswith("[00:00.00]<00:00.00>아<00:00.50>로")
       and llines[1].startswith("[00:02.00]"))
    ck("an imported .lrc re-stamps by offset and clamps at zero",
       "[00:01.50]가<00:02.00>사", shift_lrc("[00:00.50]가<00:01.00>사", 1.0),
       shift_lrc("[00:00.50]가<00:01.00>사", 1.0) == "[00:01.50]가<00:02.00>사"
       and shift_lrc("[00:00.50]가", -2.0) == "[00:00.00]가"
       and shift_lrc("[ti:아로하]", 3.0) == "[ti:아로하]")
    lref = action_render({"scoreMediaPath": "data/sing/selftest-lyr.musicxml"})
    ck("playing a lyric-only sheet is refused TOWARD the lyrics lane",
       False, lref.get("success"),
       lref.get("success") is False and "lyricsMediaPath" in str(lref.get("error")))
    ltrk = action_render({"score": {"bpm": 120, "notes": [
        {"syl": "라", "note": "C4", "beats": 1.0}]},
        "lyricsMediaPath": "data/sing/selftest-lyr.musicxml"})
    ldat = ltrk.get("data") or {}
    # Read the same channel the caller reads: the products are the media imports, not paths in
    # the payload. When this test can still find both files, so can the answer.
    limports = ldat.get("_mediaImport") if isinstance(ldat.get("_mediaImport"), list) else []
    lrc_imp = next((i for i in limports if str(i.get("path", "")).endswith(".lrc")), None)
    lok = bool(ltrk.get("success") and lrc_imp and os.path.isfile(lrc_imp["path"]))
    ck("two-track: audio from one score, .lrc from the lyric sheet, one call",
       True, lok, lok and len(limports) == 2 and ldat.get("lrcLines") == 2)
    ck("a render hands back no address the caller cannot open", [],
       sorted(k for k in ldat if k.endswith("Path")),
       not any(k.endswith("Path") for k in ldat))
    for imp in limports:
        pth = imp.get("path")
        if pth and os.path.isfile(pth):
            os.remove(pth)

    def _tri(beat, beats, pitch):
        return {"beat": beat, "beats": beats, "part": "melody", "patch": "piano",
                "program": 0, "pitch": pitch, "vel": 0.5, "gate": 1.0}

    tri_rows = [_tri(0.0, 1 / 3, 60), _tri(1 / 3, 1 / 3, 62), _tri(2 / 3, 1 / 3, 64),
                _tri(0.0, 0.75, 72), _tri(0.75, 0.25, 72)]
    tri_n = assimilate_triplets(tri_rows)
    tri_six = next(r for r in tri_rows if r["pitch"] == 72 and r["beat"] > 0)
    tri_dot = next(r for r in tri_rows if r["pitch"] == 72 and r["beat"] == 0.0)
    ck("a dotted sixteenth against a live triplet grid joins the third triplet note",
       (1, True), (tri_n, abs(tri_six["beat"] - 2 / 3) < 1e-9),
       tri_n == 1 and abs(tri_six["beat"] - 2 / 3) < 1e-9
       and abs(tri_six["beats"] - 1 / 3) < 1e-9 and abs(tri_dot["beats"] - 2 / 3) < 1e-9)
    lit_rows = [_tri(0.0, 0.75, 72), _tri(0.75, 0.25, 72), _tri(0.0, 1.0, 48)]
    lit_n = assimilate_triplets(lit_rows)
    ck("with no triplet grid the dotting stays literal 3:1",
       (0, 0.75), (lit_n, lit_rows[1]["beat"]),
       lit_n == 0 and lit_rows[1]["beat"] == 0.75)

    dn = _diatonic_neighbors(4, 68)   # E major (월광's signature), G#
    ck("ornament neighbors are diatonic (E major: G#-A up a semitone, G#-F# down a tone)",
       (1, 2), dn, dn == (1, 2))
    orn_base = {"beat": 0.0, "beats": 1.0, "part": "melody", "patch": "piano", "program": 0,
                "pitch": 60, "vel": 0.5, "gate": 1.0}
    m_dn = _ornament_rows(dict(orn_base), "mordent", *_diatonic_neighbors(0, 60))
    m_up = _ornament_rows(dict(orn_base), "mordent_up", *_diatonic_neighbors(0, 60))
    ck("the mordent sign beats down, the inverted mordent beats up",
       (59, 62), (m_dn[1]["pitch"], m_up[1]["pitch"]),
       m_dn[1]["pitch"] == 59 and m_up[1]["pitch"] == 62)
    arp_doc = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>'
               '<notations><arpeggiate/></notations></note>'
               '<note><chord/><pitch><step>E</step><octave>4</octave></pitch>'
               '<duration>4</duration><notations><arpeggiate/></notations></note>'
               '</measure>' + E)
    with open("data/sing/selftest-arp.musicxml", "w", encoding="utf-8") as fh:
        fh.write(arp_doc)
    arows = []
    asc, aerr = musicxml_to_score("data/sing/selftest-arp.musicxml", parts_out=arows)
    arp_top = [r for r in arows if r.get("pitch") == 64]
    ck("a rolled chord is a hand gesture — constant milliseconds, not beats",
       0.044, arp_top[0]["beat"] if arp_top else None,
       aerr is None and bool(arp_top) and abs(arp_top[0]["beat"] - 0.044) < 0.002)

    rk = _rank_lrc([{"trackName": "a"},
                    {"trackName": "b", "syncedLyrics": "[00:01.00]x", "duration": 250},
                    {"trackName": "c", "syncedLyrics": "[00:01.00]x", "duration": 227}],
                   duration=226)
    ck("lyric search keeps synced entries and picks the closest cut by duration",
       ("c", 2), (rk[0]["trackName"] if rk else None, len(rk)),
       len(rk) == 2 and rk[0]["trackName"] == "c")
    os.makedirs("data/sing/lrc", exist_ok=True)
    with open("data/sing/lrc/selftest-cached.lrc", "w", encoding="utf-8") as fh:
        fh.write("[00:01.00]가\n")
    with open("data/sing/lrc/selftest-cached.json", "w", encoding="utf-8") as fh:
        fh.write('{"artist": "x", "track": "y", "duration": 1, "source": "lrclib"}')
    cp, cm, ce = _fetch_lrc("selftest cached")
    ck("a fetched lyric is cached by query slug — re-renders stay off the network",
       ("data/sing/lrc/selftest-cached.lrc", "x"),
       (cp, (cm or {}).get("artist")),
       ce is None and cp == "data/sing/lrc/selftest-cached.lrc"
       and (cm or {}).get("artist") == "x")
    lyx = action_lyrics({"lyricsMediaPath": "data/sing/lrc/selftest-cached.lrc",
                         "lrcOffset": 1.0})
    lyd = lyx.get("data") or {}
    # 본문이 응답에 있으니 파일을 열지 않는다 — 부르는 쪽이 실제로 하는 일과 같은 경로다.
    lyt = lyd.get("lrc", "") if lyx.get("success") else ""
    ck("the lyrics action hands back the text itself, not an address only it can read",
       True,
       bool(lyx.get("success") and lyt.startswith("[00:02.00]")
            and isinstance(lyd.get("_mediaImport"), dict)),
       bool(lyx.get("success")) and lyt.startswith("[00:02.00]")
       and isinstance(lyd.get("_mediaImport"), dict) and lyd.get("lrcLines") == 1)
    for f in ("data/sing/lrc/selftest-cached.lrc", "data/sing/lrc/selftest-cached.json",
              lyd.get("path")):
        if f and os.path.isfile(f):
            os.remove(f)

    xml_doc = (
        '<score-partwise><part-list/><part id="P1"><measure number="1">'
        '<attributes><divisions>2</divisions><time><beats>3</beats>'
        '<beat-type>4</beat-type></time></attributes>'
        '<direction><direction-type><dynamics><pp/></dynamics></direction-type>'
        '<sound tempo="80"/></direction>'
        '<harmony><root><root-step>A</root-step></root><kind>minor</kind></harmony>'
        '<note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration>'
        '<lyric><text>사</text></lyric></note>'
        '<note><chord/><pitch><step>C</step><octave>5</octave></pitch>'
        '<duration>2</duration></note>'
        '<note><rest/><duration>2</duration></note>'
        '<note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>'
        '<duration>4</duration><lyric><text>랑</text></lyric></note>'
        '</measure></part></score-partwise>')
    with open("data/sing/selftest-x.musicxml", "w", encoding="utf-8") as fh:
        fh.write(xml_doc)
    xsc, xerr = musicxml_to_score("data/sing/selftest-x.musicxml")
    ck("MusicXML parses — the electronic score standard", None, xerr, xerr is None)
    if xsc:
        ck("MusicXML carries what MIDI only implies (meter, tempo, dynamics, lyric)",
           (3, 80.0, 0.3, "사"),
           (xsc.get("meter"), xsc.get("bpm"), xsc["notes"][0].get("vel"),
            xsc["notes"][0]["syl"]),
           xsc.get("meter") == 3 and xsc.get("bpm") == 80.0
           and xsc["notes"][0].get("vel") == 0.3 and xsc["notes"][0]["syl"] == "사")
        # A rest is a row of its own now. It used to be added to the note before it, which held
        # every phrase through its own breath and — with nothing before it — deleted the intro.
        rows = [(n.get("note", "rest"), n["beats"]) for n in xsc["notes"]]
        ck("chord tones stack, ties merge, and a rest is silence rather than a longer note",
           [("A4", 1.0), ("rest", 1.0), ("A#4", 2.0)], rows,
           len(rows) == 3 and rows[0] == ("A4", 1.0) and rows[1] == ("rest", 1.0)
           and rows[2][1] == 2.0 and xsc["notes"][2]["note"] in ("A#4", "Bb4"))
        ck("…and the written length of the bar is unchanged by that", 4.0,
           sum(n["beats"] for n in xsc["notes"]),
           abs(sum(n["beats"] for n in xsc["notes"]) - 4.0) < 1e-9)
        # The intro: a rest with no note before it. This is the one the old rule dropped whole.
        intro = xml_doc.replace(
            '<harmony><root><root-step>A</root-step></root><kind>minor</kind></harmony>',
            '<harmony><root><root-step>A</root-step></root><kind>minor</kind></harmony>'
            '<note><rest/><duration>8</duration></note>')
        with open("data/sing/selftest-intro.musicxml", "w", encoding="utf-8") as fh:
            fh.write(intro)
        isc, ierr = musicxml_to_score("data/sing/selftest-intro.musicxml")
        _, iev, _, _, _, _, ierr2 = parse_score(isc) if isc else (None,)*7
        lead_gap = (iev[0].get("gap") if iev else None)
        ck("a rest before the first note is the intro, and it survives", 4.0, lead_gap,
           ierr is None and ierr2 is None and lead_gap == 4.0)
        ck("…and the piece is that much longer, not that much shorter", 8.0,
           events_beats(iev) if iev else None,
           bool(iev) and abs(events_beats(iev) - 8.0) < 1e-9)
        if os.path.isfile("data/sing/selftest-intro.musicxml"):
            os.remove("data/sing/selftest-intro.musicxml")
        ck("harmony elements become REAL chords, quality included",
           ("A2", "m"), (xsc["chords"][0]["root"], xsc["chords"][0]["quality"]),
           bool(xsc.get("chords")) and xsc["chords"][0]["quality"] == "m")
    two_voice = xml_doc.replace(
        '<note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>'
        '<duration>4</duration><lyric><text>랑</text></lyric></note>',
        '<note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>'
        '<duration>4</duration><voice>1</voice><lyric><text>랑</text></lyric></note>'
        '<backup><duration>8</duration></backup>'
        '<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration>'
        '<voice>2</voice></note>'
        '<note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration>'
        '<voice>2</voice></note>')
    with open("data/sing/selftest-2v.musicxml", "w", encoding="utf-8") as fh:
        fh.write(two_voice)
    fparts = []
    v_sc, v_err = musicxml_to_score("data/sing/selftest-2v.musicxml", parts_out=fparts)
    v_notes = _pitched((v_sc or {}).get("notes") or [])
    ck("the melody reduction follows ONE voice (월광: no more inflated length)", 2,
       len(v_notes), v_err is None and len(v_notes) == 2)
    ck("...while faithful rows keep every voice", 5, len(fparts), len(fparts) == 5)
    os.remove("data/sing/selftest-2v.musicxml")
    import zipfile as _zf
    with _zf.ZipFile("data/sing/selftest-x.mxl", "w") as z:
        z.writestr("score.xml", xml_doc)
    mxl_sc, mxl_err = musicxml_to_score("data/sing/selftest-x.mxl")
    ck("a compressed .mxl opens the same door", 2,
       len(_pitched((mxl_sc or {}).get("notes") or [])),
       mxl_err is None and len(_pitched(mxl_sc["notes"])) == 2)
    import shutil as _sh
    _sh.copy("data/sing/selftest-x.mxl", "data/sing/selftest-x.bin")
    ck("an .mxl the upload renamed .bin is judged by its bytes (실측: 월광)", "musicxml",
       score_media_kind("data/sing/selftest-x.bin"),
       score_media_kind("data/sing/selftest-x.bin") == "musicxml"
       and musicxml_to_score("data/sing/selftest-x.bin")[1] is None)
    os.remove("data/sing/selftest-x.bin")
    for f in ("data/sing/selftest-x.musicxml", "data/sing/selftest-x.mxl",
              "data/sing/selftest-rep.musicxml", "data/sing/selftest-tempo.musicxml",
              "data/sing/selftest-met.musicxml", "data/sing/selftest-perf.musicxml",
              "data/sing/selftest-lyr.musicxml", "data/sing/selftest-arp.musicxml"):
        if os.path.exists(f):
            os.remove(f)
    low = parse_score(dict(score, chords=[{"root": "C1", "beats": 4}]))
    arr_low = build_arrangement(low[1], low[2], "none", 4, None, low[5])
    lb = [e["pitch"] for e in arr_low if e["part"] == "bass"]
    lc = [e["pitch"] for e in arr_low if e["part"] == "chord"]
    ck("the bass floors at a real double bass's E1 — no subwoofer hum", True,
       (min(lb), min(lc)), min(lb) >= 28 and min(lc) >= 48)
    ens = parse_score(dict(score, style="현악"))
    ck("현악 answers to the string orchestra", "strings", ens[3], ens[3] == "strings")
    arr_s = build_arrangement(ens[1], ens[2], "strings", 4, None, ens[5])
    ck("a string orchestra is strings only — no percussion, viola and cello doubling", True,
       sorted({e.get("patch") or e.get("drum") for e in arr_s if e["part"] != "melody"}),
       not [e for e in arr_s if e["part"] == "drum"]
       and any(e.get("double_of") == "melody" for e in arr_s))
    loud = [{"syl": "라", "note": "C4", "beats": 1, "vel": 0.9} for _ in range(16)]
    quiet = [{"syl": "라", "note": "C4", "beats": 1, "vel": 0.3} for _ in range(16)]
    fl_l = parse_score(dict(score, style="classic", notes=loud))
    fl_q = parse_score(dict(score, style="classic", notes=quiet))
    arr_l = build_arrangement(fl_l[1], fl_l[2] * 4, "classic", 16, None, fl_l[5])
    arr_q = build_arrangement(fl_q[1], fl_q[2] * 4, "classic", 16, None, fl_q[5])
    ck("orchestral percussion follows the dynamics — forte crashes", True,
       sorted({e["drum"] for e in arr_l if e["part"] == "drum"}),
       any(e.get("drum") == "crash" for e in arr_l))
    ck("...and pp stays silent (짐노페디 무사)", 0,
       len([e for e in arr_q if e["part"] == "drum"]),
       not [e for e in arr_q if e["part"] == "drum"])
    bad_dbl = parse_score(dict(score, band={"doubles": [{"part": "drums",
                                                         "instrument": "flute"}]}))[6]
    ck("a double of a non-part is refused", True, (bad_dbl or "")[:30],
       bool(bad_dbl) and "melody" in (bad_dbl or ""))
    dyn = parse_score(dict(score, notes=[
        {"syl": "라", "note": "C4", "beats": 1, "vel": 0.3},
        {"syl": "나", "note": "E4", "beats": 1}]))
    darr = build_arrangement(dyn[1], dyn[2], "none", 2, None, dyn[5])
    dm = [e["vel"] for e in darr if e["part"] == "melody"]
    ck("a note's own dynamic wins; the phrase curve only fills silence", (0.3, 0.74),
       tuple(round(v, 2) for v in dm), abs(dm[0] - 0.3) < 1e-6 and abs(dm[1] - 0.74) < 1e-6)
    hy = _norm_name("take-five")
    ck("hyphens are spelling, not identity (take-five == take five)", True,
       hy, hy == _norm_name("Take Five"))
    ck("bare drum names land on their family's lead voice",
       ("triangle_open", "conga_open", "hat", "kick"),
       (_drum_of("triangle"), _drum_of("conga"), _drum_of("hi-hat"), _drum_of("bass drum")),
       (_drum_of("triangle"), _drum_of("conga"), _drum_of("hi-hat"), _drum_of("bass drum"))
       == ("triangle_open", "conga_open", "hat", "kick"))
    long_note = parse_score(dict(score, notes=[{"syl": "라", "note": "C4", "beats": 34.5}]))[6]
    ck("a held 34.5-beat note is legal (the cap is 64 now)", None, long_note, long_note is None)
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
    elif action == "lyrics":
        out = action_lyrics(inp)
    elif action == "preview":
        out = action_preview(inp)
    else:
        out = {"success": False,
               "error": f"unknown action {action!r} — one of: render, preview, scores, lyrics, "
                        "selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts,
    # and the envelope is UTF-8 by contract on both ends.
    sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False)).encode("utf-8"))


if __name__ == "__main__":
    main()
