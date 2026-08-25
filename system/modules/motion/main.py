# -*- coding: utf-8 -*-
"""motion — 2D motion-graphics video renderer.

A declarative scene (JSON) goes in; an mp4, still PNGs, or a transparent sticker
comes out through `_mediaImport`. Every drawable is a named asset (the `assets`
action is the authoritative grammar); the renderer is a deterministic frame loop
`draw(t)` piped into a bundled ffmpeg — no realtime capture, no dropped frames,
same input → same file. Audio (bgm + voice) is mixed with ducking and the voice
envelope can drive a sprite's mouth (lipsync).

Design notes carried from the 2026-08-25 prototype sessions:
- The background gradient MUST be broadcast to full width before it becomes the
  canvas — a (H,1,3) array silently clips every crisp draw to one column (the
  bug shipped once; `_frame_geometry_ok` pins it).
- Stickers exclude the additive glow layer: on a transparent ground the addition
  becomes a dark ring around the flame.
- Width/height are kept multiples of 8 and passed with macro_block_size=8 so the
  encoder never silently resizes (1080 is not a multiple of 16).
"""
import json
import math
import os
import random
import sys
import hashlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── limits ───────────────────────────────────────────────────────────────────
SIZES = {"1080x1920": (1080, 1920), "1920x1080": (1920, 1080), "1080x1080": (1080, 1080)}
DUR_MAX = 20.0
FPS_MIN, FPS_MAX = 10, 30
LAYERS_MAX = 40
TEXT_MAX = 200
STICKER_MIN, STICKER_MAX = 200, 2048
OUT_DIR = os.path.join("data", "motion")

# ── palette ──────────────────────────────────────────────────────────────────
INK, DIM = (236, 240, 248), (148, 163, 184)
CYAN, BLUE, AMBER = (34, 211, 238), (59, 130, 246), (255, 190, 70)
CHAR_PALETTE = {
    "body": (255, 138, 42), "bodyDark": (196, 90, 18), "outline": (92, 42, 12),
    "belly": (255, 208, 128), "wing": (150, 74, 30),
    "flame1": (255, 106, 26), "flame2": (255, 170, 40), "flame3": (255, 226, 110),
}
NAMED = {"ink": INK, "dim": DIM, "cyan": CYAN, "blue": BLUE, "amber": AMBER}

# ── easing ───────────────────────────────────────────────────────────────────
def clamp01(x):
    return max(0.0, min(1.0, x))

def eo3(x):
    x = clamp01(x)
    return 1 - (1 - x) ** 3

def eob(x):  # easeOutBack — the springy overshoot
    x = clamp01(x)
    c1 = 1.70158
    return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2

def win(t, a, b, fi=0.4, fo=0.4):
    """Visibility alpha inside [a,b] with eased fade-in/out."""
    if t < a or t > b:
        return 0.0
    return min(eo3((t - a) / fi) if fi else 1.0, eo3((b - t) / fo) if fo else 1.0, 1.0)

# ── fonts ────────────────────────────────────────────────────────────────────
_FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
     "/usr/share/fonts/truetype/nanum/NanumGothic.ttf", True),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", True),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
     "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", True),
    (r"C:\Windows\Fonts\malgunbd.ttf", r"C:\Windows\Fonts\malgun.ttf", True),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
     "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", False),
]

def resolve_fonts():
    """(bold_path, regular_path, korean_capable). Settings first, then the scan."""
    override = (os.environ.get("MODULE_FONTPATH") or "").strip()
    if override:
        if os.path.isfile(override):
            return override, override, True  # the operator's pick is trusted for Korean
        raise ValueError(
            f"settings fontPath points at a missing file: {override!r} — fix the path "
            "in the module settings or clear it to use the system scan")
    for bold, reg, ko in _FONT_CANDIDATES:
        if os.path.isfile(bold):
            return bold, (reg if os.path.isfile(reg) else bold), ko
    raise ValueError(
        "no usable font found — install one (Debian/Ubuntu: `apt install fonts-nanum`) "
        "or set the module's fontPath setting to a TTF")

def has_hangul(s):
    return any("\uac00" <= ch <= "\ud7a3" or "\u3131" <= ch <= "\u318e" for ch in str(s))

class Fonts:
    """Sized on demand against the supersampled canvas."""
    def __init__(self, ss):
        self.bold, self.regular, self.korean = resolve_fonts()
        self.ss = ss
        self._cache = {}

    def get(self, size, bold=True):
        key = (size, bold)
        if key not in self._cache:
            self._cache[key] = ImageFont.truetype(
                self.bold if bold else self.regular, int(size * self.ss))
        return self._cache[key]

# ── the character ────────────────────────────────────────────────────────────
def _capsule(d, p0, p1, w, fill):
    d.line([p0, p1], fill=fill, width=int(w))
    r = w / 2
    for p in (p0, p1):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)

