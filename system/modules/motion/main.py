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

_HEART_PTS = None

def draw_heart(d, x, y, r, col, a=255):
    """One smooth polygon from the classic parametric heart — the circles+triangle
    assembly showed its seams the moment a heart became 300px clip art."""
    global _HEART_PTS
    if _HEART_PTS is None:
        _HEART_PTS = []
        for i in range(72):
            t = i * 2 * math.pi / 72
            hx = 16 * math.sin(t) ** 3
            hy = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            _HEART_PTS.append((hx / 16.0, -hy / 16.0))
    d.polygon([(x + px * r, y + py * r) for px, py in _HEART_PTS], fill=(*col, a))

# ── custom clip-art assets ───────────────────────────────────────────────────
# The ORIGINAL of a saved clip art is its declaration (a JSON parts list) under
# data/motion/assets/; the PNG in the media store is a derived thumbnail. Scenes
# and stickers reference the name, and the interpreter below redraws the vector
# at whatever size and pose the moment asks for — reuse never touches the PNG.
#
# Part grammar (viewBox 100x100 units, feet anchored at (50,100)):
#   {shape: ellipse|rect|polygon|capsule|heart|star, at:[x,y], size:[w,h] |
#    points:[[x,y]..] | ends:[[x,y],[x,y]]+width, fill:[r,g,b(,a)],
#    outline:[r,g,b]?, outlineWidth?, role: "swing"|"mouth"|"eye"|null,
#    pivot:[x,y]? (swing rotation centre)}
ASSET_DIR = os.path.join("data", "motion", "assets")
ASSET_PARTS_MAX = 60
import re as _re
_ASSET_NAME_RE = _re.compile(r"^[0-9A-Za-z가-힣_-]{1,24}$")
_CUSTOM_SHAPES = ("ellipse", "rect", "roundedrect", "polygon", "capsule", "heart",
                  "star", "text")
# Seed assets ship WITH the module (assets/*.json) — the same declaration grammar the
# save_asset action stores, deployed by git like any declaration. The five former
# built-ins live here now; the module keeps only the interpreter (원본 하나).
_SEED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

class SceneError(ValueError):
    pass

def _asset_path(name):
    return os.path.join(ASSET_DIR, f"{name}.json")

def load_custom_asset(name):
    """Saved declarations first, then the module's seeds — a user save may not take a
    seed's name (validate refuses), so this order never shadows silently."""
    for base in (_asset_path(name), os.path.join(_SEED_DIR, f"{name}.json")):
        if os.path.isfile(base):
            with open(base, encoding="utf-8") as fh:
                return json.load(fh)
    return None

def _names_in(dirpath):
    if not os.path.isdir(dirpath):
        return []
    return sorted(f[:-5] for f in os.listdir(dirpath) if f.endswith(".json"))

def list_custom_assets():
    return _names_in(ASSET_DIR)

def list_seed_assets():
    return _names_in(_SEED_DIR)

def _rgb(v, name, alpha_ok=True):
    if not (isinstance(v, (list, tuple)) and len(v) in ((3, 4) if alpha_ok else (3,))
            and all(isinstance(c, (int, float)) and 0 <= c <= 255 for c in v)):
        raise SceneError(f"{name} must be [r,g,b] (0..255)")
    return [int(c) for c in v]

def _pt(v, name):
    if not (isinstance(v, (list, tuple)) and len(v) == 2
            and all(isinstance(c, (int, float)) and -50 <= c <= 150 for c in v)):
        raise SceneError(f"{name} must be [x,y] in the 100x100 viewBox")
    return [float(v[0]), float(v[1])]

def validate_asset_decl(name, parts):
    if not _ASSET_NAME_RE.match(name or ""):
        raise SceneError("name must be 1-24 chars of letters, digits, 한글, - or _")
    if name in list_seed_assets():
        raise SceneError(f"{name!r} is a seed asset shipped with the module — pick "
                         "another name")
    return validate_parts(parts)

