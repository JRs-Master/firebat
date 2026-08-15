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
    """Normalize {bpm, notes[], chords?, style?} -> (spb, events, chords, style, err).

    An event is one SUNG syllable: consecutive '-' notes extend the previous syllable across
    pitches (a melisma) — for the MVP the extension keeps the first pitch's duration math simple:
    each event carries a list of (freq, beats) segments.
    """
    if not isinstance(score, dict):
        return None, None, None, None, "score 가 객체가 아닙니다"
    bpm = float(score.get("bpm") or 0)
    if not (20 <= bpm <= 300):
        return None, None, None, None, f"bpm {bpm} 은 20~300 이어야 합니다"
    spb = 60.0 / bpm
    notes = score.get("notes")
    if not isinstance(notes, list) or not notes:
        return None, None, None, None, "notes 가 비었습니다"
    events = []
    for n in notes:
        if not isinstance(n, dict):
            return None, None, None, None, "notes 항목이 객체가 아닙니다"
        freq = note_freq(n.get("note"))
        beats = float(n.get("beats") or 1)
        if freq is None:
            return None, None, None, None, f"음이름을 읽을 수 없습니다: {n.get('note')!r}"
        if beats <= 0 or beats > 16:
            return None, None, None, None, f"beats {beats} 가 이상합니다 (0 < beats <= 16)"
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
    style = str(score.get("style") or "trot").strip().lower()
    return spb, events, chords, style, None


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

PATCHES = {
    # harm = harmonic amplitudes · hdecay/hslope = how fast brightness falls · detune = 2nd osc
    # offset (× f0) · noise = attack transient level · atk/rel = amplitude envelope seconds
    "melody": {"harm": [1.0, 0.55, 0.30, 0.16, 0.08], "hdecay": 1.6, "hslope": 1.35,
               "detune": 0.004, "noise": 0.06, "atk": 0.012, "rel": 0.10, "gain": 0.34},
    "chord":  {"harm": [1.0, 0.40, 0.16, 0.07], "hdecay": 0.9, "hslope": 1.2,
               "detune": 0.010, "noise": 0.0, "atk": 0.035, "rel": 0.22, "gain": 0.15},
    "bass":   {"harm": [1.0, 0.62, 0.28, 0.12], "hdecay": 2.4, "hslope": 1.5,
               "detune": 0.0, "noise": 0.03, "atk": 0.006, "rel": 0.09, "gain": 0.50},
}


def synth_note(freq, dur, patch="bass", vel=0.8):
    """One note of `patch` — float array of `dur` seconds, peak-normalised to the patch gain."""
    p = PATCHES.get(patch, PATCHES["bass"])
    n = max(1, int(SR * dur))
    t = np.arange(n) / SR
    x = np.zeros(n)
    # Velocity opens the timbre: the upper harmonics are the ones it reaches.
    bright = 0.55 + 0.45 * float(np.clip(vel, 0.0, 1.0))
    for k, amp in enumerate(p["harm"], start=1):
        f = freq * k
        if f > SR * 0.45:  # past Nyquist — this harmonic would alias back as a wrong pitch
            break
        a = amp * (bright ** (k - 1))
        if a < 0.005:
            continue
        # The brightness sweep, as a per-harmonic decay instead of a filter recursion.
        env_k = np.exp(-t * p["hdecay"] * (k ** p["hslope"]))
        wave = np.sin(2 * np.pi * f * t)
        if p["detune"]:
            wave = 0.5 * (wave + np.sin(2 * np.pi * (f + p["detune"] * freq * k) * t))
        x += a * env_k * wave
    if p["noise"]:
        m = min(n, int(SR * 0.012))
        if m > 1:
            # Fixed seed: the same score has to render the same bytes.
            burst = np.random.default_rng(int(freq)).standard_normal(m)
            burst = np.convolve(burst, np.ones(8) / 8.0, "same")
            x[:m] += burst * p["noise"] * np.linspace(1.0, 0.0, m)
    env = np.ones(n)
    a = min(n, int(SR * p["atk"]))
    if a > 1:
        env[:a] = np.linspace(0, 1, a)
    r = min(max(0, n - a), int(SR * min(p["rel"], dur * 0.35)))
    if r > 1:
        env[-r:] = np.linspace(1, 0, r)
    peak = float(np.max(np.abs(x))) or 1.0
    return x * env * (p["gain"] / peak)


