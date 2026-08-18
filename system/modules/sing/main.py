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
    band = {}
    for part, name in (score.get("band") or {}).items() if isinstance(score.get("band"), dict) else []:
        part = str(part).strip().lower()
        name = str(name).strip().lower()
        if part not in ("melody", "chord", "bass"):
            return None, None, None, None, None, None, \
                f"band 의 파트 {part!r} 를 모릅니다 — melody | chord | bass 만 받습니다"
        if name not in PATCHES:
            return None, None, None, None, None, None, \
                f"악기 {name!r} 가 라이브러리에 없습니다 — 가능한 악기: {', '.join(sorted(PATCHES))}"
        band[part] = name
    # feel = how the band plays. Every knob has a style default, so a bare score still grooves.
    meter = int(score.get("meter") or 4)
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
    feel = {"meter": meter, "swing": swing, "comp": comp, "bass": bassline}
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
    # the original trio — names kept because arrangement events fall back to their part name
    "melody":     {"harm": [1.0, 0.55, 0.30, 0.16, 0.08], "hdecay": 1.6, "hslope": 1.35,
                   "detune": 0.004, "noise": 0.06, "atk": 0.012, "rel": 0.10, "gain": 0.34, "gm": 65},
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
DRUM_PATTERNS = {
    "trot":      [("kick", 0.0, 0.9), ("hat", 0.5, 0.45), ("snare", 1.0, 0.8), ("hat", 1.5, 0.45),
                  ("kick", 2.0, 0.85), ("hat", 2.5, 0.45), ("snare", 3.0, 0.8), ("ohat", 3.5, 0.55)],
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
                  ("snare", 1.0, 0.6), ("snare", 3.0, 0.6)],
    "rnb":       [("hat", o / 2.0, 0.3) for o in range(8)] +
                 [("kick", 0.0, 0.8), ("kick", 2.5, 0.6), ("snare", 1.0, 0.7), ("snare", 3.0, 0.7)],
    "rocknroll": _HATS8 + [("kick", 0.0, 0.9), ("kick", 2.0, 0.85),
                           ("snare", 1.0, 0.8), ("snare", 3.0, 0.8)],
    "hiphop":    [("hat", o / 2.0, 0.35) for o in range(8)] +
                 [("kick", 0.0, 0.9), ("kick", 1.75, 0.6), ("kick", 2.5, 0.75),
                  ("snare", 1.0, 0.85), ("snare", 3.0, 0.85)],
    "classic":   [],
    "newage":    [],
    "none":      [],
}

# Familiar names people actually say → the row that plays them. kpop/jpop are pop grooves here
# honestly: what makes them THEM is production this synth does not do.
STYLE_ALIASES = {"edm": "dance", "house": "dance", "kpop": "pop", "jpop": "pop",
                 "rock-ballad": "ballad", "rockballad": "ballad", "waltz": "ballad",
                 "rap": "hiphop", "boombap": "hiphop"}

# 쿵덕 for three bars, 두구두구 on the fourth, 쨍 on the downbeat after: every 4th bar keeps its
# groove up to the fill start and rolls down the toms; every 4-bar group opens on a crash.
# (start beat, [hits]) — velocities rise through the roll because a drummer leans into a fill.
DRUM_FILLS = {
    "trot":   (2.0, [("snare", 2.0, 0.55), ("tom_hi", 2.25, 0.5), ("tom_hi", 2.5, 0.55),
                     ("tom_mid", 2.75, 0.6), ("tom_mid", 3.0, 0.7), ("tom_lo", 3.25, 0.8),
                     ("tom_lo", 3.5, 0.9), ("tom_lo", 3.75, 0.95)]),
    "ballad": (3.0, [("tom_hi", 3.0, 0.4), ("tom_mid", 3.25, 0.5), ("tom_lo", 3.5, 0.6),
                     ("tom_lo", 3.75, 0.7)]),
    "march":  (3.0, [("snare", 3.0, 0.5), ("snare", 3.25, 0.6), ("snare", 3.5, 0.75),
                     ("snare", 3.75, 0.9)]),
}

# GM percussion notes (channel 10) — the .mid side of the kit, one map for every drum name.
DRUM_NOTE = {"kick": 36, "snare": 38, "hat": 42, "ohat": 46,
             "tom_lo": 45, "tom_mid": 47, "tom_hi": 50, "crash": 49}

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
    "classic":   {"melody": "eviolin", "chord": "strings", "bass": "bass"},
    "newage":    {"melody": "piano", "chord": "strings", "bass": "bass"},
    "none":      {"melody": "melody", "chord": "chord", "bass": "bass"},
}

