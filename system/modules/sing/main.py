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

import collections
import inspect as _inspect
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


# `parse_score` 가 **악보 안에서** 읽는 노브 전부. 파일 악보(scoreMediaPath)로 부르면 악보
# dict 는 파일에서 나오므로, 호출자가 top-level 로 준 이 이름들을 거기 얹어 줘야 한다.
#
# ⚠️ 2026-08-21 로 이 목록이 짧아졌다. 여기 있던 기교 노브 아홉(orn·chordShape·humanize·
# voicing·laidback·gate·double·fill·vary)은 **우리가 지어낸 주법**이었고, 폰트가 원래 하는
# 연주법(프로그램 번호·CC1·피치휠·CC7/11)을 부르는 대신 그 자리를 차지하고 있었다.
# 장르 기본값(STYLE_FEEL)은 남는다 — 걷은 것은 호출자가 돌리던 다이얼이다.
SCORE_KNOBS = ("style", "band", "drumPattern", "bpm", "pedal",
               "swing", "comp", "bassline", "mix")


# 걷은 노브 — 값이 아니라 **부재**가 답이면 모델은 성공했다고 믿는다. 어느 인자가 조용히
# 무시되는지는 호출자가 알 방법이 없으므로, 걷은 이름은 자기가 걷혔다고 말하고 다음 수를 준다.
# (`lrc` 를 흡수할 때와 같은 자리 — 옛 이름이 오면 파서가 대답한다.)
RETIRED_KNOBS = {
    "orn":        "장식은 이제 악보가 적은 것만 연주합니다(트릴·꾸밈음·아르페지오)",
    "chordShape": "코드 모양은 장르가 정합니다 — rock·punk·metal 이 파워코드입니다",
    "humanize":   "루바토는 걷었습니다 — 적힌 자리에서 연주합니다",
    "voicing":    "성부 균형은 mix 로 주세요 — 예: mix {\"chord\": 0.5}",
    "laidback":   "뒤로 눕히기는 걷었습니다",
    "gate":       "음 길이는 장르가 정합니다(comp 로 주법을 고르세요)",
    "double":     "겹치기는 band.doubles 로 선언하세요 — 어느 성부를 무슨 악기로 몇 옥타브",
    "fill":       "받아침은 걷었습니다",
    "vary":       "마디별 세기 변화는 걷었습니다",
}


def retired_notice(d):
    """The one-line refusal for a knob we no longer play, or None."""
    if not isinstance(d, dict):
        return None
    for k in RETIRED_KNOBS:
        if d.get(k) is not None:
            return (f"{k} 는 2026-08-21 에 걷은 인자입니다 — 우리가 코드로 지어낸 주법이라, "
                    f"폰트가 원래 하는 연주법으로 갈아탔습니다. {RETIRED_KNOBS[k]}")
    return None


def parse_score(score):
    """Normalize {bpm, notes[], chords?, style?, band?, meter?, swing?, comp?, bassline?}
    -> (spb, events, chords, style, band, feel, err).

    An event is one SUNG syllable: consecutive '-' notes extend the previous syllable across
    pitches (a melisma) — for the MVP the extension keeps the first pitch's duration math simple:
    each event carries a list of (freq, beats) segments.
    """
    gone = retired_notice(score)
    if gone:
        return None, None, None, None, None, None, gone
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
            "pedal": pedal, "mix": mixmap}
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