def validate_parts(parts):
    if not isinstance(parts, list) or not (1 <= len(parts) <= ASSET_PARTS_MAX):
        raise SceneError(f"parts must be a list of 1..{ASSET_PARTS_MAX}")
    norm = []
    for i, p in enumerate(parts):
        if not isinstance(p, dict):
            raise SceneError(f"parts[{i}] must be an object")
        shape = p.get("shape")
        if shape not in _CUSTOM_SHAPES:
            raise SceneError(f"parts[{i}].shape must be one of {list(_CUSTOM_SHAPES)}")
        q = {"shape": shape, "fill": _rgb(p.get("fill", [200, 200, 200]), f"parts[{i}].fill")}
        if p.get("outline") is not None:
            q["outline"] = _rgb(p["outline"], f"parts[{i}].outline", alpha_ok=False)
            q["outlineWidth"] = float(p.get("outlineWidth", 1.2))
        role = p.get("role")
        if role is not None:
            if role not in ("swing", "mouth", "eye", "flicker", "foot", "flap"):
                raise SceneError(
                    f"parts[{i}].role must be swing | mouth | eye | flicker | foot | flap")
            q["role"] = role
        if p.get("glow"):
            q["glow"] = True
        if shape == "text":
            q["at"] = _pt(p.get("at", [50, 50]), f"parts[{i}].at")
            q["height"] = float(p.get("height", 16))
            if not (4 <= q["height"] <= 40):
                raise SceneError(f"parts[{i}].height must be 4..40 units")
            if p.get("bind") is not None and p["bind"] != "text":
                raise SceneError(f"parts[{i}].bind may only be \"text\"")
            if p.get("bind"):
                q["bind"] = "text"
            else:
                q["value"] = str(p.get("value") or "")[:TEXT_MAX]
            norm.append(q)
            continue
        if shape == "roundedrect":
            q["at"] = _pt(p.get("at", [50, 50]), f"parts[{i}].at")
            size = p.get("size", [20, 20])
            if not (isinstance(size, (list, tuple)) and len(size) == 2
                    and all(isinstance(c, (int, float)) and 0.5 <= c <= 120 for c in size)):
                raise SceneError(f"parts[{i}].size must be [w,h] in 0.5..120 units")
            q["size"] = [float(size[0]), float(size[1])]
            q["radius"] = float(p.get("radius", min(q["size"]) * 0.25))
            norm.append(q)
            continue
        if shape == "polygon":
            pts = p.get("points")
            if not (isinstance(pts, list) and 3 <= len(pts) <= 72):
                raise SceneError(f"parts[{i}].points must be 3..72 [x,y] pairs")
            q["points"] = [_pt(v, f"parts[{i}].points[{j}]") for j, v in enumerate(pts)]
        elif shape == "capsule":
            ends = p.get("ends")
            if not (isinstance(ends, list) and len(ends) == 2):
                raise SceneError(f"parts[{i}].ends must be two [x,y] points")
            q["ends"] = [_pt(ends[0], f"parts[{i}].ends[0]"), _pt(ends[1], f"parts[{i}].ends[1]")]
            q["width"] = float(p.get("width", 6))
            if not (0.5 <= q["width"] <= 40):
                raise SceneError(f"parts[{i}].width must be 0.5..40 units")
        else:
            q["at"] = _pt(p.get("at", [50, 50]), f"parts[{i}].at")
            size = p.get("size", [20, 20])
            if not (isinstance(size, (list, tuple)) and len(size) == 2
                    and all(isinstance(c, (int, float)) and 0.5 <= c <= 120 for c in size)):
                raise SceneError(f"parts[{i}].size must be [w,h] in 0.5..120 units")
            q["size"] = [float(size[0]), float(size[1])]
        if role in ("swing", "flap"):
            q["pivot"] = _pt(p.get("pivot", q.get("at", [50, 50])), f"parts[{i}].pivot")
        norm.append(q)
    return norm