def draw_firebat(d, g, cx, cy, s, t, pal=None, mouth=0.0, wave=0.0, walk=0.0,
                 sy=1.0, look=(0.0, 0.0), blink_t=None, glow=True):
    """cy = sole of the feet. s = pixels per unit. sy = vertical squash
    (width is volume-compensated). All shapes, no bitmaps."""
    P = dict(CHAR_PALETTE)
    if pal:
        P.update({k: tuple(v) for k, v in pal.items() if k in P})
    BODY, BODY_DK, OUTL = P["body"], P["bodyDark"], P["outline"]
    sx = 1.0 / math.sqrt(max(0.3, sy))
    bw, bh = 150 * s * sx, 140 * s * sy
    bcy = cy - bh - walk * 10 * s * abs(math.sin(t * 11))
    wf = math.sin(t * 9) * (0.5 + 0.5 * walk)
    for side in (-1, 1):  # wings, behind
        wx, wy = cx + side * bw * 0.92, bcy - bh * 0.15
        tip = (wx + side * 56 * s, wy - 34 * s - wf * 22 * s)
        d.polygon([(wx, wy - 26 * s), tip, (wx + side * 40 * s, wy + 20 * s),
                   (wx, wy + 12 * s)], fill=P["wing"], outline=OUTL, width=int(4 * s))
    step = math.sin(t * 11) * walk
    for side, ph in ((-1, step), (1, -step)):  # feet
        fx = cx + side * bw * 0.42 + ph * 14 * s
        fy = cy - max(0.0, ph * side) * 10 * s
        d.ellipse([fx - 26 * s, fy - 18 * s, fx + 26 * s, fy + 10 * s],
                  fill=BODY_DK, outline=OUTL, width=int(4 * s))
    d.ellipse([cx - bw, bcy - bh, cx + bw, bcy + bh],  # body
              fill=BODY, outline=OUTL, width=int(6 * s))
    d.ellipse([cx - bw * 0.62, bcy - bh * 0.05, cx + bw * 0.62, bcy + bh * 0.88],
              fill=P["belly"])
    fl = math.sin(t * 13) * 6 * s + math.sin(t * 23 + 1) * 3 * s  # flame tuft
    fx0, fy0 = cx + fl * 0.4, bcy - bh
    for rr, key, dy in ((44, "flame1", 0), (30, "flame2", 26), (16, "flame3", 46)):
        r = rr * s
        yy = fy0 - dy * s - r * 0.6
        xx = fx0 + fl * (dy / 46)
        d.ellipse([xx - r, yy - r * 1.35, xx + r, yy + r * 0.85], fill=P[key])
        if glow and g is not None:
            g.ellipse([xx - r * 1.5, yy - r * 1.8, xx + r * 1.5, yy + r * 1.3],
                      fill=(*P["flame2"], 90))
    for side in (-1, 1):  # arms — outline underlay so they read against the body
        shx, shy = cx + side * bw * 0.82, bcy + bh * 0.05
        ang = math.pi / 2.2
        if side == 1 and wave:
            ang = -0.9 + 0.5 * math.sin(t * 9)
        hand = (shx + side * 66 * s * math.cos(ang) * (1 if side == 1 else 0.6),
                shy + 66 * s * math.sin(ang))
        _capsule(d, (shx, shy), hand, 35 * s, OUTL)
        _capsule(d, (shx, shy), hand, 26 * s, BODY)
    eh = 1.0
    if blink_t is not None:
        eh = 1 - 0.92 * math.sin(math.pi * clamp01(blink_t))
    for side in (-1, 1):  # eyes
        ex, ey = cx + side * bw * 0.34, bcy - bh * 0.28
        ew, ehh = 30 * s, 40 * s * eh
        d.ellipse([ex - ew, ey - ehh, ex + ew, ey + ehh], fill=(252, 252, 255),
                  outline=OUTL, width=int(3 * s))
        if eh > 0.35:
            px = ex + look[0] * 10 * s
            py = ey + look[1] * 12 * s
            pr = 12 * s * min(1.0, eh)
            d.ellipse([px - pr, py - pr, px + pr, py + pr], fill=(30, 20, 14))
            d.ellipse([px - pr * .35 + pr * .3, py - pr * .75,
                       px + pr * .35 + pr * .3, py - pr * .15], fill=(255, 255, 255))
    for side in (-1, 1):  # cheeks
        bx, by = cx + side * bw * 0.62, bcy - bh * 0.02
        d.ellipse([bx - 16 * s, by - 10 * s, bx + 16 * s, by + 10 * s],
                  fill=(255, 96, 64, 110))
    mx, my = cx, bcy + bh * 0.24  # mouth
    mo = 8 * s + clamp01(mouth) * 30 * s
    if mouth > 0.08:
        d.ellipse([mx - 24 * s, my - mo * 0.5, mx + 24 * s, my + mo],
                  fill=(94, 34, 20), outline=OUTL, width=int(3 * s))
        d.ellipse([mx - 14 * s, my + mo * 0.35, mx + 14 * s, my + mo],
                  fill=(255, 120, 120))
    else:
        d.arc([mx - 22 * s, my - 14 * s, mx + 22 * s, my + 16 * s],
              20, 160, fill=OUTL, width=int(5 * s))

def blink_phase(t, offs=0.0, period=2.6, dur=0.14):
    ph = (t + offs) % period
    return ph / dur if ph < dur else None

def jump_arc(t, t0):
    """(height_px_factor, squash) for a jump triggered at t0 — crouch, air
    stretch, landing squash. Height is in units of the canvas height."""
    p = (t - t0) / 0.62
    if 0 <= p <= 1:
        return 0.125 * 4 * p * (1 - p), 1.0 + 0.18 * math.sin(math.pi * p)
    lp = (t - t0 - 0.62) / 0.14
    if 0 <= lp <= 1:
        return 0.0, 1 - 0.28 * math.sin(math.pi * lp)
    pp = (t - t0 + 0.12) / 0.12
    if 0 <= pp <= 1:
        return 0.0, 1 - 0.22 * math.sin(math.pi * pp)
    return 0.0, 1.0

def draw_heart(d, x, y, r, col, a=255):
    d.ellipse([x - r, y - r, x + r * 0.04, y + r * 0.04], fill=(*col, a))
    d.ellipse([x - r * 0.04, y - r, x + r, y + r * 0.04], fill=(*col, a))
    d.polygon([(x - r * 0.92, y - r * 0.10), (x + r * 0.92, y - r * 0.10),
               (x, y + r * 1.05)], fill=(*col, a))

# ── scene ────────────────────────────────────────────────────────────────────
class SceneError(ValueError):
    pass