# Per-style one-bar (4 beats) pattern: (instrument, beat offset).
DRUM_PATTERNS = {
    "trot":   [("kick", 0.0), ("hat", 0.5), ("snare", 1.0), ("hat", 1.5),
               ("kick", 2.0), ("hat", 2.5), ("snare", 3.0), ("hat", 3.5)],
    "ballad": [("kick", 0.0), ("hat", 1.0), ("snare", 2.0), ("hat", 3.0)],
    "march":  [("kick", 0.0), ("kick", 1.0), ("snare", 2.0), ("kick", 3.0), ("snare", 3.5)],
    "none":   [],
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

GM_PROGRAM = {"melody": 65, "chord": 4, "bass": 33}  # alto sax / e.piano / finger bass


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


def build_arrangement(events, chords, style, total_beats):
    """Score -> flat list of {beat, beats, part, pitch|drum, program}. Beats, not samples: the
    renderers turn them into whatever they count in (samples here, ticks in the MIDI writer)."""
    out = []
    # Melody — the notes the voice sings, also given to an instrument. Without this an
    # instrumental render (no vocalPath) had rhythm and bass and no tune at all.
    beat = 0.0
    for ev in events:
        for freq, beats in ev["segments"]:
            m = int(round(69 + 12 * math.log2(freq / 440.0)))
            out.append({"beat": beat, "beats": beats, "part": "melody",
                        "pitch": m, "program": GM_PROGRAM["melody"]})
            beat += beats
    pos = 0.0
    for root, beats, quality in chords:
        rm = int(round(69 + 12 * math.log2(root / 440.0)))
        for p in chord_voicing(rm, quality):
            out.append({"beat": pos, "beats": beats, "part": "chord",
                        "pitch": p, "program": GM_PROGRAM["chord"]})
        # An octave below the written root — a root written at C3 plays bass at C2.
        out.append({"beat": pos, "beats": beats, "part": "bass",
                    "pitch": rm - 12, "program": GM_PROGRAM["bass"]})
        pos += beats
        if pos >= total_beats:
            break
    bar = 0.0
    while bar < total_beats:
        for inst, off in DRUM_PATTERNS.get(style, DRUM_PATTERNS["trot"]):
            if bar + off < total_beats:
                out.append({"beat": bar + off, "beats": 0.25, "part": "drum", "drum": inst})
        bar += 4.0
    out.sort(key=lambda e: (e["beat"], e["part"]))
    return out


def render_arrangement(arr, spb, total_beats):
    """The numpy backend — every part of `arr` mixed into one float array."""
    n_total = int(SR * spb * total_beats) + int(SR * 0.5)
    out = np.zeros(n_total)
    hits = {"kick": kick(), "snare": snare(), "hat": hat()}
    for e in arr:
        i = int(SR * spb * e["beat"])
        if i >= n_total:
            continue
        if e["part"] == "drum":
            seg = hits[e["drum"]]
        else:
            seg = synth_note(freq_of_midi(e["pitch"]), spb * e["beats"], e["part"])
        out[i:i + len(seg)] += seg[: max(0, n_total - i)]
    return out


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
            pitch = 36 if part == "drum" and e["drum"] == "kick" else \
                38 if part == "drum" and e["drum"] == "snare" else \
                42 if part == "drum" else e["pitch"]
            marks.append((start, 1, pitch))
            marks.append((start + max(1, int(round(e["beats"] * tpb))), 0, pitch))
        marks.sort(key=lambda m: (m[0], m[1]))
        prev = 0
        for tick, on, pitch in marks:
            tr.append(mido.Message("note_on" if on else "note_off", channel=ch,
                                   note=max(0, min(127, pitch)),
                                   velocity=90 if on else 0, time=tick - prev))
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


def resolve_score_media(inp):
    """scoreMediaPath input, falling back to the module's own scoreMediaUrl setting.

    The setting stores a media URL (/user/media/<slug>.<ext>); the sandbox runs at workspace
    root, so stripping the leading slash (and any scheme+host) yields the readable path.
    """
    raw = str(inp.get("scoreMediaPath") or os.environ.get("MODULE_SCOREMEDIAURL") or "").strip()
    if not raw:
        return None, None
    path = raw
    if "://" in path:
        path = "/" + path.split("://", 1)[1].split("/", 1)[1] if "/" in path.split("://", 1)[1] else ""
    path = path.lstrip("/")
    if ".." in path.split("/"):
        return None, f"scoreMediaPath escapes the workspace: {raw}"
    if not os.path.isfile(path):
        return None, f"score file not found: {path} (workspace-relative)"
    return path, None


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
                    "error": "no score: pass `score`, or `scoreMediaPath`, or upload one in the "
                             "module settings (scoreMediaUrl)"}
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
    spb, events, chords, style, err = parse_score(score)
    if err:
        return {"success": False, "error": err}
    total_beats = sum(b for ev in events for _, b in ev["segments"])
    chord_beats = sum(c[1] for c in chords)
    total_beats = max(total_beats, chord_beats)
    arr = build_arrangement(events, chords, style, total_beats)
    vocal_path = str(inp.get("vocalPath") or "").strip()
    # The melody doubles the voice when there is one, so it steps aside; with no vocal it IS the
    # tune, and dropping it was why an instrumental render came out as rhythm and bass only.
    if vocal_path:
        arr = [e for e in arr if e["part"] != "melody"]
    mix = render_arrangement(arr, spb, total_beats) * 0.45
    if vocal_path:
        if not os.path.isfile(vocal_path):
            return {"success": False,
                    "error": f"vocalPath 파일이 없습니다: {vocal_path} (workspace 기준 상대 경로)"}
        vocal = render_vocal(read_wav_mono(vocal_path), events, spb)
        n = max(len(mix), len(vocal))
        mix = np.pad(mix, (0, n - len(mix))) + np.pad(vocal, (0, n - len(vocal))) * 0.9
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
    spb, events, chords, style, err = parse_score(score)
    ck("score parses", None, err, err is None)
    ck("a '-' note extends the previous syllable (melisma)", 3, len(events), len(events) == 3)

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
    # A chord written as one root has to reach the ear as a chord.
    ck("one written root becomes a triad", 3,
       sum(1 for e in arr if e["part"] == "chord"),
       sum(1 for e in arr if e["part"] == "chord") == 3)
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

    band = render_arrangement(arr, spb, 4)
    ck("accompaniment covers the bar", int(SR * spb * 4), len(band),
       abs(len(band) - SR * spb * 4) <= SR)
    ck("accompaniment is not silence and not NaN", True,
       bool(np.max(np.abs(band)) > 0.01), np.max(np.abs(band)) > 0.01 and not np.any(np.isnan(band)))

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