def _shape_points(q):
    """Every shape becomes a point loop so rotation/squash is one code path.
    Capsules keep their two ends and width instead."""
    shape = q["shape"]
    if shape == "polygon":
        return list(q["points"])
    if shape == "capsule":
        return None
    cx, cy = q["at"]
    w, h = q["size"][0] / 2, q["size"][1] / 2
    if shape == "rect":
        return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]]
    if shape == "roundedrect":
        r = min(q["radius"], w, h)
        pts = []
        for kx, ky, a0 in ((1, -1, -math.pi / 2), (1, 1, 0.0),
                           (-1, 1, math.pi / 2), (-1, -1, math.pi)):
            ccx, ccy = cx + kx * (w - r), cy + ky * (h - r)
            for j in range(7):
                a = a0 + j * (math.pi / 2) / 6
                pts.append([ccx + r * math.cos(a), ccy + r * math.sin(a)])
        return pts
    if shape == "ellipse":
        return [[cx + w * math.cos(a), cy + h * math.sin(a)]
                for a in (i * math.pi / 12 for i in range(24))]
    if shape == "heart":
        if _HEART_PTS is None:  # populate the shared parametric curve
            tmp = Image.new("RGB", (4, 4))
            draw_heart(ImageDraw.Draw(tmp, "RGBA"), 2, 2, 1, (0, 0, 0), 0)
        return [[cx + px * w, cy + py * h] for px, py in _HEART_PTS]
    if shape == "star":
        pts = []
        for i in range(10):
            r = 1.0 if i % 2 == 0 else 0.42
            a = -math.pi / 2 + i * math.pi / 5
            pts.append([cx + w * r * math.cos(a), cy + h * r * math.sin(a)])
        return pts
    raise SceneError(f"unhandled shape {shape}")