# How a style PLAYS — the arrangement was static before this: the chord part held whole notes
# like a pad and the bass hit one root per chord, so swapping instruments still sounded slow.
# comp = how the chord part moves · bass = how the bass moves · swing = how far the offbeat
# eighths lean (0 straight, 1 full triplet; drums/comp/bass only — the melody stays straight
# because the vocal is cut to the written grid). Every knob is score-overridable.
STYLE_FEEL = {
    "trot":      {"comp": "stabs", "bass": "twobeat", "swing": 0.3},
    "ballad":    {"comp": "arp", "bass": "hold", "swing": 0.0},
    "march":     {"comp": "quarters", "bass": "alt", "swing": 0.0},
    "rock":      {"comp": "eighths", "bass": "alt", "swing": 0.0},
    "metal":     {"comp": "eighths", "bass": "alt", "swing": 0.0},
    "pop":       {"comp": "eighths", "bass": "alt", "swing": 0.0},
    "dance":     {"comp": "stabs", "bass": "alt", "swing": 0.0},
    "rnb":       {"comp": "arp", "bass": "hold", "swing": 0.55},
    "rocknroll": {"comp": "quarters", "bass": "alt", "swing": 0.6},
    "hiphop":    {"comp": "pad", "bass": "hold", "swing": 0.45},
    "classic":   {"comp": "pad", "bass": "hold", "swing": 0.0},
    "newage":    {"comp": "arp", "bass": "hold", "swing": 0.0},
    "none":      {"comp": "pad", "bass": "hold", "swing": 0.0},
}
COMP_KINDS = ("pad", "stabs", "arp", "quarters", "eighths")
BASS_KINDS = ("hold", "twobeat", "alt")

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


def _bass_line(kind, root_midi, beats, next_root_midi, meter):
    """(offset, dur, pitch, vel) for one chord segment. The bass register is root-12 as before.
    twobeat = root/5th alternation (the 뽕짝 walk) · alt = marching quarters · hold = the old
    whole note, now with a chromatic approach into the next chord when there is one."""
    b = root_midi - 12
    fifth = b + 7
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
        if part in hire and name in PATCHES:
            hire[part] = name
    prog = {part: PATCHES[name].get("gm", 0) for part, name in hire.items()}
    defaults = STYLE_FEEL.get(style, STYLE_FEEL["trot"])
    feel = feel or {}
    meter = int(feel.get("meter") or 4)
    swing = float(feel.get("swing") if feel.get("swing") is not None else defaults["swing"])
    comp = feel.get("comp") or defaults["comp"]
    bassline = feel.get("bass") or defaults["bass"]
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
            out.append({"beat": beat, "beats": beats, "part": "melody", "patch": hire["melody"],
                        "pitch": m, "program": prog["melody"], "vel": vel})
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
                            "patch": hire["chord"], "pitch": order[slot % len(order)],
                            "program": prog["chord"],
                            "vel": 0.58 if slot % 2 == 0 else 0.48})
        else:
            for off, dur, vel in _comp_hits(comp, beats, meter):
                if pos + off >= total_beats:
                    break
                for p in voicing:
                    out.append({"beat": pos + off, "beats": dur, "part": "chord",
                                "patch": hire["chord"], "pitch": p,
                                "program": prog["chord"], "vel": vel})
        next_rm = None
        if idx + 1 < len(chords):
            next_rm = int(round(69 + 12 * math.log2(chords[idx + 1][0] / 440.0)))
        for off, dur, pitch, vel in _bass_line(bassline, rm, beats, next_rm, meter):
            if pos + off < total_beats:
                out.append({"beat": pos + off, "beats": dur, "part": "bass",
                            "patch": hire["bass"], "pitch": pitch,
                            "program": prog["bass"], "vel": vel})
        pos += beats
        if pos >= total_beats:
            break
    patterns = DRUM_PATTERNS_3 if meter == 3 else DRUM_PATTERNS
    fills = DRUM_FILLS_3 if meter == 3 else DRUM_FILLS
    base = patterns.get(style, patterns["trot"])
    fill = fills.get(style if style in fills else "trot")
    bar, bar_i = 0.0, 0
    while bar < total_beats:
        hits = list(base)
        if hits and fill and bar_i % 4 == 3:
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
    hits = {"kick": kick(), "snare": snare(), "hat": hat(), "ohat": ohat(),
            "tom_hi": tom(210.0, seed=5), "tom_mid": tom(150.0, seed=6),
            "tom_lo": tom(105.0, seed=8), "crash": crash()}
    for e in arr:
        i = int(SR * spb * e["beat"])
        if i >= n_total:
            continue
        if e["part"] == "drum":
            seg = hits[e["drum"]] * float(e.get("vel", 0.8))
            key = e["drum"]
        else:
            seg = synth_note(freq_of_midi(e["pitch"]), spb * e["beats"],
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
       "kick": 0.0, "snare": 0.08, "hat": 0.32, "ohat": 0.32,
       "tom_hi": -0.28, "tom_mid": 0.0, "tom_lo": 0.28, "crash": -0.32}