def synth_note(freq, dur, patch="bass", vel=0.8, bend=None):
    """One note of `patch` — float array of `dur` seconds, peak-normalised to the patch gain.

    `bend` = [(음 길이의 몇 %, 반음), …]. 음 하나 안에서 음정이 움직인다. 물리모델(ks) 패치는
    줄 길이가 곧 음정이라 이 경로로는 못 휘고, 가산합성 패치만 휜다."""
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
        if bend:
            fr = t / max(1e-6, dur)
            semis = np.array([bend_at(bend, float(x)) for x in fr])
            curve = np.power(2.0, semis / 12.0)
        if p.get("vib"):
            rate, depth = p["vib"]
            # Vibrato that starts immediately sounds like a siren; players ease in.
            onset = np.minimum(1.0, t / 0.18)
            inst = freq * curve * (1.0 + depth * onset * np.sin(2 * np.pi * rate * t))
            ph = 2 * np.pi * np.cumsum(inst) / SR
        elif bend:
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
    # 뱅크 0 이 먼저 자리를 잡고(같은 이름이면 그쪽이 이긴다), 그 다음 나머지 멜로디 뱅크.
    # 예전엔 0 만 등록해서 GS/XG 변형 뱅크의 프리셋은 **이름이 있어도 부를 방법이 없었다.**
    for bank in [0] + [b for b in inv["banks"] if b not in (0, 128)]:
        for p in inv["presets"].values():
            if p["bank"] != bank:
                continue
            k = _norm_inst(p["name"])
            if k:
                _FONT_ALIASES.setdefault(k, (p["bank"], p["program"]))


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
            hit = ("font", g)                              # (뱅크, 프로그램)
    if hit is None:
        return None
    if hit[0] == "patch":
        return hit[1], PATCHES[hit[1]].get("gm", 0)
    if hit[0] == "font":
        bank, g = hit[1]
        # 뱅크는 세 번째 값으로만 나간다 — 두 값을 받는 호출부가 많고, 뱅크 0 이 대부분이라
        # 계약을 넓히는 대신 필요한 쪽이 `font_bank_of` 로 묻는다.
        return GM_BUILTIN_OVERRIDE.get(g, FAMILY_FALLBACK[g // 8]), g
    g = hit[1]
    return GM_BUILTIN_OVERRIDE.get(g, FAMILY_FALLBACK[g // 8]), g


def font_bank_of(name):
    """그 이름이 뱅크 0 이 아닌 프리셋을 가리키면 뱅크 번호, 아니면 None.
    .mid 를 쓸 때만 필요하다 — 뱅크 셀렉트(CC0)가 program_change 앞에 서야 한다."""
    hit = _FONT_ALIASES.get(_norm_inst(name))
    if isinstance(hit, tuple) and hit[0] not in (0, None):
        return hit[0]
    return None


_GM_REVERSE = None


def gm_name(program):
    """GM 번호 → 사람이 읽는 이름. 보고 전용 — 있는 표를 뒤집을 뿐 새 목록이 아니다.
    짧은 이름(우리 어휘)이 있으면 그것, 없으면 규격 이름, 둘 다 없으면 번호."""
    global _GM_REVERSE
    if program is None:
        return "?"
    if _GM_REVERSE is None:
        rev = {}
        for k, v in GM_OFFICIAL.items():
            rev.setdefault(v, k)
        for k, v in GM_NAMES.items():
            rev[v] = k          # 짧은 이름이 이긴다
        _GM_REVERSE = rev
    return _GM_REVERSE.get(int(program), "GM%d" % program)


def named_program(name):
    """파트 이름이 악기를 말하면 그 GM 번호, 아니면 None.

    총보의 파트 이름은 대개 악기 이름 그대로다("Flute", "Violin I"). `<midi-program>` 이 없는
    악보에서는 그 이름이 편성에 대해 우리가 가진 **유일한 선언**이고, 그걸 안 읽으면 전 성부가
    프로그램 0(피아노)으로 떨어져 악보가 말한 것을 우리가 지운다.

    성부 번호(I·II·2)는 "같은 악기의 몇 번째 자리"라는 뜻이라 떼고 한 번 더 묻는다. 이름을 못
    알아들으면 None — 지어내지 않는다.
    """
    raw = str(name or "").strip()
    if not raw:
        return None
    got = resolve_instrument(raw)
    if got is None:
        import re as _re
        trimmed = _re.sub(r"[\s._-]*(?:[0-9]+|[IVXivx]+)$", "", raw).strip()
        if trimmed and trimmed != raw:
            got = resolve_instrument(trimmed)
    return got[1] if got else None


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
                 "christmas": "carol", "xmas": "carol",
                 # 사람이 말하는 이름 그대로. 한 라운드를 아끼자는 것이지 새 장르가 아니다 —
                 # "헤비메탈로 해줘" 는 목록과 함께 거부당한 뒤 모델이 다시 부르고 있었다.
                 "트로트": "trot", "뽕짝": "trot", "메탈": "metal", "헤비메탈": "metal",
                 "락": "rock", "록": "rock", "발라드": "ballad", "재즈": "jazz",
                 "블루스": "blues", "힙합": "hiphop", "랩": "hiphop", "컨트리": "country",
                 "훵크": "funk", "펑키": "funk", "펑크록": "punk", "펑크로크": "punk",
                 "댄스": "dance", "클래식": "classic", "행진곡": "march", "마치": "march",
                 "캐롤": "carol", "캐럴": "carol", "포크": "folk", "민요": "folk",
                 "알앤비": "rnb", "아르앤비": "rnb", "뉴에이지": "newage", "팝": "pop",
                 "로큰롤": "rocknroll", "로큰롤": "rocknroll", "왈츠": "ballad"}
# ⚠️ 맨 "펑크" 는 일부러 없다 — 우리말에서 punk 도 funk 도 그렇게 쓴다. 뜻이 둘인 별칭은 모델이
# 하나를 합법적으로 골라 틀리고 값이 유효라 어느 그물에도 안 찍힌다(제7장 "한 필드 한 뜻").
# 목록과 함께 거부당해 사용자가 고르는 편이 조용히 다른 장르로 가는 것보다 낫다.


def band_seats(style, band=None):
    """장르가 선언한 자리 → `{part: [악기, …]}`. 컴핑은 자리가 여럿일 수 있다.

    자리마다 악기가 하나이던 시절, 성부가 몇이든 리드와 베이스를 뺀 전부가 `chord` 한 자리에서
    악기를 받아 갔다. 아로나 5성부를 뽕짝으로 입히니 기타·피아노·기타가 **아코디언 세 대**가
    됐고(사용자 8/21 "웅엥웅엥"), 감쇠 없는 악기 세 벌이 겹치면 화음이 아니라 벽이다. 세 대를
    쓰기로 아무도 결정하지 않았다 — 컴핑 의자가 하나뿐인 소리였다.

    목록 길이 1 = 옛 동작 그대로. 호출자가 자리 이름을 대면 그 자리는 통째로 그 하나가 된다
    ("컴핑을 피아노로"). 둘째·셋째 손을 따로 지목하는 것은 자리가 아니라 **역할**이라
    `recast_parts` 몫이다.
    """
    out = {part: ([v] if isinstance(v, str) else [x for x in v if x])
           for part, v in STYLE_BAND.get(style, STYLE_BAND["trot"]).items()}
    for part, name in (band or {}).items():
        if part in out and resolve_instrument(name) is not None:
            out[part] = [name]
    return out


# 여기 `comping_stage` 가 있었다 — 컴핑 N 목소리를 좌우로 벌려 앉히던 것. 포개지는 것을
# 푼다는 이유였지만 **자리를 정한 것은 우리**였고, 그 자리는 파일에도 폰트에도 근거가 없다.
# 이제 팬은 파일의 CC10 이 말할 때만 움직인다.


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
    # the GS/GM2 extension, and the fonts people actually install do carry it: GeneralUser GS
    # ships 13 kits (실측 8/22). Naming them is the difference between "the font has castanets" and "you
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
    # 컴핑 자리는 **목록**일 수 있다 — 성부가 여럿인 악보를 입힐 때 높은 성부부터 순서대로
    # 앉는다. 하나만 적으면(대부분) 옛 동작 그대로다. 아래 셋만 목록인 이유 = 그 편성의 관례를
    # 댈 수 있는 장르가 그 셋이고, 없는 취향을 내가 지어내는 것이 이 표에서 제일 위험하다.
    "trot":      {"melody": "melody", "chord": ["accordion", "epiano", "cguitar"],
                  "bass": "bass"},
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
    # 관현악의 안쪽 성부는 패드가 아니라 **각자 다른 줄**이다. 자리가 하나뿐이던 시절 "오케스트라"
    # 는 바이올린 + 현악 패드 + 콘트라베이스 세 줄이었고, 관현악처럼 들리게 하려고 STYLE_DOUBLES
    # 가 한 줄을 넷으로 유니즌 겹쳤다 — 두께로 때운 것이지 편성이 아니었다(사용자 8/21
    # "오케스트라도 악기를 몇 개 안 쓰더라"). 순서 = 음역 내림차순, 총보가 앉는 그 순서.
    "classic":   {"melody": "violin",
                  "chord": ["violin", "viola", "clarinet", "cello", "frenchhorn"],
                  "bass": "contrabass"},
    "strings":   {"melody": "violin", "chord": ["violin", "viola", "cello"],
                  "bass": "contrabass"},
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
    "rock":      {"voicing_kind": "power", "comp": "eighths", "bass": "drive", "swing": 0.0, "gate": 0.8},
    "metal":     {"voicing_kind": "power", "comp": "chug", "bass": "drive",
                  "swing": 0.0, "gate": 1.0},
    "pop":       {"comp": "eighths", "bass": "alt", "swing": 0.0, "gate": 0.85},
    "dance":     {"comp": "stabs", "bass": "offbeat", "swing": 0.0, "gate": 0.7},
    "rnb":       {"comp": "arp", "bass": "hold", "swing": 0.45, "gate": 0.9},
    "rocknroll": {"comp": "quarters", "bass": "boogie", "swing": 0.6, "gate": 0.75},
    "hiphop":    {"comp": "pad", "bass": "hold", "swing": 0.45, "gate": 0.85},
    "country":   {"comp": "stabs", "bass": "twobeat", "swing": 0.0, "gate": 0.8},
    "funk":      {"comp": "chank", "bass": "funk16", "swing": 0.0, "gate": 0.55},
    "punk":      {"voicing_kind": "power", "comp": "eighths", "bass": "drive", "swing": 0.0, "gate": 0.6},
    "jazz":      {"comp": "charleston", "bass": "walk", "swing": 0.65, "gate": 0.85},
    "blues":     {"comp": "quarters", "bass": "walk", "swing": 0.6, "gate": 0.85},
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
COMP_KINDS = ("pad", "stabs", "arp", "quarters", "eighths", "chug", "charleston", "chank")
BASS_KINDS = ("hold", "twobeat", "alt", "walk", "drive", "offbeat", "funk16", "boogie")
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


# 벤딩의 통로는 남는다 — 움직이는 것은 **악보가 적은 벤딩**이지 우리가 고른 곡선이 아니다.
# 행의 `bend` = [(음 길이의 몇 %, 반음), …]. sf2 는 피치휠로, 내장 신디는 위상 램프로 낸다.
# ⚠️ 2026-08-21 현재 이 칸을 채우는 곳이 없다 — 파서가 악보의 벤딩을 읽기 시작하면 산다.


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


def recast_parts(rows, style, band=None, lead_row=None, keep_instruments=False, names=None):
    """The file's own parts, re-cast for a genre — every voice keeps its notes and takes the
    instrument its ROLE and REGISTER call for. Returns (rows, cast_map).

    The arrangement path throws the score away: it reduces the piece to one line, derives chords
    from it, and rebuilds a backing. That is right when you want the genre to play the song, and
    wrong when the song already has five parts and you only wanted them dressed differently
    (사용자 8/20: "악보에 나오는 악기들을 헤비메탈에 맞게 바꿔서 다 넣어줄 수 있나" — the model
    could only approximate it with four layers of doubling, because this path did not exist).

    Casting is derived, not declared: the part the reader chose as the tune sings, the lowest
    voice plays bass, everyone else comps — and the comping voices take the genre's hands **in
    register order**, highest part first. That order is why an orchestra sounds like one: violin,
    viola, clarinet, cello sit where a score puts them. Before it, every comping voice asked the
    same single seat and got the same answer (아로하 뽕짝: 아코디언 세 대 = "웅엥웅엥").

    `keep_instruments` = the parts play what the FILE says they play; only the roles, the stage
    and the balance are ours. "악보에 있는 악기들 다 살려서 뽕짝으로" reads that way in Korean and
    there was no path for it: `faithful` refuses the moment a style is named, so keeping the
    score's own instruments meant losing the groove entirely."""
    voices = {}
    for r in rows:
        if "pitch" in r and not r.get("pedal"):
            voices.setdefault(r["part"], []).append(r["pitch"])
    if not voices:
        return rows, {}
    avg = {p: sum(v) / len(v) for p, v in voices.items()}
    seats = band_seats(style, band)
    lead = lead_row if lead_row in avg else max(avg, key=lambda x: avg[x])
    low = min(avg, key=lambda x: avg[x])
    by_register = sorted(avg, key=lambda x: -avg[x])
    roles, n = {}, 0
    for part in by_register:
        if part == lead:
            roles[part] = "melody"
        elif part == low:
            roles[part] = "bass"
        else:
            n += 1
            roles[part] = "chord" if n == 1 else f"chord{n}"
    comping = [p for p in by_register if roles[p].startswith("chord")]
    hands = seats.get("chord") or ["piano"]
    inst_for = {"melody": (seats.get("melody") or ["piano"])[0],
                "bass": (seats.get("bass") or ["bass"])[0]}
    src_prog = {}
    for r in rows:
        if "pitch" in r and r.get("part") in avg and r["part"] not in src_prog:
            src_prog[r["part"]] = r.get("program")
    for i, part in enumerate(comping):
        inst_for[roles[part]] = hands[i % len(hands)]
    # 역할 단위 지목 — `band: {"chord2": "piano"}` 는 자리가 아니라 **둘째 컴핑**을 말한다.
    # 자리에만 걸려 있던 시절 그 이름은 `hire` 에 키가 없어 조용히 버려졌고, 호출자는 둘째 손을
    # 부를 방법이 아예 없었다. 명시가 파생을 이긴다.
    for role, name in (band or {}).items():
        if role in inst_for and resolve_instrument(name) is not None:
            inst_for[role] = name
    out = []
    for r in rows:
        if r.get("part") == "drum":
            out.append(r)
            continue
        role = roles.get(r.get("part"))
        if role is None:
            out.append(r)
            continue
        q = dict(r)
        q["part"] = role
        if not keep_instruments:
            _nm = inst_for.get(role, "piano")
            got = resolve_instrument(_nm)
            if got is not None:
                q["patch"], q["program"] = got
                _bk = font_bank_of(_nm)
                if _bk:
                    q["bank"] = _bk
        out.append(q)
    # 누가 무엇을 연주하는지는 **응답이 말해야 한다.** 캐스팅은 파생이라 호출자가 짐작할 수 없고,
    # 사용자가 "이게 원래 악보상 악기를 쓴다는 말인가"를 물어야 했던 자리가 바로 이것이다(8/21).
    cast = {}
    for src, role in roles.items():
        name = (gm_name(src_prog.get(src)) if keep_instruments
                else inst_for.get(role, "piano"))
        cast[role] = {"part": (names or {}).get(src, src), "instrument": name}
    return out, cast


def build_arrangement(events, chords, style, total_beats, band=None, feel=None):
    """Score -> flat list of {beat, beats, part, patch, pitch|drum, program, vel}. Beats, not
    samples: the renderers turn them into whatever they count in (samples here, MIDI ticks there).
    `band` = per-part instrument override ({part: PATCHES name}) on top of the style's own.
    `feel` = {meter, swing, comp, bass} from parse_score; None = the style's own defaults."""
    # 편곡 경로는 컴핑이 **한 목소리**다(chord2 = 더블트래킹이라 같은 악기가 제 규약) — 자리의
    # 첫 손을 쓴다. 자리가 목록이 된 것은 악보 성부를 입히는 recast 쪽 사정이고, 여기 소리는
    # 목록 도입 전과 바이트 단위로 같아야 한다.
    # The answering voice defaults to whoever is comping — in trot that is the accordion, which
    # is the instrument the ear expects to hear reply. `band.fill` names someone else.
    hire = {k: v[0] for k, v in band_seats(style, band).items() if v}
    # Two faces per instrument: the GM program (what the .mid and the sf2 engine mean) and the
    # builtin patch (what numpy can play). PATCHES names are native to both; GM names degrade.
    patch_of, prog, bank_of = {}, {}, {}
    for part, name in hire.items():
        patch_of[part], prog[part] = resolve_instrument(name)
        bank_of[part] = font_bank_of(name)
    defaults = STYLE_FEEL.get(style, STYLE_FEEL["trot"])
    feel = feel or {}
    # Caller first, genre second — for every axis. A genre row is a bundle of defaults, not a
    # locked kit: naming one different hand has to leave the other five where the genre put them.
    voicing_kind = feel.get("voicing_kind") or defaults.get("voicing_kind", "")
    if voicing_kind == "full":       # an explicit "not power" is the plain quality voicing
        voicing_kind = ""
    meter = int(feel.get("meter") or 4)
    swing = float(feel.get("swing") if feel.get("swing") is not None else defaults["swing"])
    comp = feel.get("comp") or defaults["comp"]
    bassline = feel.get("bass") or defaults["bass"]
    # Articulation: how much of a written note actually SOUNDS — the genre's own value, not a
    # dial. Velocity alone made every style press notes the same shape (funk clips, a ballad
    # sings through), so the row keeps saying it; the caller no longer overrides it.
    gate = float(defaults.get("gate", 0.9))
    # A machine-gun roll belongs to uptempo music: a slow piece keeps its soft fill even in a
    # rolling genre (실측: pop-style 캐논 at a slow bpm rolled, and it fit nothing).
    bpm = float(feel.get("bpm") or 120.0)
    out = []
    # Melody — the notes the voice sings, also given to an instrument. Without this an
    # instrumental render (no vocalPath) had rhythm and bass and no tune at all.
    # Velocity is a phrase shape, not a constant: downbeats lean, offbeats step back.
    beat = 0.0
    mel_gaps, prev_m = [], None
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
            out.append({"beat": beat, "beats": beats, "part": "melody",
                        "patch": patch_of["melody"], "pitch": m,
                        "program": prog["melody"], "vel": vel, "gate": gate})
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
            hits_here = _comp_hits(comp, beats, meter, spb=spb_a)
            for hi, (off, dur, vel) in enumerate(hits_here):
                if pos + off >= total_beats:
                    break
                for p in struck:
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
    # 뱅크는 여기서 한 번 얹는다 — emit 자리마다 붙이면 새 emit 이 생길 때마다 빠진다.
    for e in out:
        b = bank_of.get(e.get("part"))
        if b:
            e["bank"] = b
    out.sort(key=lambda e: (e["beat"], e["part"]))
    return out


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
    bank = font_bank_of(inst)
    for r in rows:
        if "pitch" in r and not r.get("pedal"):
            r["patch"], r["program"] = patch, prog
            if bank:
                r["bank"] = bank
    return rows, inst


def apply_performance(arr, feel, spb, total_beats):
    """The pedal layer, applied to ANY arr (faithful or arranged).

    pedal:true — when the score carries no pedal marks of its own, generate the pianist's
    default: press at every bar, release at the barline (re-pedal — the standard way to keep the
    wash without smearing harmonies; 월광's own marks are famously absent from transcriptions).
    pedal:false plays a marked score dry; unasked plays exactly what is written.

    ⚠️ humanize·voicing 이 여기 있었다 — 랜덤워크 루바토와 성부별 세기 재조정. 둘 다 우리가
    지어낸 연주였고 2026-08-21 에 걷었다. 세기는 이제 악보가 적은 것과 볼륨 층이 정한다.
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
    return arr


def render_arrangement(arr, spb, total_beats, mixmap=None, filecc7=None, ctl=None):
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
        # 같은 판정을 .mid 는 CC7·CC11 로 말하고 여기서는 진폭으로 곱한다 — 층이 둘이지
        # 표가 둘이 아니다.
        # 내장 신디는 컨트롤러를 다 알아듣지 못한다 — 진폭에 닿는 CC11 만 반영하고 나머지는
        # 그냥 안 쓴다(sf2 로는 전부 나간다). 못 하는 것을 흉내 내면 두 엔진이 갈린다.
        lvl = part_gain(e["part"], mixmap, filecc7) \
            * expr_at((((ctl or {}).get(e["part"]) or {}).get("cc") or {}).get(CC_EXPRESSION),
                      e["beat"])
        if e["part"] == "drum":
            # sf2 는 번호를 그대로 친다. 내장 신디는 샘플이 **이름으로** 서 있어서, 이름 없는
            # 번호는 제일 가까운 번호의 샘플로 근사한다 — 근사는 내장 신디의 성질이지 손실이
            # 아니고, 여기서 버리면 두 엔진이 서로 다른 음표를 연주하게 된다.
            key = e.get("drum")
            if key not in hits:
                key = _nearest_drum_name(e.get("drumNote"))
            seg = hits[key] * float(e.get("vel", 0.8)) * lvl
        else:
            held = e["beats"]
            for a, b in pedal_spans.get(e["part"], ()):  # noqa: B007
                if a <= e["beat"] < b:
                    held = max(held, b - e["beat"])
                    break
            seg = synth_note(freq_of_midi(e["pitch"]),
                             spb * held * float(e.get("gate", 1.0)),
                             e.get("patch", e["part"]), vel=float(e.get("vel", 0.8)),
                             bend=e.get("bend")) * lvl
            key = e["part"]
        m = min(len(seg), n_total - i)
        seg = seg[:m]
        # Constant-power pan: the band sits on a stage, not a point.
        pan_v = float(e.get("pan") or 0.0)     # 행이 말할 때만. 아니면 중앙 = GM 기본
        theta = (pan_v + 1.0) * np.pi / 4.0
        out[i:i + m, 0] += seg * np.cos(theta)
        out[i:i + m, 1] += seg * np.sin(theta)
        send[i:i + m] += seg * ROOM_SEND
    # 내장 신디도 같은 마스터 페이더를 지난다 — 엔진을 바꿨다고 크기가 달라지면 안 된다.
    out *= BUILTIN_GAIN
    send *= BUILTIN_GAIN
    return out, send


# ── 아무도 안 말했으면 아무 말도 안 한다 ───────────────────────────────────────────────────
# 여기 `MIX`(멜로디 1.0 · 베이스 0.80 · 컴핑 0.58 …) 표가 있었다. 그 숫자는 **우리가 지어낸
# 것**이고, 표를 하나 들고 있는 한 파일이 뭐라 쓰든 우리 결정이 그 위에 얹힌다
# (사용자 2026-08-21: *"니가 임의로 설정한 값들은 다 폰트 디폴트로"*).
#
# 규격은 아무도 안 보냈을 때의 답을 이미 갖고 있다 — GM 채널 볼륨 100, 팬 중앙, 리버브 센드 40.
# 그리고 폰트는 **그 기본 위에서** 목소리들의 음량이 맞도록 잡혀 있다.
# **안 보낸 컨트롤러는 결손이 아니라 그 답에 맡긴 것이다.**
#
# 남은 출처 둘 = 호출자의 `mix` · 파일의 CC7. 둘 다 없으면 침묵.
MIX_TOP = 127          # 호출자가 mix 1.0 이라 하면 그것은 페이더 끝이다 — 우리 여유분이 아니라


def mix_cc7(level):
    """A `mix` level (an AMPLITUDE ratio) → the CC7 byte that actually produces it.

    Channel Volume is not a linear fader. The MIDI/DLS curve is `dB = 40·log10(cc/127)`, i.e. the
    gain is the byte **squared** — so writing `MIX_TOP * mix` asked for mix² and every part below
    the lead came out far quieter than the table says. Our own two engines disagreed because of
    it: the builtin renderer multiplies the samples by `mix` (a true amplitude ratio) while the
    .mid asked the SoundFont for its square.

    실측 2026-08-21: mix 0.335 를 선형으로 쓰면 CC7 37 = 리드보다 −18.9 dB 인데 부른 값은
    −9.5 dB 였다. 곡선을 뒤집어야 호출자가 말한 비율이 두 엔진에서 그대로 난다.
    """
    return max(1, min(127, int(round(MIX_TOP * math.sqrt(max(0.0, min(1.0, level)))))))


def mix_of(part, over=None):
    """The caller's level for this part, or **None**. 표는 없다 — 아무도 안 말하면 없는 것이다."""
    if over and part in over:
        return max(0.0, min(1.0, float(over[part])))
    return None


# ── 볼륨은 표 하나가 아니라 층 셋이고, 각자 일과 출처가 다르다 ─────────────────────────────────
#   벨로시티  = 이 **음 하나**를 얼마나 세게 쳤나. 폰트의 레이어도 이 값이 고른다.  출처 = 악보
#   CC7      = 그 **파트의 페이더**. 곡 내내 고정.                                출처 = 파일 > 우리 표
#   CC11     = 그 파트 **안에서의 부풀림**(크레셴도). 시간에 따라 움직인다.        출처 = 파일
# 셋을 하나로 뭉개면 어느 층이 틀렸는지 못 가른다 — 8/21 하루가 그것이었다.
def part_cc7(part, mixmap=None, filecc7=None):
    """The fader byte for this part, or **None when nobody said one**.

    호출자의 mix 가 먼저, 없으면 **파일이 쓴 바이트
    그대로**, 그것도 없으면 **None** — 그러면 CC7 을 아예 안 보내고 신디 기본값(GM 100)이 선다.
    예전엔 여기서 우리 표가 답했고, 그 표가 곡의 균형을 정하고 있었다."""
    if mixmap and part in mixmap:
        return mix_cc7(max(0.0, min(1.0, float(mixmap[part]))))
    if filecc7 and filecc7.get(part) is not None:
        return max(0, min(127, int(filecc7[part])))
    return None


def part_gain(part, mixmap=None, filecc7=None):
    """같은 판정을 내장 신디용 진폭(0~1)으로. 아무도 안 말했으면 **1.0** — sf2 쪽에서 CC7 을
    안 보내는 것과 같은 뜻이다(둘 다 '건드리지 않는다')."""
    byte = part_cc7(part, mixmap, filecc7)
    return 1.0 if byte is None else min(1.0, (byte / 127.0) ** 2)


def expr_at(series, beat):
    """CC11 at `beat` as a 0~1 gain — a step curve, which is what a controller is. 없으면 1.0."""
    if not series:
        return 1.0
    val = series[0][1]
    for at, v in series:
        if at > beat:
            break
        val = v
    return (max(0, min(127, int(val))) / 127.0) ** 2


# 여기 `PAN`(파트·드럼 보이스마다 좌우 자리) 과 `SEND`(파트마다 리버브 양) 표가 있었다. 둘 다
# 우리가 지어낸 것이고, **SF2 는 존마다 자기 팬을 선언한다**(generator 17) — 우리가 CC10 을
# 보내면 그 선언을 덮는다. 이제 팬은 **행이 말할 때만** 나가고(파일의 CC10 이 그 출처),
# 리버브는 파트를 안 가린다. 내장 신디의 방도 하나 — GM 기본 센드(CC91 = 40)를 균일하게.
ROOM_SEND = 40 / 127.0     # GM Level 1 이 정한 기본값. 파트별 차등은 우리 취향이었다


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


def write_midi(arr, bpm, path, mix=None, filecc7=None, ctl=None, sysex=None):
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
            # else the font carried (GeneralUser GS ships 13 kits; we could reach one).
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
            # 뱅크 셀렉트가 program_change **앞**에 서야 한다 — 뒤에 오면 다음 프로그램부터
            # 걸린다. 뱅크 0 이면 아무 말도 안 한다(기본값). 이게 없던 동안 폰트의 GS/XG 변형
            # 뱅크는 이름이 있어도 부를 방법이 없었다.
            _bank = int((first_note or {}).get("bank") or 0)
            if _bank:
                tr.append(mido.Message("control_change", channel=ch, control=0,
                                       value=max(0, min(127, _bank)), time=0))
            tr.append(mido.Message("program_change", channel=ch,
                                   program=int((first_note or {}).get("program", 0)), time=0))
            # 팬도 **행이 말할 때만**. SF2 는 존마다 자기 팬을 선언하고(gen 17) CC10 을 보내면
            # 그 선언을 덮는다 — 우리 표가 하던 일이 그것이다.
            pan = (first_note or {}).get("pan")
            if pan is not None:
                tr.append(mido.Message("control_change", channel=ch, control=10,
                                       value=max(0, min(127, int(round(64 + pan * 63)))), time=0))
        # 페이더를 여기서 놓는 것은 **아무도 안 말했을 때뿐**이다. 파일이 CC7 을 썼으면 그 시리즈가
        # 아래 패스스루로 그대로 지나간다 — 우리가 t=0 에 첫 값을 미리 놓으면, 4박에서 페이더를
        # 내리는 파일의 앞 4박이 조용히 그 값으로 바뀐다(그리고 같은 바이트가 두 번 나간다).
        _file_fader = bool(((ctl or {}).get(part) or {}).get("cc", {}).get(CC_VOLUME))
        _fader = part_cc7(part, mix, filecc7)
        if _fader is not None and not (_file_fader and not (mix and part in mix)):
            tr.append(mido.Message("control_change", channel=ch, control=7,
                                   value=_fader, time=0))
        # (tick, kind) marks in one time-ordered pass — MIDI deltas are relative, so note-offs
        # and pedal changes have to be interleaved rather than appended per event. kind: 0 =
        # note_off, 1 = note_on, 2 = CC64 (sustain — fluidsynth and every GM synth honor it),
        # 3 = pitch wheel (벤딩 — sf2 가 기본 엔진이라 여기에도 실려야 실제로 들린다),
        # 4 = 컨트롤 체인지 일반(값 a, 번호 b). 파일이 보낸 컨트롤러는 **전부** 여기로 지나간다:
        # CC11 부풀림, CC1 모듈레이션(폰트 자기 비브라토 LFO), CC64, CC91/93 센드… 무엇을
        # 뜻하는지 우리가 알 필요가 없다. 아는 쪽은 폰트다. 셋만 고르던 것이 손목록이었다.
        marks = []
        # 5 = program_change. 리더는 트랙 중간 악기 변경을 읽는데(`_prog_at`) 라이터가 트랙당
        # 하나만 써서, 도중에 바뀐 악기가 첫 악기로 되돌아가고 있었다 — 실측 2026-08-21 비발디
        # 사계 봄: 4,054음 중 **218음이 다른 악기로** 났다. 읽기만 고치고 쓰기를 안 따라간 자리.
        _pg_now = int((first_note or {}).get("program", 0)) if part != "drum" else None
        if part != "drum":
            for e in rows:
                if e.get("pedal") or "program" not in e:
                    continue
                _p = int(e["program"])
                if _p != _pg_now:
                    marks.append((int(round(e["beat"] * tpb)), 5, _p, 0))
                    _pg_now = _p
        _cs = (ctl or {}).get(part) or {}
        _skip = {CC_VOLUME} if (mix and part in mix) else set()   # 호출자가 덮은 페이더만 막는다
        for _num, _series in (_cs.get("cc") or {}).items():
            if _num in _skip:
                continue
            for at, val in _series:
                marks.append((int(round(at * tpb)), 4, max(0, min(127, int(val))), int(_num)))
        for at, val in (_cs.get("bend") or []):
            marks.append((int(round(at * tpb)), 3, max(-8192, min(8191, int(val))), 0))
        # 압력 둘. 뜻을 몰라도 나른다 — 무엇을 하는지는 폰트가 선언한다(GS = 비브라토).
        for at, val in (_cs.get("press") or []):
            marks.append((int(round(at * tpb)), 6, max(0, min(127, int(val))), 0))
        for at, note, val in (_cs.get("poly") or []):
            marks.append((int(round(at * tpb)), 7, max(0, min(127, int(val))),
                          max(0, min(127, int(note)))))
        for e in rows:
            if e.get("pedal"):
                start = int(round(e["beat"] * tpb))
                end = start + max(1, int(round(e["beats"] * tpb)))
                marks.append((start, 2, 127, 0))
                marks.append((end, 2, 0, 0))
                continue
            curve = e.get("bend")
            if curve and part != "drum":
                # GM 의 휠 기본 범위는 ±2반음 — 록의 온음 벤딩이 마침 그 끝이다. 끝나면 0 으로
                # 돌려 다음 음을 오염시키지 않는다. **시간 격자로** 훑는 이유는 벤딩이
                # 박이 아니라 초로 움직이기 때문 — 음을 n등분하면 느린 곡에서 늘어진다.
                spb_w = 60.0 / max(1e-6, bpm)
                dur_s = e["beats"] * spb_w
                b0 = int(round(e["beat"] * tpb))
                b1 = b0 + max(1, int(round(e["beats"] * tpb)))
                steps = max(8, min(240, int(dur_s / 0.025)))
                for k in range(steps + 1):
                    frac = k / steps
                    semis = bend_at(curve, frac)
                    val = max(-8192, min(8191, int(round(semis / 2.0 * 8192))))
                    marks.append((b0 + int((b1 - b0) * frac), 3, val, 0))
                marks.append((b1, 3, 0, 0))
            start = int(round(e["beat"] * tpb))
            if part == "drum":
                # 파일에서 온 행은 자기 번호를 들고 있다. 편곡기가 만든 행만 이름표를 거친다.
                pitch = (int(e["drumNote"]) if e.get("drumNote") is not None
                         else DRUM_NOTE.get(e.get("drum"), 42))
            else:
                pitch = e["pitch"]
            # 벨로시티는 **바이트 그대로** 나간다 — 곡선도 스케일도 없다. 세게 친 음이 얼마나
            # 커지고 어느 샘플 레이어를 고르는지는 폰트가 정한다(SF2 기본 모듈레이터
            # velocity → attenuation). 여기서 우리가 손대면 그 판단을 두 번 하는 것이 된다.
            vel = int(round(127 * float(e.get("vel", XML_DEFAULT_VEL))))
            length = e["beats"] * float(e.get("gate", 1.0))
            marks.append((start, 1, pitch, vel))
            marks.append((start + max(1, int(round(length * tpb))), 0, pitch, 0))
        # 컨트롤러가 음보다 먼저 — 같은 틱에서 CC11 이 note_on 뒤에 오면 그 음은 옛 값으로 난다.
        # 컨트롤러와 프로그램이 음보다 먼저 — 같은 틱에서 뒤에 오면 그 음은 옛 값으로 난다.
        marks.sort(key=lambda m: (m[0], {4: -2, 5: -1, 6: -0.5, 7: -0.4}.get(m[1], m[1])))
        prev = 0
        for tick, kind, a, b in marks:
            if kind == 5:
                tr.append(mido.Message("program_change", channel=ch,
                                       program=max(0, min(127, a)), time=tick - prev))
            elif kind == 4:
                tr.append(mido.Message("control_change", channel=ch, control=b, value=a,
                                       time=tick - prev))
            elif kind == 3:
                tr.append(mido.Message("pitchwheel", channel=ch, pitch=a, time=tick - prev))
            elif kind == 6:
                tr.append(mido.Message("aftertouch", channel=ch, value=a, time=tick - prev))
            elif kind == 7:
                tr.append(mido.Message("polytouch", channel=ch, note=b, value=a,
                                       time=tick - prev))
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
    # 파일이 보낸 전역 시스템 메시지는 **자기 트랙**에 실린다 — 파트 트랙에 끼우면 그 파트의
    # 채널 배치에 묶여 읽히고, 애초에 이건 파트의 것이 아니다. 없으면 트랙도 안 생긴다.
    if sysex:
        con = mido.MidiTrack()
        con.append(mido.MetaMessage("track_name", name="_file", time=0))
        prev_t = 0
        for beat, data in sorted(sysex, key=lambda x: x[0]):   # 안정 정렬 = 파일 순서 보존
            tick = int(round(float(beat) * tpb))
            con.append(mido.Message("sysex", data=list(data), time=max(0, tick - prev_t)))
            prev_t = tick
        mid.tracks.insert(0, con)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    mid.save(path)
    return path, None


# ── SF2 backend (system fluidsynth) ─────────────────────────────────────────────────────────────

SF2_DIRS = ("/usr/share/sounds/sf2", "/usr/local/share/sounds/sf2")


# ── what the installed font can actually play ─────────────────────────────────────────────────
# We used to assume. The font is the original for "which sounds exist" — it says so in its own
# table of contents — and asking it is cheap: the chunk walk SEEKS past the sample data, so a
# 155 MB SoundFont costs 0.36 MB of reads and 1.8 ms (실측 8/20). Cheap enough to ask
# every render, which means we never ship a name the current font cannot sound. Swap the font and
# the answer changes with it; no table of ours has to be edited to keep up.
_FONT_CACHE = {}


# SF2 제너레이터 — 규격 §8.1. 뜻을 아는 것에 이름을 붙이되 **모르는 것도 번호로 싣는다**:
# 아는 것만 나르면 그게 손목록이고, 폰트가 선언한 무엇이 조용히 사라진다.
SF2_GEN = {8: "filterFc", 15: "chorusSend", 16: "reverbSend", 17: "pan", 21: "delayVolEnv",
           23: "holdVolEnv", 24: "decayVolEnv", 25: "sustainVolEnv", 26: "releaseVolEnv",
           41: "instrument", 43: "keyRange", 44: "velRange", 48: "attenuation",
           51: "coarseTune", 52: "fineTune", 53: "sampleID", 54: "sampleModes",
           56: "scaleTuning", 58: "overridingRootKey"}

# ⚠️ **파일에 안 적혀 있어도 걸리는 것.** pmod/imod 만 읽고 "이 폰트는 CC1 을 안 쓴다"고
# 말하면 그것이 오독이다 — 안 적힌 것이 없는 것이 아니다.
#
# 다만 **출처가 둘**이라 열을 나눈다. 목록 하나로 뭉치면 "규격이 그렇다"와 "신디가 그렇게
# 동작한다"가 섞이고, 그 섞인 표를 근거로 다음 판단을 하게 된다:
#   spec  = SF2 2.04 §8.4.1 기본 모듈레이터 열 줄. 모듈레이터 기계 그 자체다
#   synth = 모듈레이터가 아니라 신디의 음 수명·채널 처리. 규격 목록엔 없지만 실제로 걸린다
SF2_DEFAULT_MODULATORS = (
    ("velocity", "attenuation", "spec", "세게 칠수록 크게 (그리고 폰트의 벨로시티 레이어를 고른다)"),
    ("velocity", "filterFc", "spec", "세게 칠수록 밝게"),
    ("CC1", "vibLfoToPitch", "spec", "모듈레이션 휠 → 폰트 자기 비브라토 LFO (기본 ±50센트)"),
    ("CC7", "attenuation", "spec", "채널 볼륨"),
    ("CC10", "pan", "spec", "팬"),
    ("CC11", "attenuation", "spec", "익스프레션"),
    ("CC91", "reverbSend", "spec", "리버브 센드"),
    ("CC93", "chorusSend", "spec", "코러스 센드"),
    ("channelPressure", "vibLfoToPitch", "spec", "애프터터치 → 비브라토"),
    # 규격의 목적지는 "Initial Pitch"(가상 목적지)이고 양은 피치휠 감도가 정한다 — gen 52
    # fineTune 이라고 적었던 것은 내 오기였다.
    ("pitchWheel", "initialPitch", "spec", "피치 벤딩 (폭은 RPN0 피치휠 감도)"),
    # 서스테인은 **모듈레이터가 아니다.** 신디가 note-off 를 붙들고 있는 것이라 §8.4.1 목록에
    # 없다. 그런데 실제로는 걸리므로 안 적으면 그것도 거짓말이다.
    ("CC64", "hold", "synth", "서스테인 페달 — 신디가 음을 붙든다(모듈레이터 아님)"),
)


def _mod_source(word):
    """모듈레이터 소스 워드 → 이름. bit7 이 서면 그 아래 7비트가 **MIDI CC 번호**다."""
    idx = word & 0x7F
    if word & 0x80:
        return f"CC{idx}"
    return {0: "none", 2: "velocity", 3: "key", 10: "polyPressure",
            13: "channelPressure", 14: "pitchWheel", 16: "pitchWheelSens"}.get(idx, f"src{idx}")


def _zone_gens(bag, gen, bi, n_bag):
    """한 존의 제너레이터 {번호: 값}. 존 경계는 bag 의 인접 인덱스가 정한다."""
    gs = bag[bi][0]
    ge = bag[bi + 1][0] if bi + 1 < n_bag else len(gen)
    return {op: amt for op, amt in gen[gs:min(ge, len(gen))]}


def _zone_mods(bag, mod, bi, n_bag):
    """한 존이 **선언한** 모듈레이터 [(소스, 목적지, 양)]."""
    ms = bag[bi][1]
    me = bag[bi + 1][1] if bi + 1 < n_bag else len(mod)
    out = []
    for src, dest, amt, _amtsrc, _trans in mod[ms:min(me, len(mod))]:
        out.append((_mod_source(src), SF2_GEN.get(dest, f"gen{dest}"), amt))
    return out


def _merge_range(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return [min(a[0], b[0]), max(a[1], b[1])]


def font_inventory(path):
    """폰트가 **선언한 전부**. None = 못 읽음.

    돌려주는 것:
      name            폰트 자기 이름(INFO/INAM). 파일명은 심링크일 수 있다
      banks           들어 있는 뱅크 번호 전부 — 0·128 만 보던 시절 GS/XG 변형 뱅크가 안 보였다
      presets         "뱅크:프로그램" → {name, keys, vels, zones, attenDb, pan, loop, cc, gens}
      programs/kits   뱅크 0 / 뱅크 128 — 옛 계약 그대로(호출자 다수), presets 에서 파생
      attenDb         프로그램별 감쇠(dB)
      modulators      이 폰트가 **선언한** (소스→목적지) 집합. 규격 기본값은 별도(그건 파일에 없다)
      samples         샘플 헤더 수

    sdta 는 seek 로 건너뛴다 — 155MB 폰트에서 실제로 읽는 것은 pdta 뿐이라 렌더마다 물어도
    싸고, 그래서 우리 표를 들고 있을 이유가 없다."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    ck = (path, st.st_mtime_ns, st.st_size)
    if ck in _FONT_CACHE:
        return _FONT_CACHE[ck]
    try:
        raw, info = {}, {}
        with open(path, "rb") as f:
            f.seek(12)
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    break
                cid = hdr[:4].decode("latin1")
                sz = struct.unpack("<I", hdr[4:])[0]
                if cid == "LIST":
                    kind = f.read(4)
                    if kind == b"INFO":
                        # INFO 는 통째로 — 이름만 꺼내던 자리다. 폰트 제작자·도구·설명·규격
                        # 버전이 전부 여기 있고, 어느 폰트가 울렸는지 응답이 말할 재료다.
                        stop = f.tell() + sz - 4
                        while f.tell() < stop - 8:
                            h2 = f.read(8)
                            s2 = h2[:4].decode("latin1")
                            z2 = struct.unpack("<I", h2[4:])[0]
                            blob = f.read(z2)
                            if z2 & 1:
                                f.read(1)
                            info[s2] = blob
                        f.seek(stop + (sz & 1))
                        continue
                    if kind == b"pdta":
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

        def text(key):
            return info.get(key, b"").split(bytes([0]))[0].decode("latin1", "replace").strip()

        if not {"phdr", "pbag", "pgen", "inst", "ibag", "igen"} <= set(raw):
            return None

        def recs(name, fmt, size):
            b = raw.get(name, b"")
            return [struct.unpack_from(fmt, b, i * size) for i in range(len(b) // size)]

        phdr = [(n.split(bytes([0]))[0].decode("latin1", "replace"), pr, bk, bg)
                for n, pr, bk, bg, *_ in recs("phdr", "<20sHHHIII", 38)]
        pbag, pgen = recs("pbag", "<HH", 4), recs("pgen", "<HH", 4)
        pmod = recs("pmod", "<HHhHH", 10)
        inst = [(n.split(bytes([0]))[0].decode("latin1", "replace"), bg)
                for n, bg in recs("inst", "<20sH", 22)]
        ibag, igen = recs("ibag", "<HH", 4), recs("igen", "<HH", 4)
        imod = recs("imod", "<HHhHH", 10)
        shdr = recs("shdr", "<20sIIIIIBbHH", 46)

        # ── instrument 단위로 한 번만 집계한다 (프리셋마다 다시 걸으면 O(n²)) ──────────────
        n_ibag = len(ibag)
        inst_agg = []
        for ix in range(len(inst)):
            start = inst[ix][1]
            stop = inst[ix + 1][1] if ix + 1 < len(inst) else n_ibag
            keys = vels = None
            atten, pan, loop, mods, gens = None, None, False, [], set()
            for bi in range(start, min(stop, n_ibag)):
                g = _zone_gens(ibag, igen, bi, n_ibag)
                gens |= set(g)
                if 43 in g:
                    keys = _merge_range(keys, [g[43] & 0xFF, (g[43] >> 8) & 0xFF])
                if 44 in g:
                    vels = _merge_range(vels, [g[44] & 0xFF, (g[44] >> 8) & 0xFF])
                if 48 in g and atten is None:
                    atten = float(g[48])
                if 17 in g and pan is None:
                    pan = g[17] - 65536 if g[17] > 32767 else g[17]
                if g.get(54, 0) in (1, 3):
                    loop = True
                mods += _zone_mods(ibag, imod, bi, n_ibag)
            inst_agg.append({"name": inst[ix][0], "keys": keys, "vels": vels, "atten": atten,
                             "pan": pan, "loop": loop, "mods": mods, "gens": gens})

        # ── 프리셋 — **뱅크를 안 가린다** ─────────────────────────────────────────────────
        n_pbag = len(pbag)
        presets, banks = {}, set()
        for pi in range(len(phdr)):
            name, program, bank, bagndx = phdr[pi]
            if name == "EOP" and pi == len(phdr) - 1:
                continue                                   # 규격이 붙이는 종료 레코드
            stop = phdr[pi + 1][3] if pi + 1 < len(phdr) else n_pbag
            keys = vels = None
            glob_at, zone_at, pan, loop = 0.0, None, None, False
            mods, gens, zones = [], set(), 0
            for bi in range(bagndx, min(stop, n_pbag)):
                zones += 1
                g = _zone_gens(pbag, pgen, bi, n_pbag)
                gens |= set(g)
                mods += _zone_mods(pbag, pmod, bi, n_pbag)
                if 43 in g:
                    keys = _merge_range(keys, [g[43] & 0xFF, (g[43] >> 8) & 0xFF])
                if 44 in g:
                    vels = _merge_range(vels, [g[44] & 0xFF, (g[44] >> 8) & 0xFF])
                ref = g.get(41)
                if ref is None:
                    glob_at = float(g.get(48, 0.0))        # instrument 를 안 가리키면 글로벌 존
                    continue
                if ref < len(inst_agg):
                    ia = inst_agg[ref]
                    keys = _merge_range(keys, ia["keys"])
                    vels = _merge_range(vels, ia["vels"])
                    mods += ia["mods"]
                    gens |= ia["gens"]
                    loop = loop or ia["loop"]
                    if pan is None and ia["pan"] is not None:
                        pan = ia["pan"]
                    if zone_at is None:
                        # 존은 **대안이지 누적이 아니다** — 다 더하면 스플릿이 많은 프리셋이
                        # 137 dB 같은 무음 값을 낸다(8/21 실측, 내 첫 구현).
                        zone_at = float(g.get(48, 0.0)) + (ia["atten"] or 0.0)
            banks.add(bank)
            # ⚠️ 규격은 센티벨(0.1 dB/단위)이라 적지만 **신디는 0.04 를 쓴다** — 사운드블래스터
            # 유산이고 fluidsynth 도 같다(gain = 10^(cb/−200)). /10 을 쓰면 2.5배 커진다.
            presets[f"{bank}:{program}"] = {
                "bank": bank, "program": program, "name": name, "zones": zones,
                "keys": keys, "vels": vels, "loop": loop,
                "pan": None if pan is None else round(pan / 1000.0, 3),
                "attenDb": round((glob_at + (zone_at or 0.0)) * 0.04, 2),
                "cc": sorted({m[0] for m in mods if m[0].startswith("CC")},
                             key=lambda c: int(c[2:])),
                "mods": sorted({(m[0], m[1]) for m in mods}),
                "gens": sorted(SF2_GEN.get(n, f"gen{n}") for n in gens),
            }
        if not presets:
            return None
        programs = {p["program"]: p["name"] for p in presets.values() if p["bank"] == 0}
        kits = {p["program"]: {"name": p["name"],
                               "keys": set(range(p["keys"][0], p["keys"][1] + 1))
                               if p["keys"] else set()}
                for p in presets.values() if p["bank"] == 128}
        out = {
            "name": text("INAM"),
            "info": {k: text(k) for k in ("INAM", "IENG", "IPRD", "ICOP", "ICMT", "ISFT", "ICRD")
                     if text(k)},
            "banks": sorted(banks),
            "presets": presets,
            "programs": programs,
            "kits": kits,
            "attenDb": {p["program"]: p["attenDb"] for p in presets.values() if p["bank"] == 0},
            "modulators": sorted({m for p in presets.values() for m in p["mods"]}),
            "samples": max(0, len(shdr) - 1),              # 마지막은 EOS 종료 레코드
        }
    except (OSError, ValueError, struct.error, IndexError):
        out = None
    _FONT_CACHE[ck] = out
    return out


def sf2_backend():
    """The OS synth, if the OS has one: fluidsynth + a GM SoundFont in the distro's sf2 dir.

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
        return None, font, "fluidsynth 미설치 — `apt install fluidsynth`"
    if not font:
        # 이 폰트를 지목하는 이유는 취향이 아니라 측정이다 — 128 중 116 프로그램이 루프 없는
        # 원샷 샘플이고(튕기고 잦아드는 악기가 늘어나지 않는다) 31 MB 로 그걸 한다. 그리고
        # 저자가 fluidsynth 설정을 문서로 지정해 둔 유일한 폰트라 FONT_SYNTH_PROFILES 가 안다.
        return binp, None, ("사운드폰트(.sf2)가 없습니다 — GeneralUser-GS.sf2 를 "
                            "/usr/share/sounds/sf2 에 두세요 "
                            "(github.com/mrbumpy409/GeneralUser-GS)")
    return binp, font, None


# ── 폰트가 자기 문서에서 지정한 신디 설정 ───────────────────────────────────────────────
# sf2 파일은 이 값들을 담지 못한다 — 리버브·코러스·보간·폴리포니는 **재생기** 설정이지 폰트의
# 청크가 아니다. 그래서 파일에서 파생할 방법이 없고 유일한 집이 선언이다. 여기 들어올 수 있는
# 값의 조건은 하나 — **출처를 댈 수 있을 것.** 우리 취향은 못 들어온다.
# 매치는 폰트가 말하는 자기 이름(INFO/INAM)의 앞부분. 모르는 폰트면 빈 프로필 = fluidsynth 기본값.
FONT_SYNTH_PROFILES = {
    # GeneralUser GS — 문서 revision 6 (2026-02-23) §3.0.2 "FluidSynth", S. Christian Collins.
    # github.com/mrbumpy409/GeneralUser-GS  (문서 = documentation/README.md)
    # 이 폰트는 모듈레이터를 2,258개 선언한다(pmod 449 + imod 1,809, 실측). 벨로시티가 필터를
    # 열고 CC91/CC93 이 존별 센드를 움직이는 식이라, 규격을 다 구현한 신디를 전제로 만들어졌다.
    # 저자가 fluidsynth 를 "Excellent" 로 꼽으면서 같이 적어 둔 값이 아래다.
    "generalusergs": {
        "gain": 0.5,
        "interp": 7,             # 최고차 보간. 이건 설정이 아니라 셸 명령이라 -f 로만 걸린다
        "settings": {
            # 기본 256. 레이어가 두꺼운 폰트라 페달 밟은 피아노에서 보이스를 훔친다
            "synth.polyphony": 512,
            "synth.device-id": 16,          # 롤랜드 GS 기기로 동작 = GS SysEx 를 GS 로 읽는다
            # 리버브 넷은 fluidsynth 2.4 기본값과 같은 값이다. 그래도 **적는다** —
            # 2.3.x 기본은 damp 0 / level 0.9 / room 0.2 / width 0.5 였고, 배포판이 내려가면
            # 아무 말 없이 소리가 바뀐다. 적어 두면 버전이 아니라 문서가 정한다.
            "synth.reverb.damp": 0.3, "synth.reverb.level": 0.7,
            "synth.reverb.room-size": 0.5, "synth.reverb.width": 0.8,
            # 코러스는 2.4 기본(4.25 / 0.6 / 3 / 0.2)과 다르다. ⚠️ 실측: 대부분의 파일에서
            # **아무것도 안 바뀐다**(표본차 0.000e+00) — 존이 코러스 유닛으로 보내는 양이 0 이면
            # 설정을 뭘로 두든 들어가는 소리가 없다. `CC93=64` 를 주는 파일에서만 산다(3.5e-2).
            # 리버브가 반대인 이유는 이 폰트가 **126/128 프리셋에서 리버브 센드를 직접 선언**하기
            # 때문이다(코러스 센드 선언은 57개뿐) — GM 관례가 아니라 폰트의 선언이다.
            "synth.chorus.depth": 3.6, "synth.chorus.level": 0.55,
            "synth.chorus.nr": 4, "synth.chorus.speed": 0.36,
        },
    },
}


def synth_profile(font_path):
    """(프로필 이름, 프로필) — 그 폰트의 저자가 지정한 신디 설정. 없으면 (None, {})."""
    inv = font_inventory(font_path) if font_path else None
    key = _norm_inst((inv or {}).get("name") or os.path.basename(font_path or ""))
    for pref, prof in FONT_SYNTH_PROFILES.items():
        if key.startswith(pref):
            return pref, prof
    return None, {}


def fluidsynth_argv(binp, font, mid_path, wav_path, cfg_path=None):
    """fluidsynth 한 줄. 렌더도 프로브도 **같은 줄**을 쓴다 — 다른 설정으로 잰 값은
    우리가 실제로 내보내는 소리에 대한 값이 아니다."""
    _pn, prof = synth_profile(font)
    argv = [binp, "-ni", "-g", str(float(prof.get("gain", SYNTH_GAIN))),
            "-r", str(SR), "-O", "float"]
    if prof.get("interp") and cfg_path:
        with open(cfg_path, "w", encoding="utf-8") as fh:
            print("interp %d" % int(prof["interp"]), file=fh)
        argv += ["-f", cfg_path]
    for k, v in sorted((prof.get("settings") or {}).items()):
        argv += ["-o", f"{k}={v}"]
    return argv + ["-F", wav_path, font, mid_path]


def render_sf2(arr, spb, binp, font, mixmap=None, filecc7=None, ctl=None, sysex=None):
    """The arrangement through fluidsynth: the same .mid midiOut writes, played on the GM font.

    Returns (stereo, why_not) — any why_not drops the render back to the builtin synth, so a
    broken font or a killed process degrades the tone, never the turn.
    """
    import subprocess
    os.makedirs("data/sing", exist_ok=True)
    tag = f"{os.getpid()}-{hashlib.sha1(f'{spb}:{len(arr)}'.encode()).hexdigest()[:8]}"
    mid_path = f"data/sing/tmp-{tag}.mid"
    wav_path = f"data/sing/tmp-{tag}.wav"
    cfg_path = f"data/sing/tmp-{tag}.cfg"
    try:
        written, note = write_midi(arr, 60.0 / spb, mid_path, mix=mixmap,
                                   filecc7=filecc7, ctl=ctl, sysex=sysex)
        if not written:
            return None, note or "mido unavailable — the sf2 engine goes through a .mid"
        # 우리 취향은 여전히 0 이다. 달라진 것은 **누구의 기본값이냐** — 그냥 fluidsynth 것을
        # 쓰면 그건 "아무 폰트나"의 기본값이고, 이 폰트를 만든 사람은 이 폰트를 위한 값을
        # 자기 문서에 적어 뒀다. 적어 둔 것이 있으면 그것이 기본값이다.
        # ⚠️ 출력은 **부동소수**로 받는다. fluidsynth 기본은 16비트라, 조용한 대목을 렌더한 뒤
        # 라우드니스 정규화가 끌어올리면 양자화 잡음도 같이 올라간다. 실측(pp 화음 하나):
        # 16비트 바닥이 정규화 후 −42.4 dBFS, float 는 −112.6 dBFS. **70 dB 차이.**
        r = subprocess.run(fluidsynth_argv(binp, font, mid_path, wav_path, cfg_path),
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
        # 정규화 없음. 피크를 1.0 에 맞추는 것도 넘칠 때만 내리는 것도 **우리 결정**이라,
        # 폰트와 fluidsynth 가 정한 레벨을 그대로 둔다 (사용자 2026-08-21: "넘치는거 그런거도
        # 하지말고 일단 폰트 그 자체로 들어보자").
        return data, None
    except subprocess.TimeoutExpired:
        return None, "fluidsynth timed out"
    finally:
        for pth in (mid_path, wav_path, cfg_path):
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
    """One track -> [[note, start_tick, dur_tick, velocity, channel], …] sorted by start.

    Keyed by **(channel, note)**, not by note. One track can carry several channels — a type-0
    file carries all sixteen — and two channels sounding the same note number would otherwise
    close each other's notes.

    그리고 같은 (채널, 음)이 **겹치면 줄로 쌓는다.** 아직 울리는 음을 또 켜는 일은 흔하다 —
    트레몰로, 반복음, 페달 밟은 아르페지오. 값 하나로 들고 있으면 나중 것이 앞엣것을 덮고
    note_off 하나가 하나만 닫아, 덮인 음은 **소리 없이 사라진다**. 실측 2026-08-21 캐논:
    2,241음 중 209음(9%)이 그렇게 없어졌고 verify 가 그 자리를 짚었다. 먼저 켠 것부터 닫는다."""
    events, t, on = [], 0, {}
    for msg in track:
        t += msg.time
        ch = int(getattr(msg, "channel", 0))
        if msg.type == "note_on" and msg.velocity > 0:
            on.setdefault((ch, msg.note), []).append((t, msg.velocity))
        elif (msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0)) \
                and on.get((ch, msg.note)):
            start, vel = on[(ch, msg.note)].pop(0)
            events.append([msg.note, start, t - start, vel, ch])
    events.sort(key=lambda e: e[1])
    return events


def _track_controls(track):
    """What each channel DECLARES over time: program, volume (CC7), pan (CC10), expression (CC11).

    A track is not a part — GM puts the instrument on the **channel**. Reading one
    program_change per track collapses a type-0 file to a single voice and sends the kick
    through a piano; 실측 2026-08-21: a 3-channel 12-note type-0 file came out as
    `part=p1 program=0 x12`, bass and drums included.

    The controllers are the balance and the articulation the person who wrote the file already
    set. We read none of them and substituted a table of our own — which is why 밸런스 kept
    being ours to solve (사용자: "악기별 소리는 이미 폰트에 세팅되어 있는거잖아").

    **Every** controller is collected, not a chosen few. A list of "controllers we support" is
    a hand-list, and the font already knows what CC1 (its own vibrato LFO), CC64, CC91/93 and
    the wheel mean. We do not have to understand one to carry it."""
    out, t = {}, 0
    for msg in track:
        t += msg.time
        ch = getattr(msg, "channel", None)
        if ch is None:
            continue
        c = out.setdefault(int(ch),
                           {"prog": [], "cc": {}, "bend": [], "press": [], "poly": []})
        if msg.type == "program_change":
            c["prog"].append((t, int(msg.program)))
        elif msg.type == "control_change":
            c["cc"].setdefault(int(msg.control), []).append((t, int(msg.value)))
        elif msg.type == "pitchwheel":
            c["bend"].append((t, int(msg.pitch)))
        elif msg.type == "aftertouch":
            # 채널 압력. **GeneralUser GS 는 이것을 비브라토로 선언한다**
            # (channelPressure → vibLfoToPitch, 실측 8/22) — 즉 이 메시지를 버리면
            # 폰트가 자기 문서에서 약속한 연주법 하나가 통째로 안 걸린다.
            c["press"].append((t, int(msg.value)))
        elif msg.type == "polytouch":
            c["poly"].append((t, int(msg.note), int(msg.value)))
    return out


CC_VOLUME, CC_PAN, CC_EXPRESSION = 7, 10, 11


def _prog_at(changes, tick):
    """The program in force at `tick` — a track that switches instrument mid-piece switched it."""
    prog = 0
    for at, p in changes:
        if at > tick:
            break
        prog = p
    return prog


_NOTE_DRUM = {v: k for k, v in DRUM_NOTE.items()}


def _nearest_drum_name(note):
    """번호 → 우리 어휘에서 제일 가까운 드럼 이름. **내장 신디 전용 근사** — sf2 는 파일이
    적은 번호를 그대로 친다."""
    if note is None:
        return "hat"
    return _NOTE_DRUM[min(_NOTE_DRUM, key=lambda k: (abs(k - int(note)), k))]


def _patch_for_program(g):
    """GM program -> the nearest builtin patch (the sf2 engine uses the program itself)."""
    return GM_BUILTIN_OVERRIDE.get(g, FAMILY_FALLBACK[max(0, min(127, int(g))) // 8])


# ── 파일이 보낸 시스템 메시지 ───────────────────────────────────────────────────────────
# ⚠️ **전부 흘리면 틀린다.** 우리는 파트를 채널에 **다시 배치**하므로(실측: ch4→ch2), 특정
# 파트를 가리키는 GS/XG 메시지는 엉뚱한 파트에 걸린다. 그래서 **채널을 안 가리키는 것만**
# 나르고, 나머지는 안 걸었다고 응답이 말한다. 흘리는 쪽은 fluidsynth 가 GS 기기로 동작할 때
# (`synth.device-id 16`, FONT_SYNTH_PROFILES) 실제로 받는다.
# 출처 = MIDI 1.0 Universal System Exclusive (7E 비실시간 / 7F 실시간) + Roland GS Reset +
# Yamaha XG System On. 기기 바이트(인덱스 1)는 대상 지정이라 비교에서 뺀다.
_UNIVERSAL_SYSEX = {
    (0x7E, 0x09, 0x01): "GM System On", (0x7E, 0x09, 0x02): "GM System Off",
    (0x7E, 0x09, 0x03): "GM2 System On",
    (0x7F, 0x04, 0x01): "Master Volume", (0x7F, 0x04, 0x03): "Master Fine Tuning",
    (0x7F, 0x04, 0x04): "Master Coarse Tuning",
}


def global_sysex_name(data):
    """채널을 안 가리키는 전역 메시지면 그 이름, 아니면 None. data = F0/F7 뺀 본문."""
    d = list(data)
    if len(d) >= 4 and d[0] in (0x7E, 0x7F):
        return _UNIVERSAL_SYSEX.get((d[0], d[2], d[3]))
    if (len(d) >= 9 and d[0] == 0x41 and d[2] == 0x42 and d[3] == 0x12
            and d[4:8] == [0x40, 0x00, 0x7F, 0x00]):
        return "GS Reset"
    if (len(d) >= 6 and d[0] == 0x43 and d[2] == 0x4C and d[3:6] == [0x00, 0x00, 0x7E]):
        return "XG System On"
    return None


def _note_beats(warp, tpb, start, dur, b0):
    """그 음의 길이(박). 파일이 적은 그대로 두되 **길이 0 만** 막는다.

    ⚠️ 바닥은 `1/tpb` 가 아니다 — 그건 **안 휜** 틱 크기다. 템포맵이 있으면 같은 한 틱이
    구간마다 다른 박이 되므로, 안 휜 값으로 바닥을 깔면 멀쩡한 짧은 음까지 늘어난다
    (실측: 저자 데모 Umi 가 0.00625 박짜리 음을 0.010417 로 늘려 받고 있었다).
    """
    b1 = warp((start + dur) / tpb)
    if b1 <= b0:
        # 파일이 길이 0 을 적었다. 우리 격자가 표현할 수 있는 **제일 짧은 것**을 준다 —
        # 라이터가 어차피 한 틱을 바닥으로 깔기 때문이고(같은 틱에 note_off 를 놓으면 정렬에서
        # note_on 앞에 서서 음이 안 꺼진다), 0 과 한 틱은 어택+릴리스뿐이라 같게 들린다.
        # ⚠️ 그래도 **우리 결정**이라 verify 가 `changed` 로 말한다(J-cycle 1,177음).
        return 1.0 / MIDI_TPB
    return max(1e-6, b1 - b0)


def midi_to_parts(path):
    """The WHOLE file as playable rows — every CHANNEL, its own instrument, its own dynamics,
    and its own place in the mix. This is the faithful mode's source.

    Returns (rows, bpm, meta, err). `meta[part]` = {name, cc7, cc, bend}: what the FILE wrote,
    kept as the **bytes it wrote** rather than converted into levels of ours. A conversion is a
    decision, and the whole point is that this decision is already made. `cc` is every
    controller it sent, in beats; `cc7` is just the opening fader lifted out because the caller
    may override that one."""
    import mido
    try:
        mf = mido.MidiFile(path)
    except Exception as e:  # noqa: BLE001
        return None, None, None, f"MIDI parse failed: {e}"
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
    rows, meta, pidx = [], {}, 0
    sysex, sysex_skipped = [], {}
    for tr in mf.tracks:
        _t = 0
        for _m in tr:
            _t += _m.time
            if _m.type not in ("sysex", "sequencer_specific"):
                continue
            _nm = global_sysex_name(getattr(_m, "data", ()) or ())
            if _nm:
                sysex.append((round(warp(_t / tpb), 4), tuple(_m.data)))
            else:
                _k = "sysex(파트 지정 — 채널 재배치와 어긋납니다)"
                sysex_skipped[_k] = sysex_skipped.get(_k, 0) + 1
    for tr in mf.tracks:
        ev = _track_events(tr)
        if not ev:
            continue
        ctl = _track_controls(tr)
        tname = next((str(m.name).strip() for m in tr
                      if getattr(m, "type", "") == "track_name"), "")
        by_ch = {}
        for note, start, dur, vel, ch in ev:
            by_ch.setdefault(ch, []).append((note, start, dur, vel))
        for ch in sorted(by_ch):
            if ch == 9:
                # GM fixes the kit on channel 10 (index 9): there a note NUMBER names a drum.
                # Deciding this per TRACK is what played the kick as a piano note.
                for note, start, dur, vel in by_ch[ch]:
                    # 길이도 파일이 적은 그대로. `0.25` 가 박혀 있었다 — 대부분의 킷은
                    # 원샷이라 안 들리지만 그건 우리가 고른 값이었고, verify 를 처음 돌린
                    # 자리에서 바로 잡혔다(원본 0.5 → 우리 0.25). 안 들린다는 것이 고쳐도
                    # 된다는 뜻은 아니다.
                    b0 = warp(start / tpb)
                    # ⚠️ **번호가 원본이다.** 예전엔 우리 이름표에 없는 키를 통째로 버렸다 —
                    # 저자 데모 10개에서 21·23·24번 **256음**이 그렇게 사라졌고, GS Standard
                    # 킷은 그 셋을 갖고 있다(키 0~127). 이름은 편곡기와 내장 신디가 쓰는 우리
                    # 어휘일 뿐이라, 이름이 없다고 소리를 없앨 이유가 없다.
                    row = {"beat": b0,
                           "beats": _note_beats(warp, tpb, start, dur, b0),
                           "part": "drum", "drumNote": int(note),
                           "vel": round(vel / 127.0, 3)}
                    name = _NOTE_DRUM.get(note)
                    if name:
                        row["drum"] = name
                    rows.append(row)
                # ⚠️ 드럼 채널의 컨트롤러가 통째로 사라지고 있었다 — 파트를 안 만들고
                # continue 했기 때문이다. 저자 데모 **10개 전부**가 ch10 에 CC7·CC10·CC91·
                # CC93 을 쓴다(드럼 버스의 페이더·팬·센드). 그건 파일이 정한 밸런스다.
                c9 = ctl.get(ch) or {}
                if any(c9.get(k) for k in ("cc", "bend", "press", "poly")):
                    dm = meta.setdefault("drum", {"name": "drum", "cc7": None, "cc": {},
                                                  "bend": [], "press": [], "poly": []})
                    for n2, series in (c9.get("cc") or {}).items():
                        dm["cc"].setdefault(int(n2), []).extend(
                            (round(warp(t2 / tpb), 4), v2) for t2, v2 in series)
                    dm["bend"] += [(round(warp(t2 / tpb), 4), v2)
                                   for t2, v2 in (c9.get("bend") or [])]
                    dm["press"] += [(round(warp(t2 / tpb), 4), v2)
                                    for t2, v2 in (c9.get("press") or [])]
                    dm["poly"] += [(round(warp(t2 / tpb), 4), n3, v2)
                                   for t2, n3, v2 in (c9.get("poly") or [])]
                    if dm["cc7"] is None and (c9.get("cc") or {}).get(CC_VOLUME):
                        dm["cc7"] = c9["cc"][CC_VOLUME][0][1]
                continue
            pidx += 1
            part = f"p{pidx}"
            c = ctl.get(ch) or {}
            _pans = (c.get("cc") or {}).get(CC_PAN)
            pan = _pans[0][1] if _pans else None
            for note, start, dur, vel in by_ch[ch]:
                prog = _prog_at(c.get("prog") or [], start)
                b0 = warp(start / tpb)
                # 길이는 **파일이 적은 그대로**. `max(0.125, …)` 가 박혀 있었다 — 32분음표
                # 보다 짧은 음을 전부 늘리는 내 숫자였고, 트레몰로 곡에서는 그게 대부분이다
                # (실측 2026-08-21 알함브라: 2,727음 중 2,082음이 0.125 로 늘어나 있었다).
                # 바닥은 **그 파일의 틱 하나** — 길이 0 인 음만 막고 그 위는 안 건드린다.
                row = {"beat": b0,
                       "beats": _note_beats(warp, tpb, start, dur, b0),
                       "part": part, "patch": _patch_for_program(prog), "program": prog,
                       "pitch": int(note), "vel": round(vel / 127.0, 3), "gate": 1.0}
                if pan is not None:
                    row["pan"] = round((pan - 64) / 63.0, 3)
                rows.append(row)
            label = tname if len(by_ch) == 1 else (tname + f" ch{ch + 1}").strip()
            meta[part] = {
                "name": label or f"ch{ch + 1}",
                "cc7": (c.get("cc") or {}).get(CC_VOLUME, [(0, None)])[0][1],
                "cc": {n: [(round(warp(t / tpb), 4), v) for t, v in series]
                       for n, series in (c.get("cc") or {}).items()},
                "bend": [(round(warp(t / tpb), 4), v) for t, v in (c.get("bend") or [])],
                "press": [(round(warp(t / tpb), 4), v) for t, v in (c.get("press") or [])],
                "poly": [(round(warp(t / tpb), 4), n, v)
                         for t, n, v in (c.get("poly") or [])],
            }
    if not rows:
        return None, None, None, "MIDI 에서 음표를 못 읽었습니다"
    # 파일 전체의 것 — 파트가 아니다. 밑줄 = 파트 순회가 건너뛴다.
    meta["_file"] = {"sysex": sorted(sysex, key=lambda x: x[0]),  # 같은 틱이면 파일 순서
                 "sysexSkipped": sysex_skipped}
    return rows, bpm, meta, None


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
    for i, (note, start, dur, vel, _ch) in enumerate(mel):
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
            window = [e[0] for e in bass if lo <= e[1] < hi]
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
# MusicXML 규격 §sound: `dynamics` 는 **벨로시티 90 에 대한 백분율**이고, 아무것도 안 적힌
# 음의 벨로시티도 90 이다. 그래서 우리 기본값은 이 하나에서 나온다 — 내가 고른 수가 아니라.
XML_DEFAULT_VEL = 90 / 127.0        # ≈ 0.709

# 기호(p·f)만 있고 `<sound dynamics>` 가 없는 파일용 **폴백**. 규격은 기호와 벨로시티의 대응을
# 정하지 않는다 — 정한 것은 표기 프로그램이고, 아래는 그중 가장 널리 깔린 MuseScore 의 값이다
# (velocity/127). ⚠️ 여기 있던 표는 **내가 지어낸 숫자**였고 mf 를 0.65 로 두어 규격 기본값
# 0.709 와도 어긋났다(사용자 2026-08-21: "니가 만든 숫자인가"). 파일이 숫자를 말하면 이 표는
# 안 쓰인다 — 그게 정상이고, 이건 안 말한 파일에만 서는 자리다.
_XML_DYN = {"ppp": 16 / 127.0, "pp": 33 / 127.0, "p": 49 / 127.0, "mp": 64 / 127.0,
            "mf": 80 / 127.0, "f": 96 / 127.0, "ff": 112 / 127.0, "fff": 126 / 127.0}


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


# 적힌 길이의 **절반**이 스타카토의 교과서 규칙이고, 스타카티시모는 그 절반. 테누토는
# "제 길이를 다 지켜라" 라 **1.0** 이다 — 1.05 는 다음 음을 침범하므로 테누토가 아니었다.
_XML_ART_GATE = {"staccato": 0.5, "staccatissimo": 0.25, "tenuto": 1.0}
# 세기는 **셈여림 표의 한 칸**으로 움직인다. 예전엔 +0.12·+0.18 이라는 내가 고른 값이었는데,
# "조금 세게" 를 말해 주는 출처가 우리에게 _XML_DYN 하나뿐이라 거기서 파생한다.
_XML_ART_STEP = {"accent": 1, "strong-accent": 2, "marcato": 2}


def _dyn_step(vel, steps):
    """셈여림 표에서 `steps` 칸 옮긴 세기. 표 밖으로는 안 나간다.

    악센트가 "얼마나 더 세게" 인지, 목표 없는 쐐기가 "얼마나 부푸는지" 를 말해 주는 곳이
    악보에도 규격에도 없다. 우리가 가진 유일한 세기 눈금이 이 표이므로 거기서 한 칸씩
    움직인다 — 새 숫자를 만들지 않고, 표를 고치면 셋이 같이 따라온다.
    """
    if not steps:
        return vel
    scale = sorted(_XML_DYN.values())
    for _ in range(abs(steps)):
        if steps > 0:
            nxt = next((v for v in scale if v > vel + 1e-9), None)
        else:
            nxt = next((v for v in reversed(scale) if v < vel - 1e-9), None)
        if nxt is None:
            break
        vel = nxt
    return max(0.02, min(1.0, vel))


def _art_of(el):
    """그 음표의 아티큘레이션 → (게이트, 셈여림 칸 수).

    ⚠️ 한 곳에 둔다. 예전엔 음표 가지 안에만 있어서 **드럼(unpitched) 가지가 이걸 안 읽었고**,
    실측 2026-08-22 아로하: 파일이 드럼에 악센트를 40개 적어 놨는데 880행이 전부 평평하게
    나갔다. 파일이 말한 것을 우리가 버리고 있었다.
    """
    nots = _xk1(el, "notations")          # 모듈 레벨 헬퍼 — kid/text_of 는 파서 안 지역명이다
    arts = _xk1(nots, "articulations") if nots is not None else None
    gate, steps = 1.0, 0
    if arts is not None:
        for a in arts:
            tag = _strip_ns(a.tag)
            gate = min(gate, _XML_ART_GATE.get(tag, 1.0))
            steps = max(steps, _XML_ART_STEP.get(tag, 0))
    return gate, steps

# 물결선으로 지시된 화음 굴리기(rolled chord). ⚠️ 우리말 "아르페지오 주법"(손가락으로 뜯는
# 분산화음)과 **다른 물건**이다 — 그쪽은 악보에 음표로 다 적히고 우리는 그대로 연주한다.
# 굴림은 기호 하나뿐이라 우리가 시간을 만들어야 하는 유일한 자리다.
#
# 폭에는 출처가 없다. 규격은 `<arpeggiate>` 에 시간 칸이 아예 없고, 기타 교습도 고정값을
# 안 준다(Douglas Niedt: "a rolled chord is not necessarily one speed. It can be many
# speeds."). 그래서 **밀리초 대신 음표 값**으로 적는다 — 무엇을 골랐는지 말할 수 있고
# 바꿔 들어 볼 수 있다. 128분음표 = 99bpm 에서 19 ms, 6줄이면 줄당 3.8 ms 로 실제 피크
# 스윕에 가깝다. 청취 비교 2026-08-22(아로하 5~11마디, 판본 6개, 라우드니스 −18.0 고정):
# 넓힐수록 어택이 하나씩 서서 **세게 긁은 것처럼** 들린다 — 폭은 타이밍 노브가 아니라
# 성격 노브라, 악보가 안 시킨 성격을 안 얹는 쪽으로 제일 좁은 값을 고른다.
ROLL_SPAN = 1.0 / 32.0
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
    changes and metronome marks bend time onto one master tempo; <transpose> corrects the
    sounding pitch of transposing instruments; wedges ramp the dynamics between steps;
    staccato/accent/tenuto shape gate and weight; grace notes steal their moment; trills,
    mordents and turns play as the notes they mean; fermatas hold; a chord marked with the
    arpeggio sign is ROLLED so its last note lands on the written beat; pedal
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
    # 파트가 하나도 <midi-program> 을 선언하지 않았으면 이름을 읽는다. 선언이 하나라도 있으면
    # 선언이 원본이고 이름은 안 본다 — 반쯤 섞인 편성이 통째로 모르는 것보다 나쁘다.
    named_progs = {}
    if not prog_of:
        for _pid, _nm in name_of.items():
            _g = named_program(_nm)
            if _g is not None:
                named_progs[_pid] = _g

    skipped = {}

    def skip_mark(what, whose="us"):
        """못 연주한 기호를 센다. `whose` 는 **누구 사정인지**를 가른다.

        "us" = 우리가 아직 못 읽는 기호(트레몰로·글리산도…) — 우리가 고칠 것.
        "file" = 파일이 스스로 어긋난 자리 — 고칠 데가 우리 코드에 없다. 둘을 한 통에
        담고 "파서 미구현분" 이라고 적으면 파일 결함을 우리 결손으로 보고하는 셈이라,
        사용자가 우리한테 고치라고 하고 우리는 고칠 게 없다. 실측 2026-08-21 아로하
        보컬 28마디: 27마디 끝 C#5 에 붙임줄이 시작되는데 짝인 C#5 앞에 B4 가 한 음
        끼어 있다(그 파트에 `<grace>` 는 0개 — 꾸밈음이 아니라 온전한 8분음표다).
        붙임줄은 이웃한 두 음을 잇는 것이라 이건 이을 수 없다.
        """
        skipped.setdefault(whose, {})
        skipped[whose][what] = skipped[whose].get(what, 0) + 1

    order = _playback_order([_measure_flags(m) for m in kids(parts[0], "measure")])

    meter = None
    tempo_events = []  # (raw beats, bpm) — collected on part 0's walk
    parsed_parts = []
    # (파트, **성부**, 음고) → 그 음이 최근에 울린 parts_out 인덱스들. 붙임줄이 붙을 자리를
    # 찾는 데 쓴다. 셋 다 필요하다: 바로 앞 행으로 찾으면 화음 안에서 못 찾고, 하나만 들고
    # 있으면 아직 울리는 긴 음을 집고, 성부를 빼면 같은 음악을 든 다른 성부의 것을 집는다.
    tie_open = {}
    for pi, part in enumerate(parts):
        divisions = 1.0
        vel_any = [None]   # 이 파트에서 마지막으로 선 셈여림 — 보표를 안 가린다
        vel_by_staff = {}  # dynamics are written PER STAFF (실측 월광: pp 는 오른손 보표의
        # 것인데 문서 순서대로 전 성부에 들러붙어 왼손이 더 커졌다 — 악보가 아니라 우리
        # 부산물). staff 없는 지시는 "1" 로.
        notes, harmonies, pos = [], [], 0.0
        lead_voice = None
        f_prog = prog_of.get(part.get("id"), named_progs.get(part.get("id"), 0))
        f_part = f"p{pi + 1}"
        last_onset, stack_n, roll_here, roll_dir_here = 0.0, 0, False, ""
        pedal_down = None
        tab_staves = set()   # 타브 보표 번호 — 오선의 사본이라 소리로 내지 않는다
        cur_fifths = 0  # key signature — ornament neighbors are DIATONIC, not fixed intervals
        transpose = 0  # transposing instruments, in semitones
        graces = []    # pending grace pitches awaiting their host note
        wedges = []    # (raw pos, "c"|"d"|"stop")
        dyn_events = []  # (raw pos, vel)
        def _staff_vel(staff):
            """이 보표에 지금 걸려 있는 셈여림. 자기 것이 없으면 **파트의 것**을 쓴다.

            셈여림은 대보표 사이에 한 번 적고 두 손에 다 건다 — 실측 2026-08-21 월광:
            파일의 셈여림 27개 중 26개가 오른손 보표(1)에 달려 있고 왼손(2)엔 42마디
            하나뿐이다. 보표별로만 보면 왼손은 42마디 전까지 셈여림이 없는 손이 된다.
            """
            v = vel_by_staff.get(staff)
            if v is None:
                v = vel_any[0]
            return XML_DEFAULT_VEL if v is None else v

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
                    # 타브 보표를 찾아 둔다. 기타 파트는 오선 + 타브 한 쌍으로 적히고, 그
                    # **둘은 같은 연주**다 — 표기 방식만 다르다. 둘 다 소리로 내면 기타가 두 번
                    # 울린다(실측 2026-08-21 아로하 Gtr1: 오선 1,617음 · 타브 1,617음, 음 수가
                    # 정확히 같다). 파일이 스스로 말해 준다: 타브 보표는 <staff-tuning> 으로
                    # 줄 조율을 적거나 <clef><sign>TAB</sign> 을 단다.
                    # ⚠️ 보표가 둘이라고 다 타브가 아니다 — 피아노 대보표는 양손이 서로 다른
                    # 음악이라 둘 다 울려야 한다. 그래서 '보표 수'가 아니라 이 표시로 가른다.
                    for sd in _xk(el, "staff-details"):
                        if _xk1(sd, "staff-tuning") is not None:
                            tab_staves.add(sd.get("number") or "1")
                    for cl in _xk(el, "clef"):
                        if (text_of(cl, "sign") or "").strip().upper() == "TAB":
                            tab_staves.add(cl.get("number") or "1")
                    tr_el = kid(el, "transpose")
                    if tr_el is not None:
                        transpose = int(float(text_of(tr_el, "chromatic") or 0))                             + 12 * int(float(text_of(tr_el, "octave-change") or 0))
                elif tag == "direction":
                    d_staff = _xt(el, "staff", "1") or "1"
                    snd = kid(el, "sound")
                    if snd is not None and snd.get("tempo") and pi == 0:
                        tempo_events.append((m_base + cur, float(snd.get("tempo"))))
                    # 파일이 숫자를 말하면 그 숫자를 쓴다. `<sound dynamics="N">` = 벨로시티 90 에
                    # 대한 백분율(규격). 기호를 우리 표로 옮기는 것보다 이쪽이 먼저다 — 월광에
                    # 27개가 있는데 안 읽고 있었다.
                    if snd is not None and snd.get("dynamics"):
                        try:
                            _sv = max(0.0, min(1.0, 90.0 * float(snd.get("dynamics"))
                                               / 100.0 / 127.0))
                            vel_by_staff[d_staff] = _sv
                            vel_any[0] = _sv
                            dyn_events.append((m_base + cur, _sv, d_staff))
                        except ValueError:
                            pass
                    dt = kid(el, "direction-type")
                    if dt is not None:
                        dyn = kid(dt, "dynamics")
                        # 기호는 파일이 숫자를 안 말했을 때만 — 말했으면 그 값이 이미 섰다.
                        if (dyn is not None and len(dyn)
                                and not (snd is not None and snd.get("dynamics"))):
                            v_new = _XML_DYN.get(_strip_ns(dyn[0].tag),
                                                 vel_by_staff.get(d_staff))
                            vel_by_staff[d_staff] = v_new
                            if v_new is not None:
                                vel_any[0] = v_new
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
                        # 드럼도 악센트를 읽는다 — 게이트는 원샷이라 무의미하지만 세기는 아니다.
                        uv = _dyn_step(_staff_vel(u_staff), _art_of(el)[1])
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
                                       + transpose)
                                notes.append({"midi": nom, "beats": dur, "syl": usyl,
                                              "vel": (uv if uv is not None
                                                      else XML_DEFAULT_VEL),
                                              "_at": onset, "_st": u_staff, "_sung": dur,
                                              "_unp": True})
                        elif dname and parts_out is not None:
                            # `_src` = 이 드럼이 원래 어느 파트의 것인가. 드럼은 전부 한 채널로
                            # 모이므로 파트 이름을 잃는데, **셈여림 쐐기는 파트 단위로 걸린다** —
                            # 실측 2026-08-21 아로하: 크레셴도 셋이 전부 Drums 파트에 있었고
                            # 램프가 `part == f_part` 로만 찾아 셋 다 버려졌다.
                            # 길이도 적힌 대로. 0.25 가 박혀 있었다(MIDI 리더와 같은 자리).
                            parts_out.append({"beat": onset, "beats": max(0.03, dur),
                                              "part": "drum", "_src": f_part, "drum": dname,
                                              "vel": (uv if uv is not None
                                                      else XML_DEFAULT_VEL)})
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
                    # `<pitch>` 는 **울리는 음**이다. 그 위에 얹는 건 `<transpose>`(조옮김
                    # 악기, 적힌 음과 나는 음이 다르다고 파일이 스스로 선언한 것) **하나뿐**
                    # 이고, 음자리표의 `clef-octave-change` 와 `octave-shift`(8va) 는 **그리는
                    # 법**이라 음고에 얹지 않는다. 얹으면 한 옥타브씩 밀린다.
                    #
                    # 실측 2026-08-21 아로하 — 기타 두 파트는 오선과 타브를 나란히 적는데,
                    # 타브의 음고는 줄·프렛에서 나오므로 **물리적으로 확정된 실음**이다
                    # (staff-tuning 1번줄 = E2 … 6번줄 = E4). 둘을 대조하니:
                    #   · Gtr1 1,431음 **전부 일치** — 오선 오선 = 타브 = 실음
                    #   · Gtr2 78음 중 66음 일치. 어긋난 12음은 51마디 8va 괄호 안이고,
                    #     같은 파일의 다른 8va 괄호(56마디)에서는 두 보표가 **또 일치한다**
                    # 즉 옥타브를 얹어야 한다는 증거가 1,497음 중 12음뿐이고 그 12음은 규칙이
                    # 아니라 **그 파일 그 괄호의 자기모순**이다. 두 보표가 같은 파일 안에서
                    # 갈리면 프렛(실음)이 아니라 규격(`<pitch>` = 실음)을 따른다.
                    midi = 12 * (octave + 1) + _XML_STEP.get(step, 0) + alter + transpose
                    if is_grace:
                        # 꾸밈음이 본음에서 가져가는 시간. 규격에 칸이 있고(steal-time-*),
                        # 없으면 **그 꾸밈음이 그려진 음표 값**을 쓴다 — 실측 2026-08-22 아로하
                        # 18개가 전부 <type>16th 로 자기 값을 적어 놨다.
                        _gel = kid(el, "grace")
                        _steal = None
                        for _a in ("steal-time-following", "steal-time-previous"):
                            _v = _gel.get(_a) if _gel is not None else None
                            if _v:
                                try:
                                    _steal = max(0.0, min(1.0, float(_v) / 100.0))
                                except ValueError:
                                    _steal = None
                        _gt = _XML_UNIT.get((text_of(el, "type") or "").strip().lower())
                        graces.append((midi, _steal, _gt))
                        continue
                    nots = kid(el, "notations")
                    gate, vsteps = _art_of(el)
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
                        # 관례는 "대략 두 배, 연주자 재량". 1.75 는 내가 고른 값이었다.
                        dur *= 2.0
                    _roll_el = _xk1(nots, "arpeggiate") if nots is not None else None
                    rolled = _roll_el is not None
                    # 규격 기본은 저음 → 고음. 파일이 반대로 적으면 그쪽이 이긴다.
                    roll_dir = (_roll_el.get("direction") or "").strip().lower() if rolled else ""
                    ly = kid(el, "lyric")
                    syl = (text_of(ly, "text") or "").strip() if ly is not None else ""
                    tie = any(t.get("type") == "stop" for t in kids(el, "tie"))
                    is_stack = kid(el, "chord") is not None
                    if is_stack:
                        stack_n += 1
                    else:
                        stack_n = 0
                        roll_here, roll_dir_here = rolled, roll_dir
                    onset = last_onset if is_stack else m_base + cur
                    # 화음의 **첫 음도** 표시해 둔다 — 아래 후처리가 화음 전체를 한 무리로
                    # 잡아 마지막 음을 자리에 맞추려면 무리의 크기를 알아야 한다.
                    roll_n = stack_n if (roll_here or rolled) else None
                    if not is_stack:
                        last_onset = onset
                    n_staff = _xt(el, "staff", "1") or "1"
                    # 타브 보표의 음은 자리 계산에는 참여하되(cur 는 그대로 흐른다) 소리로는
                    # 안 낸다. 여기서 continue 하면 <backup> 과 박 계산이 어긋난다.
                    is_tab = n_staff in tab_staves
                    # 붙임줄은 **자기 성부 안에서** 이어진다. 한 파트가 같은 음악을 두 성부로
                    # 들고 있으면(악보+타브 쌍) 같은 음의 붙임줄이 동시에 둘 걸리고, 성부를
                    # 안 보면 남의 것을 집는다 — 실측 2026-08-21 아로하 Gtr1 41→42마디:
                    # 성부 1 과 성부 5 가 A2·E3·G3·D4 에 똑같이 붙임줄을 걸어 놓았다.
                    n_voice = _xt(el, "voice", "1") or "1"
                    nvel = _dyn_step(_staff_vel(n_staff), vsteps)
                    if parts_out is not None and not is_tab:
                        stolen = 0.0
                        if graces and not is_stack:
                            # 각 꾸밈음이 가져갈 시간: 규격 칸 > 그려진 음표 값 > 남는 것
                            # 균등. 합계는 본음의 **절반**을 안 넘는다(앞꾸밈음 관례).
                            _w = [(dur * _gs if _gs is not None
                                   else (_gt if _gt else dur * 0.5 / len(graces)))
                                  for _gm, _gs, _gt in graces]
                            _cap = dur * 0.5
                            if sum(_w) > _cap:
                                _w = [v * _cap / sum(_w) for v in _w]
                            _at = onset
                            for (_gm, _gs2, _gt2), _gw in zip(graces, _w):
                                # 꾸밈음도 보표·성부를 단다 — 쐐기 램프가 그걸 보고 고른다.
                                # 세기·게이트는 본음과 같다: 꾸밈음이 더 여리다고 말한 곳이
                                # 악보에도 관례에도 없어서 −0.1·0.9 는 내 숫자였다.
                                parts_out.append({"beat": _at, "beats": _gw,
                                                  "part": f_part,
                                                  "patch": _patch_for_program(f_prog),
                                                  "program": f_prog, "pitch": _gm,
                                                  "vel": nvel, "gate": 1.0,
                                                  "staff": n_staff, "voice": n_voice})
                                _at += _gw
                            stolen = sum(_w)
                        # 여기에도 `max(0.125, …)` 가 있었다 — MIDI 리더에서 걷은 그 바닥이
                        # MusicXML 쪽에 그대로 남아 있었다. 그리고 여기서는 값이 틀리는 것으로
                        # 끝나지 않는다: 음이 늘어나면 **끝이 다음 음의 시작과 안 맞아 이음줄
                        # 연속성 검사가 깨지고**, 이어져야 할 음이 다시 때려진다. 실측
                        # 2026-08-21 아로하: 기타 두 파트에서 이음줄 37개가 그렇게 안 붙었다.
                        # 바닥은 divisions 한 칸 — 길이 0 만 막는다.
                        base_row = {"beat": onset + stolen,
                                    "beats": max(1.0 / max(1.0, divisions), dur - stolen),
                                    "part": f_part, "patch": _patch_for_program(f_prog),
                                    "program": f_prog, "pitch": midi, "vel": nvel,
                                    # 성부도 싣는다 — 파일이 선언한 값이고, 붙임줄이 제 성부에
                                    # 붙었는지 **밖에서 확인할 방법**이 이것뿐이다. staff 와 같은 층.
                                    "gate": gate, "staff": n_staff, "voice": n_voice}
                        if roll_n is not None:
                            base_row["_roll"] = roll_n
                            base_row["_rollcap"] = dur - stolen
                            if roll_dir or roll_dir_here:
                                base_row["_rolldir"] = roll_dir or roll_dir_here
                        # 이음줄은 **그 음이 마지막으로 울린 행**으로 이어진다 — 바로 앞 행이
                        # 아니라. 화음 안에서는 앞 행이 다른 성부라 붙을 자리를 못 찾았고, 그
                        # 음은 이어지는 대신 **다시 때려졌다**. 실측 2026-08-21 아로하:
                        # 단선율 Base 는 277/277 로 정확했는데 Gtr1(화음 2,440음)은 +358,
                        # Piano 는 +141 이 남았다 — 그 차이가 전부 안 이어진 이음줄이다.
                        # 연속성은 확인한다: 끝나는 자리에서 시작하는 음만 같은 음이다.
                        # 한 파트에 성부가 여럿이면 **같은 음이 동시에 여러 번 울린다** —
                        # 온음표를 붙들고 있는 성부와, 그 위에서 이음줄로 이어지는 성부. 마지막
                        # 행 하나만 들고 있으면 그 온음표를 집고 연속성 검사에서 떨어진다.
                        # 실측 2026-08-21 아로하: 38건이 전부 그것이었고 어긋남이 **정확히
                        # +4.0박(한 마디) 32건**이었다 — 아직 울리는 긴 음의 끝이다.
                        # 그래서 후보를 여럿 들고 **끝이 이 음의 시작과 맞는 것**을 고른다.
                        cand = tie_open.get((f_part, n_voice, midi)) or []
                        prev = None
                        if tie:
                            for _ix in reversed(cand):
                                _r = parts_out[_ix]
                                if abs(_r["beat"] + _r["beats"] - onset) < 1e-6:
                                    prev = _r
                                    break
                            if prev is None:
                                # 이음줄 끝인데 이 자리에서 끝나는 같은 음이 없다. 파일 쪽
                                # 사정이고(성부를 건너뛴 이음줄, 시작이 빠진 이음줄) 짝을 지어낼
                                # 수는 없다 — 따로 친다. **다만 조용히 하지는 않는다**: 실측
                                # 2026-08-21 아로하 811개 중 5개가 그랬고, 그걸 알아내려고 내가
                                # 원본 XML 을 손으로 세야 했다. 응답이 말하면 그럴 일이 없다.
                                skip_mark("이음줄(짝이 이웃하지 않음)", "file")
                        if prev is not None:
                            prev["beats"] += dur
                        elif orn_kind:
                            parts_out.extend(_ornament_rows(
                                base_row, orn_kind,
                                *_diatonic_neighbors(cur_fifths, midi)))
                        else:
                            # 최근 것부터 여덟만 — 성부가 그보다 많이 겹치는 악보는 없다.
                            q = tie_open.setdefault((f_part, n_voice, midi), [])
                            q.append(len(parts_out))
                            del q[:-8]
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
            # 시작값·목표값도 자기 보표에서 못 찾으면 파트에서 찾는다. 이 폴백이 없어서
            # 월광 왼손의 크레센도 둘(16·18마디)이 pp 가 아니라 **기본값 90** 에서
            # 출발했다 — 사용자가 "왜 피아노 부서지도록 치노" 라고 짚은 그 자리다.
            # 음표 경로는 이미 폴백하고 있었으므로 어긋난 건 쐐기 하나였다.
            v0 = next((v for t, v, st in reversed(dyn_events)
                       if t <= wstart and st == wstaff and v is not None),
                      next((v for t, v, st in reversed(dyn_events)
                            if t <= wstart and v is not None), XML_DEFAULT_VEL))
            v1 = next((v for t, v, st in dyn_events
                       if t >= wstop - 0.25 and st == wstaff and v is not None),
                      next((v for t, v, st in dyn_events
                            if t >= wstop - 0.25 and v is not None),
                           _dyn_step(v0, 1 if wkind == "c" else -1)))
            span = max(1e-9, wstop - wstart)
            for row in (parts_out or []):
                # 드럼 행은 `part` 가 "drum" 이라 자기 파트 이름을 `_src` 로 들고 있다.
                if ((row.get("part") == f_part or row.get("_src") == f_part)
                        and not row.get("pedal")
                        and (row.get("staff") == wstaff or row.get("drum"))
                        and wstart <= row["beat"] < wstop):
                    row["vel"] = round(v0 + (v1 - v0) * (row["beat"] - wstart) / span, 3)
            for nrow in notes:
                if nrow.get("_st") == wstaff and wstart <= nrow.get("_at", -1) < wstop:
                    nrow["vel"] = round(v0 + (v1 - v0) * (nrow["_at"] - wstart) / span, 3)
        if notes:
            parsed_parts.append({"notes": notes, "harmonies": harmonies,
                                 "id": part.get("id"), "name": name_of.get(part.get("id"), ""),
                                 "row": f_part,
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
        # 굴림 — **마지막 음이 적힌 자리에 선다.** 첫 음을 자리에 두고 뒤로 밀면 멜로디(대개
        # 맨 윗줄)가 박보다 늦게 도착한다. 실측 2026-08-22 아로하 6음 화음에서 110 ms 늦었고,
        # 기타 교습 둘이 정확히 그것을 하지 말라고 가르친다:
        #   Douglas Niedt — "if I start a rolled chord on a beat, the last note of the chord
        #     is significantly delayed."
        #   Classical Guitar Corner — "place the last note of a rolled chord on the downbeat."
        # 리드에 붙이는 게 아니라 **악보의 그 자리**에 붙이는 것이라, 같은 박에 있는 다른 파트와
        # 저절로 같이 떨어진다.
        _rollg = {}
        for row in parts_out:
            if "_roll" in row:
                _rollg.setdefault((row.get("part"), row.get("staff"),
                                   row.get("voice"), row["beat"]), []).append(row)
        for _rows in _rollg.values():
            _mx = max(r["_roll"] for r in _rows)
            if not _mx:
                continue          # 한 음짜리에 붙은 물결선 — 굴릴 것이 없다
            # 굴림은 그 화음의 적힌 길이 안에서 끝난다 (Classical Guitar Shed — "This should
            # be done within the notated duration and rhythm of the notes"). 상한이 없으면
            # 빠른 곡의 짧은 화음에서 다음 화음 위로 넘어간다.
            # `beats` 가 아니라 `_rollcap`(악보가 적은 길이) — beats 는 이미 하한을 먹었다.
            _span = min([ROLL_SPAN] + [r["_rollcap"] for r in _rows if r.get("_rollcap")])
            _down = any(r.get("_rolldir") == "down" for r in _rows)
            for r in _rows:
                _k = (_mx - r["_roll"]) if _down else r["_roll"]
                r["beat"] = round(r["beat"] - (_mx - _k) * (_span / _mx), 4)
        for row in parts_out:
            row.pop("_roll", None)
            row.pop("_rolldir", None)
            row.pop("_rollcap", None)
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
        score["_leadRow"] = best.get("row")
        # 행의 파트 id(p1·p3)는 우리 내부 번호다. 캐스팅 보고가 그걸 그대로 대면 읽는 쪽이
        # 어느 성부인지 알 수 없다 — 이름은 파일이 이미 말해 준다.
        score["_partNames"] = {pp["row"]: (pp.get("name") or pp.get("id") or pp["row"])
                               for pp in parsed_parts if pp.get("row")}
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


# ── 크기 맞추기 ────────────────────────────────────────────────────────────────────────────────
# 사용자: "인코딩할때 볼륨을 일정하게 하면 되는거 아닌가". 그것이 라우드니스 정규화이고,
# 재생기의 "볼륨 일정하게"(Sound Check / ReplayGain)와 같은 기계다.
#
# ⚠️ 걷어낸 피크 정규화와 **다른 물건**이다. 피크 정규화는 게인을 표본 하나(제일 큰 순간)로
# 정해서, 폰트 넷이 전부 −0.45 dBFS 로 나오고 어느 쪽이 큰 폰트인지 사라졌다. 이쪽은
# **선언한 목표값**으로 맞춘다 — 곡이 달라도 같은 크기로 들리는 것이 목적이고, 그래서
# 오히려 비교가 된다(같은 크기에서 비교해야 음색이 보인다. 큰 쪽이 늘 좋게 들린다).
# 폰트끼리의 원래 레벨 차이는 `levels` 액션이 그대로 잰다 — 잃는 게 아니라 자리를 옮긴다.
#
# 실측 2026-08-21, 우리 여덟 렌더: 아로하 RMS −35 dBFS · 월광 −58 dBFS. **23.7 dB 차이**라
# 월광은 재생기를 100% 로 올려도 안 들렸다. 곡이 pp 인 것은 맞지만 23 dB 는 연주의 여림이
# 아니라 우리 출력의 결손이다.
# 목표값은 관례에서 온다(사용자: "89dbSPL이 기본값이라는데"). ReplayGain 1.0 의 기준
# 레벨이 **89 dB SPL** 이고, 같은 기준을 R128 로 다시 쓴 것이 ReplayGain 2.0 의 **−18 LUFS**
# 다. 스트리밍 쪽은 더 크게 잡지만(Spotify·YouTube −14 · Apple −16) 그건 팝을 앞세운 값이고,
# 우리는 솔로 피아노가 섞이므로 다이내믹이 남는 −18 이 맞다 — 목표가 높을수록 천장에 먼저
# 걸려서 조용한 곡이 목표에 못 미친 채 나간다.
LUFS_TARGET = -18.0
PEAK_CEILING_DB = -1.0  # 목표를 맞추다 넘칠 것 같으면 여기서 멈춘다(자르지 않는다)


# BS.1770 의 K-weighting 두 단. 규격이 싣는 것은 **48kHz 계수표**뿐이라 다른 표본율에서는
# 같은 아날로그 원형을 그 율로 다시 설계해야 한다 — 표를 베끼면 44.1k 에서 조용히 틀린다.
# 아래 상수 넷이 규격이 정한 원형이고, 계수는 RBJ 공식으로 파생된다(48k 에서 규격의 표와
# 일치하는지는 selftest 가 대조한다).
_K_SHELF = (1681.974450955533, 0.7071752369554196, 3.999843853973347)   # f0, Q, +dB
_K_HPF = (38.13547087602444, 0.5003270373238773)                       # f0, Q


def _kweight_biquads(sr):
    """(b, a) 두 쌍 — 고역 셸프 다음 고역 통과. a[0] 로 이미 정규화돼 있다.

    ⚠️ 이 셸프는 RBJ 쿡북의 고역 셸프가 **아니다**. 처음에 그걸로 설계했더니 48k 계수가
    규격 표와 최대 0.056 어긋났다(대조 검사가 잡았다). BS.1770 은 자기 아날로그 원형을
    쓰고, 쌍선형 변환 뒤 `Vb = Vh**0.4996667…` 라는 그 원형 고유의 지수가 남는다.
    고역 통과 쪽도 규격은 분자를 [1, −2, 1] 로 두므로 RBJ 의 (1+cos w0)/2 배율을 안 쓴다
    (−0.043 dB 상수차라 안 잡히기 쉽다 — 그래서 표와 대조한다).
    """
    out = []
    f0, q, gdb = _K_SHELF
    K = math.tan(math.pi * f0 / sr)
    vh = 10.0 ** (gdb / 20.0)
    vb = vh ** 0.499666774155
    den = 1.0 + K / q + K * K
    out.append(([(vh + vb * K / q + K * K) / den,
                 2.0 * (K * K - vh) / den,
                 (vh - vb * K / q + K * K) / den],
                [1.0, 2.0 * (K * K - 1.0) / den, (1.0 - K / q + K * K) / den]))
    f0, q = _K_HPF
    K = math.tan(math.pi * f0 / sr)
    den = 1.0 + K / q + K * K
    out.append(([1.0, -2.0, 1.0],
                [1.0, 2.0 * (K * K - 1.0) / den, (1.0 - K / q + K * K) / den]))
    return out


def _kweight_ir(sr, n=8192):
    """K-weighting 을 임펄스 응답으로 — 두 biquad 를 임펄스에 한 번 돌려서 만든다.

    재귀 필터라 numpy 로 곧장 못 돌리는데 scipy 는 이 서버에 없고 90MB 를 들일 값도 아니다.
    대신 **응답이 짧다**는 성질을 쓴다: 38Hz 고역통과의 시정수가 4.2ms 라 8,192탭(170ms)
    이면 남는 게 없다. 그 뒤는 FFT 합성곱이고 numpy 만으로 빠르다.
    """
    out = np.zeros(n, dtype=np.float64)
    out[0] = 1.0
    for b, a in _kweight_biquads(sr):
        y = np.empty(n, dtype=np.float64)
        x1 = x2 = y1 = y2 = 0.0
        for i in range(n):
            xv = out[i]
            yv = b[0] * xv + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
            y[i] = yv
            x2, x1, y2, y1 = x1, xv, y1, yv
        out = y
    return out


def _hop_energy(x1, sr, hop):
    """한 채널을 K-weighting 하고 hop(100ms) 칸마다 제곱합을 모은다.

    조각으로 흘려 보낸다. 전 파형을 float64 로 펼치면 384초 스테레오가 그것만 295MB 이고,
    거기에 필터 출력까지 얹히면 RSS 655MB 였다(실측 2026-08-21) — 949MB 서버에서 렌더와
    겹치면 OOM 이다. 조각 크기를 hop 의 배수로 잡아 두면 칸 합계가 reshape 한 번이다.
    """
    ir = _kweight_ir(sr)
    m = len(ir)
    chunk = hop * 16
    nfft = 1
    while nfft < chunk + m - 1:
        nfft <<= 1
    H = np.fft.rfft(ir, nfft)
    n = len(x1)
    acc = np.zeros(n // hop + 1)          # 마지막 모자란 칸은 아래에서 버린다
    tail = np.zeros(m - 1)
    for i in range(0, n, chunk):
        seg = np.asarray(x1[i:i + chunk], dtype=np.float64)
        y = np.fft.irfft(np.fft.rfft(seg, nfft) * H, nfft)[:len(seg) + m - 1]
        y[:m - 1] += tail
        tail = np.zeros(m - 1)
        tail[:len(y) - len(seg)] = y[len(seg):]
        sq = y[:len(seg)] ** 2
        j0 = i // hop
        full = len(sq) // hop
        if full:
            acc[j0:j0 + full] += sq[:full * hop].reshape(full, hop).sum(axis=1)
        if len(sq) % hop:
            acc[j0 + full] += sq[full * hop:].sum()
    return acc[:n // hop]                 # 온전한 칸만


def integrated_lufs(x, sr):
    """통합 라우드니스(LUFS). 400ms 블록 · 100ms 간격 · 두 단 게이팅(−70 절대, −10 상대)."""
    if x.ndim == 1:
        x = x[:, None]
    hop = int(round(0.1 * sr))
    bl = 4 * hop
    if x.shape[0] < bl:
        return None
    per = [_hop_energy(x[:, c], sr, hop) for c in range(x.shape[1])]
    nb = min(len(p) for p in per) - 3
    if nb < 1:
        return None
    # 블록 = 이웃한 네 칸. G = 1.0 (L/R) — 서라운드가 아니라 가중이 필요 없다.
    z = np.zeros((nb, len(per)))
    for c, p in enumerate(per):
        cs = np.concatenate(([0.0], np.cumsum(p)))
        z[:, c] = (cs[np.arange(nb) + 4] - cs[np.arange(nb)]) / bl
    tot = z.sum(axis=1)

    def _l(rows):
        e = tot[rows].mean() if len(rows) else 0.0
        return -0.691 + 10 * math.log10(e) if e > 0 else -float("inf")

    with np.errstate(divide="ignore"):
        lj = np.where(tot > 0, -0.691 + 10 * np.log10(np.maximum(tot, 1e-300)),
                      -float("inf"))
    keep = np.flatnonzero(lj > -70.0)
    if not len(keep):
        return None
    keep2 = keep[lj[keep] > _l(keep) - 10.0]
    if not len(keep2):
        keep2 = keep
    v = _l(keep2)
    return None if v == -float("inf") else v


def _peak_of(x, chunk=1 << 20):
    """조각 최대값 — abs() 사본을 통째로 만들지 않는다."""
    pk = 0.0
    for i in range(0, len(x), chunk):
        pk = max(pk, float(np.abs(x[i:i + chunk]).max()))
    return pk


def match_loudness(x, sr=None):
    """목표 라우드니스로 올린다. 넘칠 것 같으면 천장에서 멈추고, 멈췄다고 말한다.

    ⚠️ **받은 배열을 제자리에서 곱한다** — 이 함수를 부르는 곳은 파일을 쓰기 직전이고,
    그 뒤로 그 파형을 다시 쓰는 데가 없다. 사본을 뜨면 384초 스테레오마다 147MB 다.

    자르지 않는다 — 리미터는 소리를 바꾸는 물건이라 '악보 그대로'와 어긋난다. 천장에
    걸리면 목표에 못 미친 채로 두고 응답이 몇 dB 모자랐는지 적는다. 재생기의 클리핑
    방지와 같은 처신이다(ReplayGain 도 넘칠 때 게인을 줄이지 리미터를 안 건다).
    """
    sr = sr or SR
    x = np.asarray(x, dtype=np.float32)
    lu = integrated_lufs(x, sr)
    peak = _peak_of(x)
    rep = {"target": LUFS_TARGET, "measured": None if lu is None else round(lu, 1),
           "gainDb": 0.0, "peakDbfs": None, "ceilingHit": False}
    if lu is None or peak <= 0:
        rep["note"] = "너무 짧거나 무음이라 라우드니스를 못 쟀습니다 — 손대지 않았습니다"
        return x, rep
    want = 10.0 ** ((LUFS_TARGET - lu) / 20.0)
    room = (10.0 ** (PEAK_CEILING_DB / 20.0)) / peak
    g = min(want, room)
    if g < want:
        rep["ceilingHit"] = True
        rep["shortByDb"] = round(20 * math.log10(want / g), 1)
    for i in range(0, len(x), 1 << 20):
        x[i:i + (1 << 20)] *= g
    rep["gainDb"] = round(20 * math.log10(g), 1)
    rep["achieved"] = round(lu + rep["gainDb"], 1)
    rep["peakDbfs"] = round(20 * math.log10(min(1.0, peak * g)), 2)
    return x, rep


def write_wav(path, x):
    # soundfile picks the container from the extension — wav/flac ride PCM_16, mp3 goes through
    # libsndfile's LAME encoder (subtype MPEG_LAYER_III, its own default rate ~150 kbps VBR).
    #
    # ⚠️ 여기 `x *= 0.95 / peak` 가 있었다. 렌더 쪽 정규화를 걷은 뒤에도 **파일을 쓰는 이쪽이
    # 따로 정규화하고 있었고**, 출력 레벨을 실제로 정하는 건 마지막 이쪽이다. 실측 2026-08-21:
    # 폰트 넷 × 곡 둘 여덟 파일이 전부 peak −0.45 dBFS 로 **똑같았다**(0.95 가 그 값이다).
    # 폰트가 다른데 피크가 같으면 그건 폰트 소리가 아니라 우리 소리다.
    # 값이 흘러가는 다음 홉을 안 열면 앞에서 지운 것이 뒤에서 그대로 산다.
    import soundfile as sf
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    x, loud = match_loudness(np.asarray(x, dtype=np.float32))
    ext = path.rsplit(".", 1)[-1].lower()
    if ext == "opus":
        sf.write(path, x, SR, format="OGG", subtype="OPUS")
    else:
        sf.write(path, x, SR, subtype="MPEG_LAYER_III" if ext == "mp3" else "PCM_16")
    return loud


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
    gone = retired_notice(inp)
    if gone:
        return {"success": False, "error": gone}
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
                    fr, fb, fmeta, ferr = midi_to_parts(media_path)
                    if not ferr:
                        faithful_rows = fr
                        # 파일이 이미 말한 밸런스와 이름. MusicXML 쪽은 파서가 직접 심는다.
                        _fdoc = fmeta.pop("_file", None) or {}
                        file_sysex = _fdoc.get("sysex") or []
                        file_cc7 = {p: m["cc7"] for p, m in fmeta.items()
                                    if m.get("cc7") is not None}
                        file_ctl = {p: {"cc": m.get("cc") or {}, "bend": m.get("bend") or [],
                                        "press": m.get("press") or [], "poly": m.get("poly") or []}
                                    for p, m in fmeta.items()}
                        if isinstance(score, dict):
                            score["_partNames"] = {p: m["name"] for p, m in fmeta.items()}
                            score["_partsSeen"] = [
                                "%s(%d)" % (m["name"],
                                            sum(1 for r in fr if r.get("part") == p))
                                for p, m in fmeta.items()]
                            if _fdoc.get("sysexSkipped"):
                                score.setdefault("_notation_skipped", {}).setdefault(
                                    "us", {}).update(_fdoc["sysexSkipped"])
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
            apply_top_level_knobs(score, inp)
            parsed_from = media_path
        else:
            ext = media_path.rsplit(".", 1)[-1].lower() if "." in media_path else "?"
            return {"success": False,
                    "error": f"score media must be MIDI or MusicXML (got .{ext}, and the bytes "
                             "are neither MThd, zip nor XML) — hum-to-score is a later slice"}
    # Lift the reader's report off the score before it is parsed — it is about the FILE, not
    # about the music, and the caller needs it whether or not the parse succeeds.
    lead_part = score.pop("_leadPart", None) if isinstance(score, dict) else None
    lead_row = score.pop("_leadRow", None) if isinstance(score, dict) else None
    # 파일이 선언한 페이더·부풀림 (MIDI 만; MusicXML 은 셈여림을 벨로시티로 적는다).
    file_cc7 = locals().get("file_cc7") or {}
    file_ctl = locals().get("file_ctl") or {}
    file_sysex = locals().get("file_sysex") or []
    parts_seen = score.pop("_partsSeen", None) if isinstance(score, dict) else None
    part_names = score.pop("_partNames", None) if isinstance(score, dict) else None
    spb, events, chords, style, band, feel, err = parse_score(score)
    if err:
        return {"success": False, "error": err}
    # ── LRC lane: lyricsMediaPath = lyric score (rhythm-lyric lead sheet, karaoke MIDI) or a
    # ready-made .lrc; lrc:true reads the main score's own syllables. Built BEFORE the render
    # so a bad lyrics input refuses in milliseconds, not after minutes of synthesis.
    lrc_text, lrc_meta, lrc_miss = None, None, None
    lyr_src = str(inp.get("lyricsMediaPath") or "").strip()
    lyr_q = str(inp.get("lyricsQuery") or "").strip()
    # `lrc` 는 이름이 **가사 데이터**처럼 읽히는데 하는 일은 "악보에서 만들어라" 였다 — 손에 가사가
    # 없는 모델이 그 칸을 켜고 "이 악보에는 가사가 없습니다"를 맞았다(실측). 이름을 하는 일대로
    # 둘로 갈랐고, 옛 이름은 파서가 흡수한다: 참이면 파생 스위치, 문자열이면 그것이 곧 .lrc 다.
    lrc_ready = str(inp.get("lrcText") or "").strip()
    lrc_derive = bool(inp.get("lrcFromScore"))
    legacy_lrc = inp.get("lrc")
    if isinstance(legacy_lrc, str) and legacy_lrc.strip():
        if legacy_lrc.strip().lower() in ("true", "1", "yes", "y"):
            lrc_derive = True
        elif not lrc_ready:
            lrc_ready = legacy_lrc.strip()
    elif legacy_lrc:
        lrc_derive = True
    if lyr_src or lyr_q or lrc_derive or lrc_ready:
        try:
            lrc_offset = float(inp.get("lrcOffset") or 0.0)
        except (TypeError, ValueError):
            return {"success": False, "error": "lrcOffset must be a number of seconds"}
        # 명시한 것이 이긴다: 파일 → 손에 든 텍스트 → 이름으로 찾기 → 악보에서 파생.
        # 텍스트가 조회보다 먼저인 이유 = 조회는 네트워크를 타고 **틀린 곡을 고를 수 있다**.
        if lyr_src:
            lpath, lerr = resolve_score_media(inp, key="lyricsMediaPath")
            if lerr:
                return {"success": False, "error": lerr}
            lrc_text, lerr = lrc_from_file(lpath, lrc_offset, title=lyr_src)
            if lerr:
                return {"success": False, "error": lerr}
        elif lrc_ready:
            lrc_text = shift_lrc(lrc_ready, lrc_offset)
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
                    "lrcFromScore 는 **업로드한 악보 파일**의 음절에서 가사 줄을 만듭니다 — "
                    "이 요청에는 그게 없습니다(인라인 score 는 대상이 아니고, 이 파일에는 "
                    "음절이 없습니다). 가사를 손에 들고 있으면 lrcText 로, 가사 악보나 .lrc "
                    "파일이면 lyricsMediaPath 로, 곡 이름으로 찾으려면 lyricsQuery 로 주세요")}
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
    # ── the third way: keep the score's parts AND arrange them. faithful plays the file as
    # written; arranged throws it away and rebuilds from one line. "Dress my five parts as a
    # metal band" was neither, and until now the model could only fake it with doubling.
    arrange_from = str(inp.get("arrangeFrom") or "").strip().lower()
    if arrange_from and arrange_from not in ("melody", "score", "parts"):
        return {"success": False,
                "error": "arrangeFrom 은 melody | score | parts 입니다 — 악보에서 무엇을 "
                         "남기느냐입니다 (생략 = melody: 가락 한 줄만 남기고 장르 반주를 새로 "
                         "짓기 / score: 성부를 전부 남기고 악기만 장르 것으로 / parts: 성부도 "
                         "악기도 악보 그대로 두고 장르 리듬섹션만 얹기)"}
    recast = None
    if (arrange_from in ("score", "parts") and not faithful
            and len(locals().get("faithful_rows") or []) > 0):
        recast, cast_map = recast_parts(faithful_rows, style, band, lead_row,
                                        keep_instruments=arrange_from == "parts",
                                        names=part_names)
        # The genre's rhythm section, borrowed whole from the arrangement path so the kit, the
        # fills and the crashes stay one implementation. Only the drums: the harmony is already
        # in the score's own parts.
        if not any(r.get("part") == "drum" for r in recast):
            backing = build_arrangement([], chords, style, total_beats, band, feel)
            recast += [r for r in backing if r.get("part") == "drum"]
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
    if recast is not None:
        arr = sorted(recast, key=lambda r: (r["beat"], r["part"]))
    elif faithful:
        arr = sorted(faithful_rows, key=lambda r: (r["beat"], r["part"]))
    else:
        arr = build_arrangement(events, chords, style, total_beats, band, feel)
    if kit_prog:
        for e in arr:
            if e.get("part") == "drum":
                e["program"] = kit_prog
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
                cur = e.get("drumNote")
                if cur is None:
                    cur = DRUM_NOTE.get(d, 42)
                if int(cur) in have:
                    continue
                sub = DRUM_GM1_SUB.get(d)
                if sub and DRUM_NOTE[sub] in have:
                    swapped[d] = sub
                    e["drum"] = sub
                    e["drumNote"] = DRUM_NOTE[sub]
    engine = str(inp.get("engine") or "").strip().lower()
    if engine not in ("", "auto", "sf2", "builtin"):
        return {"success": False,
                "error": "engine must be sf2 | builtin (omit = auto: sf2 when installed)"}
    engine_used, engine_note, sf2_font = "builtin", None, None
    sf2_font_path = None
    mix = send = None
    if engine != "builtin":
        binp, font, why = _fbin, _ffont, _fwhy
        if engine == "sf2" and why:
            return {"success": False, "error": f"engine:sf2 사용 불가 — {why}"}
        if not why:
            stereo, err = render_sf2(arr, spb, binp, font, mixmap=feel.get("mix"),
                                     filecc7=file_cc7, ctl=file_ctl, sysex=file_sysex)
            if stereo is None:
                engine_note = f"sf2 렌더 실패 — 내장 신디로 강등: {err}"
            else:
                engine_used, sf2_font = "sf2", os.path.basename(font)
                sf2_font_path = font
                # ⚠️ 여기 `stereo *= 0.45` 가 있었다 — 설명이 없는 상수였고, 라우드니스
                # 정규화가 뒤에서 그대로 되돌리므로 지워도 소리가 안 바뀐다(2026-08-22).
                mix, send = stereo, np.zeros(len(stereo), dtype=np.float32)
    if mix is None:
        mix, send = render_arrangement(arr, spb, total_beats, mixmap=feel.get("mix"),
                                       filecc7=file_cc7, ctl=file_ctl)
        # 내장 신디 쪽 ×0.45 도 같이 걷었다 — 크기는 인코딩 때 정규화가 정한다.
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
            # 악장마다 따로 맞춘다 — 한 곡이 여러 파일로 나가도 사이에서 크기가 안 튄다.
            loud_report = write_wav(pp, mix[a:b])
            part_paths.append(pp)
        out_path = part_paths[0]
    else:
        loud_report = write_wav(out_path, mix)
    # The .mid beside the wav — same arrangement, played by whatever the listener owns. Our one
    # tone generator is the ceiling on the wav; it is not a ceiling on this.
    midi_out = str(inp.get("midiOutPath") or "").strip()
    if not midi_out and inp.get("midiOut"):
        midi_out = out_path.rsplit(".", 1)[0] + ".mid"
    midi_written, midi_note = (None, None)
    if midi_out:
        midi_written, midi_note = write_midi(arr, 60.0 / spb, midi_out, sysex=file_sysex)
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
        "mode": "faithful" if faithful else ("recast" if recast is not None else "arranged"),
    }
    if faithful and reinst_name:
        data["reInstrument"] = reinst_name
    if parsed_from and locals().get("notation_skipped"):
        # Silence is not consent: what the parser could not play is SAID, next to the render.
        _parts = []
        _ours = notation_skipped.get("us") or {}
        _theirs = notation_skipped.get("file") or {}
        if _ours:
            _parts.append("아직 못 읽는 기호: "
                          + ", ".join(f"{k}×{v}" for k, v in _ours.items()))
        if _theirs:
            _parts.append("악보가 어긋난 자리(그대로 두고 연주했습니다): "
                          + ", ".join(f"{k}×{v}" for k, v in _theirs.items()))
        data["notationNote"] = " / ".join(_parts)
    if locals().get("loud_report"):
        data["loudness"] = loud_report
    _oor = notes_out_of_range(arr, sf2_font_path)
    if _oor:
        data["outOfRange"] = _oor[:20]
        data["outOfRangeNote"] = (
            f"{sum(r['count'] for r in _oor)}개 음이 그 프리셋의 선언된 음역 밖이라 폰트가 "
            "답하지 않습니다 — 소리가 안 납니다. 악기를 바꾸거나(band) 옥타브를 옮기세요.")
    if sf2_font:
        data["soundfont"] = sf2_font
        # 파일명은 심링크 이름일 수 있다(default-GM.sf2 = update-alternatives). 어느 폰트가
        # 실제로 울렸는지는 폰트 자신이 말한다.
        _inv = font_inventory(sf2_font_path) if sf2_font_path else None
        if _inv and _inv.get("name"):
            data["soundfont"] = "%s (%s)" % (_inv["name"], sf2_font)
        # 어느 설정으로 울렸는지도 응답이 말한다 — 안 말하면 소리가 달라져도 이유를 못 댄다.
        _pn, _pf = synth_profile(sf2_font_path) if sf2_font_path else (None, {})
        data["synth"] = {"gain": float(_pf.get("gain", SYNTH_GAIN)), "format": "float",
                         "profile": _pn or "fluidsynth defaults",
                         **({"interp": _pf["interp"]} if _pf.get("interp") else {}),
                         **(_pf.get("settings") or {})}
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
    if recast is not None and cast_map:
        # 역할 ← 악보 파트 · 그 역할이 든 악기. 한 줄씩이라 응답을 읽는 쪽이 바로 확인한다.
        order = ["melody", "bass"] + sorted(r for r in cast_map if r.startswith("chord"))
        data["cast"] = ["%s ← %s · %s" % (r, cast_map[r]["part"], cast_map[r]["instrument"])
                        for r in order if r in cast_map]
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


def apply_top_level_knobs(score, inp):
    """파일에서 읽어 온 악보 위에 호출자가 top-level 로 준 노브를 얹는다. 명시가 파일을 이긴다.

    함수로 빼 둔 이유는 하나 — **테스트가 닿게 하려고**. 인라인 루프이던 시절 목록이 여덟 개
    뒤처져 있었고, 그 사실을 알아챌 그물이 없었다."""
    for knob in SCORE_KNOBS:
        if inp.get(knob) is not None:
            score[knob] = inp[knob]
    return score


def action_levels(inp):
    """파트마다 실제로 얼마나 큰 소리가 나는지 — 한 파트씩만 켜서 잰다.

    `MIX` 는 최종 밸런스가 아니라 **트림**이다. 그 위에 음표 벨로시티, 악기 자체의 샘플 레벨,
    그리고 크레스트(드럼은 순간음, 가락은 지속음)가 얹히고, 셋 다 우리 표보다 크다. 실측
    2026-08-21 (내장 엔진): 표는 드럼을 리드보다 −2.4 dB 로 두라 했는데 실제로는 RMS **+6.6 dB**,
    피크 **+18.1 dB** 로 났다. 출력은 마지막에 피크로 정규화되므로 그 피크를 정하는 드럼 순간음이
    나머지 전부를 같이 눌러 내린다 — 사용자가 "멜로디만 크고 나머지는 작다"고 들은 것과
    "드럼이 제일 크다"가 동시에 참인 이유다.

    폰트를 갈면 숫자가 바뀌므로 표에 적어 두지 않는다. 재는 도구를 두고 그때 잰다.
    """
    style = str(inp.get("style") or "trot").strip().lower()
    style = STYLE_ALIASES.get(style, style)
    if style not in DRUM_PATTERNS:
        return {"success": False,
                "error": f"style {style!r} 를 모릅니다 — {' | '.join(sorted(DRUM_PATTERNS))}"}
    # 고정 탐침 — 재는 값이 곡이 아니라 편성에 대한 것이어야 하므로 악보를 인자로 받지 않는다.
    probe = {"bpm": 100, "style": style,
             "chords": [{"root": "A2", "beats": 4}] * 8,
             "notes": [{"syl": "라", "note": n, "beats": 1}
                       for n in ["A4", "B4", "C5", "B4", "A4", "G4", "A4", "E4"] * 4]}
    spb, ev, ch, st, bd, fl, err = parse_score(probe)
    if err:
        return {"success": False, "error": err}
    arr = apply_performance(build_arrangement(ev, ch, st, 32, bd, fl), fl, spb, 32)
    want = str(inp.get("engine") or "").strip().lower()
    binp, font, why = sf2_backend()
    use_sf2 = (want == "sf2" or (not want and binp and font))
    if want == "sf2" and why:
        return {"success": False, "error": why}
    if want and want not in ("sf2", "builtin"):
        return {"success": False, "error": "engine 은 sf2 | builtin 입니다"}

    def dbfs(v):
        return None if v <= 1e-9 else round(20 * math.log10(v), 1)

    rows = []
    for part in sorted({r["part"] for r in arr}):
        solo = [r for r in arr if r["part"] == part]
        if use_sf2:
            stereo, ferr = render_sf2(solo, spb, binp, font, mixmap=None)
            if ferr:
                return {"success": False, "error": ferr}
        else:
            stereo, _ = render_arrangement(solo, spb, 32, mixmap=None)
        mono = stereo.mean(axis=1)
        rms, pk = float(np.sqrt((mono ** 2).mean())), float(np.abs(mono).max())
        rows.append({"part": part, "mix": mix_of(part, mixmap),
                     "rmsDb": dbfs(rms), "peakDb": dbfs(pk),
                     "crestDb": (None if dbfs(rms) is None or dbfs(pk) is None
                                 else round(dbfs(pk) - dbfs(rms), 1))})
    lead = next((r for r in rows if r["part"] in ("melody", "vocal")), None)
    for r in rows:
        for k, ref in (("rmsDb", "rmsDb"), ("peakDb", "peakDb")):
            if lead and r[k] is not None and lead[ref] is not None:
                r[k.replace("Db", "VsLead")] = round(r[k] - lead[ref], 1)
        # 표가 뜻한 값과 실제로 난 값의 차 — 0 이면 MIX 가 말한 대로 났다는 뜻이다.
        if r.get("rmsVsLead") is not None and r["mix"] > 0:
            r["tableSaysDb"] = round(20 * math.log10(r["mix"]), 1)
            r["offByDb"] = round(r["rmsVsLead"] - r["tableSaysDb"], 1)
    inv = font_inventory(font) if (use_sf2 and font) else None
    if inv and inv.get("attenDb"):
        # 폰트가 선언한 감쇠가 실측 어긋남을 설명하나? 설명하면 렌더 때마다 공짜로 보정할 수
        # 있고, 아니면 짧은 탐침을 한 번 굽는 수밖에 없다. 그 판정을 위해 나란히 싣는다.
        for r in rows:
            prog = next((e.get("program") for e in arr
                         if e.get("part") == r["part"] and e.get("program") is not None), None)
            if prog is not None:
                r["program"] = prog
                r["fontAttenDb"] = inv["attenDb"].get(prog)
    return {"success": True, "data": {
        "engine": "sf2" if use_sf2 else "builtin",
        "soundfont": ("%s (%s)" % (inv["name"], os.path.basename(font))
                      if inv and inv.get("name") else
                      (os.path.basename(font) if use_sf2 and font else None)),
        "style": style,
        "parts": rows,
        "note": ("한 파트씩만 켜서 잰 절대 레벨입니다(정규화 끔). `offByDb` = MIX 표가 뜻한 "
                 "레벨과 실제로 난 레벨의 차 — 0 이 아니면 그만큼 표가 결과를 못 잡고 있다는 "
                 "뜻입니다. 크레스트가 큰 파트(드럼)는 RMS 가 작아도 피크로 전체 정규화를 "
                 "지배하므로 RMS 와 peak 를 같이 보세요. 폰트를 갈면 숫자가 바뀝니다."),
    }}


def action_selftest():
    checks = []
    _PROBE_SRC = _inspect.getsource(probe_controllers)

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
    # 팬은 **아무도 안 말하면 중앙**이다. 예전엔 파트마다 자리를 가진 표가 있어서 무대가
    # 저절로 넓어졌는데, 그 자리를 정한 건 파일도 폰트도 아닌 우리였다.
    ck("아무도 팬을 안 말했으면 두 채널이 같다 — 무대는 우리가 만드는 게 아니다", True,
       np.allclose(audio[:, 0], audio[:, 1]), np.allclose(audio[:, 0], audio[:, 1]))
    _panned = [dict(e, pan=(-0.9 if e["part"] == "bass" else 0.9)) for e in arr]
    _pa, _ = render_arrangement(_panned, spb, 4)
    ck("…행이 말하면 실제로 갈린다", True,
       not np.allclose(_pa[:, 0], _pa[:, 1]), not np.allclose(_pa[:, 0], _pa[:, 1]))
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
    # 자리에 적힌 이름은 전부 실제 악기여야 한다. 컴핑 자리가 목록이 되면서 오타 한 글자가
    # 조용히 피아노로 떨어질 수 있게 됐다 — 선언이 힘을 갖는 건 읽는 코드가 있어서고, 읽는
    # 코드가 못 알아들으면 아무 일도 안 일어난다.
    _unknown = sorted({n for seats in STYLE_BAND.values()
                       for v in seats.values()
                       for n in ([v] if isinstance(v, str) else v)
                       if resolve_instrument(n) is None})
    ck("every instrument a genre row names is one the module can actually play",
       [], _unknown, _unknown == [])
    # 별칭이 가리키는 장르도 실재해야 한다. 한글 별칭을 늘리면서 오타가 나면 그 말은 목록과
    # 함께 거부당하는데, 거부 메시지 안에 그 별칭이 들어 있어 사용자가 두 번 헷갈린다.
    _dangling = sorted({v for v in STYLE_ALIASES.values() if v not in DRUM_PATTERNS})
    ck("every style alias points at a style that exists", [], _dangling, _dangling == [])
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
        # ⭐ 예전엔 여기서 "모든 파트가 채널 볼륨을 갖고, 가락이 제일 크다"를 쟀다. 그 서열을
        # 정한 표가 우리 것이었다 — 이제 아무도 안 말한 파트에는 CC7 이 아예 안 나간다.
        ck("선언이 없으면 채널 볼륨을 한 줄도 안 보낸다", {}, vol, not vol)
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
    # 가사 칸은 이름이 하는 일을 말해야 한다 — 옛 `lrc` 는 데이터처럼 읽히고 파생 스위치였다.
    _lsc = {"bpm": 120, "notes": [{"syl": "가", "note": "C4", "beats": 1},
                                  {"syl": "나", "note": "D4", "beats": 1}]}
    _ltxt = "[00:01.00]손에 든 가사" + chr(10) + "[00:03.00]둘째 줄"
    _lr = action_render({"action": "render", "score": _lsc, "audioFormat": "wav",
                         "lrcText": _ltxt})
    ck("lrcText = 손에 든 가사가 그대로 실린다", 2,
       (_lr.get("data") or {}).get("lrcLines"), (_lr.get("data") or {}).get("lrcLines") == 2)
    _lo = action_render({"action": "render", "score": _lsc, "audioFormat": "wav",
                         "lrc": _ltxt})
    ck("…옛 이름에 문자열이 오면 파서가 흡수한다(거부하면 모델이 우회한다)", 2,
       (_lo.get("data") or {}).get("lrcLines"), (_lo.get("data") or {}).get("lrcLines") == 2)
    _lb = action_render({"action": "render", "score": _lsc, "lrc": True})
    ck("…옛 이름의 참은 파생 스위치로 흡수되고, 대상이 없으면 다음 수를 말하며 거부한다",
       True, (_lb.get("error") or "")[:24],
       not _lb.get("success") and "lrcText" in (_lb.get("error") or "")
       and "lyricsMediaPath" in (_lb.get("error") or ""))

    # 걷은 노브는 **자기가 걷혔다고 말한다**. 조용히 무시되면 모델은 성공했다고 믿고, 다음 턴에
    # 또 같은 인자를 보낸다 — 값이 아니라 부재가 답인 자리가 우리가 제일 자주 밟는 함정이다.
    _silent = [k for k in RETIRED_KNOBS
               if not str(parse_score(dict(_lsc, **{k: 0.5}))[-1] or "").startswith(k + " ")]
    ck("걷은 인자 아홉은 전부 자기 이름을 대며 거부한다", [], _silent, not _silent)
    _mute = [k for k in RETIRED_KNOBS
             if action_render({"action": "render", "score": _lsc, k: 0.5}).get("success")]
    ck("…top-level 로 와도 같은 대답 — 두 입구가 한 판정을 쓴다", [], _mute, not _mute)
    _nxt = [k for k, why in RETIRED_KNOBS.items() if len(why) < 10]
    ck("…그리고 거부는 다음 수를 말한다(빈 사유 금지)", [], _nxt, not _nxt)
    # 그리고 살아 있는 인자는 통과해야 한다 — 은퇴 목록이 넓어지면 이게 먼저 빨개진다.
    _live = parse_score(dict(_lsc, style="trot", comp="arp", bassline="walk", swing=0.3))
    ck("…살아 있는 장르 인자는 그대로 통과한다", None, _live[-1], _live[-1] is None)

    # Dressing the score instead of replacing it.
    rrows = ([{"beat": float(i), "beats": 1.0, "part": "p1", "pitch": 72, "vel": 0.8,
               "patch": "piano", "program": 0} for i in range(4)]
             + [{"beat": float(i), "beats": 1.0, "part": "p2", "pitch": 60, "vel": 0.7,
                 "patch": "piano", "program": 0} for i in range(4)]
             + [{"beat": float(i), "beats": 1.0, "part": "p3", "pitch": 40, "vel": 0.7,
                 "patch": "piano", "program": 0} for i in range(4)])
    cast_rows, cast = recast_parts(rrows, "metal", None, "p1")
    ck("recast keeps every part the score wrote", 3,
       len({r["part"] for r in cast_rows}), len({r["part"] for r in cast_rows}) == 3)
    ck("…and casts them by role: the tune, the floor, the comping",
       ["bass", "chord", "melody"], sorted({r["part"] for r in cast_rows}),
       sorted({r["part"] for r in cast_rows}) == ["bass", "chord", "melody"])
    ck("…the reader's lead part is the one that sings", "p1",
       (cast.get("melody") or {}).get("part"), (cast.get("melody") or {}).get("part") == "p1")
    ck("…the lowest voice takes the bass", "p3",
       (cast.get("bass") or {}).get("part"), (cast.get("bass") or {}).get("part") == "p3")
    # 캐스팅은 파생이라 호출자가 짐작할 수 없다 — 응답이 누가 무엇을 연주하는지 말해야 한다.
    ck("…and the cast says which instrument each role took",
       resolve_instrument(STYLE_BAND["metal"]["melody"])[1],
       (cast.get("melody") or {}).get("instrument"),
       (cast.get("melody") or {}).get("instrument") == STYLE_BAND["metal"]["melody"])
    kept_cast = recast_parts(rrows, "metal", None, "p1", keep_instruments=True)[1]
    ck("…and in parts mode it names the FILE's instrument, not the genre's", "grandpiano",
       (kept_cast.get("melody") or {}).get("instrument"),
       (kept_cast.get("melody") or {}).get("instrument") == gm_name(0))
    # CC7 은 페이더가 아니다 — 규격이 dB = 40·log10(cc/127) 이라 게인은 바이트의 **제곱**이다.
    # 선형으로 쓰면 호출자가 부른 비율이 제곱으로 눌린다.
    _ratio = lambda lv: (mix_cc7(lv) / 127.0) ** 2
    for _lv in (0.80, 0.58, 0.25):
        ck("CC7 이 호출자가 부른 비율을 그대로 낸다 (%.2f)" % _lv, _lv, round(_ratio(_lv), 2),
           abs(_ratio(_lv) - _lv) < 0.015)
    ck("…mix 1.0 은 페이더 끝(127)이다 — 우리 여유분을 몰래 빼지 않는다", 127, mix_cc7(1.0),
       mix_cc7(1.0) == 127)
    # 그리고 두 엔진이 같은 값을 뜻해야 한다 — 내장 렌더는 같은 바이트를 진폭으로 되돌린다.
    ck("두 엔진이 같은 balance 를 뜻한다", True,
       [round(part_gain("chord", {"chord": 0.58}), 3), 0.58],
       abs(part_gain("chord", {"chord": 0.58}) - 0.58) < 0.015)
    # ⭐ 아무도 안 말하면 아무 말도 안 한다 — 여기 우리 표가 답하던 자리다.
    ck("아무 선언도 없으면 CC7 을 아예 안 보낸다 (신디 기본값이 선다)", None,
       part_cc7("chord"), part_cc7("chord") is None)
    ck("…그리고 내장 신디도 손대지 않는다(1.0)", 1.0, part_gain("chord"),
       part_gain("chord") == 1.0)

    # 파일 악보 위에 얹히는 노브 — 목록이 뒤처지면 선언이 광고한 축이 **조용히** 사라진다.
    _sc = {"bpm": 100, "notes": [{"syl": "라", "note": "C4", "beats": 1}]}
    _got = apply_top_level_knobs(dict(_sc), {"mix": {"chord": 1.0}, "comp": "arp",
                                             "style": "metal"})
    ck("호출자가 준 노브가 파일 악보 위에 얹힌다", ["comp", "mix", "style"],
       sorted(k for k in _got if k not in _sc),
       sorted(k for k in _got if k not in _sc) == ["comp", "mix", "style"])
    # 파일이 이미 말한 것을 호출자가 덮는다 — 명시가 파일을 이긴다.
    ck("…호출자가 파일을 이긴다", 140,
       apply_top_level_knobs({"bpm": 99}, {"bpm": 140})["bpm"],
       apply_top_level_knobs({"bpm": 99}, {"bpm": 140})["bpm"] == 140)
    # 안 준 것은 안 건드린다.
    ck("…안 준 노브는 파일 값 그대로", 99,
       apply_top_level_knobs({"bpm": 99}, {"style": "rock"})["bpm"],
       apply_top_level_knobs({"bpm": 99}, {"style": "rock"})["bpm"] == 99)

    # 캐스팅 보고는 **파일이 부르는 이름**으로. 내부 행 id(p1·p3)를 그대로 대면 읽는 쪽이
    # 어느 성부인지 알 수 없다 — 8/21 실측에서 응답이 "chord ← p3" 라고만 말했다.
    named_cast = recast_parts(rrows, "metal", None, "p1",
                              names={"p1": "Voice", "p2": "Piano", "p3": "Base"})[1]
    ck("the cast calls each part what the FILE calls it, not our row id", "Voice",
       (named_cast.get("melody") or {}).get("part"),
       (named_cast.get("melody") or {}).get("part") == "Voice")
    lead_prog = next(r["program"] for r in cast_rows if r["part"] == "melody")
    ck("…and each role wears the genre's instrument, not the file's", True,
       (lead_prog, next(r["program"] for r in cast_rows if r["part"] == "chord")),
       lead_prog == resolve_instrument(STYLE_BAND["metal"]["melody"])[1])
    # 팬은 우리가 정하지 않는다 — SF2 는 존마다 자기 팬을 선언하고(gen 17), CC10 을 보내면
    # 그 선언을 덮는다. 캐스팅이 자리를 배정하던 시절 그 덮개가 늘 씌워져 있었다.
    ck("캐스팅은 자리를 정하지 않는다 — 팬은 파일이나 폰트 몫", [],
       sorted({r.get("pan") for r in cast_rows} - {None}),
       not [r for r in cast_rows if r.get("pan") is not None])
    p4 = [{"beat": 0.0, "beats": 1.0, "part": "p4", "pitch": 64,
           "vel": 0.7, "patch": "piano", "program": 0}]
    many, _ = recast_parts(rrows + p4, "metal", None, "p1")
    ck("a fourth voice comps as chord2 — its own part, so a caller can name it",
       True, sorted({r["part"] for r in many}), "chord2" in {r["part"] for r in many})
    # ⚠️ 볼륨도 나누지 않는다. 한때 √N 으로 나눴는데(무상관 N 개는 √N 으로 합해진다는 계산)
    # 그건 **같은 것을 여러 번 낼 때** 맞고 성부마다 다른 음악에는 틀렸다. 이제는 아예 표가
    # 없으니 나눌 것도 없다 — 컴핑이 몇이든 전부 폰트 기본값에서 시작한다.
    ck("컴핑이 몇이든 우리가 레벨을 손대지 않는다", [None, None],
       [part_cc7("chord"), part_cc7("chord2")],
       part_cc7("chord") is None and part_cc7("chord2") is None)
    # 둘째 손을 이름으로 부를 수 있다. 자리에만 걸려 있던 시절 이 인자는 조용히 버려졌다.
    named = recast_parts(rrows + p4, "metal", {"chord2": "piano"}, "p1")[0]
    ck("…and the caller can name the SECOND comping hand, which used to be dropped",
       resolve_instrument("piano")[1],
       next(r["program"] for r in named if r["part"] == "chord2"),
       next(r["program"] for r in named if r["part"] == "chord2")
       == resolve_instrument("piano")[1])
    # parts 모드 = 악보가 말한 악기 그대로. 역할·무대·균형만 우리 것이다.
    kept = recast_parts(rrows + p4, "metal", None, "p1", keep_instruments=True)[0]
    ck("parts mode leaves every instrument the file declared", [0],
       sorted({r["program"] for r in kept if "pitch" in r}),
       sorted({r["program"] for r in kept if "pitch" in r}) == [0])
    bad_af = action_render({"action": "render", "score": score, "arrangeFrom": "웩"})
    ck("an unknown arrangeFrom is refused with both ways", True,
       (bad_af.get("error") or "")[:40],
       not bad_af.get("success") and "melody" in (bad_af.get("error") or "")
       and "score" in (bad_af.get("error") or ""))
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
    perf = parse_score(dict(score, pedal=True))
    ck("pedal is a legal performance knob", None, perf[6], perf[6] is None)
    parr = build_arrangement(perf[1], perf[2], "none", 4, None, perf[5])
    parr = apply_performance(parr, perf[5], 0.5, 4)
    ck("pedal:true lays a bar-long damper span per pitched part", True,
       len([e for e in parr if e.get("pedal")]),
       any(e.get("pedal") and e["beats"] == 4.0 for e in parr))
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
    c5 = [r for r in prows if r.get("pitch") == 60]
    trill = [r for r in prows if r.get("pitch") in (69, 71) and r["beats"] <= 0.5]
    # 8va 괄호는 **그리는 법**이지 음고가 아니다 — `<pitch>` 가 이미 울리는 음이라
    # 괄호 안의 C4 는 C4 로 남는다. 얹으면 그 구간만 한 옥타브 뜬다.
    ck("an 8va bracket does not move the pitch — <pitch> already sounds",
       (1, 0.5), (len(c5), c5[0]["gate"] if c5 else None),
       perr is None and len(c5) == 1 and c5[0]["gate"] == 0.5)
    ck("…and nothing else got moved either", [], [r["pitch"] for r in prows if r["pitch"] == 72],
       not [r for r in prows if r.get("pitch") == 72])
    # 꾸밈음은 **본음에서 훔친다** — 더해지지 않는다. 예전 단언은 "0.15박 이하"라는 내
    # 상수를 못 박고 있었다. 지금 길이는 악보가 정하므로(steal-time-* > 그려진 값 > 절반)
    # 값을 박지 말고 **불변식**을 박는다: 꾸밈음 + 본음 = 본음이 원래 적힌 길이.
    ck("…and the trill plays as the notes it means", True, len(trill), len(trill) >= 4)

    # 꾸밈음은 자기 문서로 잰다 — 위 문서는 본음에 트릴이 걸려 쪼개지므로 짝을 못 센다.
    # 16분 꾸밈음(0.25박) + 4분 본음(1박) → 꾸밈음이 0.25 를 훔치고 본음이 0.75 로 줄어
    # **합이 여전히 1박**. 예전엔 `0.1박 × 개수` 라는 내 상수였다.
    _gd = (P + '<measure number="1"><attributes><divisions>4</divisions></attributes>'
           '<note><grace/><pitch><step>G</step><octave>4</octave></pitch>'
           '<type>16th</type></note>'
           '<note><pitch><step>C</step><octave>5</octave></pitch>'
           '<duration>4</duration><type>quarter</type></note></measure>' + E)
    with open("data/sing/selftest-grace.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_gd)
    _gp = []
    musicxml_to_score("data/sing/selftest-grace.musicxml", parts_out=_gp)
    _g1 = next((r for r in _gp if r.get("pitch") == 67), None)
    _h1 = next((r for r in _gp if r.get("pitch") == 72), None)
    ck("a grace note takes the value the score drew for it, stolen from its host",
       (0.25, 0.75), (_g1 and round(_g1["beats"], 4), _h1 and round(_h1["beats"], 4)),
       _g1 is not None and _h1 is not None
       and abs(_g1["beats"] - 0.25) < 1e-4 and abs(_h1["beats"] - 0.75) < 1e-4
       and abs(_g1["beat"] + _g1["beats"] - _h1["beat"]) < 1e-4
       and abs(_g1["vel"] - _h1["vel"]) < 1e-9)
    os.remove("data/sing/selftest-grace.musicxml")

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
       and any("글리산도" in k for k in (dsc["_notation_skipped"].get("us") or {})))

    # …그리고 **누구 사정인지** 갈라서 말한다. 파일이 어긋난 자리를 "파서 미구현" 이라고
    # 적으면 사용자는 우리한테 고치라 하고 우리에겐 고칠 게 없다. 실측 2026-08-21 아로하
    # 보컬 28마디: 붙임줄의 두 짝 사이에 온전한 8분음표가 하나 끼어 있다(그 파트 <grace> 0).
    _tw = (P + '<measure number="1"><attributes><divisions>2</divisions></attributes>'
           '<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration>'
           '<tie type="start"/></note>'
           '<note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration></note>'
           '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration>'
           '<tie type="stop"/></note></measure>' + E)
    with open("data/sing/selftest-tiegap.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_tw)
    _tg = []
    _tsc, _ = musicxml_to_score("data/sing/selftest-tiegap.musicxml", parts_out=_tg)
    _sk = (_tsc or {}).get("_notation_skipped") or {}
    ck("a tie whose partners are not adjacent is the FILE's, and is named as such",
       ("file", 3),
       (list(_sk), len([r for r in _tg if "pitch" in r])),
       list(_sk) == ["file"] and len([r for r in _tg if "pitch" in r]) == 3)
    os.remove("data/sing/selftest-tiegap.musicxml")
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
    wrows, wbpm, _wmeta, werr = midi_to_parts("data/sing/selftest-warp.mid")
    ck("a MIDI tempo map bends time like MusicXML does (2 beats @60 = 4 @120)",
       (120.0, 2.0, 4.0),
       (wbpm, wrows[0]["beats"] if wrows else None, wrows[1]["beats"] if wrows else None),
       werr is None and wbpm == 120.0 and abs(wrows[0]["beats"] - 2.0) < 1e-6
       and abs(wrows[1]["beats"] - 4.0) < 1e-6)
    os.remove("data/sing/selftest-warp.mid")

    # 짧은 음은 짧게. `max(0.125, …)` 가 박혀 있어 32분음표보다 짧은 음이 전부 늘어났다 —
    # 트레몰로 곡에서는 그게 대부분이다(실측 알함브라 2,727음 중 2,082음). 그리고 트랙 중간
    # 악기 변경은 리더만 읽고 라이터가 안 써서 218음이 첫 악기로 났다(비발디).
    _sh = _mido.MidiFile(ticks_per_beat=480)
    _st2 = _mido.MidiTrack(); _sh.tracks.append(_st2)
    _st2.append(_mido.Message("program_change", channel=0, program=0, time=0))
    _st2.append(_mido.Message("note_on", channel=0, note=60, velocity=90, time=0))
    _st2.append(_mido.Message("note_off", channel=0, note=60, velocity=0, time=30))   # 1/16박
    _st2.append(_mido.Message("program_change", channel=0, program=42, time=90))
    _st2.append(_mido.Message("note_on", channel=0, note=64, velocity=90, time=0))
    _st2.append(_mido.Message("note_off", channel=0, note=64, velocity=0, time=480))
    _sh.save("data/sing/selftest-short.mid")
    _srows, _sb, _sm, _se = midi_to_parts("data/sing/selftest-short.mid")
    _short = next((r for r in _srows or [] if r.get("pitch") == 60), None)
    ck("짧은 음은 적힌 길이 그대로 — 우리 바닥값으로 늘리지 않는다", 0.0625,
       round((_short or {}).get("beats", 0), 4),
       _short is not None and abs(_short["beats"] - 30 / 480.0) < 1e-9)
    ck("트랙 중간 악기 변경을 읽는다", [0, 42],
       sorted({r["program"] for r in _srows or [] if "pitch" in r}),
       sorted({r["program"] for r in _srows or [] if "pitch" in r}) == [0, 42])
    if write_midi(_srows, _sb, "data/sing/selftest-short-out.mid")[0]:
        _pgs = [x.program for t in _mido.MidiFile("data/sing/selftest-short-out.mid").tracks
                for x in t if x.type == "program_change"]
        ck("…그리고 그 변경을 .mid 에도 쓴다 (읽기만 고치면 첫 악기로 되돌아간다)", [0, 42],
           _pgs, _pgs == [0, 42])
        os.remove("data/sing/selftest-short-out.mid")
    _svr = action_verify({"action": "verify",
                          "scoreMediaPath": "data/sing/selftest-short.mid"}).get("data") or {}
    ck("…verify 가 통째로 통과한다", True, [_svr.get("exact"), _svr.get("notes")],
       bool(_svr.get("exact")))
    os.remove("data/sing/selftest-short.mid")

    # 같은 음이 아직 울리는데 또 켜지면 — 트레몰로·반복음·페달 아르페지오 — 값 하나로 들고
    # 있던 시절 나중 것이 앞엣것을 덮고 그 음은 소리 없이 사라졌다(캐논 2,241음 중 209음).
    _ov = _mido.MidiFile(ticks_per_beat=480)
    _ot = _mido.MidiTrack(); _ov.tracks.append(_ot)
    _ot.append(_mido.Message("note_on", channel=0, note=72, velocity=90, time=0))
    _ot.append(_mido.Message("note_on", channel=0, note=72, velocity=80, time=120))  # 겹쳐 시작
    _ot.append(_mido.Message("note_off", channel=0, note=72, velocity=0, time=120))
    _ot.append(_mido.Message("note_off", channel=0, note=72, velocity=0, time=240))
    _ov.save("data/sing/selftest-overlap.mid")
    _orows, _ob, _om, _oe = midi_to_parts("data/sing/selftest-overlap.mid")
    ck("겹친 같은 음은 둘 다 산다 — 나중 것이 앞엣것을 덮지 않는다", 2, len(_orows or []),
       _oe is None and len(_orows) == 2)
    ck("…먼저 켠 것이 먼저 닫힌다 (세기로 확인)", [90, 80],
       [round(r["vel"] * 127) for r in sorted(_orows or [], key=lambda r: r["beat"])],
       [round(r["vel"] * 127) for r in sorted(_orows or [], key=lambda r: r["beat"])] == [90, 80])
    _ovr = action_verify({"action": "verify",
                          "scoreMediaPath": "data/sing/selftest-overlap.mid"}).get("data") or {}
    ck("…그리고 verify 가 통째로 통과한다", True,
       [_ovr.get("exact"), _ovr.get("notes")], bool(_ovr.get("exact")))
    os.remove("data/sing/selftest-overlap.mid")

    # 트랙이 아니라 채널이 파트다. type-0 파일은 열여섯 채널이 한 트랙에 들어 있어서, 트랙의
    # 첫 program_change 를 그 트랙의 악기라고 읽으면 곡이 통째로 한 악기가 되고 킥이 피아노 음이
    # 된다 — 실측 2026-08-21: 3채널 12음 파일이 `p1 program=0 x12` 로 나왔다.
    # 그리고 CC7/CC10/CC11 은 파일을 쓴 사람이 이미 정한 밸런스다. 안 읽으면 우리 표가 그것을 덮는다.
    _z = _mido.MidiFile(type=0, ticks_per_beat=480)
    _zt = _mido.MidiTrack(); _z.tracks.append(_zt)
    _zt.append(_mido.MetaMessage("track_name", name="Song", time=0))
    _zt.append(_mido.Message("program_change", channel=0, program=0, time=0))
    _zt.append(_mido.Message("program_change", channel=1, program=33, time=0))
    _zt.append(_mido.Message("control_change", channel=0, control=7, value=100, time=0))
    _zt.append(_mido.Message("control_change", channel=1, control=7, value=64, time=0))
    _zt.append(_mido.Message("control_change", channel=0, control=11, value=40, time=0))
    _zt.append(_mido.Message("control_change", channel=9, control=7, value=110, time=0))
    _zt.append(_mido.Message("control_change", channel=9, control=91, value=55, time=0))
    # 우리가 뜻을 해석하지 않는 것들 — 폰트는 안다.
    _zt.append(_mido.Message("control_change", channel=0, control=1, value=64, time=0))
    _zt.append(_mido.Message("control_change", channel=0, control=64, value=127, time=0))
    _zt.append(_mido.Message("control_change", channel=0, control=91, value=50, time=0))
    _zt.append(_mido.Message("pitchwheel", channel=0, pitch=2048, time=0))
    # 압력 둘 — GeneralUser GS 가 채널 압력을 **비브라토**로 선언한다(실측). 안 나르면 폰트가
    # 자기 문서에서 약속한 연주법이 조용히 사라진다.
    _zt.append(_mido.Message("aftertouch", channel=0, value=77, time=0))
    _zt.append(_mido.Message("polytouch", channel=0, note=60, value=88, time=0))
    # 시스템 메시지 셋 — 전역 둘은 나르고, 파트를 가리키는 하나는 안 나른다.
    _zt.append(_mido.Message("sysex", data=[0x7E, 0x7F, 0x09, 0x01], time=0))   # GM System On
    _zt.append(_mido.Message("sysex", data=[0x41, 0x10, 0x42, 0x12, 0x40, 0x00,
                                            0x7F, 0x00, 0x41], time=0))        # GS Reset
    _zt.append(_mido.Message("sysex", data=[0x41, 0x10, 0x42, 0x12, 0x40, 0x11,
                                            0x15, 0x02, 0x18], time=0))        # GS part 2 = drum
    for _i in range(4):
        _zt.append(_mido.Message("note_on", channel=0, note=60 + _i, velocity=90, time=0))
        _zt.append(_mido.Message("note_off", channel=0, note=60 + _i, velocity=0, time=480))
        _zt.append(_mido.Message("note_on", channel=1, note=36, velocity=100, time=0))
        _zt.append(_mido.Message("note_off", channel=1, note=36, velocity=0, time=480))
        _zt.append(_mido.Message("note_on", channel=9, note=36, velocity=110, time=0))
        _zt.append(_mido.Message("note_off", channel=9, note=36, velocity=0, time=240))
        # 우리 이름표 밖의 키 + 드럼 버스의 페이더 — 둘 다 예전엔 사라졌다
        _zt.append(_mido.Message("note_on", channel=9, note=21, velocity=65, time=0))
        _zt.append(_mido.Message("note_off", channel=9, note=21, velocity=0, time=120))
    _z.save("data/sing/selftest-t0.mid")
    zrows, _zb, zmeta, zerr = midi_to_parts("data/sing/selftest-t0.mid")
    zprog = sorted({(r["part"], r.get("program")) for r in zrows or [] if "pitch" in r})
    ck("type-0 파일은 채널마다 자기 악기로 갈린다 (트랙 하나 = 파트 하나가 아니다)",
       [("p1", 0), ("p2", 33)], zprog, zerr is None and zprog == [("p1", 0), ("p2", 33)])
    ck("…그리고 채널 10 은 드럼이다 — 킥이 피아노 음으로 울리지 않는다", 4,
       len([r for r in zrows or [] if r.get("part") == "drum"]),
       len([r for r in zrows or [] if r.get("drum") == "kick"]) == 4)
    ck("…파일이 쓴 페이더를 그대로 읽는다", [100, 64],
       [(zmeta or {}).get("p1", {}).get("cc7"), (zmeta or {}).get("p2", {}).get("cc7")],
       (zmeta or {}).get("p1", {}).get("cc7") == 100
       and (zmeta or {}).get("p2", {}).get("cc7") == 64)
    _zcc = {p: v["cc7"] for p, v in (zmeta or {}).items() if v.get("cc7") is not None}
    _zfile = (zmeta or {}).pop("_file", None) or {}
    ck("⭐ 전역 시스템 메시지는 나른다 (GM System On · GS Reset — device-id 16 이 받는다)", 2,
       len(_zfile.get("sysex") or []), len(_zfile.get("sysex") or []) == 2)
    ck("…파트를 가리키는 GS 메시지는 **안 나르고 안 걸었다고 말한다** "
       "(우리가 채널을 재배치하므로 엉뚱한 파트에 걸린다)", 1,
       sum((_zfile.get("sysexSkipped") or {}).values()),
       sum((_zfile.get("sysexSkipped") or {}).values()) == 1)
    _zct = {p: {"cc": v.get("cc") or {}, "bend": v.get("bend") or [],
                "press": v.get("press") or [], "poly": v.get("poly") or []}
            for p, v in (zmeta or {}).items()}
    _zok, _ = write_midi(zrows, 120, "data/sing/selftest-t0-out.mid",
                         filecc7=_zcc, ctl=_zct, sysex=_zfile.get("sysex") or [])
    _bk = _mido.MidiFile("data/sing/selftest-t0-out.mid") if _zok else None
    def _cc(name, ctl):
        for t in (_bk.tracks if _bk else []):
            if any(getattr(x, "name", None) == name for x in t):
                return [x.value for x in t if x.type == "control_change" and x.control == ctl]
        return []
    # 파일 값을 우리 0~1 로 환산했다 되돌리면 반올림과 MIX_TOP 상한에서 값이 변한다.
    ck("…그리고 그 바이트가 그대로 나간다 (환산은 또 하나의 결정이다)", [[100], [64]],
       [_cc("p1", 7), _cc("p2", 7)], _cc("p1", 7) == [100] and _cc("p2", 7) == [64])
    ck("⭐ 드럼 채널의 페이더·센드도 파일의 것이다 (예전엔 파트를 안 만들어 통째로 버렸다)",
       [[110], [55]], [_cc("drum", 7), _cc("drum", 91)],
       _cc("drum", 7) == [110] and _cc("drum", 91) == [55])
    _dnotes = sorted({x.note for t in (_bk.tracks if _bk else [])
                      if any(getattr(y, "name", None) == "drum" for y in t)
                      for x in t if x.type == "note_on"})
    ck("⭐ 이름표 밖의 드럼 키(21)도 그 번호 그대로 나간다", [21, 36], _dnotes,
       _dnotes == [21, 36])
    ck("CC11 익스프레션이 실린다 — 크레셴도가 사는 층", [40], _cc("p1", 11),
       _cc("p1", 11) == [40])
    # 컨트롤러는 고르지 않는다. 우리가 뜻을 아는 것만 나른다면 그건 손목록이고, 그 목록에 없는
    # 것을 쓴 파일은 조용히 그 표현을 잃는다. CC1 = 폰트 자기 비브라토 LFO — 어제 손으로 만든 것.
    ck("우리가 뜻을 모르는 컨트롤러도 그대로 지나간다 (CC1·CC64·CC91)",
       [[64], [127], [50]], [_cc("p1", 1), _cc("p1", 64), _cc("p1", 91)],
       _cc("p1", 1) == [64] and _cc("p1", 64) == [127] and _cc("p1", 91) == [50])
    ck("…파일이 쓴 피치휠도", [2048],
       [x.pitch for t in (_bk.tracks if _bk else [])
        for x in t if x.type == "pitchwheel"
        and any(getattr(y, "name", None) == "p1" for y in t)],
       [x.pitch for t in (_bk.tracks if _bk else [])
        for x in t if x.type == "pitchwheel"
        and any(getattr(y, "name", None) == "p1" for y in t)] == [2048])
    _sysout = [tuple(x.data) for t in (_bk.tracks if _bk else []) for x in t
               if x.type == "sysex"]
    ck("…그리고 그 둘이 **자기 트랙**에 실려 나간다 (파트 트랙에 끼우면 그 채널에 묶인다)",
       [(0x7E, 0x7F, 0x09, 0x01)], _sysout[:1],
       len(_sysout) == 2 and _sysout[0] == (0x7E, 0x7F, 0x09, 0x01)
       and any(getattr(y, "name", None) == "_file" for y in (_bk.tracks[0] if _bk else [])))

    def _msgs(name, typ):
        for t in (_bk.tracks if _bk else []):
            if any(getattr(x, "name", None) == name for x in t):
                return [x for x in t if x.type == typ]
        return []
    ck("⭐ 채널 압력(aftertouch)이 그대로 나간다 — GS 는 이걸 비브라토로 선언한다", [77],
       [x.value for x in _msgs("p1", "aftertouch")],
       [x.value for x in _msgs("p1", "aftertouch")] == [77])
    ck("…폴리 압력(polytouch)도 음번호와 함께", [(60, 88)],
       [(x.note, x.value) for x in _msgs("p1", "polytouch")],
       [(x.note, x.value) for x in _msgs("p1", "polytouch")] == [(60, 88)])
    _p1msgs = [y.type for t in (_bk.tracks if _bk else [])
               if any(getattr(z, "name", None) == "p1" for z in t) for y in t]
    _at_i = _p1msgs.index("aftertouch") if "aftertouch" in _p1msgs else 99
    _on_i = _p1msgs.index("note_on") if "note_on" in _p1msgs else -1
    ck("…그리고 그 음이 울리기 **전에** 선다 (뒤에 오면 첫 음은 옛 값으로 난다)",
       "aftertouch < note_on", "%d < %d" % (_at_i, _on_i), _at_i < _on_i)
    # 호출자의 명시가 파일을 이긴다: 파일 > 우리 표 사이에 사람이 들어갈 자리가 있어야 한다.
    ck("…호출자의 mix 가 파일의 페이더를 이긴다", mix_cc7(0.25),
       part_cc7("p1", {"p1": 0.25}, _zcc), part_cc7("p1", {"p1": 0.25}, _zcc) == mix_cc7(0.25))
    # 내장 신디도 이제 **같은 정수 바이트**를 거쳐 나온다 — 옛 경로는 sf2 만 반올림하고 내장은
    # 실수 그대로 써서 둘이 미세하게 다른 값을 뜻하고 있었다. 오차는 CC7 한 눈금(≈0.006)뿐이다.
    ck("…그리고 두 엔진이 여전히 같은 balance 를 뜻한다", True,
       [round(part_gain("p1", None, _zcc), 4), (100 / 127.0) ** 2],
       abs(part_gain("p1", None, _zcc) - (100 / 127.0) ** 2) < 0.001)
    # 그리고 덮었으면 파일의 페이더 자동화는 통째로 빠져야 한다 — 남으면 우리 값을 되돌린다.
    _zok2, _ = write_midi(zrows, 120, "data/sing/selftest-t0-mix.mid",
                          mix={"p1": 0.25}, filecc7=_zcc, ctl=_zct)
    _bk2 = _mido.MidiFile("data/sing/selftest-t0-mix.mid") if _zok2 else None
    _p1cc7 = [x.value for t in (_bk2.tracks if _bk2 else [])
              if any(getattr(y, "name", None) == "p1" for y in t)
              for x in t if x.type == "control_change" and x.control == 7]
    ck("호출자가 덮으면 파일의 페이더는 한 줄도 안 나간다", [mix_cc7(0.25)], _p1cc7,
       _p1cc7 == [mix_cc7(0.25)])
    _p1cc1 = [x.value for t in (_bk2.tracks if _bk2 else [])
              if any(getattr(y, "name", None) == "p1" for y in t)
              for x in t if x.type == "control_change" and x.control == 1]
    ck("…덮은 것은 페이더뿐 — 나머지 컨트롤러는 그대로 간다", [64], _p1cc1, _p1cc1 == [64])
    if os.path.exists("data/sing/selftest-t0-mix.mid"):
        os.remove("data/sing/selftest-t0-mix.mid")
    for _f in ("data/sing/selftest-t0.mid", "data/sing/selftest-t0-out.mid"):
        if os.path.exists(_f):
            os.remove(_f)

    # ── 폰트 리더 — 선언된 것을 전부 읽나 ──────────────────────────────────────────────────
    # 실제 폰트는 서버에만 있다. 규칙은 픽스처로 잰다: 뱅크 셋(0·1·128)·키 범위·벨로시티 범위·
    # 팬·루프·**선언된 모듈레이터**를 담은 최소 SF2 를 만들어 우리 리더에게 물어본다.
    def _sf2_fixture(path):
        def chunk(cid, body):
            pad = b"\x00" if len(body) & 1 else b""
            return cid + struct.pack("<I", len(body)) + body + pad

        def zstr(t, n=20):
            b = t.encode("latin1")[: n - 1]
            return b + bytes(n - len(b))

        info = (b"INFO"
                + chunk(b"ifil", struct.pack("<HH", 2, 1))
                + chunk(b"isng", b"EMU8000\x00")
                + chunk(b"INAM", b"Fixture Font\x00")
                + chunk(b"IENG", b"selftest\x00"))
        sdta = b"sdta" + chunk(b"smpl", bytes(96))
        # 프리셋 셋: 뱅크0/prog0, **뱅크1/prog0**(변형 뱅크 — 예전엔 안 보였다), 뱅크128/prog0
        phdr = b"".join(struct.pack("<20sHHHIII", zstr(n), pr, bk, bg, 0, 0, 0)
                        for n, pr, bk, bg in (("Fix Piano", 0, 0, 0), ("Fix Piano Var", 0, 1, 1),
                                              ("Fix Kit", 0, 128, 2), ("EOP", 0, 0, 3)))
        pbag = b"".join(struct.pack("<HH", g, m) for g, m in ((0, 0), (1, 1), (2, 1), (3, 1)))
        # 뱅크1 프리셋만 모듈레이터를 선언한다: CC74 → filterFc (파일이 적은 연주법)
        pmod = struct.pack("<HHhHH", 0x80 | 74, 8, 3000, 0, 0) + bytes(10)
        pgen = b"".join(struct.pack("<HH", o, a)
                        for o, a in ((41, 0), (41, 0), (41, 0), (0, 0)))
        inst = (struct.pack("<20sH", zstr("Fix Inst"), 0)
                + struct.pack("<20sH", zstr("EOI"), 1))
        ibag = struct.pack("<HH", 0, 0) + struct.pack("<HH", 6, 0)
        imod = bytes(10)
        igen = b"".join(struct.pack("<HH", o, a) for o, a in (
            (43, 36 | (84 << 8)),      # keyRange 36-84
            (44, 20 | (110 << 8)),     # velRange 20-110
            (48, 150),                 # initialAttenuation 150cb -> 6.0dB (0.04/단위)
            (17, -250 & 0xFFFF),       # pan -250 -> -0.25
            (54, 1),                   # sampleModes = loop
            (53, 0),                   # sampleID
            (0, 0)))
        shdr = (struct.pack("<20sIIIIIBbHH", zstr("Fix Sample"), 0, 16, 4, 12, 44100, 60, 0, 0, 1)
                + struct.pack("<20sIIIIIBbHH", zstr("EOS"), 0, 0, 0, 0, 0, 0, 0, 0, 0))
        pdta = (b"pdta" + chunk(b"phdr", phdr) + chunk(b"pbag", pbag) + chunk(b"pmod", pmod)
                + chunk(b"pgen", pgen) + chunk(b"inst", inst) + chunk(b"ibag", ibag)
                + chunk(b"imod", imod) + chunk(b"igen", igen) + chunk(b"shdr", shdr))
        body = b"sfbk" + chunk(b"LIST", info) + chunk(b"LIST", sdta) + chunk(b"LIST", pdta)
        with open(path, "wb") as fh:
            fh.write(b"RIFF" + struct.pack("<I", len(body)) + body)

    _fx = "data/sing/selftest-font.sf2"
    _sf2_fixture(_fx)
    _fi = font_inventory(_fx)
    ck("폰트 이름을 폰트에게서 읽는다 (파일명은 심링크일 수 있다)", "Fixture Font",
       (_fi or {}).get("name"), bool(_fi) and _fi["name"] == "Fixture Font")
    ck("**뱅크를 안 가린다** — 0·128 만 보던 시절 변형 뱅크는 통째로 안 보였다", [0, 1, 128],
       (_fi or {}).get("banks"), bool(_fi) and _fi["banks"] == [0, 1, 128])
    _p1 = (_fi or {}).get("presets", {}).get("1:0") or {}
    ck("…그 변형 뱅크 프리셋이 실제로 잡힌다", "Fix Piano Var", _p1.get("name"),
       _p1.get("name") == "Fix Piano Var")
    _p0 = (_fi or {}).get("presets", {}).get("0:0") or {}
    ck("멜로디 프리셋의 **음역**을 읽는다 (예전엔 킷만 쟀다)", [36, 84], _p0.get("keys"),
       _p0.get("keys") == [36, 84])
    ck("벨로시티 범위도 — 그 프리셋이 다이내믹을 어디까지 받나", [20, 110], _p0.get("vels"),
       _p0.get("vels") == [20, 110])
    ck("존이 선언한 팬과 루프 여부", [-0.25, True], [_p0.get("pan"), _p0.get("loop")],
       _p0.get("pan") == -0.25 and _p0.get("loop") is True)
    ck("감쇠는 센티벨 ×0.04 — 규격 문자(0.1)를 쓰면 2.5배 커진다", 6.0, _p0.get("attenDb"),
       abs((_p0.get("attenDb") or 0) - 6.0) < 0.01)
    ck("⭐ 폰트가 **선언한 모듈레이터**를 읽는다 — 어느 CC 가 무엇을 하는지의 원본",
       [["CC74", "filterFc"]], [list(m) for m in (_fi or {}).get("modulators") or []],
       [list(m) for m in (_fi or {}).get("modulators") or []] == [["CC74", "filterFc"]])
    ck("…그리고 규격 기본 모듈레이터는 따로 안다(파일엔 없지만 늘 걸린다)", True,
       [a for a, _b, _w, _c in SF2_DEFAULT_MODULATORS][:3],
       any(a == "CC1" and _w == "spec" for a, _b, _w, _c in SF2_DEFAULT_MODULATORS))
    # ── 저자가 지정한 신디 설정 ──────────────────────────────────────────────────────────
    # 폰트 문서가 있는 폰트는 그 문서가 기본값을 정한다. 없는 폰트에 우리 취향을 얹지 않는다.
    _cfgp = "data/sing/selftest-synth.cfg"
    _gargv = fluidsynth_argv("fluidsynth", "/nope/GeneralUser-GS.sf2", "a.mid", "b.wav", _cfgp)
    _gopts = dict(o.split("=", 1) for o in _gargv if "=" in o and o.count("=") == 1)
    ck("⭐ 출력은 **부동소수** — 16비트로 받으면 정규화가 양자화 잡음까지 끌어올린다(실측 70 dB)",
       True, "-O float" if ("-O" in _gargv and "float" in _gargv) else _gargv[:6],
       "-O" in _gargv and _gargv[_gargv.index("-O") + 1] == "float")
    ck("GeneralUser GS 면 저자 문서의 게인(0.5)으로 부른다", "0.5",
       _gargv[_gargv.index("-g") + 1], _gargv[_gargv.index("-g") + 1] == "0.5")
    ck("…폴리포니 512 (기본 256 = 페달 밟은 피아노에서 보이스를 훔친다)", "512",
       _gopts.get("synth.polyphony"), _gopts.get("synth.polyphony") == "512")
    ck("…코러스 넷이 문서 값 (2.4 기본 4.25/0.6/3/0.2 과 다르다)",
       ["3.6", "0.55", "4", "0.36"],
       [_gopts.get("synth.chorus.depth"), _gopts.get("synth.chorus.level"),
        _gopts.get("synth.chorus.nr"), _gopts.get("synth.chorus.speed")],
       [_gopts.get("synth.chorus.depth"), _gopts.get("synth.chorus.level"),
        _gopts.get("synth.chorus.nr"), _gopts.get("synth.chorus.speed")]
       == ["3.6", "0.55", "4", "0.36"])
    ck("…리버브 넷도 **적어서** 나간다 (버전 기본값에 기대면 배포판이 내려갈 때 조용히 바뀐다)",
       ["0.3", "0.7", "0.5", "0.8"],
       [_gopts.get("synth.reverb.damp"), _gopts.get("synth.reverb.level"),
        _gopts.get("synth.reverb.room-size"), _gopts.get("synth.reverb.width")],
       [_gopts.get("synth.reverb.damp"), _gopts.get("synth.reverb.level"),
        _gopts.get("synth.reverb.room-size"), _gopts.get("synth.reverb.width")]
       == ["0.3", "0.7", "0.5", "0.8"])
    # ⚠️ 파일을 무조건 열면 프로필이 빠졌을 때 **검사가 죽어** 나머지 286개까지 같이 죽는다.
    # 그물은 빨강이 되어야지 끊어지면 안 된다.
    _cfgtxt = (open(_cfgp, encoding="utf-8").read().strip()
               if os.path.isfile(_cfgp) else "(파일 없음)")
    ck("…보간 7 은 설정이 아니라 셸 명령이라 -f 커맨드 파일로 나간다", "interp 7",
       _cfgtxt if "-f" in _gargv else "-f 없음",
       "-f" in _gargv and _cfgtxt == "interp 7")
    if os.path.isfile(_cfgp):
        os.remove(_cfgp)
    _uargv = fluidsynth_argv("fluidsynth", _fx, "a.mid", "b.wav", "data/sing/selftest-x.cfg")
    ck("⭐ 문서가 없는 폰트엔 **아무것도 안 얹는다** — 남의 폰트 값은 우리 취향과 같다", 0,
       _uargv.count("-o"), _uargv.count("-o") == 0 and "-f" not in _uargv)
    ck("…그때 게인은 fluidsynth 자기 기본값", str(SYNTH_GAIN),
       _uargv[_uargv.index("-g") + 1], _uargv[_uargv.index("-g") + 1] == str(SYNTH_GAIN))
    _same_line = "fluidsynth_argv(binp, font, mid_path, wav_path, cfg_path)" in _PROBE_SRC
    ck("프로브도 렌더와 **같은 줄**을 쓴다 (다른 설정에서 잰 값은 우리 소리의 값이 아니다)",
       True, _same_line, _same_line)
    # 배선 — 이름으로 부르면 뱅크가 따라오고, .mid 에 뱅크 셀렉트가 program_change **앞**에 선다.
    _FONT_ALIASES.clear()
    load_font_aliases(_fx)
    ck("변형 뱅크 프리셋을 그 이름으로 부를 수 있다", 1, font_bank_of("Fix Piano Var"),
       font_bank_of("Fix Piano Var") == 1)
    _brow = [{"beat": 0.0, "beats": 1.0, "part": "melody", "patch": "piano", "program": 0,
              "bank": 1, "pitch": 60, "vel": 0.7, "gate": 1.0}]
    if write_midi(_brow, 120, "data/sing/selftest-bank.mid")[0]:
        _bt = _mido.MidiFile("data/sing/selftest-bank.mid").tracks[0]
        _order = [m.type for m in _bt if m.type in ("control_change", "program_change")]
        ck("…뱅크 셀렉트가 program_change 앞에 선다 (뒤면 다음 프로그램부터 걸린다)",
           ["control_change", "program_change"], _order,
           _order[:2] == ["control_change", "program_change"]
           and next(m.control for m in _bt if m.type == "control_change") == 0)
        os.remove("data/sing/selftest-bank.mid")
    # 음역 밖 = 무음. 우리가 아는 것을 응답이 말해야 한다.
    _oo = notes_out_of_range([{"part": "melody", "program": 0, "pitch": 20, "beat": 0.0,
                               "beats": 1.0, "vel": 0.7}], _fx)
    ck("선언된 음역 밖 음은 무음이라고 말한다", [1, [36, 84]],
       [len(_oo), _oo[0]["range"] if _oo else None],
       len(_oo) == 1 and _oo[0]["range"] == [36, 84])
    ck("…음역 안은 조용히 통과한다", [], notes_out_of_range(
        [{"part": "melody", "program": 0, "pitch": 60, "beat": 0.0, "beats": 1.0, "vel": 0.7}],
        _fx), not notes_out_of_range(
        [{"part": "melody", "program": 0, "pitch": 60, "beat": 0.0, "beats": 1.0, "vel": 0.7}], _fx))
    _FONT_ALIASES.clear()
    os.remove(_fx)

    # `<sound dynamics="N">` = 파일이 벨로시티를 **숫자로** 말하는 자리(규격: 90 에 대한 백분율).
    # 월광에 27개가 있는데 안 읽고 기호를 우리 표로 옮기고 있었다 — 파일이 말한 것을 두고
    # 우리 수를 쓰던 자리다.
    _dyndoc = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
               '<direction><direction-type><dynamics><f/></dynamics></direction-type>'
               '<sound dynamics="120"/></direction>'
               '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>'
               '</note></measure></part></score-partwise>')
    with open("data/sing/selftest-dyn.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_dyndoc)
    _drow = []
    musicxml_to_score("data/sing/selftest-dyn.musicxml", parts_out=_drow)
    _want = 90.0 * 120 / 100 / 127.0
    _got = next((r["vel"] for r in _drow if "pitch" in r), None)
    ck("파일이 숫자로 말한 세기를 그대로 쓴다 (<sound dynamics>, 기호 표보다 먼저)",
       round(_want, 4), round(_got or 0, 4), _got is not None and abs(_got - _want) < 1e-9)
    ck("…그리고 그 값은 기호 f 의 표값과 다르다 — 실제로 파일 쪽을 읽었다는 뜻", True,
       [round(_want, 4), round(_XML_DYN["f"], 4)], abs(_want - _XML_DYN["f"]) > 0.01)
    os.remove("data/sing/selftest-dyn.musicxml")

    # 선언 표면 셋이 서로를 가리킨다 — enum · 카탈로그 행 · input 속성. 어긋나면 조용하지
    # 않고 **계단이 거부한다**: `verify` 와 `font` 는 enum 에 넣고 행을 안 만들어서
    # get_action_schema 가 "no catalog entry" 로 막았다(2026-08-21 실측, 실호출에서 잡힘).
    # 반대 방향도 있다 — 걷은 노브 아홉이 행의 params 목록에 남아 **빈 설명으로 광고**되고
    # 있었다. 모델은 그걸 보고 부르고, 거부를 맞는다.
    _cfgp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    with open(_cfgp, encoding="utf-8") as _fh:
        _cfg = json.load(_fh)
    _enum = set(_cfg["input"]["properties"]["action"]["enum"])
    _rows = {r["id"]: r for r in _cfg.get("actionCatalog") or []}
    ck("선언한 액션은 전부 카탈로그에 행이 있다 (없으면 계단이 거부한다)", [],
       sorted(_enum - set(_rows)), not (_enum - set(_rows)))
    ck("…그리고 행만 있고 선언에 없는 액션도 없다", [], sorted(set(_rows) - _enum),
       not (set(_rows) - _enum))
    _declared = set(_cfg["input"]["properties"])
    _ghost = sorted({p for r in _rows.values() for p in r.get("params", [])} - _declared)
    ck("행이 부르는 인자는 전부 선언돼 있다 (빈 설명으로 광고되던 자리)", [], _ghost, not _ghost)
    _retired = sorted(set(RETIRED_KNOBS) & ({p for r in _rows.values()
                                             for p in r.get("params", [])} | _declared))
    ck("걷은 노브는 어느 선언 표면에도 안 남는다", [], _retired, not _retired)

    # 타브 보표는 오선의 사본이다 — 같은 연주를 프렛 번호로 다시 적은 것뿐이라 소리는 한 번만
    # 나야 한다. 실측 2026-08-21 아로하 Gtr1: 오선 1,617음 · 타브 1,617음으로 정확히 같았고,
    # 우리는 둘 다 울려 기타를 두 배로 내고 있었다. ⚠️ 보표가 둘이라고 다 타브가 아니다 —
    # 피아노 대보표는 양손이 다른 음악이라 둘 다 울려야 한다. 파일이 <staff-tuning>/TAB
    # 음자리표로 스스로 가른다.
    _tabdoc = (P.replace("<part-list>", "<part-list>")
               + '<measure number="1"><attributes><divisions>1</divisions>'
                 '<staves>2</staves>'
                 '<clef number="1"><sign>G</sign><line>2</line></clef>'
                 '<clef number="2"><sign>TAB</sign><line>5</line></clef>'
                 '<staff-details number="2"><staff-lines>6</staff-lines>'
                 '<staff-tuning line="1"><tuning-step>E</tuning-step>'
                 '<tuning-octave>2</tuning-octave></staff-tuning></staff-details>'
                 '</attributes>'
                 '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>'
                 '<voice>1</voice><staff>1</staff></note>'
                 '<backup><duration>4</duration></backup>'
                 '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>'
                 '<voice>5</voice><staff>2</staff></note>'
                 '</measure></part></score-partwise>')
    with open("data/sing/selftest-tab.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_tabdoc)
    _tr = []
    musicxml_to_score("data/sing/selftest-tab.musicxml", parts_out=_tr)
    ck("타브 보표는 소리를 안 낸다 — 오선의 사본이지 두 번째 기타가 아니다", 1,
       len([r for r in _tr if "pitch" in r]), len([r for r in _tr if "pitch" in r]) == 1)
    ck("…그리고 남는 것은 오선 쪽이다", "1",
       next((r.get("staff") for r in _tr if "pitch" in r), None),
       next((r.get("staff") for r in _tr if "pitch" in r), None) == "1")
    os.remove("data/sing/selftest-tab.musicxml")

    # 음자리표의 `clef-octave-change` 도 그리는 법이다. 기타 오선은 관례로 한 옥타브 높여
    # 적고 𝄞 아래 8 을 달지만, `<pitch>` 는 그것과 무관하게 울리는 음을 적는다. 실측
    # 2026-08-21 아로하: 오선과 타브(줄·프렛에서 나온 실음)가 Gtr1 1,431음 **전부** 같았고,
    # 얹는 순간 전부 한 옥타브 내려갔다. 한 번 얹었다가 이 대조로 되돌렸으니 픽스처로 박는다.
    _cod = (P + '<measure number="1"><attributes><divisions>1</divisions>'
            '<clef><sign>G</sign><line>2</line>'
            '<clef-octave-change>-1</clef-octave-change></clef></attributes>'
            '<note><pitch><step>C</step><octave>4</octave></pitch>'
            '<duration>4</duration></note></measure>' + E)
    with open("data/sing/selftest-clefoct.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_cod)
    _cr = []
    musicxml_to_score("data/sing/selftest-clefoct.musicxml", parts_out=_cr)
    ck("a clef's octave change does not move the pitch either", 60,
       next((r["pitch"] for r in _cr if "pitch" in r), None),
       next((r["pitch"] for r in _cr if "pitch" in r), None) == 60)
    os.remove("data/sing/selftest-clefoct.musicxml")

    # 세기 델타는 **셈여림 표 한 칸**이다. 악센트 +0.12·마르카토 +0.18 은 내가 고른 값이었다.
    ck("an accent is one step up the dynamics table, not a number of mine",
       (round(_XML_DYN["mf"], 4), round(_XML_DYN["f"], 4)),
       (round(_dyn_step(_XML_DYN["p"], 1), 4), round(_dyn_step(_XML_DYN["p"], 2), 4)),
       abs(_dyn_step(_XML_DYN["p"], 1) - _XML_DYN["mp"]) < 1e-9
       and abs(_dyn_step(_XML_DYN["p"], -1) - _XML_DYN["pp"]) < 1e-9
       and _dyn_step(_XML_DYN["fff"], 1) <= 1.0
       and _dyn_step(_XML_DYN["ppp"], -1) > 0)

    # …그리고 그 계단이 **음표 경로에서** 실제로 쓰이는지. 헬퍼만 재면 호출부를 되돌려도
    # 초록이 나온다(카나리아로 확인). p 로 선언된 마디에서 악센트 붙은 음은 정확히 mp 다.
    _ad = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
           '<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>'
           '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>'
           '<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration>'
           '<notations><articulations><accent/></articulations></notations></note>'
           '</measure>' + E)
    with open("data/sing/selftest-accent.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_ad)
    _ap = []
    musicxml_to_score("data/sing/selftest-accent.musicxml", parts_out=_ap)
    _plain = next((r["vel"] for r in _ap if r.get("pitch") == 60), None)
    _accd = next((r["vel"] for r in _ap if r.get("pitch") == 62), None)
    ck("…and the note path uses that step — an accent under p comes out exactly mp",
       (round(_XML_DYN["p"], 4), round(_XML_DYN["mp"], 4)),
       (_plain and round(_plain, 4), _accd and round(_accd, 4)),
       _plain is not None and _accd is not None
       and abs(_plain - _XML_DYN["p"]) < 1e-9 and abs(_accd - _XML_DYN["mp"]) < 1e-9)
    os.remove("data/sing/selftest-accent.musicxml")

    # 드럼도 악센트를 읽는다. 실측 2026-08-22 아로하: 파일이 40개 적었는데 전부 버려졌다.
    _acc = ('<score-partwise><part-list><score-part id="P1">'
            '<midi-instrument id="P1-I36"><midi-unpitched>39</midi-unpitched>'
            '</midi-instrument></score-part></part-list><part id="P1">'
            '<measure number="1"><attributes><divisions>1</divisions></attributes>'
            '<note><unpitched><display-step>C</display-step>'
            '<display-octave>5</display-octave></unpitched>'
            '<instrument id="P1-I36"/><duration>1</duration></note>'
            '<note><unpitched><display-step>C</display-step>'
            '<display-octave>5</display-octave></unpitched>'
            '<instrument id="P1-I36"/><duration>1</duration>'
            '<notations><articulations><accent/></articulations></notations></note>'
            '</measure></part></score-partwise>')
    with open("data/sing/selftest-drumacc.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_acc)
    _dr = []
    musicxml_to_score("data/sing/selftest-drumacc.musicxml", parts_out=_dr)
    _hits = [r for r in _dr if r.get("drum")]
    ck("a drum hit marked with an accent is played accented", True,
       [round(h["vel"], 3) for h in _hits],
       len(_hits) == 2 and _hits[1]["vel"] > _hits[0]["vel"])
    os.remove("data/sing/selftest-drumacc.musicxml")

    # 페르마타는 관례대로 대략 두 배. 1.75 는 내 값이었다.
    _fd = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
           '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>'
           '<notations><fermata type="upright"/></notations></note></measure>' + E)
    with open("data/sing/selftest-ferm.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_fd)
    _fr = []
    musicxml_to_score("data/sing/selftest-ferm.musicxml", parts_out=_fr)
    ck("a fermata holds about twice the written value", 2.0,
       next((round(r["beats"], 4) for r in _fr if "pitch" in r), None),
       any(abs(r["beats"] - 2.0) < 1e-4 for r in _fr if "pitch" in r))
    os.remove("data/sing/selftest-ferm.musicxml")

    # 테누토는 제 길이를 지킨다 — 넘기지 않는다. 1.05 는 테누토가 아니었다.
    ck("tenuto holds the full value and no more", 1.0, _XML_ART_GATE["tenuto"],
       _XML_ART_GATE["tenuto"] == 1.0 and _XML_ART_GATE["staccato"] == 0.5)

    # ── 굴림(물결선으로 지시된 화음) ─────────────────────────────────────────────────────────
    # ⚠️ 이름 주의: 우리말 "아르페지오 주법"(손가락으로 뜯는 분산화음)은 악보에 음표로 다
    # 적히므로 우리가 만질 것이 없다. 여기서 다루는 것은 **기호 하나**로 지시된 굴리기다.
    def _rolldoc(direction="", dur=4, div=1):
        _ns = "".join(
            '<note>%s<pitch><step>%s</step><octave>4</octave></pitch>'
            '<duration>%d</duration><notations><arpeggiate%s/></notations></note>'
            % ("<chord/>" if i else "", st, dur,
               (' direction="%s"' % direction) if (direction and i == 0) else "")
            for i, st in enumerate("CEG"))
        return (P.replace("<divisions>1</divisions>", "<divisions>%d</divisions>" % div)
                + '<measure number="1"><attributes><divisions>%d</divisions></attributes>' % div
                + _ns + '</measure>' + E)

    def _rollrows(doc, name):
        with open("data/sing/selftest-%s.musicxml" % name, "w", encoding="utf-8") as _fh:
            _fh.write(doc)
        _r = []
        musicxml_to_score("data/sing/selftest-%s.musicxml" % name, parts_out=_r)
        os.remove("data/sing/selftest-%s.musicxml" % name)
        return sorted((r["beat"], r["pitch"]) for r in _r if "pitch" in r)

    _up = _rollrows(_rolldoc(), "rollup")
    # 마지막(제일 높은) 음이 적힌 자리 0.0 에, 나머지는 그 앞으로 ROLL_SPAN 안에.
    ck("a rolled chord lands its LAST note on the written beat",
       (0.0, 67, round(-ROLL_SPAN, 4)), (_up[-1][0], _up[-1][1], _up[0][0]),
       len(_up) == 3 and _up[-1] == (0.0, 67)
       and abs(_up[0][0] + ROLL_SPAN) < 1e-4 and _up[0][1] == 60)
    ck("…and the roll is one note value wide, not one of our milliseconds",
       round(1.0 / 32.0, 6), round(ROLL_SPAN, 6), abs(ROLL_SPAN - 1.0 / 32.0) < 1e-12)

    _dn = _rollrows(_rolldoc("down"), "rolldn")
    # 아래로 굴리면 **제일 낮은 음**이 자리에 서고 높은 음들이 앞선다.
    ck("direction=\"down\" rolls the other way — the file decides, not us",
       (0.0, 60), next(((b, p) for b, p in _dn if abs(b) < 1e-9), None),
       any(abs(b) < 1e-9 and p == 60 for b, p in _dn)
       and all(b <= 1e-9 for b, _p in _dn))

    # 화음이 굴림보다 짧으면 굴림이 그 안으로 줄어든다 — 다음 음을 침범하지 않는다.
    _sh = _rollrows(_rolldoc(dur=1, div=64), "rollcap")
    _short = 1.0 / 64.0
    ck("a roll never spills past the chord's own written length",
       True, ("굴림 폭", round(-_sh[0][0], 6), "적힌 길이", round(_short, 6)),
       abs(_sh[0][0]) <= _short + 1e-4 and _sh[-1][0] == 0.0)

    # 셈여림은 대보표 사이에 한 번 적고 두 손에 다 건다. 오른손에만 pp 가 있고 왼손에
    # 크레센도가 걸리면 그 크레센도는 pp 에서 출발해야 한다 — 실측 2026-08-21 월광
    # 16·18마디가 기본값 90 에서 출발해 "피아노 부서지도록" 들렸다. 음표 경로는 이미
    # 폴백하고 있었고 어긋난 건 쐐기 하나였으니, 둘을 한 판정기로 묶고 여기서 잠근다.
    _wd = (P + '<measure number="1"><attributes><divisions>1</divisions>'
           '<staves>2</staves></attributes>'
           '<direction><direction-type><dynamics><pp/></dynamics></direction-type>'
           '<staff>1</staff></direction>'
           '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration>'
           '<voice>1</voice><staff>1</staff></note>'
           '<backup><duration>4</duration></backup>'
           '<direction><direction-type><wedge type="crescendo"/></direction-type>'
           '<staff>2</staff></direction>'
           '<note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration>'
           '<voice>5</voice><staff>2</staff></note>'
           '<note><pitch><step>E</step><octave>3</octave></pitch><duration>2</duration>'
           '<voice>5</voice><staff>2</staff></note>'
           '</measure>' + E)
    with open("data/sing/selftest-wedge2.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_wd)
    _wr = []
    musicxml_to_score("data/sing/selftest-wedge2.musicxml", parts_out=_wr)
    _lh = [r for r in _wr if r.get("staff") == "2" and "pitch" in r]
    ck("a wedge on the other hand starts from the part's dynamic, not from the default",
       round(_XML_DYN["pp"], 3),
       round(_lh[0]["vel"], 3) if _lh else None,
       len(_lh) == 2 and abs(_lh[0]["vel"] - _XML_DYN["pp"]) < 0.02
       and _lh[1]["vel"] > _lh[0]["vel"])
    os.remove("data/sing/selftest-wedge2.musicxml")

    # 한 파트에 성부가 여럿이면 같은 음이 동시에 울린다 — 온음표를 붙든 성부와, 그 위에서
    # 이음줄로 이어지는 성부. 마지막 행 하나만 들고 있으면 그 온음표를 집고 검사에서 떨어진다
    # (실측 아로하: 어긋남이 정확히 +4.0박, 즉 아직 울리는 긴 음의 끝이었다).
    # ⚠️ 순서가 핵심이다. 이음줄 시작 **뒤에** 같은 음의 다른 성부가 붙어야 목록의 마지막이
    # 틀린 후보가 된다 — 첫 픽스처는 그 순서를 못 만들어서 카나리아가 안 터졌다(실제 파일로는
    # 4,688 → 4,721 로 터진다). 성부 2 가 3박부터 이음줄을 걸고, 그 뒤 성부 1 이 3박짜리
    # 음을 놓아 목록 끝을 차지한다.
    _vd = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
           '<note><rest/><duration>2</duration><voice>2</voice></note>'
           '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration>'
           '<voice>2</voice><tie type="start"/></note>'
           '<backup><duration>4</duration></backup>'
           '<note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration>'
           '<voice>1</voice></note>'
           '<note><rest/><duration>1</duration><voice>1</voice></note>'
           '</measure><measure number="2">'
           '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration>'
           '<voice>2</voice><tie type="stop"/></note>'
           '<note><rest/><duration>2</duration><voice>2</voice></note>'
           '</measure></part></score-partwise>')
    with open("data/sing/selftest-voice.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_vd)
    _vr = []
    _vs, _ = musicxml_to_score("data/sing/selftest-voice.musicxml", parts_out=_vr)
    _c4 = sorted((round(r["beat"], 3), round(r["beats"], 3))
                 for r in _vr if r.get("pitch") == 60)
    # 성부 1 의 3박 음 하나 + 성부 2 의 이음줄이 합쳐진 4박 음 하나 = 둘. 이음줄이 목록의
    # 마지막(성부 1)을 집으면 안 붙어서 **셋**이 된다.
    ck("성부가 겹쳐도 이음줄은 제 짝을 찾는다 (목록 끝의 다른 성부를 집지 않는다)",
       [(0.0, 3.0), (2.0, 4.0)], _c4, _c4 == [(0.0, 3.0), (2.0, 4.0)])
    # 그리고 **어느 성부의 붙임줄인지**. 둘이 같은 자리에서 끝나면 후보 검사만으로는 못 가른다 —
    # 실측 2026-08-21 아로하 Gtr1: 성부 1 과 성부 5 가 같은 음악을 들고 있어서 41→42마디의
    # 붙임줄이 남의 성부에 붙었다. 여기서는 성부 1 이 이어지고 성부 2 는 안 이어진다.
    _vd2 = (P + '<measure number="1"><attributes><divisions>1</divisions></attributes>'
            '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>'
            '<voice>1</voice><tie type="start"/></note>'
            '<backup><duration>4</duration></backup>'
            '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>'
            '<voice>2</voice></note>'
            '</measure><measure number="2">'
            '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>'
            '<voice>1</voice><tie type="stop"/></note>'
            '</measure></part></score-partwise>')
    with open("data/sing/selftest-voice2.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_vd2)
    _vr2 = []
    musicxml_to_score("data/sing/selftest-voice2.musicxml", parts_out=_vr2)
    # ⚠️ 길이만 정렬해 보면 못 가른다 — 어느 쪽이 늘어났든 [4, 8] 이다. **성부별로** 봐야 한다.
    _byv = {r.get("voice"): round(r["beats"], 3) for r in _vr2 if r.get("pitch") == 60}
    ck("…그리고 이어지는 쪽은 그 붙임줄을 쓴 성부다 (길이가 남의 성부로 가지 않는다)",
       {"1": 8.0, "2": 4.0}, _byv, _byv == {"1": 8.0, "2": 4.0})
    os.remove("data/sing/selftest-voice2.musicxml")
    os.remove("data/sing/selftest-voice.musicxml")

    # 이음줄은 **화음 안에서도** 이어져야 한다. 바로 앞 행으로 찾던 시절 앞 행이 다른 성부라
    # 못 찾았고, 그 음은 이어지는 대신 다시 때려졌다 — 악보가 한 음이라고 적은 자리에서.
    # 실측 2026-08-21 아로하: 단선율 Base 는 정확했고 화음 파트만 어긋났다.
    _tdoc = (P + '<measure number="1"><attributes><divisions>2</divisions></attributes>'
             '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration>'
             '<tie type="start"/></note>'
             '<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration>'
             '</note>'
             '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration>'
             '<tie type="stop"/></note>'
             '<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration>'
             '</note>'
             '</measure></part></score-partwise>')
    with open("data/sing/selftest-tie.musicxml", "w", encoding="utf-8") as _fh:
        _fh.write(_tdoc)
    _trows = []
    musicxml_to_score("data/sing/selftest-tie.musicxml", parts_out=_trows)
    _c4 = [r for r in _trows if r.get("pitch") == 60]
    ck("이음줄은 화음 속에서도 한 음이다 — 다시 때리지 않는다", [1, 2.0],
       [len(_c4), _c4[0]["beats"] if _c4 else None],
       len(_c4) == 1 and abs(_c4[0]["beats"] - 2.0) < 1e-6)
    ck("…같은 음이라도 이어지지 않으면 따로 친다(연속성 확인)", 2,
       len([r for r in _trows if r.get("pitch") in (64, 67)]),
       len([r for r in _trows if r.get("pitch") in (64, 67)]) == 2)
    os.remove("data/sing/selftest-tie.musicxml")

    # 출력 레벨을 정하는 건 **파일을 쓰는 마지막 자리**다. 렌더 쪽 정규화를 걷고도 여기가
    # 따로 정규화하고 있어서 폰트 넷 × 곡 둘이 전부 peak −0.45 dBFS 로 같았다(2026-08-21 실측,
    # 0.95 가 그 값이다). 폰트가 다른데 피크가 같으면 그건 폰트 소리가 아니라 우리 소리다.
    _lvl = np.array([[0.3, 0.3], [0.6, 0.6], [-0.2, -0.2]], dtype="float32")
    # ── 크기 맞추기 ────────────────────────────────────────────────────────────────────────
    # ① 우리가 설계한 K-weighting 이 규격과 같은가. BS.1770-4 는 **48kHz 계수표**를 싣고
    #    있으니, 같은 율로 설계해서 그 표와 대조한다. 다른 율은 표를 못 쓰므로 설계식이
    #    맞다는 것을 여기서 한 번 증명해 두고 그 식을 쓴다.
    _spec48 = (([1.53512485958697, -2.69169618940638, 1.19839281085285],
                [1.0, -1.69065929318241, 0.73248077421585]),
               ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]))
    _mine48 = _kweight_biquads(48000)
    _worst = max(abs(m - sp)
                 for (mb, ma), (sb, sa) in zip(_mine48, _spec48)
                 for m, sp in list(zip(mb, sb)) + list(zip(ma, sa)))
    ck("our K-weighting is the spec's, re-derived for this sample rate",
       True, ("48k 최대 계수차", round(_worst, 9)), _worst < 1e-8)

    # ② 라우드니스는 선형이다 — 6.02dB 올리면 6.02 LUFS 오른다. 이게 깨지면 게이팅이 틀렸다.
    _t = np.arange(int(3.0 * SR)) / SR
    _sig = (0.1 * np.sin(2 * math.pi * 997.0 * _t)).astype(np.float32)
    _sig = np.stack([_sig, _sig], axis=1)
    _l1 = integrated_lufs(_sig, SR)
    _l2 = integrated_lufs(_sig * 2.0, SR)
    ck("loudness is linear in gain (x2 = +6.02 LUFS)", 6.02,
       None if (_l1 is None or _l2 is None) else round(_l2 - _l1, 2),
       _l1 is not None and abs((_l2 - _l1) - 6.0206) < 0.02)

    # ③ 계약 그 자체 — 맞추고 나면 목표에 서 있어야 한다.
    _q, _rep = match_loudness(_sig * 0.02)   # 아주 조용한 것
    _got = integrated_lufs(_q, SR)
    ck("a quiet render is brought TO the target, not near it", LUFS_TARGET,
       None if _got is None else round(_got, 1),
       _got is not None and abs(_got - LUFS_TARGET) < 0.1 and not _rep["ceilingHit"])

    # ④ 천장이 먼저 걸리면 자르지 않고 멈추고, 멈췄다고 말한다. 성긴 클릭은 피크가 이미
    #    가득한데 라우드니스는 한참 낮아서 목표까지 올리면 넘친다.
    _clk = np.zeros((int(3.0 * SR), 2), dtype=np.float32)
    _clk[::SR // 2] = 0.99
    _cq, _crep = match_loudness(_clk)
    ck("the peak ceiling stops the gain instead of clipping, and says so",
       (True, True),
       (_crep["ceilingHit"], float(np.max(np.abs(_cq))) <= 10 ** (PEAK_CEILING_DB / 20) + 1e-6),
       _crep["ceilingHit"] and float(np.max(np.abs(_cq))) <= 10 ** (PEAK_CEILING_DB / 20) + 1e-6
       and _crep.get("shortByDb", 0) > 0)

    write_wav("data/sing/selftest-level.wav", _lvl.copy())
    import soundfile as _sfmod
    _back, _ = _sfmod.read("data/sing/selftest-level.wav", dtype="float32", always_2d=True)
    _pk = float(np.abs(_back).max())
    ck("파일 쓰기가 레벨을 안 건드린다 — 정규화는 우리 결정이다", 0.6, round(_pk, 3),
       abs(_pk - 0.6) < 0.01)
    os.remove("data/sing/selftest-level.wav")

    # ── verify: 그대로 연주되는지 재는 자리 ────────────────────────────────────────────────
    # ⚠️ 이 액션은 midi_to_parts 를 비교의 **한쪽에만** 쓴다. 양쪽에 쓰면 우리 리더와 우리
    # 라이터의 왕복만 증명되고, 리더가 통째로 틀려도 초록이 뜬다 — type-0 파일이 한 악기로
    # 무너져 있던 동안 selftest 는 내내 초록이었다.
    _vf = _mido.MidiFile(ticks_per_beat=480)
    _v1 = _mido.MidiTrack(); _vf.tracks.append(_v1)
    _v1.append(_mido.MetaMessage("track_name", name="Piano", time=0))
    _v1.append(_mido.Message("program_change", channel=0, program=0, time=0))
    _v1.append(_mido.Message("control_change", channel=0, control=7, value=100, time=0))
    _v1.append(_mido.Message("control_change", channel=0, control=1, value=40, time=0))
    for _i in range(6):
        _v1.append(_mido.Message("note_on", channel=0, note=60 + _i, velocity=90, time=0))
        _v1.append(_mido.Message("note_off", channel=0, note=60 + _i, velocity=0, time=480))
    _v2 = _mido.MidiTrack(); _vf.tracks.append(_v2)
    _v2.append(_mido.Message("program_change", channel=1, program=33, time=0))
    for _i in range(6):
        _v2.append(_mido.Message("note_on", channel=1, note=36, velocity=100, time=0))
        _v2.append(_mido.Message("note_off", channel=1, note=36, velocity=0, time=480))
    _v3 = _mido.MidiTrack(); _vf.tracks.append(_v3)
    for _i in range(8):
        _v3.append(_mido.Message("note_on", channel=9, note=36, velocity=110, time=0))
        _v3.append(_mido.Message("note_off", channel=9, note=36, velocity=0, time=240))
    _vf.save("data/sing/selftest-verify.mid")
    _vr = action_verify({"action": "verify",
                         "scoreMediaPath": "data/sing/selftest-verify.mid"})
    _vd = _vr.get("data") or {}
    ck("verify: 평범한 파일은 음표·악기·컨트롤러가 통째로 그대로 간다", True,
       [_vd.get("exact"), _vd.get("notes"), _vd.get("controllers", {}).get("dropped")],
       bool(_vd.get("exact")))
    ck("…드럼 길이도 파일이 적은 대로 (0.25 가 박혀 있었고 verify 첫 실행이 잡았다)", [],
       _vd.get("changed"), not _vd.get("changed"))
    # ⭐ 우리 드럼 표에 없는 키. 예전엔 리더가 **조용히 버렸고** 이 검사는 그 침묵을 확인하는
    # 것이었다 — 즉 결손을 못박아 둔 시험이었다. 저자 데모 10개에서 21·23·24번 256음이 그렇게
    # 사라졌고 GS 는 그 셋을 갖고 있다. 이제 번호가 원본이라 이름 없이도 그대로 나간다.
    _v3.append(_mido.Message("note_on", channel=9, note=13, velocity=100, time=0))
    _v3.append(_mido.Message("note_off", channel=9, note=13, velocity=0, time=240))
    _vf.save("data/sing/selftest-verify-lost.mid")
    _lr = (action_verify({"action": "verify",
                          "scoreMediaPath": "data/sing/selftest-verify-lost.mid"})
           .get("data") or {})
    ck("⭐ 이름표에 없는 드럼 키도 그대로 연주된다 (이름은 우리 어휘지 파일의 것이 아니다)",
       [True, 0], [_lr.get("exact"), len(_lr.get("lost") or [])],
       _lr.get("exact") is True and not _lr.get("lost"))
    # 그물 자체는 살아 있어야 한다. 남아 있는 진짜 차이 하나 = **길이 0 인 음** — 파일은 0 을
    # 쓸 수 있는데 우리는 그 파일의 틱 하나로 바닥을 깐다(실측: 저자 데모 J-cycle 에 1,177개).
    # 소리는 사실상 같지만(어택+릴리스뿐) 그건 **우리 결정**이라, verify 가 말해야 한다.
    _v3.append(_mido.Message("note_on", channel=9, note=38, velocity=100, time=240))
    _v3.append(_mido.Message("note_off", channel=9, note=38, velocity=0, time=0))
    _vf.save("data/sing/selftest-verify-dangle.mid")
    _dr = (action_verify({"action": "verify",
                          "scoreMediaPath": "data/sing/selftest-verify-dangle.mid"})
           .get("data") or {})
    ck("verify: 우리가 바꾼 것은 바꿨다고 말한다 (길이 0 → 틱 하나)", [False, 1],
       [_dr.get("exact"), len(_dr.get("changed") or [])],
       _dr.get("exact") is False and len(_dr.get("changed") or []) == 1)
    ck("…그리고 왜 다른지 응답이 말한다", True, (_dr.get("note") or "")[:40],
       "달라진" in (_dr.get("note") or "") or "길이" in (_dr.get("note") or ""))
    _bad = action_verify({"action": "verify", "scoreMediaPath": "data/sing/selftest-parts.musicxml"}) \
        if os.path.exists("data/sing/selftest-parts.musicxml") else {"error": "verify 는 .mid"}
    ck("…MusicXML 은 대조 기준이 없다고 이유를 대며 거부한다", True,
       (_bad.get("error") or "")[:30], "verify" in (_bad.get("error") or ""))
    for _f in ("data/sing/selftest-verify.mid", "data/sing/selftest-verify-lost.mid",
               "data/sing/selftest-verify-dangle.mid"):
        if os.path.exists(_f):
            os.remove(_f)

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

    # 여기 셋잇단 동화 시험 둘이 있었다 — 점리듬 16분음표를 셋잇단 셋째 음에 붙이던 것.
    # 월광에서는 그것이 맞는 해석이었지만 **해석이지 악보가 아니다**(사용자 2026-08-21:
    # "이거도 원래 디폴트로 돌려보자"). 지금은 적힌 3:1 을 그대로 친다.

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
    # 두 음 화음: 아래 음이 앞서고 **위 음이 적힌 자리(0박)에** 선다. 옛 규칙은 아래 음을
    # 0박에 두고 위 음을 +44ms 로 밀었다 — 멜로디가 늦는 그 동작이라 2026-08-22 에 뒤집었다.
    arp_low = [r for r in arows if r.get("pitch") == 60]
    ck("a rolled chord arrives ON the beat — its last note, not its first",
       (0.0, -ROLL_SPAN),
       (arp_top[0]["beat"] if arp_top else None, arp_low[0]["beat"] if arp_low else None),
       aerr is None and bool(arp_top) and bool(arp_low)
       and arp_top[0]["beat"] == 0.0
       and abs(arp_low[0]["beat"] + ROLL_SPAN) < 1e-4)

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
        # ⚠️ 벨로시티는 **우리가 고른 수가 아니어야 한다.** 여기 0.3 이 박혀 있었는데 그건 내가
        # 지어낸 값이었다(사용자 2026-08-21: "니가 만든 숫자인가"). pp 는 표에서 나오고, 그 표는
        # 널리 깔린 표기 프로그램의 값이지 우리 취향이 아니다 — 그래서 표를 참조해 단언한다.
        ck("MusicXML carries what MIDI only implies (meter, tempo, dynamics, lyric)",
           (3, 80.0, round(_XML_DYN["pp"], 4), "사"),
           (xsc.get("meter"), xsc.get("bpm"), round(xsc["notes"][0].get("vel"), 4),
            xsc["notes"][0]["syl"]),
           xsc.get("meter") == 3 and xsc.get("bpm") == 80.0
           and abs(xsc["notes"][0].get("vel") - _XML_DYN["pp"]) < 1e-9
           and xsc["notes"][0]["syl"] == "사")
        # 그리고 규격이 정한 기본값 — 아무 셈여림도 안 적힌 음은 벨로시티 90 이다.
        ck("아무것도 안 적힌 음의 세기는 규격이 정한다 (velocity 90)", 90,
           round(XML_DEFAULT_VEL * 127), round(XML_DEFAULT_VEL * 127) == 90)
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


# 마스터 게인 — **페이더 하나가 전체에 똑같이 걸린다.** 파일마다 다시 재는 정규화가 아니라서
# 폰트와 악보가 만든 세기 차이는 그대로 남는다(pp 곡은 pp 로 남는다).
#
# 값은 **제일 큰 렌더가 정한다** — 그 파일이 0 dBFS 를 넘으면 깨지므로 거기가 천장이다.
# 실측 2026-08-21 (fluidsynth 기본 0.2 에서): 제일 큰 아로하-musescore 가 peak −14.2 dBFS.
# 0.2 → 0.9 = +13.1 dB 라 그 파일이 −1.1 dBFS 로 앉는다. 그 위는 클리핑이다.
# ⚠️ 사용자 지적 2026-08-21: 기본 0.2 에서는 "볼륨 100% 해야 들린다". 일반 음악 파일의 RMS 가
# −12~−18 dBFS 인데 월광이 −58 이었다.
# fluidsynth 의 `-g` 는 **크기가 아니라 여유**다. 크기는 이제 라우드니스 정규화가 정한다
# (match_loudness). 여기서 할 일은 하나뿐 — 엔진 안에서 안 잘리게 하는 것.
# 실측 2026-08-21: 여덟 성부 fff 동시타를 게인 0.05 로 재고 선형 환산하면 게인 1.0 에서
# Arachno +9.6 dBFS · FluidR3 +7.8 · MuseScore +6.4 · GeneralUser +2.9 — 즉 **0.9 에서
# 제일 큰 폰트가 8.7 dB 넘게 잘린다.** fluidsynth 기본이 0.2 인 것이 이 이유다. 우리 실제
# 렌더가 여태 안 잘린 건 재료가 fff 여덟 겹이 아니었을 뿐이고, 그건 안전이 아니라 운이다.
# ⚠️ **그 여유 문제는 8/22 에 없어졌다** — 출력을 `-O float` 로 받으면서 파일 쓰기에서 잘릴
# 자리가 사라졌다(render_sf2 참조). 그래서 `-g` 는 이제 "안 잘릴 만큼 작게"가 아니라 그냥 크기
# 계수이고, 크기는 라우드니스가 정하므로 **최종 파일에 안 남는다**(스케일 불변). 남은 일은
# 하나 — 누구의 값을 쓸 것인가. 폰트가 자기 문서에서 말했으면 그것(FONT_SYNTH_PROFILES,
# GeneralUser GS = 0.5), 아무도 안 말했으면 **fluidsynth 자기 기본값**.
SYNTH_GAIN = 0.2
# 내장 신디의 마스터. 예전엔 SYNTH_GAIN 에서 파생했는데 그 연결의 근거였던 "여유"가 없어져
# 뜻이 사라졌다 — 값은 그대로 두어 회귀 0(정규화가 뒤에 서니 최종 결과는 어차피 스케일 불변).
BUILTIN_GAIN = 0.8


MIDI_TPB = 480          # write_midi 가 쓰는 격자. 대조는 이 눈금 위에서 한다


def _tick(beats):
    """비교용 시간 — **틱 격자**로 반올림. 원본 쪽은 템포맵을 실수로 편 값이고 우리 쪽은 정수
    틱에서 나온 값이라, 소수 넷째 자리로 비교하면 같은 음이 0.1328 대 0.1333 으로 갈린다.
    그러면 멀쩡한 음이 '달라졌다'로 찍혀 진짜 차이가 그 안에 묻힌다."""
    return round(round(beats * MIDI_TPB) / MIDI_TPB, 6)


def _raw_midi_notes(path):
    """(pitch, onset_beat, dur_beat, velocity, program, is_drum) 목록 — **파서를 안 거치고**
    파일에서 직접. 템포맵만 우리 warp 로 펴서 두 쪽을 같은 시간 축에 둔다.

    verify 가 `midi_to_parts` 를 쓰면 우리 리더와 우리 라이터의 왕복만 증명한다. 리더가 통째로
    틀려도 그 시험은 초록이다 — 8/21 에 type-0 파일이 한 악기로 무너져 있던 동안 selftest 는
    내내 초록이었다. 그래서 원본 쪽은 여기서 다시, 최소한으로 읽는다."""
    import mido
    mf = mido.MidiFile(path)
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
    out, ccs = [], set()
    for tr in mf.tracks:
        t, on, prog = 0, {}, {}
        for msg in tr:
            t += msg.time
            ch = getattr(msg, "channel", None)
            if msg.type == "program_change":
                prog[int(ch)] = int(msg.program)
            elif msg.type == "control_change":
                ccs.add((int(ch), int(msg.control)))
            elif msg.type == "note_on" and msg.velocity > 0:
                on.setdefault((int(ch), msg.note), []).append(
                    (t, msg.velocity, prog.get(int(ch), 0)))
            elif (msg.type == "note_off"
                  or (msg.type == "note_on" and msg.velocity == 0)) and on.get((int(ch), msg.note)):
                st, vel, pg = on[(int(ch), msg.note)].pop(0)
                b0 = warp(st / tpb)
                out.append((int(msg.note), _tick(b0), _tick(warp(t / tpb) - b0),
                            int(vel), (0 if ch == 9 else pg), ch == 9))
    return out, bpm, ccs


def _emitted_notes(path):
    """같은 모양으로, 우리가 신디에 넘기는 .mid 에서. 이쪽은 템포가 하나라 warp 가 없다."""
    import mido
    mf = mido.MidiFile(path)
    tpb = mf.ticks_per_beat or 480
    out, ccs = [], set()
    for tr in mf.tracks:
        t, on, prog = 0, {}, {}
        for msg in tr:
            t += msg.time
            ch = getattr(msg, "channel", None)
            if msg.type == "program_change":
                prog[int(ch)] = int(msg.program)
            elif msg.type == "control_change":
                ccs.add((int(ch), int(msg.control)))
            elif msg.type == "note_on" and msg.velocity > 0:
                on.setdefault((int(ch), msg.note), []).append(
                    (t, msg.velocity, prog.get(int(ch), 0)))
            elif (msg.type == "note_off"
                  or (msg.type == "note_on" and msg.velocity == 0)) and on.get((int(ch), msg.note)):
                st, vel, pg = on[(int(ch), msg.note)].pop(0)
                out.append((int(msg.note), _tick(st / tpb), _tick((t - st) / tpb),
                            int(vel), (0 if ch == 9 else pg), ch == 9))
    return out, ccs


def notes_out_of_range(arr, font_path):
    """폰트가 **답하지 않는** 음. 프리셋마다 키 범위가 선언돼 있고 그 밖은 소리가 안 난다 —
    그리고 무음은 믹싱 결정처럼 들린다. 우리가 아는 것을 안 말해 주는 자리라 응답에 싣는다.

    반환 = [{part, program, preset, pitch, range, count}]. 폰트를 못 읽으면 빈 목록(추측 금지)."""
    inv = font_inventory(font_path) if font_path else None
    if not inv:
        return []
    seen, out = {}, []
    for e in arr:
        if "pitch" not in e or e.get("pedal") or e.get("part") == "drum":
            continue
        key = f"{int(e.get('bank') or 0)}:{int(e.get('program') or 0)}"
        pre = inv["presets"].get(key)
        rng = (pre or {}).get("keys")
        if not pre or not rng:
            continue
        p = int(e["pitch"])
        if rng[0] <= p <= rng[1]:
            continue
        k = (e.get("part"), key, p)
        if k in seen:
            seen[k]["count"] += 1
            continue
        row = {"part": e.get("part"), "program": pre["program"], "preset": pre["name"],
               "pitch": p, "range": rng, "count": 1}
        seen[k] = row
        out.append(row)
    return out


# 무엇을 어떻게 재는가. `metric` 은 두 구간(낮은 값 / 높은 값)을 받아 하나의 수를 낸다 —
# 그 수가 유의하게 다르면 그 컨트롤러가 이 신디·이 폰트에서 실제로 걸린 것이다.
#   level = RMS · balance = 좌우 에너지 차 · pitch = FFT 최대 피크 · wobble = 순간 피크의 흔들림
#   tail  = 음이 끝난 뒤에 남는 에너지 (센드와 서스테인이 사는 자리)
CC_PROBES = (
    (7,   "level",   "채널 볼륨"),
    (11,  "level",   "익스프레션"),
    (10,  "balance", "팬"),
    (1,   "wobble",  "모듈레이션 휠 → 비브라토"),
    (91,  "tail",    "리버브 센드"),
    (93,  "tail",    "코러스 센드"),
    (64,  "tail",    "서스테인 페달"),
    (74,  "level",   "필터 컷오프(밝기) — 규격 기본이 아니라 폰트가 선언했을 때만 걸린다"),
)


def _probe_metric(kind, seg):
    """한 구간의 값 하나. 구간은 (n,2) 스테레오."""
    mono = seg.mean(axis=1)
    if kind == "level":
        return float(np.sqrt((mono ** 2).mean()))
    if kind == "balance":
        l, r = float(np.sqrt((seg[:, 0] ** 2).mean())), float(np.sqrt((seg[:, 1] ** 2).mean()))
        return (l - r) / max(1e-9, l + r)
    if kind == "tail":
        # 음이 끝난 뒤 뒤쪽 30% 에 남는 에너지 — 리버브 꼬리도 붙들린 음도 여기 산다
        cut = int(len(mono) * 0.7)
        head = float(np.sqrt((mono[:cut] ** 2).mean())) or 1e-9
        return float(np.sqrt((mono[cut:] ** 2).mean())) / head
    if kind in ("pitch", "wobble"):
        # 창을 여러 개로 잘라 각 창의 FFT 최대 피크를 본다. pitch = 평균, wobble = 표준편차.
        win = max(512, len(mono) // 24)
        peaks = []
        for i in range(0, len(mono) - win, win):
            w = mono[i:i + win] * np.hanning(win)
            if not np.any(w):
                continue
            sp = np.abs(np.fft.rfft(w))
            if sp[1:].max() <= 0:
                continue
            peaks.append(float(np.argmax(sp[1:]) + 1) * SR / win)
        if len(peaks) < 4:
            return 0.0
        return float(np.mean(peaks)) if kind == "pitch" else float(np.std(peaks))
    return 0.0


def probe_controllers(program=0, bank=0):
    """이 신디·이 폰트가 **실제로 답하는** 컨트롤러. 손으로 적은 표가 아니라 측정이다.

    반환 [{cc, what, metric, low, high, responds}]. fluidsynth 가 없으면 (None, 이유)."""
    binp, font, why = sf2_backend()
    if why:
        return None, why
    try:
        import mido
    except ImportError:
        return None, "mido 미설치 — 프로브는 .mid 를 씁니다"
    import subprocess
    os.makedirs("data/sing", exist_ok=True)
    tag = f"{os.getpid()}-probe"
    mid_path, wav_path = f"data/sing/{tag}.mid", f"data/sing/{tag}.wav"
    cfg_path = f"data/sing/{tag}.cfg"
    tpb, note_beats = 480, 2.0        # 120bpm 기준 1초. 뒤 30% 가 꼬리 구간이 된다
    try:
        mf = mido.MidiFile(ticks_per_beat=tpb)
        tr = mido.MidiTrack(); mf.tracks.append(tr)
        tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120), time=0))
        if bank:
            tr.append(mido.Message("control_change", channel=0, control=0, value=bank, time=0))
        tr.append(mido.Message("program_change", channel=0, program=program, time=0))
        step = int(tpb * note_beats)
        slots = []
        for cc, _kind, _what in CC_PROBES:
            for value in (0, 127):
                slots.append((cc, value))
        for i, (cc, value) in enumerate(slots):
            # 매번 기본 상태로 되돌린 뒤 이 하나만 바꾼다 — 앞 프로브가 남기면 다음이 오염된다.
            for rcc, rval in ((7, 100), (11, 127), (10, 64), (1, 0), (91, 40), (93, 0), (64, 0),
                              (74, 64)):
                tr.append(mido.Message("control_change", channel=0, control=rcc, value=rval,
                                       time=0))
            tr.append(mido.Message("control_change", channel=0, control=cc, value=value, time=0))
            tr.append(mido.Message("note_on", channel=0, note=60, velocity=100, time=0))
            # 음은 슬롯의 절반만 울리고 나머지는 꼬리 — 센드와 서스테인은 거기서만 보인다.
            tr.append(mido.Message("note_off", channel=0, note=60, velocity=0, time=step // 2))
            if i < len(slots) - 1:
                tr.append(mido.Message("control_change", channel=0, control=123, value=0,
                                       time=step - step // 2))
        mf.save(mid_path)
        # 렌더와 **같은 줄**로 잰다 — 설정이 다르면 "이 폰트가 답하는 CC" 가 우리가
        # 실제로 내보내는 소리에 대한 답이 아니게 된다.
        r = subprocess.run(fluidsynth_argv(binp, font, mid_path, wav_path, cfg_path),
                           capture_output=True, timeout=300)
        if r.returncode != 0 or not os.path.isfile(wav_path):
            tail = (r.stderr or b"")[-200:].decode("utf-8", "replace").strip()
            return None, f"fluidsynth exit {r.returncode}: {tail}"
        import soundfile as sf
        data, sr = sf.read(wav_path, dtype="float32", always_2d=True)
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        per = int(sr * (note_beats * 60.0 / 120.0))
        out = []
        for i, (cc, kind, what) in enumerate(CC_PROBES):
            segs = []
            for j in (2 * i, 2 * i + 1):
                a, b = j * per, min((j + 1) * per, len(data))
                segs.append(data[a:b, :2] if b > a else np.zeros((2, 2), dtype="float32"))
            lo, hi = (_probe_metric(kind, sg) for sg in segs)
            # 문턱은 지표마다 다르다 — balance 는 −1~1, 나머지는 비율이라 상대차로 본다.
            if kind == "balance":
                responds = abs(hi - lo) > 0.08
            else:
                responds = abs(hi - lo) / max(1e-9, abs(lo), abs(hi)) > 0.08
            out.append({"cc": cc, "what": what, "metric": kind,
                        "low": round(lo, 5), "high": round(hi, 5), "responds": bool(responds)})
        return out, None
    except subprocess.TimeoutExpired:
        return None, "fluidsynth timed out"
    finally:
        for pth in (mid_path, wav_path, cfg_path):
            try:
                os.remove(pth)
            except OSError:
                pass


def action_font(inp):
    """설치된 폰트가 **선언한 것 전부**. 우리 표가 아니라 폰트에게 물어서 나오는 답이다.

    인자 없이 = 요약(이름·뱅크·프리셋 수·이 폰트가 선언한 컨트롤러·규격 기본 모듈레이터).
    `instrument` 또는 `program`(+`bank`) = 그 프리셋 하나의 전부 — 키 범위·벨로시티 범위·존 수·
    감쇠·팬·루프 여부·답하는 CC·선언된 제너레이터."""
    _bin, font, why = sf2_backend()
    if why:
        return {"success": False, "error": f"사운드폰트를 못 씁니다 — {why}"}
    inv = font_inventory(font)
    if not inv:
        return {"success": False, "error": f"폰트를 못 읽었습니다: {font}"}
    load_font_aliases(font)
    if inp.get("probe"):
        # ⭐ 표를 읽는 대신 **물어본다.** 규격 기본 모듈레이터는 파일에 없어서 파싱할 원본이
        # 없고, 그래서 우리 표는 손으로 옮겨 적은 사본이다(실제로 두 줄이 틀려 있었다).
        # 이 신디와 이 폰트가 답하는지는 재면 알 수 있다.
        want_p = inp.get("program")
        rows, perr = probe_controllers(int(want_p or 0), int(inp.get("bank") or 0))
        if perr:
            return {"success": False, "error": f"프로브 실패 — {perr}"}
        yes = [r for r in rows if r["responds"]]
        return {"success": True, "data": {
            "font": inv["name"], "program": int(want_p or 0), "bank": int(inp.get("bank") or 0),
            "probes": rows,
            "responds": [r["cc"] for r in yes],
            "silent": [r["cc"] for r in rows if not r["responds"]],
            "note": ("측정입니다 — 이 폰트를 이 신디로 실제 렌더해서 컨트롤러를 0 과 127 로 두고 "
                     "비교했습니다. 우리가 옮겨 적은 규격 표가 아니라 여기서 나는 소리입니다. "
                     "CC74 는 규격 기본이 아니라 폰트가 선언했을 때만 걸립니다."),
        }}
    want = str(inp.get("instrument") or "").strip()
    prog = inp.get("program")
    if want or prog is not None:
        if want:
            got = resolve_instrument(want)
            if got is None:
                return {"success": False,
                        "error": f"악기 {want!r} 를 모릅니다 — 폰트 프리셋 이름이나 GM 이름으로 "
                                 "주세요. 이름 목록은 인자 없이 이 액션을 부르면 나옵니다"}
            bank = font_bank_of(want) or int(inp.get("bank") or 0)
            prog = got[1]
        else:
            bank = int(inp.get("bank") or 0)
            prog = int(prog)
        pre = inv["presets"].get(f"{bank}:{prog}")
        if not pre:
            return {"success": False,
                    "error": f"이 폰트에 뱅크 {bank} 프로그램 {prog} 이 없습니다 — 있는 뱅크: "
                             + ", ".join(str(b) for b in inv["banks"])}
        return {"success": True, "data": {"font": inv["name"], "preset": pre,
                                          "defaultModulators": [
                                              {"from": a, "to": b, "where": w, "what": c}
                                              for a, b, w, c in SF2_DEFAULT_MODULATORS]}}
    by_bank = {}
    for p in inv["presets"].values():
        by_bank.setdefault(str(p["bank"]), 0)
        by_bank[str(p["bank"])] += 1
    return {"success": True, "data": {
        "font": inv["name"],
        "info": inv["info"],
        "path": font,
        "banks": inv["banks"],
        "presetsByBank": by_bank,
        "presets": len(inv["presets"]),
        "samples": inv["samples"],
        "melodic": len(inv["programs"]),
        "kits": sorted(inv["kits"]),
        # 이 폰트가 **파일에 적어 둔** 것. 아래 기본값은 파일에 없지만 모든 SF2 가 갖는다.
        "declaredModulators": [{"from": a, "to": b} for a, b in inv["modulators"]],
        "defaultModulators": [{"from": a, "to": b, "where": w, "what": c}
                              for a, b, w, c in SF2_DEFAULT_MODULATORS],
        "note": ("이 폰트가 답하는 연주법은 declaredModulators 와 defaultModulators 의 합집합"
                 "입니다 — 기본 모듈레이터는 파일에 안 적혀 있어도 규격상 항상 걸립니다. "
                 "instrument 나 program 을 주면 그 프리셋 하나의 음역·벨로시티층·CC 를 봅니다."),
    }}


def action_verify(inp):
    """원본 파일과 **우리가 신디에 주는 .mid** 를 대조한다 — 그대로 연주되고 있나.

    소리를 재는 게 아니다. 음 하나하나가 같은 자리에 같은 길이로 같은 악기로 갔는지, 그리고
    파일이 보낸 컨트롤러가 그대로 나갔는지를 센다. 이게 없으면 무엇을 만질 때마다 정확도가
    안 깨졌다는 것을 매번 귀로만 확인해야 한다."""
    media_path, err = resolve_score_media(inp)
    if err:
        return {"success": False, "error": err}
    if not media_path:
        return {"success": False,
                "error": "점검할 악보가 없습니다 — scoreMediaPath(URL·경로·보관함 별칭)를 주거나 "
                         "설정의 악보 보관함에 올려 주세요. 보관함 목록은 scores 액션입니다"}
    kind = score_media_kind(media_path)
    if kind != "midi":
        return {"success": False,
                "error": f"verify 는 .mid 파일만 대조합니다 (받은 것: {kind or '알 수 없음'}). "
                         "MusicXML 은 원본에 시간축이 없어 음표 대조의 기준이 없습니다 — "
                         "render 응답의 notationNote 가 무엇을 못 읽었는지 말합니다"}
    try:
        src, src_bpm, src_ccs = _raw_midi_notes(media_path)
    except Exception as e:  # noqa: BLE001 — 깨진 업로드는 자기 이름을 대야지 크래시가 아니다
        return {"success": False, "error": f"원본 MIDI 를 못 읽었습니다: {e}"}
    rows, bpm, meta, rerr = midi_to_parts(media_path)
    if rerr:
        return {"success": False, "error": rerr}
    fdoc = meta.pop("_file", None) or {}     # 파일 전체의 것 — 파트 순회에서 빼 둔다
    os.makedirs("data/sing", exist_ok=True)
    tmp = f"data/sing/verify-{os.getpid()}.mid"
    try:
        ok, note = write_midi(
            rows, bpm, tmp,
            filecc7={p: m["cc7"] for p, m in meta.items() if m.get("cc7") is not None},
            ctl={p: {"cc": m.get("cc") or {}, "bend": m.get("bend") or [],
                     "press": m.get("press") or [], "poly": m.get("poly") or []}
                 for p, m in meta.items()},
            sysex=fdoc.get("sysex") or [])
        if not ok:
            return {"success": False, "error": note or "mido 없음 — .mid 를 쓸 수 없습니다"}
        got, got_ccs = _emitted_notes(tmp)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    def bag(rows_):
        out = {}
        for r in rows_:
            out[r] = out.get(r, 0) + 1
        return out

    a, b = bag(src), bag(got)
    missing = [k for k, n in a.items() if b.get(k, 0) < n]
    added = [k for k, n in b.items() if a.get(k, 0) < n]
    # 음 자체는 갔는데 길이·세기·악기만 다른 것은 따로 센다 — "사라졌다"와 다른 병이다.
    by_place = {}
    for pit, at, dur, vel, pg, dr in src:
        by_place.setdefault((pit, at, dr), []).append((dur, vel, pg))
    # 같은 음 둘이 겹치면 **어느 note-off 가 어느 것을 닫는지 MIDI 가 정하지 않는다.** 우리도
    # 원본도 먼저 켠 것부터 닫지만(FIFO), 출력의 note-off 순서가 원본과 다르면 길이가 서로
    # 바뀐 채로 나온다 — 울리는 총 시간도 세기도 같고, 드럼은 원샷이라 들리지도 않는다.
    # 실측 2026-08-21 Take Five: 5,435음 중 넷이 그것이었다. 결함이 아니라 규격의 모호성이라
    # `changed` 와 갈라 놓는다 — 안 그러면 음악적으로 같은 파일이 영원히 빨강이다.
    # 판정은 **음고별로 시작·끝·세기 집합**을 본다. 짝이 바뀐 것뿐이면 세 집합이 그대로다 —
    # 시작 시각으로만 묶으면 끝이 서로 바뀐 쌍(시작이 다른 쌍)을 놓친다(실측 Take Five: 넷 중
    # 둘만 잡혔다).
    def _shape(rows_):
        out = {}
        for pit, at, dur, vel, _pg, dr in rows_:
            k = (pit, dr)
            e = out.setdefault(k, {"on": [], "off": [], "vel": []})
            e["on"].append(at)
            e["off"].append(_tick(at + dur))
            e["vel"].append(vel)
        for e in out.values():
            for v in e.values():
                v.sort()
        return out

    s_shape, g_shape = _shape(src), _shape(got)
    changed, ambiguous = [], []
    for pit, at, dur, vel, pg, dr in added:
        was = by_place.get((pit, at, dr))
        swapped = s_shape.get((pit, dr)) == g_shape.get((pit, dr))
        if swapped:
            ambiguous.append({"pitch": pit, "at": at})
        elif was:
            changed.append({"pitch": pit, "at": at,
                            "was": {"dur": was[0][0], "vel": was[0][1], "program": was[0][2]},
                            "now": {"dur": dur, "vel": vel, "program": pg}})
    _amb_pitch = {(c["pitch"],) for c in ambiguous}
    lost = [{"pitch": p, "at": t, "dur": d, "vel": v, "program": g, "drum": dr}
            for p, t, d, v, g, dr in missing
            # 짝이 바뀐 음고는 사라진 게 아니다 — 시작·끝·세기 집합이 그대로임을 위에서 봤다.
            if s_shape.get((p, dr)) != g_shape.get((p, dr))
            and ((p, t, dr) not in by_place
                 or not any(c["pitch"] == p and c["at"] == t for c in changed))]
    src_cc = sorted({c for _ch, c in src_ccs})
    got_cc = sorted({c for _ch, c in got_ccs})
    exact = not lost and not changed and len(src) == len(got) and src_cc == got_cc
    data = {
        "file": os.path.basename(media_path),
        "exact": exact,
        "notes": {"source": len(src), "played": len(got)},
        "drums": {"source": sum(1 for r in src if r[5]),
                  "played": sum(1 for r in got if r[5])},
        "programs": {"source": sorted({r[4] for r in src if not r[5]}),
                     "played": sorted({r[4] for r in got if not r[5]})},
        "bpm": {"source": src_bpm, "played": bpm},
        "controllers": {"source": src_cc, "played": got_cc,
                        "dropped": [c for c in src_cc if c not in got_cc],
                        "added": [c for c in got_cc if c not in src_cc]},
        "lost": lost[:40],
        "lostCount": len(lost),
        "changed": changed[:40],
        "changedCount": len(changed),
        # 규격이 답을 안 정한 자리 — 결함이 아니다. 세면서 따로 둔다.
        "ambiguousCount": len(ambiguous),
        "ambiguous": ambiguous[:10],
    }
    if exact:
        data["note"] = ("음표·길이·세기·악기·컨트롤러가 원본과 같습니다 — 파일 그대로 "
                        "연주되고 소리는 폰트가 정합니다.")
        if ambiguous:
            data["note"] += (f" (겹친 같은 음 {len(ambiguous)}쌍은 어느 note-off 가 어느 것을 "
                             "닫는지 MIDI 가 정하지 않는 자리라 짝이 바뀔 수 있습니다 — 울리는 "
                             "시간도 세기도 같습니다.)")
    else:
        why = []
        if data["notes"]["source"] != data["notes"]["played"]:
            why.append(f"음 수 {data['notes']['source']} → {data['notes']['played']}")
        if lost:
            why.append(f"사라진 음 {len(lost)}")
        if changed:
            why.append(f"달라진 음 {len(changed)}")
        if data["controllers"]["dropped"]:
            why.append("안 나간 컨트롤러 CC" + ", CC".join(
                str(c) for c in data["controllers"]["dropped"]))
        if data["controllers"]["added"]:
            why.append("우리가 더한 컨트롤러 CC" + ", CC".join(
                str(c) for c in data["controllers"]["added"]))
        data["note"] = "원본과 다릅니다 — " + " · ".join(why)
    return {"success": True, "data": data}


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
    elif action == "levels":
        out = action_levels(inp)
    elif action == "verify":
        out = action_verify(inp)
    elif action == "font":
        out = action_font(inp)
    else:
        out = {"success": False,
               "error": f"unknown action {action!r} — one of: render, preview, scores, lyrics, "
                        "levels, verify, font, selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts,
    # and the envelope is UTF-8 by contract on both ends.
    sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False)).encode("utf-8"))


if __name__ == "__main__":
    main()