def draw_custom(d, cx, cy, s, t, parts, mouth=0.0, wave=0.0, walk=0.0,
                sy=1.0, blink_t=None, g=None, text="", fonts=None):
    """cx, cy = feet (unit point (50,100)). One unit = 4*s px. `g` is the scene's
    glow layer — parts flagged `glow` mirror an enlarged translucent copy there."""
    u = 4.0 * s
    sxw = 1.0 / math.sqrt(max(0.3, sy))
    cy = cy - walk * 10 * s * abs(math.sin(t * 11))
    eh = 1.0
    if blink_t is not None:
        eh = 1 - 0.92 * math.sin(math.pi * clamp01(blink_t))

    def to_px(x, y):
        return (cx + (x - 50) * u * sxw, cy - (100 - y) * u * sy)

    swing_ang = wave * (-0.55 + 0.45 * math.sin(t * 9))
    flap_ang = 0.16 * math.sin(t * 9) * (0.5 + 0.5 * walk)
    flick = math.sin(t * 13) * 1.4 + math.sin(t * 23 + 1) * 0.7
    step = math.sin(t * 11) * walk
    for q in parts:
        role = q.get("role")
        if q["shape"] == "text":
            txt = text if q.get("bind") == "text" else q.get("value", "")
            if txt and fonts is not None:
                f = ImageFont.truetype(fonts.bold, int(q["height"] * u))
                tw = d.textlength(txt, font=f)
                maxw = 92 * u
                if tw > maxw:
                    f = ImageFont.truetype(fonts.bold, max(8, int(q["height"] * u * maxw / tw)))
                    tw = d.textlength(txt, font=f)
                px_, py_ = to_px(*q["at"])
                col = tuple(q["fill"]) if len(q["fill"]) == 4 else tuple(q["fill"]) + (255,)
                d.text((px_ - tw / 2, py_ - f.size * 0.62), txt, font=f, fill=col)
            continue
        pts = _shape_points(q)

        def xform(p):
            x, y = p
            if role == "swing" and swing_ang:
                px_, py_ = q["pivot"]
                dx, dy = x - px_, y - py_
                ca, sa = math.cos(swing_ang), math.sin(swing_ang)
                x, y = px_ + dx * ca - dy * sa, py_ + dx * sa + dy * ca
            elif role == "flap":
                px_, py_ = q["pivot"]
                sign = 1.0 if px_ >= 50 else -1.0
                ang = flap_ang * sign
                dx, dy = x - px_, y - py_
                ca, sa = math.cos(ang), math.sin(ang)
                x, y = px_ + dx * ca - dy * sa, py_ + dx * sa + dy * ca
            elif role == "flicker":
                x = x + flick
            elif role == "foot":
                sign = 1.0 if (q.get("at", [50])[0]) >= 50 else -1.0
                x = x + sign * step * 3.5
                y = y - max(0.0, sign * step) * 2.5
            if role == "mouth":
                mcy = q["at"][1] if "at" in q else sum(pp[1] for pp in pts) / len(pts)
                y = mcy + (y - mcy) * (0.4 + 1.3 * clamp01(mouth))
            if role == "eye":
                ecy = q["at"][1] if "at" in q else sum(pp[1] for pp in pts) / len(pts)
                y = ecy + (y - ecy) * eh
            return to_px(x, y)

        fill = tuple(q["fill"]) if len(q["fill"]) == 4 else tuple(q["fill"]) + (255,)
        ow = int(max(1, q.get("outlineWidth", 0) * u)) if q.get("outline") else 0
        if q["shape"] == "capsule":
            p0, p1 = xform(q["ends"][0]), xform(q["ends"][1])
            w_px = q["width"] * u
            if ow:
                _capsule(d, p0, p1, w_px + 2 * ow, tuple(q["outline"]))
            _capsule(d, p0, p1, w_px, fill)
        else:
            poly = [xform(p) for p in pts]
            if q.get("glow") and g is not None:
                gcx = sum(p[0] for p in poly) / len(poly)
                gcy = sum(p[1] for p in poly) / len(poly)
                g.polygon([(gcx + (p[0] - gcx) * 1.5, gcy + (p[1] - gcy) * 1.5)
                           for p in poly], fill=fill[:3] + (90,))
            if q.get("outline"):
                d.polygon(poly, fill=fill, outline=tuple(q["outline"]), width=ow)
            else:
                d.polygon(poly, fill=fill)

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
        # One `voice` starts at 0; `voices` places each line on the timeline —
        # {media, at}. The mouth follows the MIXED envelope, so lipsync lands on
        # whichever line is speaking without any per-line bookkeeping.
        voices = audio.get("voices")
        if voices is None and audio.get("voice"):
            voices = [{"media": audio["voice"], "at": 0}]
        self.voices = []
        for i, v in enumerate(voices or []):
            if not isinstance(v, dict) or not v.get("media"):
                raise SceneError(f"audio.voices[{i}] must be {{media, at}}")
            self.voices.append(
                (media_path(v["media"]),
                 _num(v.get("at", 0), f"audio.voices[{i}].at", 0, self.dur)))
        if len(self.voices) > 12:
            raise SceneError("audio.voices: at most 12 lines")
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
        name = str(L.get("name", "firebat"))
        saved = load_custom_asset(name)
        if saved is None:
            raise SceneError(
                f"unknown sprite {name!r} — assets lists seed and saved clip art; "
                "save one first with save_asset")
        custom = saved["parts"]
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
        draw_custom(d, x, y - jump_h, s, t, custom, mouth=mouth, wave=wave,
                    walk=walk, sy=sy, blink_t=blink_phase(t), g=g,
                    fonts=self.fonts)

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
        if not self.bgm and not self.voices:
            return None
        try:
            import soundfile as sf
        except ImportError as e:
            raise SceneError(
                f"soundfile is not importable in this runtime ({e}) — the declared "
                "package likely failed to install; render without audio works, or "
                "install it manually and retry")
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
        if self.voices:
            v = np.zeros(n)
            for path, at in self.voices:
                one = load(path)
                off = int(at * RATE)
                m = min(n - off, len(one))
                if m > 0:
                    v[off:off + m] += one[:m]
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
    try:
        import imageio_ffmpeg
    except ImportError as e:
        # Measured 2026-08-25: assets/stills/sticker ran while the video path died
        # bare — numpy/pillow had installed and this lazy import had not. Name the
        # package and the next step instead of a naked traceback.
        return {"success": False,
                "error": f"imageio-ffmpeg is not importable in this runtime ({e}) — "
                         "the declared package likely failed to install on first run; "
                         "check `journalctl -u firebat | grep -iE 'pip|motion'` or "
                         "install it manually, then retry"}
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