SEND = {"melody": 0.22, "chord": 0.16, "bass": 0.04,
        "kick": 0.05, "snare": 0.14, "hat": 0.08, "ohat": 0.10,
        "tom_hi": 0.16, "tom_mid": 0.16, "tom_lo": 0.16, "crash": 0.30}


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
        # (tick, on/off) pairs, then one pass in time order — MIDI deltas are relative, so the
        # note-offs have to be interleaved rather than appended per note.
        marks = []
        for e in rows:
            start = int(round(e["beat"] * tpb))
            pitch = DRUM_NOTE.get(e["drum"], 42) if part == "drum" else e["pitch"]
            vel = int(round(127 * float(e.get("vel", 0.71))))
            marks.append((start, 1, pitch, vel))
            marks.append((start + max(1, int(round(e["beats"] * tpb))), 0, pitch, 0))
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


def resolve_score_media(inp):
    """scoreMediaPath input = a media URL, a workspace path, or the ALIAS of a shelved score.

    Songs are called by name, so there is no default: with several scores and no name, the
    error hands over every alias — the error is the discovery surface here too.
    """
    raw = str(inp.get("scoreMediaPath") or "").strip()
    shelf = score_library()
    if raw:
        wanted = raw.lower()
        for row in shelf:
            if str(row.get("alias") or "").strip().lower() == wanted \
                    or str(row.get("name") or "").strip().lower() == wanted:
                return _media_to_path(str(row["url"]))
        if "/" not in raw and "." not in raw and shelf:
            # A bare word that matches nothing is a mistyped alias, not a path — say what exists.
            aliases = ", ".join(str(r.get("alias") or r.get("name")) for r in shelf)
            return None, f"악보 별칭 {raw!r} 이 보관함에 없습니다 — 보관함: {aliases}"
        return _media_to_path(raw)
    if len(shelf) == 1:
        return _media_to_path(str(shelf[0]["url"]))
    if shelf:
        aliases = ", ".join(str(r.get("alias") or r.get("name")) for r in shelf)
        return None, f"악보가 여러 개입니다 — scoreMediaPath 에 별칭을 주세요: {aliases}"
    return None, None


# ── file IO + top-level actions ────────────────────────────────────────────────────────────────


def read_wav_mono(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype="float64", always_2d=True)
    x = data.mean(axis=1)
    if sr != SR:
        x = resample_linear(x, SR / sr)
    return x


def write_wav(path, x):
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
            if isinstance(inp.get("style"), str):
                score["style"] = inp["style"]
            parsed_from = media_path
        else:
            return {"success": False,
                    "error": f"score media must be MIDI for now (.mid/.midi, got .{ext}) — "
                             "hum-to-score is a later slice"}
    spb, events, chords, style, band, feel, err = parse_score(score)
    if err:
        return {"success": False, "error": err}
    total_beats = sum(b for ev in events for _, b in ev["segments"])
    chord_beats = sum(c[1] for c in chords)
    total_beats = max(total_beats, chord_beats)
    arr = build_arrangement(events, chords, style, total_beats, band, feel)
    vocal_path = str(inp.get("vocalPath") or "").strip()
    # The melody doubles the voice when there is one, so it steps aside; with no vocal it IS the
    # tune, and dropping it was why an instrumental render came out as rhythm and bass only.
    if vocal_path:
        arr = [e for e in arr if e["part"] != "melody"]
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
    mix = add_room(mix, send)
    out_path = str(inp.get("outPath") or "").strip()
    if not out_path:
        h = hashlib.sha1(json.dumps(score, sort_keys=True).encode()).hexdigest()[:12]
        out_path = f"data/sing/out-{h}.wav"
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
    }
    if midi_written:
        data["midiPath"] = midi_written
    if midi_note:
        data["midiNote"] = midi_note
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
    # Brightness falling over the note is what separates an instrument from a beep — measured as
    # the high-frequency content of the head against the tail.
    tone = synth_note(220.0, 0.8, "melody")
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
    nostyle = parse_score({"bpm": 120, "style": "polka",
                           "notes": [{"syl": "라", "note": "C4", "beats": 1}]})
    ck("an unknown style is refused WITH the list", True, (nostyle[-1] or "")[:50],
       bool(nostyle[-1]) and "dance" in (nostyle[-1] or ""))

    # The score shelf resolves by alias, and its errors carry the shelf — both directions.
    os.environ["MODULE_SCORES"] = json.dumps([
        {"url": "/user/media/a.mid", "name": "canon.mid", "alias": "캐논"},
        {"url": "/user/media/b.mid", "name": "alhambra.mid", "alias": "알함브라"}])
    try:
        miss = resolve_score_media({"scoreMediaPath": "월광"})
        ck("a mistyped score alias is refused WITH the shelf", True, (miss[1] or "")[:60],
           bool(miss[1]) and "캐논" in (miss[1] or ""))
        ambig = resolve_score_media({})
        ck("several shelved scores and no name = the shelf list, not a guess", True,
           (ambig[1] or "")[:60], bool(ambig[1]) and "알함브라" in (ambig[1] or ""))
    finally:
        del os.environ["MODULE_SCORES"]

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
    else:
        out = {"success": False,
               "error": f"unknown action {action!r} — one of: render, selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts,
    # and the envelope is UTF-8 by contract on both ends.
    sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False)).encode("utf-8"))


if __name__ == "__main__":
    main()