def _num(v, name, lo, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise SceneError(f"{name} must be a number, got {v!r}")
    if not (lo <= f <= hi):
        raise SceneError(f"{name} must be within [{lo}, {hi}], got {f}")
    return f

def media_path(ref, want="file"):
    """A media-store or workspace-data reference → a local path. External URLs
    are refused on purpose: sources come from the media store (image_gen lands
    there) so the sandbox never fetches the network for scene assets."""
    r = str(ref or "").strip().split("?")[0].split("#")[0]
    if r.startswith(("http://", "https://")):
        raise SceneError(
            f"external URLs are not accepted ({ref!r}) — import the file first "
            "(image_gen and media uploads land in /user/media/...) and pass that path")
    r = os.path.normpath(r.lstrip("/")).replace("\\", "/")
    parts = r.split("/")
    if ".." in parts or not (
            r.startswith("user/media/") or r.startswith("system/media/")
            or r.startswith("data/")):
        raise SceneError(f"not a media path: {ref!r} — expected /user/media/<file>")
    if not os.path.isfile(r):
        raise SceneError(f"media file not found: {r}")
    return r

class Scene:
    """Parsed, validated, ready to draw. Deterministic: every random sequence is
    seeded from the layer's own declaration."""

    def __init__(self, inp):
        size = str(inp.get("size") or "1080x1920")
        if size not in SIZES:
            raise SceneError(f"size must be one of {sorted(SIZES)}, got {size!r}")
        self.W, self.H = SIZES[size]
        self.fps = int(_num(inp.get("fps", 30), "fps", FPS_MIN, FPS_MAX))
        self.dur = _num(inp.get("duration"), "duration", 0.5, DUR_MAX)
        self.ss = 1.0 if str(inp.get("quality") or "final") == "draft" else 1.5
        self.SW, self.SH = int(self.W * self.ss), int(self.H * self.ss)
        try:
            self.fonts = Fonts(self.ss)
        except ValueError as e:
            raise SceneError(str(e))
        layers = inp.get("layers") or []
        if not isinstance(layers, list) or len(layers) > LAYERS_MAX:
            raise SceneError(f"layers must be a list of at most {LAYERS_MAX}")
        self.layers = []
        texts = []
        for i, L in enumerate(layers):
            if not isinstance(L, dict) or "kind" not in L:
                raise SceneError(f"layers[{i}] needs a 'kind'")
            kind = L["kind"]
            if kind not in ("sprite", "bubble", "title", "caption", "card", "list",
                            "image", "fireworks", "hearts", "confetti"):
                raise SceneError(
                    f"layers[{i}].kind {kind!r} is unknown — the assets action lists "
                    "every kind and its fields")
            L = dict(L)
            L["from"] = _num(L.get("from", 0), f"layers[{i}].from", 0, self.dur)
            L["to"] = _num(L.get("to", self.dur), f"layers[{i}].to", 0, self.dur)
            if L["to"] <= L["from"]:
                raise SceneError(f"layers[{i}]: to must be after from")
            for key in ("text",):
                if key in L and len(str(L[key])) > TEXT_MAX:
                    raise SceneError(f"layers[{i}].{key} exceeds {TEXT_MAX} chars")
            texts += self._texts_of(L)
            if kind == "image":
                L["_path"] = media_path(L.get("media"))
            if kind == "fireworks":
                L["_launches"] = self._launches(i, L)
            self.layers.append(L)
        bg = inp.get("background") or {"kind": "night"}
        if not isinstance(bg, dict) or bg.get("kind") not in ("night", "gradient", "image"):
            raise SceneError("background.kind must be night | gradient | image")
        self.bg_decl = bg
        if bg["kind"] == "image":
            bg["_path"] = media_path(bg.get("media"))
        audio = inp.get("audio") or {}
        self.bgm = media_path(audio["bgm"]) if audio.get("bgm") else None
        self.voice = media_path(audio["voice"]) if audio.get("voice") else None
        self.bgm_gain_db = _num(audio.get("bgmGainDb", -8), "audio.bgmGainDb", -40, 6)
        self.voice_env = None  # filled by prepare_audio
        korean = any(has_hangul(s) for s in texts)
        if korean and not self.fonts.korean:
            raise SceneError(
                "the scene contains Korean text but no Korean-capable font was found — "
                "install one (Debian/Ubuntu: `apt install fonts-nanum`) or set the "
                "module's fontPath setting")
        self._bg_cache = None

    @staticmethod
    def _texts_of(L):
        out = [str(L.get("text") or "")]
        for row in L.get("lines") or []:
            out.append(str((row or {}).get("text") or ""))
        for row in L.get("rows") or []:
            row = row or {}
            out += [str(row.get(k) or "") for k in ("label", "value", "lead", "text", "tag")]
        return out

    def _launches(self, idx, L):
        density = _num(L.get("density", 1.0), f"layers[{idx}].density", 0.2, 3.0)
        rng = random.Random(f"fw:{idx}:{L['from']}:{L['to']}:{density}")
        hues = [(255, 214, 90), (255, 120, 170), (90, 220, 255), (255, 250, 235),
                (150, 255, 150)]
        out, tt, i = [], L["from"] + 0.2, 0
        while tt < L["to"] - 1.0:
            out.append((tt, 0.15 + 0.70 * rng.random(), 0.10 + 0.18 * rng.random(),
                        hues[i % len(hues)], [rng.uniform(0, 6.28) for _ in range(34)]))
            tt += rng.uniform(0.8, 1.4) / density
            i += 1
        return out

    # ── background (built once) ─────────────────────────────────────────
    def background(self):
        if self._bg_cache is not None:
            return self._bg_cache
        SW, SH, ss = self.SW, self.SH, self.ss
        kind = self.bg_decl["kind"]
        if kind == "image":
            photo = Image.open(self.bg_decl["_path"]).convert("RGB")
            pw = max(SW, round(photo.width * SH / photo.height))
            photo = photo.resize((pw, max(SH, round(photo.height * pw / photo.width))),
                                 Image.LANCZOS)
            x0 = (photo.width - SW) // 2
            y0 = (photo.height - SH) // 2
            arr = np.asarray(photo.crop((x0, y0, x0 + SW, y0 + SH))).copy()
        else:
            top = tuple(self.bg_decl.get("top", (9, 13, 30)))
            bot = tuple(self.bg_decl.get("bottom", (24, 32, 58)))
            gy = np.linspace(0, 1, SH)[:, None, None]
            base = np.array(top)[None, None, :] * (1 - gy) + np.array(bot)[None, None, :] * gy
            # (SH,1,3) → full width. Skipping this once clipped every crisp draw
            # to a single column; the geometry assertion below pins it forever.
            arr = np.ascontiguousarray(
                np.broadcast_to(base, (SH, SW, 3))).clip(0, 255).astype(np.uint8)
            if kind == "night":
                img = Image.fromarray(arr)
                bd = ImageDraw.Draw(img, "RGBA")
                mx, my, mr = SW * 0.76, SH * 0.16, 90 * ss * (SH / 2880)
                mr = max(mr, 40 * ss)
                for hr, ha in ((2.6, 14), (1.9, 22), (1.35, 40)):
                    bd.ellipse([mx - mr * hr, my - mr * hr, mx + mr * hr, my + mr * hr],
                               fill=(210, 222, 248, ha))
                bd.ellipse([mx - mr, my - mr, mx + mr, my + mr], fill=(226, 234, 252))
                gy0 = SH * 0.80
                bd.ellipse([-SW * 0.55, gy0 - 60 * ss, SW * 0.75, SH * 1.4],
                           fill=(24, 33, 56))
                bd.ellipse([-SW * 0.35, gy0, SW * 1.35, SH * 1.5], fill=(30, 41, 66))
                rng = random.Random(11)
                for _ in range(90):
                    x, y = rng.random() * SW, rng.random() * 0.72 * SH
                    r = rng.uniform(1.0, 2.6) * ss
                    a = int(rng.uniform(60, 160))
                    bd.ellipse([x - r, y - r, x + r, y + r], fill=(170, 200, 255, a))
                arr = np.asarray(img).copy()
        if arr.shape != (SH, SW, 3):
            raise SceneError(f"background geometry drifted: {arr.shape} != {(SH, SW, 3)}")
        self._bg_cache = arr
        return arr

    # ── per-layer drawing ───────────────────────────────────────────────
    def _shadow_text(self, d, xy, txt, f, fill, a, off=3):
        d.text((xy[0] + off * self.ss, xy[1] + off * self.ss), txt, font=f,
               fill=(0, 0, 0, int(150 * a)))
        d.text(xy, txt, font=f, fill=(*fill, int(255 * a)))

    def _color(self, v, default):
        if isinstance(v, str):
            return NAMED.get(v, default)
        if isinstance(v, (list, tuple)) and len(v) == 3:
            return tuple(int(c) for c in v)
        return default

    def draw_frame(self, t):
        SW, SH, ss = self.SW, self.SH, self.ss
        img = Image.fromarray(self.background().copy())
        self._frame_img = img  # image layers paste onto this
        glow = Image.new("RGB", (SW, SH), (0, 0, 0))
        d = ImageDraw.Draw(img, "RGBA")
        g = ImageDraw.Draw(glow, "RGBA")
        for L in self.layers:
            a = win(t, L["from"], L["to"], float(L.get("fadeIn", 0.4)),
                    float(L.get("fadeOut", 0.4)))
            if a <= 0:
                continue
            getattr(self, "_draw_" + L["kind"])(d, g, t, a, L)
        if img.size != (SW, SH) or glow.size != (SW, SH):
            raise SceneError("frame geometry drifted mid-render")
        out = np.asarray(img).astype(np.uint16) + \
            np.asarray(glow.filter(ImageFilter.GaussianBlur(6 * ss))).astype(np.uint16)
        frame = Image.fromarray(out.clip(0, 255).astype(np.uint8))
        if self.ss != 1.0:
            frame = frame.resize((self.W, self.H), Image.LANCZOS)
        fade = min(clamp01(t / 0.5), clamp01((self.dur - 0.1 - t) / 0.55))
        if fade < 1:
            frame = Image.fromarray((np.asarray(frame) * fade).astype(np.uint8))
        arr = np.asarray(frame)
        if arr.shape != (self.H, self.W, 3):
            raise SceneError(f"frame shape drifted: {arr.shape}")
        return arr

    def _at(self, L, default):
        at = L.get("at") or default
        return at[0] * self.SW, at[1] * self.SH

    def _draw_sprite(self, d, g, t, a, L):
        if str(L.get("name", "firebat")) != "firebat":
            raise SceneError(f"unknown sprite {L.get('name')!r} — assets lists the sprites")
        SW, SH, ss = self.SW, self.SH, self.ss
        x, y = self._at(L, [0.5, 0.9])
        s = ss * 1.2 * float(L.get("scale", 1.0))
        enter = str(L.get("enter", "walk"))
        durs = {"walk": 2.0, "peek": 1.2, "pop": 0.5, "none": 0.0}
        if enter not in durs:
            raise SceneError(f"sprite.enter must be one of {sorted(durs)}")
        ed = durs[enter]
        p = eo3((t - L["from"]) / ed) if ed else 1.0
        walk, scale_mul = 0.0, 1.0
        if enter == "walk":
            side = str(L.get("enterFrom", "left"))
            sx0 = 1.18 * SW if side == "right" else -0.18 * SW
            x = sx0 + (x - sx0) * p
            walk = 1.0 if p < 0.985 else 0.0
        elif enter == "peek":
            y = y + 0.30 * SH * (1 - p)
        elif enter == "pop":
            scale_mul = max(0.05, eob(p))
            s *= scale_mul
        mouth, wave, sy = 0.0, 0.0, 1.0
        jump_h = 0.0
        for act in L.get("acts") or []:
            kind = str(act.get("do") or "")
            at = float(act.get("at", L["from"]))
            dur = float(act.get("for", 2.0))
            if kind == "wave":
                wave = max(wave, win(t, at, at + dur, 0.2, 0.3))
            elif kind == "talk":
                tw = win(t, at, at + dur, 0.2, 0.3)
                if L.get("lipsync") and self.voice_env is not None:
                    mouth = max(mouth, tw * self.voice_env(t))
                else:
                    mouth = max(mouth, tw * max(0.0, math.sin(t * 14))
                                * (0.6 + 0.4 * math.sin(t * 3.3)))
            elif kind == "jump":
                h, sq = jump_arc(t, at)
                jump_h += h * self.SH
                sy *= sq
            else:
                raise SceneError(f"sprite act {kind!r} — one of wave, talk, jump")
        draw_firebat(d, g, x, y - jump_h, s, t, pal=L.get("palette"), mouth=mouth,
                     wave=wave, walk=walk, sy=sy,
                     look=tuple(L.get("look") or (0, 0)), blink_t=blink_phase(t))

    def _draw_bubble(self, d, g, t, a, L):
        ss = self.ss
        full = str(L.get("text") or "")
        if not full:
            return
        f = self.fonts.get(46)
        typing = L.get("typing", True)
        n = max(0, int(len(full) * eo3((t - L["from"] - 0.2) / 1.1))) if typing else len(full)
        txt = full[:n]
        if not txt:
            return
        cx, cy = self._at(L, [0.5, 0.55])
        tw = d.textlength(full, font=f)
        pad = 36 * ss
        hx = tw / 2 + (40 * ss if L.get("heart") else 0)
        x0, y0 = cx - hx - pad, cy - 60 * ss
        x1, y1 = cx + hx + pad, cy + 60 * ss
        d.rounded_rectangle([x0, y0, x1, y1], radius=44 * ss, fill=(*INK, int(244 * a)),
                            outline=(205, 210, 220, int(255 * a)), width=int(3 * ss))
        d.polygon([(cx - 26 * ss, y1 - 4), (cx + 18 * ss, y1 - 4),
                   (cx + 2 * ss, y1 + 44 * ss)], fill=(*INK, int(244 * a)))
        d.text((cx - hx, cy - f.size * 0.62), txt, font=f,
               fill=(24, 30, 46, int(255 * a)))
        if L.get("heart") and n == len(full):
            beat = 1 + 0.10 * math.sin(t * 7)
            draw_heart(d, cx + hx - 20 * ss, cy - 2 * ss, 24 * ss * beat,
                       (235, 60, 90), int(255 * a))

    def _draw_title(self, d, g, t, a, L):
        ss = self.ss
        cx, y = self._at(L, [0.5, 0.09])
        rise = 26 * ss * (1 - eo3((t - L["from"]) / 0.9))
        sizes = {"xl": 118, "lg": 92, "md": 52, "sm": 30}
        for row in L.get("lines") or []:
            row = row or {}
            f = self.fonts.get(sizes.get(str(row.get("size", "lg")), 92))
            col = self._color(row.get("color"), INK)
            txt = str(row.get("text") or "")
            tw = d.textlength(txt, font=f)
            self._shadow_text(d, (cx - tw / 2, y + rise), txt, f, col, a)
            y += f.size * 1.28

    def _draw_caption(self, d, g, t, a, L):
        ss = self.ss
        f = self.fonts.get(38)
        txt = str(L.get("text") or "")
        cx, y = self._at(L, [0.5, 0.855])
        tw = d.textlength(txt, font=f)
        d.rounded_rectangle([cx - tw / 2 - 26 * ss, y - 14 * ss,
                             cx + tw / 2 + 26 * ss, y + f.size + 14 * ss],
                            radius=26 * ss, fill=(8, 10, 20, int(150 * a)))
        d.text((cx - tw / 2, y), txt, font=f, fill=(*INK, int(255 * a)))

    def _draw_card(self, d, g, t, a, L):
        ss, SW = self.ss, self.SW
        rows = L.get("rows") or []
        cx, y0 = self._at(L, [0.5, 0.10])
        slide = (1 - eob(clamp01((t - L["from"]) / 0.65))) * 140 * ss
        cw = SW * float(L.get("w", 0.86))
        rh = 130 * ss
        chh = 50 * ss + rh * len(rows)
        x0 = cx - cw / 2 + slide
        accent = self._color(L.get("accent"), AMBER)
        d.rounded_rectangle([x0, y0, x0 + cw, y0 + chh], radius=36 * ss,
                            fill=(9, 12, 24, int(196 * a)),
                            outline=(*accent, int(160 * a)), width=int(2.5 * ss))
        fl, fv = self.fonts.get(30), self.fonts.get(42)
        for k, row in enumerate(rows):
            row = row or {}
            yy = y0 + 40 * ss + k * rh
            lbl = str(row.get("label") or "")
            lw = d.textlength(lbl, font=fl) + 44 * ss
            d.rounded_rectangle([x0 + 44 * ss, yy, x0 + 44 * ss + lw, yy + 60 * ss],
                                radius=16 * ss, fill=(*CYAN, int(50 * a)),
                                outline=(*CYAN, int(200 * a)), width=int(2 * ss))
            d.text((x0 + 66 * ss, yy + 10 * ss), lbl, font=fl, fill=(*CYAN, int(255 * a)))
            d.text((x0 + 80 * ss + lw, yy + 3 * ss), str(row.get("value") or ""),
                   font=fv, fill=(*INK, int(255 * a)))

    def _draw_list(self, d, g, t, a, L):
        ss, SW = self.ss, self.SW
        cx, y_base = self._at(L, [0.5, 0.30])
        cw = SW * float(L.get("w", 0.86))
        ft, fm, fg = self.fonts.get(40), self.fonts.get(52), self.fonts.get(28)
        for k, row in enumerate(L.get("rows") or []):
            row = row or {}
            t0r = L["from"] + k * 0.38
            ar = win(t, t0r, L["to"], 0.45, 0.45)
            if ar <= 0:
                continue
            hot = bool(row.get("highlight"))
            slide = (1 - eob(clamp01((t - t0r) / 0.6))) * SW * 0.22
            rh = 150 * ss if hot else 128 * ss
            x0 = cx - cw / 2 + slide
            y0 = y_base + k * 158 * ss
            d.rounded_rectangle(
                [x0, y0, x0 + cw, y0 + rh], radius=30 * ss,
                fill=(26, 18, 8, int(212 * ar)) if hot else (9, 12, 24, int(190 * ar)),
                outline=(*AMBER, int(230 * ar)) if hot else (90, 100, 120, int(160 * ar)),
                width=int((3 if hot else 2) * ss))
            dx0 = x0 + 46 * ss
            for j, dc in enumerate(row.get("dots") or []):
                dxx, dy = dx0 + j * 34 * ss, y0 + rh / 2
                d.ellipse([dxx - 11 * ss, dy - 11 * ss, dxx + 11 * ss, dy + 11 * ss],
                          fill=(*self._color(dc, INK), int(255 * ar)),
                          outline=(255, 255, 255, int(90 * ar)), width=int(1.5 * ss))
            d.text((x0 + 170 * ss, y0 + rh / 2 - ft.size * 0.58),
                   str(row.get("lead") or ""), font=ft,
                   fill=(200, 208, 220, int(255 * ar)))
            tx = x0 + cw * 0.44
            d.text((tx, y0 + rh / 2 - fm.size * 0.60), str(row.get("text") or ""),
                   font=fm, fill=(*(AMBER if hot else INK), int(255 * ar)))
            tag = str(row.get("tag") or "")
            if tag:
                bx0 = tx + d.textlength(str(row.get("text") or ""), font=fm) + 30 * ss
                by0 = y0 + rh / 2 - 26 * ss
                btw = d.textlength(tag, font=fg)
                d.rounded_rectangle([bx0, by0, bx0 + btw + 40 * ss, by0 + 52 * ss],
                                    radius=26 * ss, fill=(*AMBER, int(235 * ar)))
                d.text((bx0 + 20 * ss, by0 + 8 * ss), tag, font=fg,
                       fill=(40, 24, 4, int(255 * ar)))

    def _draw_image(self, d, g, t, a, L):
        SW, SH, ss = self.SW, self.SH, self.ss
        key = ("img", L["_path"])
        cache = getattr(self, "_img_cache", None)
        if cache is None:
            cache = self._img_cache = {}
        if key not in cache:
            cache[key] = Image.open(L["_path"]).convert("RGB")
        src = cache[key]
        w = SW * float(L.get("w", 0.8))
        h = w * src.height / src.width
        kb = L.get("kenburns") or {}
        p = clamp01((t - L["from"]) / (L["to"] - L["from"]))
        zoom = 1.0 + (float(kb.get("zoom", 1.0)) - 1.0) * p
        panx = float(kb.get("panx", 0.0)) * p * SW
        cx, cy = self._at(L, [0.5, 0.4])
        wz, hz = w * zoom, h * zoom
        im = src.resize((max(2, int(wz)), max(2, int(hz))), Image.LANCZOS)
        if L.get("rounded", True):
            mask = Image.new("L", im.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                [0, 0, im.size[0], im.size[1]], radius=int(30 * ss),
                fill=int(255 * a))
        else:
            mask = Image.new("L", im.size, int(255 * a))
        self._frame_img.paste(im, (int(cx - wz / 2 + panx), int(cy - hz / 2)), mask)

    def _draw_fireworks(self, d, g, t, a, L):
        SW, SH, ss = self.SW, self.SH, self.ss
        for t0, ux, uy, col, dirs in L["_launches"]:
            bx, by = ux * SW, uy * SH
            rt = (t - (t0 - 0.8)) / 0.8
            if 0 <= rt < 1:
                ry = SH * 0.82 + (by - SH * 0.82) * eo3(rt)
                g.line([bx, ry + 40 * ss, bx, ry], fill=(*col, 160), width=int(4 * ss))
                d.ellipse([bx - 4 * ss, ry - 4 * ss, bx + 4 * ss, ry + 4 * ss],
                          fill=(255, 255, 230, 230))
            bt = t - t0
            if 0 <= bt < 1.7:
                fa = (1 - bt / 1.7) * a
                R = 230 * ss * eo3(bt / 1.7 * 1.35)
                for k, ang in enumerate(dirs):
                    rr = R * (0.75 + 0.25 * math.sin(k * 2.3))
                    px = bx + rr * math.cos(ang)
                    py = by + rr * math.sin(ang) + 260 * ss * bt * bt * 0.35
                    sz = ss * (5.5 - 3.5 * bt / 1.7)
                    g.ellipse([px - sz * 2.2, py - sz * 2.2, px + sz * 2.2, py + sz * 2.2],
                              fill=(*col, int(120 * fa)))
                    d.ellipse([px - sz, py - sz, px + sz, py + sz],
                              fill=(*col, int(235 * fa)))

    def _draw_hearts(self, d, g, t, a, L):
        SW, SH, ss = self.SW, self.SH, self.ss
        cx, cy = self._at(L, [0.5, 0.6])
        rng = random.Random(f"hearts:{L['from']}:{L['to']}")
        floats = [(L["from"] + 0.38 * k, rng.uniform(-0.6, 0.6),
                   rng.uniform(0.8, 1.25), rng.uniform(0, 6.28)) for k in range(12)]
        for ht0, hux, hs, hph in floats:
            hp = (t - ht0) / 3.0
            if 0 <= hp < 1:
                hy = cy - hp * 0.28 * SH
                hx = cx + hux * 0.16 * SW + 46 * ss * math.sin(hph + t * 2.2)
                draw_heart(d, hx, hy, 22 * ss * hs * (1 - 0.3 * hp),
                           (245, 90, 120), int(230 * (1 - hp) * a))

    def _draw_confetti(self, d, g, t, a, L):
        SW, SH, ss = self.SW, self.SH, self.ss
        cx, cy = self._at(L, [0.5, 0.7])
        rng = random.Random(f"conf:{L['from']}")
        parts = [(rng.uniform(-1, 1), rng.uniform(-1.6, -0.4),
                  [CYAN, BLUE, AMBER, INK][k % 4]) for k in range(70)]
        ct = t - L["from"]
        if 0 <= ct <= 1.9:
            for ux, uy, col in parts:
                px = cx + ux * 0.39 * SW * ct
                py = cy + uy * 0.47 * SH * ct + 0.73 * SH * ct * ct
                if py < SH:
                    rr = 7 * ss * (1 - ct / 2.2)
                    d.ellipse([px - rr, py - rr, px + rr, py + rr],
                              fill=(*col, int(235 * (1 - ct / 1.9) * a)))

    # ── audio ───────────────────────────────────────────────────────────
    def prepare_audio(self, tmp_dir):
        """Mix bgm+voice into one wav (voice ducks the bgm) and build the
        voice envelope for lipsync. Returns a wav path or None."""
        if not self.bgm and not self.voice:
            return None
        import soundfile as sf
        RATE = 44100
        n = int(self.dur * RATE)

        def load(path):
            data, rate = sf.read(path, always_2d=True)
            mono = data.mean(axis=1)
            if rate != RATE:
                mono = np.interp(np.linspace(0, len(mono), int(len(mono) * RATE / rate),
                                             endpoint=False),
                                 np.arange(len(mono)), mono)
            out = np.zeros(n)
            m = min(n, len(mono))
            out[:m] = mono[:m]
            return out

        mix = np.zeros(n)
        env_n = None
        if self.voice:
            v = load(self.voice)
            hop = RATE // 20
            frames = np.abs(v[:len(v) // hop * hop]).reshape(-1, hop).max(axis=1)
            k = np.ones(5) / 5
            frames = np.convolve(frames, k, mode="same")
            peak = np.percentile(frames, 97) or 1.0
            env_n = np.clip(frames / max(peak, 1e-6), 0, 1)
            times = (np.arange(len(frames)) + 0.5) * hop / RATE
            self.voice_env = lambda t: float(np.interp(t, times, env_n))
            mix += v
        if self.bgm:
            b = load(self.bgm) * (10 ** (self.bgm_gain_db / 20))
            if env_n is not None:  # duck under the voice
                duck_t = (np.arange(n) / RATE)
                duck = 1 - 0.65 * np.interp(duck_t, (np.arange(len(env_n)) + 0.5)
                                            * (RATE // 20) / RATE, env_n)
                b *= duck
            mix += b
        peak = np.max(np.abs(mix)) or 1.0
        if peak > 0.98:
            mix *= 0.98 / peak
        path = os.path.join(tmp_dir, "mix.wav")
        sf.write(path, mix, RATE, subtype="PCM_16")
        return path

# ── actions ──────────────────────────────────────────────────────────────────
def _out(path):
    return path.replace("\\", "/")

def _scene_hash(inp):
    return hashlib.sha1(
        json.dumps(inp, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:10]

def action_render(inp):
    try:
        scene = Scene(inp)
    except SceneError as e:
        return {"success": False,
                "error": f"{e} — call {{\"action\": \"assets\"}} for the full scene grammar"}
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = _scene_hash(inp)
    stills = inp.get("stills")
    if stills:
        if not isinstance(stills, list) or len(stills) > 8:
            return {"success": False, "error": "stills must be a list of at most 8 timestamps"}
        imports = []
        for i, ts in enumerate(stills):
            ts = max(0.0, min(scene.dur, float(ts)))
            path = os.path.join(OUT_DIR, f"still-{tag}-{i}.png")
            Image.fromarray(scene.draw_frame(ts)).save(path)
            imports.append({"path": _out(path), "contentType": "image/png",
                            "filenameHint": f"motion-still-{i}"})
        return {"success": True,
                "data": {"stills": len(imports), "duration": scene.dur,
                         "note": "stills only — drop the stills field for the full video",
                         "_mediaImport": imports if len(imports) > 1 else imports[0]}}
    import imageio_ffmpeg
    audio = scene.prepare_audio(OUT_DIR)
    out = os.path.join(OUT_DIR, f"video-{tag}.mp4")
    kwargs = dict(fps=scene.fps, quality=8, macro_block_size=8,
                  output_params=["-movflags", "+faststart"])
    if audio:
        kwargs.update(audio_path=audio, audio_codec="aac")
    writer = imageio_ffmpeg.write_frames(out, (scene.W, scene.H), **kwargs)
    writer.send(None)
    n = int(scene.dur * scene.fps)
    for i in range(n):
        writer.send(scene.draw_frame(i / scene.fps).tobytes())
    writer.close()
    if audio:
        try:
            os.remove(audio)
        except OSError:
            pass
    return {"success": True,
            "data": {"duration": scene.dur, "fps": scene.fps,
                     "size": f"{scene.W}x{scene.H}", "frames": n,
                     "bytes": os.path.getsize(out),
                     "_mediaImport": {"path": _out(out), "contentType": "video/mp4",
                                      "filenameHint": f"motion-{tag}"}}}

def action_sticker(inp):
    name = str(inp.get("name") or "firebat")
    if name != "firebat":
        return {"success": False,
                "error": f"unknown asset {name!r} — call {{\"action\": \"assets\"}} "
                         "for the sprite list"}
    try:
        size = int(_num(inp.get("stickerSize", 900), "stickerSize",
                        STICKER_MIN, STICKER_MAX))
    except SceneError as e:
        return {"success": False, "error": str(e)}
    pose = inp.get("pose") or {}
    Wc = size
    Hc = int(size * 1.1)
    img = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    s = Wc / 480.0
    # No glow layer on purpose: additive glow on a transparent ground bakes a
    # dark ring around the flame. The crisp flame reads fine alone.
    draw_firebat(d, None, Wc / 2, Hc - 30 * s, s, 1.3, pal=inp.get("palette"),
                 mouth=float(pose.get("mouth", 0.0)),
                 wave=float(pose.get("wave", 0.0)),
                 sy=float(pose.get("squash", 1.0)),
                 look=tuple(pose.get("look") or (0, 0)),
                 blink_t=0.5 * float(pose["blink"]) if pose.get("blink") else None,
                 glow=False)
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = _scene_hash(inp)
    path = os.path.join(OUT_DIR, f"sticker-{tag}.png")
    img.save(path)
    return {"success": True,
            "data": {"asset": name, "size": [Wc, Hc],
                     "_mediaImport": {"path": _out(path), "contentType": "image/png",
                                      "filenameHint": f"clip-{name}"}}}

def action_assets(_inp):
    return {"success": True, "data": {
        "envelope": {"render": "{action:'render', duration, size?, fps?, background?, "
                               "layers:[...], audio?, stills?, quality?}",
                     "sticker": "{action:'sticker', name, pose?, stickerSize?}"},
        "coordinates": "positions are normalized [x, y], 0..1, y grows downward; "
                       "times are seconds; every layer has from/to (fade windows "
                       "fadeIn/fadeOut, default 0.4s)",
        "sizes": sorted(SIZES), "durationMax": DUR_MAX, "fpsRange": [FPS_MIN, FPS_MAX],
        "backgrounds": {
            "night": "built-in starry night — moon, hills, stars (default)",
            "gradient": "{kind:'gradient', top:[r,g,b], bottom:[r,g,b]}",
            "image": "{kind:'image', media:'/user/media/<file>'} cover-cropped; "
                     "generate one with image_gen first for photoreal scenes",
        },
        "sprites": {"firebat": {
            "what": "the mascot — round flame-headed character, all vector",
            "fields": {"at": "[x,y] of the feet (default [0.5,0.9])",
                       "scale": "1.0 default", "enter": "walk | peek | pop | none",
                       "look": "[x,y] pupil offset, -1..1",
                       "palette": "override {body,bodyDark,outline,belly,wing,"
                                  "flame1,flame2,flame3} as [r,g,b]",
                       "lipsync": "true = talk acts follow audio.voice envelope",
                       "acts": "[{at, do:'wave'|'talk'|'jump', for}]"},
        }},
        "layers": {
            "bubble": "{text, at?, heart?, typing?} speech balloon, types itself out",
            "title": "{lines:[{text, size:'xl'|'lg'|'md'|'sm', color:'ink'|'amber'|"
                     "'cyan'|[r,g,b]}], at?} stacked display text with shadow",
            "caption": "{text, at?} subtitle pill (default near the bottom)",
            "card": "{rows:[{label, value}], at?, w?, accent?} info card, slides in",
            "list": "{rows:[{lead, text, dots?:[[r,g,b]..], highlight?, tag?}], at?, w?} "
                    "staggered time-table rows; highlight = amber emphasis + tag badge",
            "image": "{media, at?, w?, rounded?, kenburns?:{zoom, panx}} a picture from "
                     "the media store with optional Ken Burns drift",
            "fireworks": "{density?} launching rockets and radial bursts",
            "hearts": "{at?} floating hearts",
            "confetti": "{at?} one confetti burst at `from`",
        },
        "audio": {"bgm": "media path (flac/wav/mp3) — render one with the sing module",
                  "voice": "media path — make one with the tts tool; ducks the bgm "
                           "and drives lipsync",
                  "bgmGainDb": "default -8"},
        "iteration": "pass stills:[t1,t2,...] to get PNG frames in seconds instead of "
                     "a minutes-long video render — inspect, adjust, then render for real",
    }}

# ── selftest ─────────────────────────────────────────────────────────────────
def action_selftest():
    checks = []

    def ck(name, want, got, ok):
        checks.append({"name": name, "want": str(want), "got": str(got),
                       "ok": bool(ok)})

    base = {"action": "render", "duration": 2.0, "quality": "draft",
            "layers": [{"kind": "sprite", "from": 0, "to": 2, "enter": "none",
                        "at": [0.5, 0.9]}]}
    sc = Scene(base)
    fr = sc.draw_frame(1.0)
    ck("frame shape equals the declared size (the 1px-canvas bug class)",
       (1920, 1080, 3), fr.shape, fr.shape == (1920, 1080, 3))
    bg = sc.background()
    orange = ((fr[:, :, 0].astype(int) - fr[:, :, 2].astype(int)) > 60).sum()
    ck("the sprite actually lands on the canvas (>30k warm pixels)",
       ">30000", int(orange), orange > 30000)
    # A vertical gradient IS horizontally uniform — the 1px-canvas guard is the
    # shape plus the fact that the moon/stars/hills landed somewhere off-column.
    varied = bool((bg != bg[:, :1]).any())
    ck("night background carries off-column features (moon, stars, hills)",
       True, varied, bg.shape == (sc.SH, sc.SW, 3) and varied)

    ck("win() is zero outside its window and full at mid-window",
       (0.0, 1.0), (win(0.1, 1, 2), win(1.5, 1, 2)),
       win(0.1, 1, 2) == 0.0 and win(1.5, 1, 2) == 1.0)
    ck("jump_arc returns to the ground with no residual squash",
       (0.0, 1.0), jump_arc(5.0, 1.0), jump_arc(5.0, 1.0) == (0.0, 1.0))

    st = action_sticker({"action": "sticker", "stickerSize": 240})
    ok_st = st.get("success")
    alpha_ok = False
    if ok_st:
        p = st["data"]["_mediaImport"]["path"]
        arr = np.asarray(Image.open(p))
        alpha_ok = arr.shape[2] == 4 and arr[2, 2, 3] == 0 and \
            arr[arr.shape[0] // 2, arr.shape[1] // 2, 3] == 255
        os.remove(p)
    ck("sticker is RGBA with transparent corners and an opaque body",
       True, alpha_ok, ok_st and alpha_ok)

    try:
        Scene({"action": "render", "duration": 2,
               "layers": [{"kind": "warp", "from": 0, "to": 1}]})
        ck("an unknown layer kind is refused with a pointer", "SceneError", "passed", False)
    except SceneError as e:
        ck("an unknown layer kind is refused with a pointer", "assets pointer",
           str(e)[:40], "assets" in str(e))

    try:
        media_path("../../etc/passwd")
        ck("path traversal is refused", "SceneError", "passed", False)
    except SceneError:
        ck("path traversal is refused", "refused", "refused", True)

    enc_ok, enc_note = False, ""
    try:
        out = action_render({"action": "render", "duration": 0.6, "fps": 10,
                             "quality": "draft", "size": "1080x1080",
                             "layers": [{"kind": "confetti", "from": 0.1, "to": 0.6}]})
        enc_ok = out.get("success") and out["data"]["bytes"] > 2000
        enc_note = out["data"]["bytes"] if enc_ok else out.get("error", "")
        if enc_ok:
            os.remove(out["data"]["_mediaImport"]["path"])
    except Exception as e:  # noqa: BLE001 — the check reports, not crashes
        enc_note = repr(e)
    ck("a tiny scene encodes to a real mp4", ">2000 bytes", enc_note, enc_ok)

    try:
        f = Fonts(1.0)
        ck("a font resolves (korean-capable flagged honestly)",
           "resolved", f"korean={f.korean}", True)
    except ValueError as e:
        ck("a font resolves (korean-capable flagged honestly)", "resolved",
           str(e)[:60], False)

    failed = sum(1 for c in checks if not c["ok"])
    return {"success": failed == 0,
            "data": {"total": len(checks), "failed": failed, "checks": checks}}

# ── protocol ─────────────────────────────────────────────────────────────────
def main():
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        envelope = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        sys.stdout.buffer.write(
            json.dumps({"success": False, "error": f"input JSON: {e}"}).encode("utf-8"))
        return
    inp = envelope.get("data") or envelope
    action = str(inp.get("action") or "").strip()
    try:
        if action == "render":
            out = action_render(inp)
        elif action == "sticker":
            out = action_sticker(inp)
        elif action == "assets":
            out = action_assets(inp)
        elif action == "selftest":
            out = action_selftest()
        else:
            out = {"success": False,
                   "error": f"unknown action {action!r} — one of: render, sticker, "
                            "assets, selftest"}
    except SceneError as e:
        out = {"success": False,
               "error": f"{e} — call {{\"action\": \"assets\"}} for the scene grammar"}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))

if __name__ == "__main__":
    main()