def _color_of(pose, default):
    c = pose.get("color")
    if isinstance(c, (list, tuple)) and len(c) == 3:
        return tuple(int(v) for v in c)
    return default

def _custom_sticker_png(decl, size, pose):
    parts = decl["parts"] if isinstance(decl, dict) else decl
    aspect = float(decl.get("aspect", 1.0)) if isinstance(decl, dict) else 1.0
    aspect = min(2.0, max(0.3, aspect))
    Wc, Hc = size, int(size * aspect)
    img = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    txt = str(pose.get("text") or "")
    fonts = None
    if any(p.get("shape") == "text" for p in parts):
        fonts = Fonts(1.0)
        if has_hangul(txt) and not fonts.korean:
            raise SceneError("pose.text is Korean but no Korean-capable font was found "
                             "— install fonts-nanum or set fontPath")
    draw_custom(d, Wc / 2, Hc - Hc * 0.02, Wc / 400.0 * 0.96, 1.3, parts,
                mouth=float(pose.get("mouth", 0.0)), wave=float(pose.get("wave", 0.0)),
                sy=float(pose.get("squash", 1.0)),
                blink_t=0.5 * float(pose["blink"]) if pose.get("blink") else None,
                text=txt, fonts=fonts)
    return img

def action_sticker(inp):
    name = str(inp.get("name") or "firebat")
    decl = load_custom_asset(name)
    if decl is None:
        return {"success": False,
                "error": f"unknown asset {name!r} — seed assets {list_seed_assets()} "
                         "or a saved clip-art name (assets lists both)"}
    try:
        size = int(_num(inp.get("stickerSize", 900), "stickerSize",
                        STICKER_MIN, STICKER_MAX))
        img = _custom_sticker_png(decl, size, inp.get("pose") or {})
    except SceneError as e:
        return {"success": False, "error": str(e)}
    Wc, Hc = img.size
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = _scene_hash(inp)
    path = os.path.join(OUT_DIR, f"sticker-{tag}.png")
    img.save(path)
    return {"success": True,
            "data": {"asset": name, "size": [Wc, Hc],
                     "_mediaImport": {"path": _out(path), "contentType": "image/png",
                                      "filenameHint": f"clip-{name}",
                                      "source": "clipart"}}}

def action_save_asset(inp):
    name = str(inp.get("name") or "").strip()
    try:
        parts = validate_asset_decl(name, inp.get("parts"))
    except SceneError as e:
        return {"success": False,
                "error": f"{e} — the assets action documents the part grammar"}
    os.makedirs(ASSET_DIR, exist_ok=True)
    replaced = os.path.isfile(_asset_path(name))
    with open(_asset_path(name), "w", encoding="utf-8") as fh:
        json.dump({"parts": parts}, fh, ensure_ascii=False, indent=1)
    # The browsable face: a thumbnail lands in the media store as clip art. The
    # declaration stays the original — consumers re-render from it, never from this PNG.
    os.makedirs(OUT_DIR, exist_ok=True)
    thumb = _custom_sticker_png({"parts": parts}, 480, {})
    tp = os.path.join(OUT_DIR, f"asset-thumb-{name}.png")
    thumb.save(tp)
    return {"success": True,
            "data": {"asset": name, "parts": len(parts), "replaced": replaced,
                     "next": "reference it as a sprite layer {kind:'sprite', name: '"
                             + name + "'} or export sizes with the sticker action",
                     "_mediaImport": {"path": _out(tp), "contentType": "image/png",
                                      "filenameHint": f"clip-{name}",
                                      "source": "clipart"}}}

def action_delete_asset(inp):
    name = str(inp.get("name") or "").strip()
    if not _ASSET_NAME_RE.match(name):
        return {"success": False, "error": "name must be a saved clip-art name"}
    p = _asset_path(name)
    if not os.path.isfile(p):
        return {"success": False,
                "error": f"no saved clip art named {name!r} — assets lists what exists"}
    os.remove(p)
    return {"success": True, "data": {"deleted": name,
            "note": "the declaration is gone; thumbnails already in the media store stay "
                    "until removed there"}}

def action_duration(inp):
    """Length of an audio file in seconds — what the scene author needs to place a
    line's bubble and talk act on the timeline before rendering."""
    try:
        path = media_path(inp.get("media"))
    except SceneError as e:
        return {"success": False, "error": str(e)}
    try:
        import soundfile as sf
    except ImportError as e:
        return {"success": False, "error": f"soundfile is not importable ({e})"}
    try:
        info = sf.info(path)
    except Exception as e:  # noqa: BLE001 — the envelope reports
        return {"success": False, "error": f"could not read {path}: {e}"}
    return {"success": True,
            "data": {"media": inp.get("media"), "seconds": round(info.frames / info.samplerate, 3),
                     "sampleRate": info.samplerate}}

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
        "sprites": {
            "what": "any clip-art declaration by name — seeds ship with the module, "
                    "saved ones come from save_asset; both are the same grammar and "
                    "both animate (enter, acts, roles)",
            "fields": {"at": "[x,y] of the feet (default [0.5,0.9])",
                       "scale": "1.0 default", "enter": "walk | peek | pop | none",
                       "lipsync": "true = talk acts follow audio.voice envelope",
                       "acts": "[{at, do:'wave'|'talk'|'jump', for}]"},
        },
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
                  "voice": "one media path starting at t=0 (tts output); ducks the bgm "
                           "and drives lipsync",
                  "voices": "dialogue on the timeline: [{media, at}] (max 12). The mouth "
                            "follows the mixed envelope automatically; call the duration "
                            "action per line, then place each line's bubble/talk at the "
                            "same `at` for that long",
                  "bgmGainDb": "default -8"},
        "dialogueSync": "the recipe: tts each line → duration each file → for line i "
                        "at time T: voices += {media, at:T}, bubble from T to T+len, "
                        "sprite act {at:T, do:'talk', for:len, lipsync}. The mouth needs "
                        "no manual sync — it follows the sound energy",
        "saved": {
            "what": "clip art declarations — the parts JSON is the original, the "
                    "media-store PNG is only a thumbnail; scenes and stickers reference "
                    "the name and redraw the vector at any size",
            "seeds": list_seed_assets(),
            "names": list_custom_assets(),
            "grammar": "save_asset {name, parts:[{shape: ellipse|rect|polygon|capsule|"
                       "heart|star, at:[x,y], size:[w,h] | points:[[x,y]..] | "
                       "ends:[[x,y],[x,y]]+width, fill:[r,g,b], outline:[r,g,b]?, "
                       "outlineWidth?, role?, pivot:[x,y]?, glow?}]} in a 100x100 "
                       "viewBox, feet at (50,100), y down. Roles: swing waves, mouth "
                       "opens with talk/lipsync, eye blinks, flicker jitters (flames), "
                       "foot steps while walking, flap idly sways around its pivot. "
                       "glow:true mirrors the part onto the scene glow layer. Extra "
                       "shapes: roundedrect {radius}, text {height, bind:'text'|value}. "
                       "Top level may set aspect (canvas h/w for stickers, 0.3..2)",
        },
        "stickers": {
            "what": "the sticker action exports any declaration (seed or saved) as a "
                    "transparent PNG — pose {wave, mouth, blink, squash} moves the "
                    "tagged parts, pose.text fills a text part (balloon)",
        },
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

    seeds = list_seed_assets()
    seed_ok = True
    for nm in seeds:
        try:
            validate_parts(load_custom_asset(nm)["parts"])
        except Exception:  # noqa: BLE001 — the check reports
            seed_ok = False
    ck("all seed declarations exist and validate against the grammar",
       "5 seeds valid", f"{len(seeds)} seeds, valid={seed_ok}",
       len(seeds) == 5 and seed_ok)

    hs = action_sticker({"action": "sticker", "name": "heart", "stickerSize": 220})
    h_ok = False
    if hs.get("success"):
        p = hs["data"]["_mediaImport"]["path"]
        arr = np.asarray(Image.open(p))
        h_ok = arr[2, 2, 3] == 0 and arr[arr.shape[0] // 2, arr.shape[1] // 2, 3] == 255
        os.remove(p)
    ck("a non-character clip-art asset (heart) exports the same way",
       True, h_ok, bool(hs.get("success")) and h_ok)

    demo_parts = [
        {"shape": "ellipse", "at": [50, 60], "size": [40, 50], "fill": [120, 160, 90],
         "outline": [40, 60, 30], "outlineWidth": 1.5},
        {"shape": "capsule", "ends": [[68, 50], [86, 34]], "width": 6,
         "fill": [120, 160, 90], "role": "swing", "pivot": [68, 50]},
        {"shape": "ellipse", "at": [50, 52], "size": [10, 6], "fill": [60, 30, 30],
         "role": "mouth"},
    ]
    sv = action_save_asset({"name": "selftest-blob", "parts": demo_parts})
    rt_ok = False
    if sv.get("success"):
        tp = sv["data"]["_mediaImport"]["path"]
        if os.path.isfile(tp):
            os.remove(tp)
        sc2 = Scene({"action": "render", "duration": 1.5, "quality": "draft",
                     "layers": [{"kind": "sprite", "name": "selftest-blob", "from": 0,
                                 "to": 1.5, "enter": "none",
                                 "acts": [{"at": 0, "do": "wave", "for": 1.5},
                                          {"at": 0, "do": "talk", "for": 1.5}]}]})
        fr2 = sc2.draw_frame(0.8)
        green = ((fr2[:, :, 1].astype(int) - fr2[:, :, 2].astype(int)) > 30).sum()
        st2 = action_sticker({"action": "sticker", "name": "selftest-blob",
                              "stickerSize": 220})
        if st2.get("success"):
            os.remove(st2["data"]["_mediaImport"]["path"])
        dl = action_delete_asset({"name": "selftest-blob"})
        rt_ok = green > 5000 and st2.get("success") and dl.get("success") \
            and load_custom_asset("selftest-blob") is None
    ck("a saved declaration round-trips: save → scene sprite → sticker → delete",
       True, rt_ok, bool(sv.get("success")) and rt_ok)

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
    out = {"success": failed == 0,
           "data": {"total": len(checks), "failed": failed, "checks": checks}}
    if failed:
        # Envelope form 2 needs an `error` — success:false with only data came back
        # from the framework as a bare "module failed", hiding every detail.
        out["error"] = f"{failed} of {len(checks)} checks failed: " + "; ".join(
            f"{c['name']} (got {c['got']})" for c in checks if not c["ok"])[:600]
    return out

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
        elif action == "duration":
            out = action_duration(inp)
        elif action == "save_asset":
            out = action_save_asset(inp)
        elif action == "delete_asset":
            out = action_delete_asset(inp)
        elif action == "selftest":
            out = action_selftest()
        else:
            out = {"success": False,
                   "error": f"unknown action {action!r} — one of: render, sticker, "
                            "assets, save_asset, delete_asset, duration, selftest"}
    except SceneError as e:
        out = {"success": False,
               "error": f"{e} — call {{\"action\": \"assets\"}} for the scene grammar"}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))

if __name__ == "__main__":
    main()
