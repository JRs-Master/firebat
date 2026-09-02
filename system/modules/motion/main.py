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
import re
import shutil
import subprocess
import sys
import time
import hashlib

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gltf3d  # noqa: E402 — module-local pure-python GLB reader + toon rasterizer

# ── limits ───────────────────────────────────────────────────────────────────
SIZES = {"1080x1920": (1080, 1920), "1920x1080": (1920, 1080), "1080x1080": (1080, 1080)}
DUR_MAX = 90.0
FPS_MIN, FPS_MAX = 10, 30
LAYERS_MAX = 40
TEXT_MAX = 200
STICKER_MIN, STICKER_MAX = 200, 2048
OUT_DIR = os.path.join("data", "motion")
JOB_DIR = os.path.join("data", "motion", "jobs")
# Review stills go here: under the served media root so a browser can show them,
# but with no media-store row, so the gallery only ever holds finished work.
SCRATCH_DIR = os.path.join("user", "media", "_scratch")


def _sweep_scratch(keep_sec=86400, keep_n=150):
    """Iteration stills are inputs, not deliverables — keep a day's worth."""
    try:
        files = []
        for n in os.listdir(SCRATCH_DIR):
            p = os.path.join(SCRATCH_DIR, n)
            if os.path.isfile(p):
                files.append((os.path.getmtime(p), p))
        files.sort(reverse=True)
        now = time.time()
        for i, (mt, p) in enumerate(files):
            if i >= keep_n or now - mt > keep_sec:
                try:
                    os.remove(p)
                except OSError:
                    pass
    except OSError:
        pass

# ── palette ──────────────────────────────────────────────────────────────────
INK, DIM = (236, 240, 248), (148, 163, 184)
CYAN, BLUE, AMBER = (34, 211, 238), (59, 130, 246), (255, 190, 70)
NAMED = {"ink": INK, "dim": DIM, "cyan": CYAN, "blue": BLUE, "amber": AMBER}

# ── maths typesetting ────────────────────────────────────────────────────────
# The scene writes the formula as a string and this turns it into ink. The
# alternative — render it in a browser, screenshot it, crop it, upload the file
# and reference it — is four moving parts to say one equation, and this server
# has no browser at all.
_MATH_CACHE = {}


def _split_math(text):
    """'교점 = $S(x)=m$ 의 해' -> [(False,'교점 = '), (True,'S(x)=m'), (False,' 의 해')].

    An unpaired `$` stays literal instead of swallowing the rest of the line — a
    caption that mentions a price should not silently become maths.
    """
    out, buf, i, n = [], "", 0, len(text)
    while i < n:
        if text[i] == "$":
            j = text.find("$", i + 1)
            if j < 0:
                buf += text[i:]
                break
            if buf:
                out.append((False, buf))
                buf = ""
            out.append((True, text[i + 1:j]))
            i = j + 1
            continue
        buf += text[i]
        i += 1
    if buf:
        out.append((False, buf))
    return out or [(False, "")]


def _mathtext_rgba(tex, rgb, px_h):
    """TeX-ish maths -> a transparent RGBA image, typeset in this process.

    Cached per (tex, colour, height): one formula usually sits on screen for
    hundreds of frames and the layout is the expensive half.
    """
    key = (tex, tuple(rgb), int(px_h))
    hit = _MATH_CACHE.get(key)
    if hit is not None:
        return hit
    import io as _io
    try:
        import matplotlib
        matplotlib.use("Agg")
        from matplotlib.figure import Figure
        from matplotlib.backends.backend_agg import FigureCanvasAgg
    except ImportError as e:
        raise SceneError(
            "maths needs matplotlib (declared in this module's packages) — %s" % e)
    matplotlib.rcParams["mathtext.fontset"] = "cm"   # the Computer Modern look
    fig = Figure(figsize=(0.01, 0.01), dpi=220)
    FigureCanvasAgg(fig)
    fig.text(0, 0, "$" + tex + "$", fontsize=36,
             color=(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0))
    buf = _io.BytesIO()
    try:
        fig.savefig(buf, format="png", transparent=True,
                    bbox_inches="tight", pad_inches=0.02)
    except Exception as e:
        raise SceneError("cannot typeset %r — %s" % (tex[:60], e))
    buf.seek(0)
    im = Image.open(buf).convert("RGBA")
    if im.height != px_h and im.height > 0:
        im = im.resize((max(1, round(im.width * px_h / im.height)), int(px_h)),
                       Image.LANCZOS)
    if len(_MATH_CACHE) > 120:
        _MATH_CACHE.clear()
    _MATH_CACHE[key] = im
    return im

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

_EASE_NAMES = {"smooth", "snap", "overshoot", "anticipate", "linear"}

def ease2d(name, x):
    """Cartoon easing. snap arrives by 60% of the window and holds (pose-to-pose
    timing), overshoot springs past and settles, anticipate pulls back before
    launching. May leave [0,1] on purpose — blenders that must stay bounded
    clamp on their side."""
    x = clamp01(x)
    if name == "linear":
        return x
    if name == "snap":
        return 1 - (1 - min(1.0, x / 0.6)) ** 5
    if name == "overshoot":
        return eob(x)
    if name == "anticipate":
        if x < 0.28:
            return -0.18 * math.sin(math.pi * x / 0.28)
        return eob((x - 0.28) / 0.72)
    return eo3(x)

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
                  "star", "text", "image")
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

def validate_bones(bones, parts):
    """Bone chains for FK: {name: {pivot:[x,y], parent?}} — parents first at draw."""
    if bones is None:
        return {}
    if not isinstance(bones, dict) or len(bones) > 40:
        raise SceneError("bones must be an object of at most 40 named bones")
    norm = {}
    for name, b in bones.items():
        if not re.match(r"^[A-Za-z0-9_]{1,20}$", str(name)):
            raise SceneError(f"bone name {name!r} must be 1-20 letters/digits/_")
        if not isinstance(b, dict):
            raise SceneError(f"bones.{name} must be an object")
        norm[name] = {"pivot": _pt(b.get("pivot", [50, 50]), f"bones.{name}.pivot")}
        if b.get("parent") is not None:
            norm[name]["parent"] = str(b["parent"])
    for name, b in norm.items():
        seen, cur = {name}, b.get("parent")
        while cur is not None:
            if cur not in norm:
                raise SceneError(f"bones.{name}: parent {cur!r} is not a declared bone")
            if cur in seen:
                raise SceneError(f"bones: cycle through {cur!r}")
            seen.add(cur)
            cur = norm[cur].get("parent")
    declared = set(norm)
    for i, p in enumerate(parts or []):
        if isinstance(p, dict) and p.get("bone") is not None \
                and str(p["bone"]) not in declared:
            raise SceneError(f"parts[{i}].bone {p['bone']!r} is not declared in bones")
    return norm


def _affine_apply(m, x, y):
    return (m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5])


def _bone_affines(bones, angles):
    """Per-bone 2x3 affine in declaration space — a bone rotates about its pivot
    as already moved by its ancestors, so children follow their parents."""
    done = {}

    def m_of(name):
        if name in done:
            return done[name]
        b = bones[name]
        parent = b.get("parent")
        mp = m_of(parent) if parent else (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
        px, py = _affine_apply(mp, *b["pivot"])
        ang = float(angles.get(name, 0.0))
        ca, sa = math.cos(ang), math.sin(ang)
        r = (ca, -sa, px - ca * px + sa * py, sa, ca, py - sa * px - ca * py)
        m = (r[0] * mp[0] + r[1] * mp[3], r[0] * mp[1] + r[1] * mp[4],
             r[0] * mp[2] + r[1] * mp[5] + r[2],
             r[3] * mp[0] + r[4] * mp[3], r[3] * mp[1] + r[4] * mp[4],
             r[3] * mp[2] + r[4] * mp[5] + r[5])
        done[name] = m
        return m

    return {name: m_of(name) for name in bones}


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
        if p.get("bone") is not None:
            q["bone"] = str(p["bone"])
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
        if shape == "image":
            # cutout rigging: a polygon-cropped piece of a real picture becomes a
            # joint — same roles as vector parts, so an attached photo animates
            media = p.get("media")
            if not isinstance(media, str) or not media.strip():
                raise SceneError(f"parts[{i}].media must be a media-store path")
            q["media"] = media.strip()
            crop = p.get("crop")
            if not (isinstance(crop, list) and 3 <= len(crop) <= 60):
                raise SceneError(
                    f"parts[{i}].crop must be 3..60 [x,y] pairs in 0..1 image coords")
            cc = []
            for j, v in enumerate(crop):
                if not (isinstance(v, (list, tuple)) and len(v) == 2
                        and all(isinstance(c, (int, float)) and 0.0 <= c <= 1.0
                                for c in v)):
                    raise SceneError(
                        f"parts[{i}].crop[{j}] must be [x,y] in 0..1 image coords")
                cc.append([float(v[0]), float(v[1])])
            q["crop"] = cc
            q["at"] = _pt(p.get("at", [50, 50]), f"parts[{i}].at")
            q["width"] = float(p.get("width", 30))
            if not (2 <= q["width"] <= 110):
                raise SceneError(f"parts[{i}].width must be 2..110 units")
            if p.get("flip"):
                q["flip"] = True
            if role in ("swing", "flap", "mouth"):
                q["pivot"] = _pt(p.get("pivot", q["at"]), f"parts[{i}].pivot")
            # Alternate crops of the SAME picture, named. A character generated as
            # one expression sheet gives four faces that cannot disagree about the
            # jaw, the skin or the line weight, because they are four rectangles of
            # one file - consistency by not regenerating, which is the whole reason
            # a cutout rig beats a fresh image per shot.
            variants = p.get("variants")
            if variants is not None:
                if not isinstance(variants, dict) or not 1 <= len(variants) <= 12:
                    raise SceneError(
                        f"parts[{i}].variants must be {{name: crop}} - 1 to 12 named "
                        "alternate crops of the same media")
                vv = {}
                for vname, vcrop in variants.items():
                    vn = str(vname).strip()
                    if not vn or len(vn) > 24:
                        raise SceneError(f"parts[{i}].variants: name 1..24 chars")
                    if not (isinstance(vcrop, list) and 3 <= len(vcrop) <= 60):
                        raise SceneError(
                            f"parts[{i}].variants[{vn}] must be 3..60 [x,y] pairs")
                    cv = []
                    for j, v in enumerate(vcrop):
                        if not (isinstance(v, (list, tuple)) and len(v) == 2
                                and all(isinstance(c, (int, float)) and 0.0 <= c <= 1.0
                                        for c in v)):
                            raise SceneError(
                                f"parts[{i}].variants[{vn}][{j}] must be [x,y] in 0..1")
                        cv.append([float(v[0]), float(v[1])])
                    vv[vn] = cv
                q["variants"] = vv
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

# ── motion clips (BVH) ───────────────────────────────────────────────────────
# Free skeletal mocap drives declared bones: CMU clips ship with the module,
# any BVH from the media store plugs in the same way (paid mocap included).

_CLIP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "assets", "motions")
_CLIP_MAP_DEFAULT = {
    "upperArmR": ("RightArm", "RightForeArm"),
    "foreArmR": ("RightForeArm", "RightHand"),
    "upperArmL": ("LeftArm", "LeftForeArm"),
    "foreArmL": ("LeftForeArm", "LeftHand"),
    "thighR": ("RightUpLeg", "RightLeg"),
    "shinR": ("RightLeg", "RightFoot"),
    "thighL": ("LeftUpLeg", "LeftLeg"),
    "shinL": ("LeftLeg", "LeftFoot"),
    "footR": ("RightFoot", "RightToeBase"),
    "footL": ("LeftFoot", "LeftToeBase"),
    "spine": ("Hips", "Neck"),
    "neck": ("Neck", "Head"),
}
_CLIP_CACHE = {}


def _parse_bvh(path):
    if os.path.getsize(path) > 8_000_000:
        raise SceneError("BVH file too large (8MB cap)")
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    if "MOTION" not in text:
        raise SceneError("not a BVH file — no MOTION section")
    hier, motion = text.split("MOTION", 1)
    tokens = hier.replace("{", " { ").replace("}", " } ").split()
    joints, stack, col = [], [], 0
    i = 0
    while i < len(tokens):
        tk = tokens[i]
        if tk in ("ROOT", "JOINT"):
            name = tokens[i + 1].split(":")[-1]  # strip mixamorig: style prefixes
            joints.append({"name": name, "parent": stack[-1] if stack else -1,
                           "offset": np.zeros(3), "chans": []})
            i += 2
        elif tk == "{":
            stack.append(len(joints) - 1)
            i += 1
        elif tk == "}":
            stack.pop()
            i += 1
        elif tk == "End":
            depth = 0
            i += 2
            while i < len(tokens):
                if tokens[i] == "{":
                    depth += 1
                elif tokens[i] == "}":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
        elif tk == "OFFSET":
            joints[stack[-1]]["offset"] = np.array(
                [float(tokens[i + 1]), float(tokens[i + 2]), float(tokens[i + 3])])
            i += 4
        elif tk == "CHANNELS":
            n = int(tokens[i + 1])
            for c in range(n):
                joints[stack[-1]]["chans"].append((col + c, tokens[i + 2 + c]))
            col += n
            i += 2 + n
        else:
            i += 1
    lines = [ln for ln in motion.strip().splitlines() if ln.strip()]
    dt = 1.0 / 30
    rows = []
    for ln in lines:
        low = ln.strip()
        if low.startswith("Frames"):
            continue
        if low.startswith("Frame Time"):
            dt = float(low.split(":")[1])
            continue
        rows.append(low)
    if len(rows) > 12000:
        rows = rows[:12000]
    frames = np.array([r.split() for r in rows], dtype=np.float64)
    if frames.ndim != 2 or frames.shape[1] != col:
        raise SceneError(f"BVH motion is {frames.shape} but hierarchy declares "
                         f"{col} channels")
    return joints, frames, dt


def _euler_rots(frames, chans):
    """(N,3,3) local rotation from this joint's rotation channels, applied in
    the order the file lists them."""
    n = frames.shape[0]
    R = np.tile(np.eye(3), (n, 1, 1))
    for cidx, cname in chans:
        if not cname.endswith("rotation"):
            continue
        th = np.radians(frames[:, cidx])
        ca, sa = np.cos(th), np.sin(th)
        M = np.tile(np.eye(3), (n, 1, 1))
        if cname[0] == "X":
            M[:, 1, 1], M[:, 1, 2] = ca, -sa
            M[:, 2, 1], M[:, 2, 2] = sa, ca
        elif cname[0] == "Y":
            M[:, 0, 0], M[:, 0, 2] = ca, sa
            M[:, 2, 0], M[:, 2, 2] = -sa, ca
        else:
            M[:, 0, 0], M[:, 0, 1] = ca, -sa
            M[:, 1, 0], M[:, 1, 1] = sa, ca
        R = np.einsum("nij,njk->nik", R, M)
    return R


def _clip_curves(path, mirror=False, bone_map=None):
    """BVH → per-declared-bone screen-angle deltas vs frame 0 (side view)."""
    key = (path, os.path.getmtime(path), bool(mirror),
           json.dumps(bone_map, sort_keys=True) if bone_map else "")
    got = _CLIP_CACHE.get(key)
    if got is not None:
        return got
    joints, frames, dt = _parse_bvh(path)
    world_R, world_P = {}, {}
    for idx, j in enumerate(joints):
        Rl = _euler_rots(frames, j["chans"])
        pos_cols = {c[1][0]: c[0] for c in j["chans"] if c[1].endswith("position")}
        if j["parent"] < 0:
            P = np.stack([frames[:, pos_cols[a]] if a in pos_cols
                          else np.zeros(frames.shape[0]) for a in "XYZ"], axis=1)
            world_R[idx], world_P[idx] = Rl, P
        else:
            Rp, Pp = world_R[j["parent"]], world_P[j["parent"]]
            world_P[idx] = Pp + np.einsum("nij,j->ni", Rp, j["offset"])
            world_R[idx] = np.einsum("nij,njk->nik", Rp, Rl)
    by_name = {}
    for idx, j in enumerate(joints):
        by_name.setdefault(j["name"], idx)
    # facing = horizontal normal of the average shoulder line (works standing
    # in place or travelling); side view projects onto (facing, up)
    la, ra = by_name.get("LeftArm"), by_name.get("RightArm")
    if la is None or ra is None:
        la, ra = by_name.get("LeftUpLeg"), by_name.get("RightUpLeg")
    if la is None or ra is None:
        raise SceneError("BVH skeleton has no recognizable arm or leg joints")
    # facing = per-frame horizontal normal of the shoulder line, so a subject
    # who TURNS during the capture keeps presenting the same profile (a fixed
    # plane would flip left/right whenever the body rotates — measured on the
    # CMU boxing clip). Sign continuity frame-to-frame, then toes-point-forward
    # sets the global sign: un-mirrored clips ALWAYS face screen-right.
    sh = world_P[la] - world_P[ra]
    F = np.stack([sh[:, 2], np.zeros(sh.shape[0]), -sh[:, 0]], axis=1)
    ln = np.linalg.norm(F, axis=1, keepdims=True)
    F = np.where(ln > 1e-6, F / np.maximum(ln, 1e-9), np.array([[1.0, 0.0, 0.0]]))
    for k in range(1, F.shape[0]):
        if float(F[k] @ F[k - 1]) < 0:
            F[k] = -F[k]
    for fj, tj in (("RightFoot", "RightToeBase"), ("LeftFoot", "LeftToeBase")):
        fi, ti = by_name.get(fj), by_name.get(tj)
        if fi is not None and ti is not None:
            toe = world_P[ti] - world_P[fi]
            if float(np.einsum("ni,ni->n", toe, F).mean()) < 0:
                F = -F
            break
    amap = dict(bone_map or _CLIP_MAP_DEFAULT)
    curves = {}
    for our, pair in amap.items():
        pj, cj = by_name.get(str(pair[0])), by_name.get(str(pair[1]))
        if pj is None or cj is None:
            continue
        v = world_P[cj] - world_P[pj]
        ang = np.unwrap(np.arctan2(np.einsum("ni,ni->n", v, F), -v[:, 1]))
        delta = ang - ang[0]
        curves[our] = -delta if mirror else delta
    if not curves:
        raise SceneError("clip boneMap matched no joints in this BVH")
    got = {"curves": curves, "dt": dt, "n": frames.shape[0],
           "dur": frames.shape[0] * dt}
    if len(_CLIP_CACHE) > 8:
        _CLIP_CACHE.clear()
    _CLIP_CACHE[key] = got
    return got


def _clip_gain(g, i):
    """gain scales mocap amplitude per bone: a number, or {bone: k, '*': default}.
    The 2D projection turns a boxer's duck into a 90-degree fold — spine 0.3~0.4
    keeps punches while taming the weave."""
    if g is None:
        return {"*": 1.0}
    if isinstance(g, (int, float)):
        return {"*": max(0.0, min(2.0, float(g)))}
    if isinstance(g, dict):
        out = {}
        for k, v in g.items():
            if not isinstance(v, (int, float)):
                raise SceneError(f"layers[{i}].clip.gain.{k} must be a number")
            out[str(k)] = max(0.0, min(2.0, float(v)))
        out.setdefault("*", 1.0)
        return out
    raise SceneError(f"layers[{i}].clip.gain must be a number or {{bone: k}}")


_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "assets", "models")

def list_builtin_models():
    if not os.path.isdir(_MODEL_DIR):
        return []
    return sorted(fn[:-4] for fn in os.listdir(_MODEL_DIR) if fn.endswith(".glb"))

def _model_path(ref):
    r = str(ref or "").strip()
    if re.fullmatch(r"[a-z0-9_-]{1,40}", r):
        p = os.path.join(_MODEL_DIR, r + ".glb")
        if os.path.isfile(p):
            return p
        raise SceneError(
            f"unknown built-in model {r!r} — bundled: {list_builtin_models()}; "
            "or pass a media-store .glb path")
    return media_path(r)

def list_builtin_clips():
    try:
        return sorted(fn[:-4] for fn in os.listdir(_CLIP_DIR) if fn.endswith(".bvh"))
    except OSError:
        return []


# ── 2D keypose cycles ────────────────────────────────────────────────────────
# Hand-keyed cartoon cycles over the canonical bone names. Unlike mocap these
# read as drawn animation: distinct key poses, snappy arrivals, holds (duplicate
# keys), and squash. Degrees clockwise-positive, dy in viewBox units (neg = up),
# sy = vertical squash factor. Non-loop presets must end on a phase-1.0 key.
_ANIMS_2D = {
    "walk": {"dur": 0.8, "loop": True, "keys": [
        (0.0, {"ease": "snap", "dy": 0.4, "bones": {
            "thighR": -26, "shinR": 6, "footR": -6, "thighL": 22, "shinL": 28,
            "upperArmR": 36, "foreArmR": 22, "upperArmL": -36, "foreArmL": -24,
            "spine": -3}}),
        (0.25, {"ease": "smooth", "dy": -1.2, "bones": {
            "thighR": -4, "shinR": 34, "thighL": 2, "shinL": 6,
            "upperArmR": 6, "upperArmL": -6, "spine": -2}}),
        (0.5, {"ease": "snap", "dy": 0.4, "bones": {
            "thighL": -26, "shinL": 6, "footL": -6, "thighR": 22, "shinR": 28,
            "upperArmL": 36, "foreArmL": 22, "upperArmR": -36, "foreArmR": -24,
            "spine": -3}}),
        (0.75, {"ease": "smooth", "dy": -1.2, "bones": {
            "thighL": -4, "shinL": 34, "thighR": 2, "shinR": 6,
            "upperArmL": 6, "upperArmR": -6, "spine": -2}}),
    ]},
    "run": {"dur": 0.55, "loop": True, "keys": [
        (0.0, {"ease": "snap", "dy": 0.8, "sy": 0.97, "bones": {
            "thighR": -48, "shinR": 14, "thighL": 40, "shinL": 55,
            "upperArmR": 38, "foreArmR": 42, "upperArmL": -38, "foreArmL": -46,
            "spine": -10, "neck": 3}}),
        (0.25, {"ease": "smooth", "dy": -2.4, "sy": 1.04, "bones": {
            "thighR": -8, "shinR": 50, "thighL": 4, "shinL": 20,
            "upperArmR": 8, "foreArmR": 40, "upperArmL": -8, "foreArmL": -40,
            "spine": -9}}),
        (0.5, {"ease": "snap", "dy": 0.8, "sy": 0.97, "bones": {
            "thighL": -48, "shinL": 14, "thighR": 40, "shinR": 55,
            "upperArmL": 38, "foreArmL": 42, "upperArmR": -38, "foreArmR": -46,
            "spine": -10, "neck": 3}}),
        (0.75, {"ease": "smooth", "dy": -2.4, "sy": 1.04, "bones": {
            "thighL": -8, "shinL": 50, "thighR": 4, "shinR": 20,
            "upperArmL": 8, "foreArmL": 40, "upperArmR": -8, "foreArmR": -40,
            "spine": -9}}),
    ]},
    "idle": {"dur": 3.0, "loop": True, "keys": [
        (0.0, {"ease": "smooth", "dy": 0.0, "sy": 1.0, "bones": {
            "spine": 0, "neck": 0, "upperArmR": 0, "upperArmL": 0}}),
        (0.5, {"ease": "smooth", "dy": 0.7, "sy": 0.985, "bones": {
            "spine": 1.6, "neck": -2, "upperArmR": 2.5, "upperArmL": -2.5}}),
    ]},
    "punch": {"dur": 0.9, "loop": False, "keys": [
        (0.0, {"ease": "smooth", "bones": {}}),
        (0.33, {"ease": "smooth", "dy": 0.5, "sy": 0.96, "bones": {
            "upperArmR": 34, "foreArmR": 58, "spine": 9, "neck": 2,
            "thighR": 6, "thighL": -4}}),
        (0.46, {"ease": "snap", "dy": 0.2, "sy": 1.02, "bones": {
            "upperArmR": -82, "foreArmR": -4, "upperArmL": 18, "foreArmL": 30,
            "spine": -13, "neck": -4, "thighR": -8, "thighL": 10}}),
        (0.62, {"ease": "smooth", "dy": 0.2, "sy": 1.0, "bones": {
            "upperArmR": -82, "foreArmR": -4, "upperArmL": 18, "foreArmL": 30,
            "spine": -13, "neck": -4, "thighR": -8, "thighL": 10}}),
        (1.0, {"ease": "smooth", "bones": {}}),
    ]},
    "dance": {"dur": 0.9, "loop": True, "keys": [
        (0.0, {"ease": "overshoot", "dy": 0.6, "sy": 0.96, "bones": {
            "upperArmR": -150, "foreArmR": -18, "upperArmL": -26, "foreArmL": -38,
            "spine": -5, "neck": -3, "thighR": -4, "thighL": 4}}),
        (0.25, {"ease": "smooth", "dy": -1.8, "sy": 1.05, "bones": {
            "upperArmR": -95, "foreArmR": -25, "upperArmL": -95, "foreArmL": -25,
            "spine": 0}}),
        (0.5, {"ease": "overshoot", "dy": 0.6, "sy": 0.96, "bones": {
            "upperArmL": -150, "foreArmL": -18, "upperArmR": -26, "foreArmR": -38,
            "spine": 5, "neck": 3, "thighL": -4, "thighR": 4}}),
        (0.75, {"ease": "smooth", "dy": -1.8, "sy": 1.05, "bones": {
            "upperArmR": -95, "foreArmR": -25, "upperArmL": -95, "foreArmL": -25,
            "spine": 0}}),
    ]},
}

def _sample_anim(preset, ph):
    """Sample a keypose cycle at phase ph -> (bones deg, dy units, sy)."""
    keys = preset["keys"]
    if preset["loop"]:
        ph = ph % 1.0
        seq = keys + [(1.0 + keys[0][0], keys[0][1])]
    else:
        ph = clamp01(ph)
        seq = keys
    k0 = seq[0]
    for k1 in seq[1:]:
        if ph <= k1[0] or k1 is seq[-1]:
            span = max(1e-6, k1[0] - k0[0])
            e = ease2d(k1[1].get("ease", "smooth"), (ph - k0[0]) / span)
            b0 = k0[1].get("bones") or {}
            b1 = k1[1].get("bones") or {}
            bones = {n: b0.get(n, 0.0) + (b1.get(n, 0.0) - b0.get(n, 0.0)) * e
                     for n in set(b0) | set(b1)}
            dy = k0[1].get("dy", 0.0) + (k1[1].get("dy", 0.0) - k0[1].get("dy", 0.0)) * e
            sy = k0[1].get("sy", 1.0) + (k1[1].get("sy", 1.0) - k0[1].get("sy", 1.0)) * e
            return bones, dy, sy
        k0 = k1
    last = seq[-1][1]
    return dict(last.get("bones") or {}), last.get("dy", 0.0), last.get("sy", 1.0)

def _clip_path(decl):
    name = str(decl.get("name") or "").strip()
    if name:
        if not re.match(r"^[A-Za-z0-9_-]{1,32}$", name) \
                or name not in list_builtin_clips():
            raise SceneError(f"unknown clip {name!r} — built-ins: "
                             f"{list_builtin_clips()}; or pass media: a BVH path")
        return os.path.join(_CLIP_DIR, name + ".bvh")
    if decl.get("media"):
        return media_path(decl["media"])
    raise SceneError("clip needs name (built-in) or media (a BVH in the store)")


_CUTOUT_CACHE = {}


def _label_blobs(mask):
    """Two-pass connected components, 8-neighbour. numpy only — no scipy on this box."""
    H, W = mask.shape
    lab = np.zeros((H, W), np.int32)
    parent = [0]

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    nxt = 1
    for y in range(H):
        for x in np.where(mask[y])[0]:
            near = []
            if x > 0 and lab[y, x - 1]:
                near.append(lab[y, x - 1])
            if y > 0:
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if 0 <= xx < W and lab[y - 1, xx]:
                        near.append(lab[y - 1, xx])
            if not near:
                lab[y, x] = nxt
                parent.append(nxt)
                nxt += 1
            else:
                m = min(near)
                lab[y, x] = m
                for o in near:
                    union(m, o)
    flat = np.array([find(i) for i in range(nxt)], np.int32)
    return flat[lab]


# Chebyshev distance from the backdrop colour: at or under _KEY_NEAR is
# background, at or over _KEY_FAR is drawing, between the two is the
# anti-aliased edge and gets partial alpha.
_KEY_NEAR, _KEY_FAR = 40, 90
# An enclosed patch of backdrop bigger than this is taken to be part of the drawing.
_KEY_POCKET_MAX_FRAC = 0.0005


def _reach_from_border(mask):
    """Which True pixels a flood entering from the image edge can reach.

    The keyer only ever asked "does the border reach here", never "which blob is this", and
    the general labeller it was using walks every backdrop pixel in Python — 4.7s for one
    1024x1536 drawing, which made the one-frame-per-call path (seven files, each read three
    times) time out the caller. Scanline propagation answers the same question in a handful
    of whole-array passes: within one row, a run of mask survives if any reached pixel sits
    in it, which is a pair of running maxima.

    4-connected on purpose. It is the conservative direction — a one-pixel diagonal pinch
    stops the flood rather than letting it through into the drawing — and a pocket left
    behind by that is caught by the small-pocket rule below.
    """
    reach = np.zeros(mask.shape, bool)
    reach[0] = mask[0]
    reach[-1] = mask[-1]
    reach[:, 0] = mask[:, 0]
    reach[:, -1] = mask[:, -1]

    def sweep(m, r):
        n = m.shape[1]
        idx = np.arange(n)[None, :]
        wall = np.maximum.accumulate(np.where(~m, idx, -1), axis=1)
        seed = np.maximum.accumulate(np.where(r, idx, -1), axis=1)
        out = m & (seed > wall)
        rm, rr = m[:, ::-1], (r | out)[:, ::-1]
        wall = np.maximum.accumulate(np.where(~rm, idx, -1), axis=1)
        seed = np.maximum.accumulate(np.where(rr, idx, -1), axis=1)
        return out | (rm & (seed > wall))[:, ::-1]

    for _ in range(24):
        grown = sweep(mask, reach)
        grown = grown | sweep(mask.T, grown.T).T
        if grown.sum() == reach.sum():
            break
        reach = grown
    return reach


def _key_flat_background(im):
    """An RGBA sheet whose flat backdrop has been turned into real transparency.

    A drawn sheet's frames are told apart by their alpha. The generator does not
    always deliver one: asked for a transparent background it sometimes answers
    with RGB on a flat chroma backdrop and says so in as many words ("a removable
    flat chroma-key backdrop"). Both answers come back for the same prompt —
    measured 2026-08-30, an eight-frame sheet arrived RGBA and a four-frame one
    arrived RGB on green — so writing "transparent" more forcefully is not the
    fix. Both were asked for it. The import has to take either.

    The key colour is read off the sheet's own border, so nothing here knows what
    green is; a magenta or white backdrop keys the same way. A border that is not
    one flat colour is a picture, not a backdrop, and is returned untouched.
    """
    a = np.asarray(im)[:, :, 3]
    if int(a.min()) < 250:
        return im                      # already has an alpha channel of its own
    rgb = np.asarray(im)[:, :, :3].astype(np.int16)
    H, W, _ = rgb.shape
    if H < 8 or W < 8:
        return im
    ring = np.concatenate([rgb[:2].reshape(-1, 3), rgb[-2:].reshape(-1, 3),
                           rgb[:, :2].reshape(-1, 3), rgb[:, -2:].reshape(-1, 3)])
    bg = np.median(ring, 0).astype(np.int16)
    # Flat means flat: nearly the whole border sits on that one colour. A drawing
    # that runs to the edge fails this and keeps every pixel it has.
    if float((np.abs(ring - bg).max(1) <= _KEY_NEAR).mean()) < 0.90:
        return im
    dist = np.abs(rgb - bg).max(2)
    # Background is what the border reaches, not every pixel of that colour. Keying by
    # colour alone eats the subject wherever the subject shares it: measured 2026-08-30
    # on a swallow sheet drawn on a white checkerboard, the birds lost their white
    # bellies. An enclosed area is inside the drawing however pale it is, so the key
    # runs as a flood from the edge and stops at the outline.
    near = dist <= _KEY_FAR
    outside = _reach_from_border(near)
    if not outside.any():
        return im
    # A pocket the drawing encloses is backdrop too. The gap between this man's headband tail
    # and his neck is one, and the flood cannot reach it — it came through into a finished
    # video as a pink patch on his throat (2026-08-31). Only tiny ones are taken: an enclosed
    # area is usually PART of the drawing, which is the whole reason this keys by flood and
    # not by colour, and a swallow's white belly on a white backdrop is what that protects.
    # Measured the same day, the neck pockets were 122 px and 56 px on a 1536x1024 sheet
    # (0.008%), while a body part runs percent-scale. Folding them into `outside` rather than
    # zeroing them separately is what also gets them despilled below — the magenta fringe
    # around the pocket, not the pocket itself, was most of what showed.
    pocket_cap = max(64, int(H * W * _KEY_POCKET_MAX_FRAC))
    pockets = _label_blobs(near & ~outside)
    for pid in np.unique(pockets):
        if pid == 0:
            continue
        m = pockets == pid
        if int(m.sum()) <= pocket_cap:
            outside |= m
    alpha = np.ones(dist.shape, np.float32)
    alpha[outside] = np.clip(
        (dist[outside].astype(np.float32) - _KEY_NEAR) / float(_KEY_FAR - _KEY_NEAR),
        0.0, 1.0)
    kept = float((alpha > 0.5).mean())
    # Nothing keyed, or nearly everything keyed: the guess was wrong either way,
    # and a sheet emptied by a bad guess is worse than one we could not read.
    if kept < 0.005 or kept > 0.98:
        return im
    out = rgb.copy()
    # Despill — the backdrop bleeds into anti-aliased edges, which is what leaves a
    # coloured fringe around a cut-out. Cap whichever channel the backdrop is made
    # of, at the edge pixels only, where the spill lives.
    k = int(np.argmax(bg))
    if int(bg[k]) - int(np.sort(bg)[-2]) > 60:
        edge = outside & (alpha < 0.999)
        other = np.max(np.delete(out, k, axis=2), axis=2)
        ch = out[:, :, k]
        out[:, :, k] = np.where(edge, np.minimum(ch, other), ch)
    keyed = np.dstack([out.astype(np.uint8),
                       (alpha * 255).astype(np.uint8)])
    return Image.fromarray(keyed, "RGBA")


def load_sheet(path):
    """One drawn sheet, always with an alpha channel worth reading."""
    return _key_flat_background(Image.open(media_path(path)).convert("RGBA"))


def find_sheet_cells(path, min_frac=0.004):
    """Where each drawn frame sits on a sheet, found from the alpha.

    A generated animation sheet is not a tidy grid: the figures are unevenly
    spaced and their bounding boxes overlap, so splitting by column density cuts
    through a drawing — measured 2026-08-30, two of three cuts on a four-frame
    sheet landed at densities 28 and 37 and one frame lost its front foot in the
    finished video. Separate pixels are what a blob finds, and overlapping boxes
    do not fool it. Reading order is row-major, the order a sheet is drawn in.

    Rows are found by vertical OVERLAP, never by quantised bands. Figures stand
    bottom-anchored on a shared ground line, so a frame the generator drew a few
    percent short STARTS LOWER, and with fixed bands (y0 // 18% of sheet height)
    that start can fall across a band edge and sort the frame into the next row.
    Measured 2026-09-01: one short cell in a 2x2 walk sheet swapped play order
    with its neighbour, the left step ran contact -> passing -> weight, and the
    walk limped. Overlap has no edges to fall across.
    """
    im = load_sheet(path)
    a = np.asarray(im)[:, :, 3]
    H, W = a.shape
    lab = _label_blobs(a > 16)
    min_px = int(H * W * min_frac)
    out = []
    for i in np.unique(lab):
        if i == 0:
            continue
        ys, xs = np.where(lab == i)
        if len(ys) < min_px:
            continue
        out.append([int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())])
    if not out:
        raise SceneError(
            f"no frames found on {path!r} — frames are told apart by transparency, and "
            "this sheet has neither an alpha channel nor one flat backdrop colour to key "
            "out. Ask the image generator for a transparent background, or for a plain "
            "single-colour backdrop the import can remove")
    out.sort(key=lambda b: b[1])
    rows = []
    for b in out:
        for r in rows:
            ov = min(r["y1"], b[3]) - max(r["y0"], b[1])
            if ov > 0.5 * min(b[3] - b[1], r["y1"] - r["y0"]):
                r["boxes"].append(b)
                r["y0"] = min(r["y0"], b[1])
                r["y1"] = max(r["y1"], b[3])
                break
        else:
            rows.append({"y0": b[1], "y1": b[3], "boxes": [b]})
    rows.sort(key=lambda r: r["y0"])
    return [b for r in rows for b in sorted(r["boxes"], key=lambda b: b[0])]


def _cutout_piece(q, crop=None):
    """Load, polygon-crop and alpha-mask one image part; cached per (media, crop).

    `crop` overrides the part's own - that is how a named variant is drawn without
    a second declaration or a second file."""
    crop = crop or q["crop"]
    key = (q["media"], json.dumps(crop), bool(q.get("flip")))
    got = _CUTOUT_CACHE.get(key)
    if got is not None:
        return got
    src = Image.open(media_path(q["media"])).convert("RGBA")
    w0, h0 = src.size
    poly = [(p[0] * w0, p[1] * h0) for p in crop]
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    x0 = max(0, int(min(xs))); y0 = max(0, int(min(ys)))
    x1 = min(w0, int(max(xs)) + 1); y1 = min(h0, int(max(ys)) + 1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        raise SceneError(f"image part crop of {q['media']!r} is degenerate")
    piece = src.crop((x0, y0, x1, y1))
    mask = Image.new("L", piece.size, 0)
    ImageDraw.Draw(mask).polygon([(px - x0, py - y0) for px, py in poly], fill=255)
    piece.putalpha(ImageChops.multiply(piece.getchannel("A"), mask))
    if q.get("flip"):
        piece = piece.transpose(Image.FLIP_LEFT_RIGHT)
    if len(_CUTOUT_CACHE) > 48:
        _CUTOUT_CACHE.clear()
    _CUTOUT_CACHE[key] = piece
    return piece


def draw_custom(d, cx, cy, s, t, parts, mouth=0.0, wave=0.0, walk=0.0,
                sy=1.0, blink_t=None, g=None, text="", fonts=None, canvas=None,
                bones=None, bone_angles=None, express=None):
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
    bone_ms = _bone_affines(bones, bone_angles or {}) if bones else {}
    for q in parts:
        role = q.get("role")
        if q["shape"] == "image":
            if canvas is None:
                continue
            # A named expression swaps this part's crop for its own. Parts that do
            # not carry that name are untouched, so one act changes the face while
            # the body it belongs to keeps moving.
            piece = _cutout_piece(q, (q.get("variants") or {}).get(express))
            wpx = max(2, int(q["width"] * u * sxw))
            hpx = max(2, int(wpx * piece.height / max(1, piece.width) * sy))
            if role == "eye":
                hpx = max(2, int(hpx * eh))
            im = piece.resize((wpx, hpx), Image.LANCZOS)
            ang, dx_u, dy_u = 0.0, 0.0, 0.0
            if role == "swing":
                ang = swing_ang
            elif role == "flap":
                ang = flap_ang * (1.0 if q.get("pivot", q["at"])[0] >= 50 else -1.0)
            elif role == "flicker":
                dx_u = flick
            elif role == "foot":
                sign = 1.0 if q["at"][0] >= 50 else -1.0
                dx_u = sign * step * 3.5
                dy_u = -max(0.0, sign * step) * 2.5
            elif role == "mouth":
                m = clamp01(mouth)
                dy_u = 4.5 * m
                ang = 0.10 * m * (1.0 if q.get("pivot", q["at"])[0] >= 50 else -1.0)
            bm = bone_ms.get(q.get("bone"))
            ax, ay = q["at"][0] + dx_u, q["at"][1] + dy_u
            pvx_u, pvy_u = q.get("pivot", q["at"])
            bang = 0.0
            if bm is not None:
                ax, ay = _affine_apply(bm, ax, ay)
                pvx_u, pvy_u = _affine_apply(bm, pvx_u, pvy_u)
                bang = math.atan2(bm[3], bm[0])
            px_c, py_c = to_px(ax, ay)
            total_ang = ang + bang
            if abs(total_ang) > 1e-4:
                if abs(ang) > 1e-4:
                    pvx, pvy = to_px(pvx_u, pvy_u)
                    ca, sa = math.cos(ang), math.sin(ang)
                    rx, ry = px_c - pvx, py_c - pvy
                    px_c, py_c = pvx + rx * ca - ry * sa, pvy + rx * sa + ry * ca
                im = im.rotate(-math.degrees(total_ang), resample=Image.BICUBIC,
                               expand=True)
            canvas.paste(im, (int(px_c - im.width / 2), int(py_c - im.height / 2)), im)
            continue
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
            bm = bone_ms.get(q.get("bone"))
            if bm is not None:
                x, y = _affine_apply(bm, x, y)
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

def _tile_seamless(mono, n, rate, xfade_sec=0.25):
    """Repeat `mono` until it covers n samples, overlapping each join with an
    equal-power crossfade so the loop point is not an audible click. The first
    repetition keeps its natural attack; every later one fades in under the
    previous one's fade-out (sin/cos hold the sum's power constant).
    """
    xf = int(min(xfade_sec * rate, len(mono) // 4))
    period = max(1, len(mono) - xf)
    buf = np.zeros(n + len(mono))
    if xf > 0:
        ramp = np.linspace(0, np.pi / 2, xf, endpoint=False)
        fade_in, fade_out = np.sin(ramp), np.cos(ramp)
    pos, first = 0, True
    while pos < n:
        seg = mono.copy()
        if xf > 0:
            if not first:
                seg[:xf] *= fade_in
            seg[-xf:] *= fade_out
        buf[pos:pos + len(seg)] += seg
        pos += period
        first = False
    return buf

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
    # user/attachments/ carries tts output — the same workspace trust domain as the
    # media store (measured 8/25: every dialogue line lands there and was refused).
    if ".." in parts or not (
            r.startswith("user/media/") or r.startswith("system/media/")
            or r.startswith("user/attachments/") or r.startswith("data/")):
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
        # What had to be moved to stay on the canvas — reported with the render so an
        # author sees it instead of finding a cropped row in the finished mp4.
        self.layout_fixes = []
        texts = []
        for i, L in enumerate(layers):
            if not isinstance(L, dict) or "kind" not in L:
                raise SceneError(f"layers[{i}] needs a 'kind'")
            kind = L["kind"]
            if kind not in ("sprite", "bubble", "title", "caption", "card", "list",
                            "image", "fireworks", "hearts", "confetti", "model3d",
                            "spark", "shake", "speedlines", "hpbar", "spritesheet",
                            "math"):
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
            if kind == "math":
                tex = str(L.get("tex") or "").strip()
                if not tex:
                    raise SceneError(
                        f"layers[{i}]: a math layer needs `tex` — the formula itself, "
                        "e.g. tex: \"f^{-1}(x)=\\\\frac{5x-x^3}{2}\"")
                if len(tex) > TEXT_MAX:
                    raise SceneError(f"layers[{i}].tex exceeds {TEXT_MAX} chars")
                L["tex"] = tex
            if kind == "image":
                L["_path"] = media_path(L.get("media"))
            if kind == "spritesheet":
                L["_path"] = media_path(L.get("media"))
                # grid = [cols, rows] in ONE field — "rows" alone would collide
                # with card/list rows (a list of text rows) and one field must
                # keep one meaning across the layer vocabulary
                grid = L.get("grid")
                if not (isinstance(grid, (list, tuple)) and len(grid) == 2):
                    raise SceneError(f"layers[{i}].grid must be [cols, rows]")
                L["_cols"] = int(_num(grid[0], f"layers[{i}].grid[0]", 1, 32))
                L["_rows"] = int(_num(grid[1], f"layers[{i}].grid[1]", 1, 32))
                ncell = L["_cols"] * L["_rows"]
                L["_count"] = int(_num(L.get("count", ncell),
                                       f"layers[{i}].count", 1, ncell))
                L["_fps"] = _num(L.get("fps", 12), f"layers[{i}].fps", 1, 60)
            if kind == "fireworks":
                L["_launches"] = self._launches(i, L)
            if kind == "sprite" and L.get("clip"):
                cd = L["clip"]
                if not isinstance(cd, dict):
                    raise SceneError(f"layers[{i}].clip must be an object — "
                                     "{name|media, speed?, loop?, mirror?, boneMap?}")
                cur = _clip_curves(_clip_path(cd), mirror=bool(cd.get("mirror")),
                                   bone_map=cd.get("boneMap"))
                L["_clip"] = {"curves": cur["curves"], "dur": cur["dur"],
                              "dt": cur["dt"], "n": cur["n"],
                              "speed": max(0.1, min(4.0, float(cd.get("speed", 1.0)))),
                              "loop": bool(cd.get("loop", True)),
                              "start": max(0.0, float(cd.get("start", 0.0))),
                              "gain": _clip_gain(cd.get("gain"), i)}
            if kind == "model3d":
                try:
                    L["_model"] = gltf3d.load(_model_path(L.get("media", "robot")))
                except gltf3d.GlbError as e:
                    raise SceneError(f"layers[{i}].media: {e}")
                names = set(L["_model"].clips)
                plays = L.get("plays")
                if plays is None:
                    plays = [{"clip": L["clip"], "at": L["from"]}] if L.get("clip") else []
                if not isinstance(plays, list) or len(plays) > 20:
                    raise SceneError(f"layers[{i}].plays must be a list of at most 20")
                norm = []
                for j, p in enumerate(plays):
                    if not isinstance(p, dict) or not p.get("clip"):
                        raise SceneError(f"layers[{i}].plays[{j}] must be {{clip, at?}}")
                    cn = str(p["clip"])
                    if cn not in names:
                        raise SceneError(
                            f"layers[{i}]: clip {cn!r} is not in this model — the "
                            f"model_info action lists them ({sorted(names)[:16]})")
                    norm.append({"clip": cn,
                                 "at": _num(p.get("at", L["from"]),
                                            f"layers[{i}].plays[{j}].at", 0, self.dur)})
                norm.sort(key=lambda p: p["at"])
                L["_plays"] = norm
                L["_speed"] = _num(L.get("speed", 1.0), f"layers[{i}].speed", 0.1, 4.0)
                L["_height"] = _num(L.get("height", 0.55), f"layers[{i}].height", 0.1, 1.2)
                L["_yaw"] = _num(L.get("yaw", 22), f"layers[{i}].yaw", -180, 180)
                tint = L.get("tint")
                if tint is not None:
                    L["_tint"] = [c / 255.0 for c in _rgb(tint, f"layers[{i}].tint",
                                                          alpha_ok=False)]
            if kind == "spark":
                rng = random.Random(101 + i)
                L["_rays"] = [(rng.uniform(0, 2 * math.pi), rng.uniform(0.7, 1.3))
                              for _ in range(12)]
            if kind == "speedlines":
                rng = random.Random(202 + i)
                L["_lines"] = [(rng.random(), rng.uniform(0.14, 0.42),
                                rng.uniform(2.0, 5.0), rng.random())
                               for _ in range(14)]
            if kind in ("list", "card"):
                self._fit_rows(i, L)
            self.layers.append(L)
        bg = inp.get("background") or {"kind": "night"}
        if not isinstance(bg, dict) or bg.get("kind") not in ("night", "gradient",
                                                              "image", "studio"):
            raise SceneError("background.kind must be night | gradient | image | studio")
        self.bg_decl = bg
        if bg["kind"] == "image":
            bg["_path"] = media_path(bg.get("media"))
        vdef = {"night": 0.22, "studio": 0.16, "gradient": 0.15, "image": 0.25}
        self.vignette = _num(bg.get("vignette", vdef[bg["kind"]]),
                             "background.vignette", 0, 0.6)
        self._vign_map = None
        # camera — scene-wide zoom/pan keyframes ("zoom into the city while its
        # line is spoken"). Missing primitive measured 2026-08-26: per-city
        # close-ups were faked by swapping whole map images per segment.
        cam = inp.get("camera") or []
        if not isinstance(cam, list) or len(cam) > 12:
            raise SceneError("camera must be a list of at most 12 keyframes")
        self.camera = []
        for i, k in enumerate(cam):
            if not isinstance(k, dict):
                raise SceneError(f"camera[{i}] must be {{at, zoom?, center?, in?}}")
            at = _num(k.get("at", 0), f"camera[{i}].at", 0, self.dur)
            zoom = _num(k.get("zoom", 1.0), f"camera[{i}].zoom", 1.0, 4.0)
            ctr = k.get("center", [0.5, 0.5])
            if not (isinstance(ctr, (list, tuple)) and len(ctr) == 2):
                raise SceneError(f"camera[{i}].center must be [x,y] (0..1)")
            cx = _num(ctr[0], f"camera[{i}].center[0]", 0, 1)
            cy = _num(ctr[1], f"camera[{i}].center[1]", 0, 1)
            ease_in = _num(k.get("in", 0.8), f"camera[{i}].in", 0.05, 10)
            self.camera.append((at, zoom, cx, cy, ease_in))
        self.camera.sort(key=lambda k: k[0])
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
        # A track shorter than the scene used to leave the tail silent with nothing
        # said about it — the duration cap going 20s -> 90s made that the common case.
        self.bgm_loop = bool(audio.get("bgmLoop", True))
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
        out = [str(L.get("text") or ""), str(L.get("label") or "")]
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
            dt, db = ((244, 246, 251), (212, 219, 233)) if kind == "studio" \
                else ((9, 13, 30), (24, 32, 58))
            top = tuple(self.bg_decl.get("top", dt))
            bot = tuple(self.bg_decl.get("bottom", db))
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
            elif kind == "studio":
                # a bright presenter stage: soft spotlight pool, floor line,
                # gentle contact shading — made for caster / info videos
                img = Image.fromarray(arr)
                bd = ImageDraw.Draw(img, "RGBA")
                fy = SH * 0.845
                for rr, aa in ((1.5, 26), (1.15, 30), (0.85, 34)):
                    bd.ellipse([SW * 0.5 - SW * 0.62 * rr, SH * 0.06 - SH * 0.30 * rr,
                                SW * 0.5 + SW * 0.62 * rr, SH * 0.06 + SH * 0.62 * rr],
                               fill=(255, 255, 255, aa))
                bd.rectangle([0, fy, SW, SH], fill=(198, 205, 221))
                bd.line([0, fy, SW, fy], fill=(172, 180, 200), width=max(2, int(3 * ss)))
                bd.ellipse([SW * 0.08, fy - 26 * ss, SW * 0.92, fy + 60 * ss],
                           fill=(255, 255, 255, 42))
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
        out = np.asarray(img).astype(np.float32) + \
            np.asarray(glow.filter(ImageFilter.GaussianBlur(6 * ss))).astype(np.float32)
        if self.vignette > 0:
            if self._vign_map is None:
                yy = (np.linspace(-1, 1, SH) * (SH / max(SW, SH)))[:, None]
                xx = (np.linspace(-1, 1, SW) * (SW / max(SW, SH)))[None, :]
                r = np.sqrt(xx * xx + yy * yy)
                r /= max(r[0, 0], r[-1, -1], 1e-6)
                self._vign_map = (1.0 - self.vignette
                                  * np.clip(r, 0, 1) ** 2.4).astype(np.float32)[..., None]
            out *= self._vign_map
        frame = Image.fromarray(out.clip(0, 255).astype(np.uint8))
        if self.ss != 1.0:
            frame = frame.resize((self.W, self.H), Image.LANCZOS)
        fade = min(clamp01(t / 0.5), clamp01((self.dur - 0.1 - t) / 0.55))
        if fade < 1:
            frame = Image.fromarray((np.asarray(frame) * fade).astype(np.uint8))
        if self.camera:
            z, ccx, ccy = self._camera_state(t)
            if z > 1.001:
                cw, ch = self.W / z, self.H / z
                x0 = min(max(ccx * self.W - cw / 2, 0), self.W - cw)
                y0 = min(max(ccy * self.H - ch / 2, 0), self.H - ch)
                frame = frame.crop((int(x0), int(y0),
                                    int(x0 + cw), int(y0 + ch)))                     .resize((self.W, self.H), Image.LANCZOS)
        arr = np.asarray(frame)
        sdx = sdy = 0.0
        for L in self.layers:
            if L["kind"] != "shake":
                continue
            aw = win(t, L["from"], L["to"], 0.03, max(0.2, (L["to"] - L["from"]) * 0.7))
            if aw <= 0:
                continue
            amp = min(60.0, max(0.0, float(L.get("amp", 14)))) * (self.W / 1080.0)
            sdx += amp * aw * math.sin((t - L["from"]) * 61)
            sdy += amp * aw * 0.6 * math.sin((t - L["from"]) * 47 + 1.3)
        if abs(sdx) >= 1 or abs(sdy) >= 1:
            iy = np.clip(np.arange(self.H) + int(round(sdy)), 0, self.H - 1)
            ix = np.clip(np.arange(self.W) + int(round(sdx)), 0, self.W - 1)
            arr = np.ascontiguousarray(arr[iy][:, ix])
        if arr.shape != (self.H, self.W, 3):
            raise SceneError(f"frame shape drifted: {arr.shape}")
        return arr

    def _camera_state(self, t):
        """(zoom, cx, cy) at time t — each keyframe eases in from the previous
        state over its own `in` seconds, then holds."""
        state = (1.0, 0.5, 0.5)
        for (at, z, cx, cy, ease_in) in self.camera:
            if t < at:
                break
            f = eo3(clamp01((t - at) / ease_in))
            state = (state[0] + (z - state[0]) * f,
                     state[1] + (cx - state[1]) * f,
                     state[2] + (cy - state[2]) * f)
        return state

    # Row heights the two growing kinds draw with — kept beside the fitter so the
    # arithmetic here and in _draw_list/_draw_card cannot drift apart.
    LIST_ROW, LIST_TALL, LIST_PLAIN = 158, 150, 128
    CARD_PAD, CARD_ROW, CARD_SHADOW = 50, 130, 12

    def _fit_rows(self, i, L):
        """Keep a list/card inside the canvas.

        `at` is the TOP of these two kinds and they grow downward one row at a time, so a
        y that looks like the middle of the frame puts the last row past the bottom edge.
        Measured 2026-08-29: at [0.36, 0.59] with three rows ended at 1081px of a 1080px
        canvas and row `03` was gone from the finished video with nothing said about it.

        Cropping in silence is the one outcome worth spending code to avoid — a render is
        minutes long and the author sees the loss only after it finishes. Refusing would
        cost that same round, so the box is moved up to fit and the move is reported.
        """
        rows = L.get("rows") or []
        if not rows:
            return
        if L["kind"] == "list":
            last_tall = bool((rows[-1] or {}).get("highlight"))
            h = (len(rows) - 1) * self.LIST_ROW + (self.LIST_TALL if last_tall
                                                   else self.LIST_PLAIN)
        else:
            h = self.CARD_PAD + self.CARD_ROW * len(rows) + self.CARD_SHADOW
        # ss cancels: the draw code scales both the offsets and the canvas by it.
        hn = h / float(self.H)
        top = (L.get("at") or [0.5, 0.30 if L["kind"] == "list" else 0.10])[1]
        if top + hn <= 1.0:
            return
        fitted = max(0.0, 1.0 - hn)
        at = list(L.get("at") or [0.5, top])
        at[1] = fitted
        L["at"] = at
        self.layout_fixes.append(
            f"layers[{i}] ({L['kind']}, {len(rows)} rows) reached y={top + hn:.2f} — "
            f"`at` is this kind's TOP, so it was moved up to {fitted:.2f} to stay on "
            f"the canvas. Place it yourself at or above that to control the spacing.")

    def _at(self, L, default):
        at = L.get("at") or default
        return at[0] * self.SW, at[1] * self.SH

    def _move_acts(self, L, t, x, y):
        """Where a sprite's move acts have carried it by time `t`, in pixels.

        Shared by both sprite paths. A drawn-sheet character read `at` straight off
        the layer and never came here, so a move act was accepted, validated and
        silently ignored — measured 2026-08-30 on a flying swallow that stayed put
        for three seconds. Anything that travels without a walking stride (a bird, a
        thrown ball, a car) has no other way across the screen.
        """
        for act in sorted((a for a in L.get("acts") or []
                           if str(a.get("do")) == "move"),
                          key=lambda a: float(a.get("at", L["from"]))):
            at = float(act.get("at", L["from"]))
            if t < at:
                break
            to = act.get("to")
            if not (isinstance(to, (list, tuple)) and len(to) == 2):
                raise SceneError("move act needs to:[x,y] (0..1 screen coords)")
            mdur = max(0.05, float(act.get("for", 0.6)))
            ease_m = str(act.get("ease", "smooth"))
            if ease_m not in _EASE_NAMES:
                raise SceneError(f"move ease must be one of {sorted(_EASE_NAMES)}")
            f = ease2d(ease_m, (t - at) / mdur)
            tx, ty = clamp01(float(to[0])) * self.SW, clamp01(float(to[1])) * self.SH
            x, y = x + (tx - x) * f, y + (ty - y) * f
        return x, y

    def _draw_sprite(self, d, g, t, a, L):
        name = str(L.get("name", "firebat"))
        saved = load_custom_asset(name)
        if saved is None:
            raise SceneError(
                f"unknown sprite {name!r} — assets lists seed and saved clip art; "
                "save one first with save_asset")
        # A character whose asset carries drawn sheets plays those frames instead of
        # being posed. Nothing is warped or interpolated: each frame is a drawing, and
        # they are shown one after another, which is what animation is.
        if saved.get("sheets"):
            return self._draw_sheet_sprite(t, a, L, saved["sheets"])
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
        x, y = self._move_acts(L, t, x, y)
        mouth, wave, sy = 0.0, 0.0, 1.0
        express = None
        jump_h = 0.0
        point_s, point_to = 0.0, None
        bones_decl = saved.get("bones") or {}
        bone_angles = {}
        pose_acts = sorted((act for act in L.get("acts") or []
                            if str(act.get("do")) == "pose"),
                           key=lambda act: float(act.get("at", L["from"])))
        pose_sy = 1.0
        for act in pose_acts:
            at = float(act.get("at", L["from"]))
            if t < at:
                break
            dur = max(0.05, float(act.get("for", 0.4)))
            ease = str(act.get("ease", "smooth"))
            if ease not in _EASE_NAMES:
                raise SceneError(f"pose ease must be one of {sorted(_EASE_NAMES)}")
            f = ease2d(ease, (t - at) / dur)
            if "squash" in act:
                sq = float(act["squash"])
                if not 0.4 <= sq <= 1.6:
                    raise SceneError("pose squash must be 0.4..1.6")
                pose_sy = pose_sy + (sq - pose_sy) * clamp01(f)
            tgt = act.get("bones")
            if not isinstance(tgt, dict) or not tgt:
                if "squash" in act:
                    continue
                raise SceneError("pose act needs bones:{name: degrees}")
            for bn, deg in tgt.items():
                if bn not in bones_decl:
                    raise SceneError(
                        f"pose act bone {bn!r} is not declared — this asset has "
                        f"{sorted(bones_decl) if bones_decl else 'no bones'}")
                cur = bone_angles.get(bn, 0.0)
                bone_angles[bn] = cur + (math.radians(float(deg)) - cur) * f
        anim_dy, anim_sy = 0.0, 1.0
        anim_acts = sorted((act for act in L.get("acts") or []
                            if str(act.get("do")) == "anim"),
                           key=lambda act: float(act.get("at", L["from"])))
        for act in anim_acts:
            nm = str(act.get("name", ""))
            preset = _ANIMS_2D.get(nm)
            if preset is None:
                raise SceneError(f"anim name must be one of {sorted(_ANIMS_2D)}")
            if not bones_decl:
                raise SceneError(
                    f"sprite {name!r} has an anim act but the asset declares no "
                    "bones — declare bones and tag parts with bone:'...' first")
            speed = float(act.get("speed", 1.0))
            if not 0.1 <= speed <= 4.0:
                raise SceneError("anim speed must be 0.1..4")
            at = float(act.get("at", L["from"]))
            base_dur = preset["dur"] / speed
            forv = float(act.get("for", 2.0 if preset["loop"] else base_dur))
            w = win(t, at, at + forv, 0.2, 0.25)
            if w <= 0:
                continue
            bones_t, dy_t, sy_t = _sample_anim(preset, (t - at) / base_dur)
            drove = False
            for bn, deg in bones_t.items():
                if bn not in bones_decl:
                    continue
                drove = True
                cur = bone_angles.get(bn, 0.0)
                bone_angles[bn] = cur + (math.radians(deg) - cur) * w
            if not drove and bones_t:
                raise SceneError(
                    f"anim {nm!r} drives none of this asset's bones — it keys the "
                    "canonical names (upperArmR/L, foreArmR/L, thighR/L, shinR/L, "
                    "footR/L, spine, neck)")
            anim_dy += dy_t * w
            anim_sy *= 1.0 + (sy_t - 1.0) * w
        clip = L.get("_clip")
        if clip:
            if not bones_decl:
                raise SceneError(
                    f"sprite {name!r} has a clip but the asset declares no bones — "
                    "declare bones and tag parts with bone:'...' first")
            tc = (t - L["from"]) * clip["speed"] + clip["start"]
            tc = tc % clip["dur"] if clip["loop"] else min(tc, clip["dur"] - 1e-6)
            fi = max(0, min(clip["n"] - 1, int(tc / clip["dt"])))
            cw = win(t, L["from"], L["to"], 0.3, 0.3)
            gain = clip.get("gain") or {"*": 1.0}
            for bn, arr in clip["curves"].items():
                if bn in bones_decl:
                    gv = gain.get(bn, gain["*"])
                    base = bone_angles.get(bn, 0.0)
                    bone_angles[bn] = base + (float(arr[fi]) * gv - base) * cw
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
            elif kind == "point":
                pw = win(t, at, at + dur, 0.25, 0.3)
                if pw > point_s:
                    to = act.get("to") or [0.7, 0.4]
                    point_s = pw
                    point_to = (clamp01(float(to[0])), clamp01(float(to[1])))
            elif kind == "express":
                # Last one wins inside an overlap: two expressions at once is not a
                # face, and picking the later act is what the timeline already means.
                if at <= t < at + dur:
                    want = str(act.get("as") or "").strip()
                    if not want:
                        raise SceneError(
                            "sprite act express needs {do:'express', as:'<variant "
                            "name>', at, for} - the name comes from a part's variants")
                    express = want
            elif kind in ("pose", "anim", "move"):
                pass  # blended above, in timeline order
            else:
                raise SceneError(
                    f"sprite act {kind!r} — one of wave, talk, jump, point, "
                    "pose, anim, move, express")
        sy *= pose_sy * anim_sy
        jump_h += -anim_dy * 4.0 * s
        point_arm = None
        if point_s > 0 and point_to is not None and bones_decl:
            # a rig with an arm chain aims the arm itself at the target
            txp0, typ0 = point_to[0] * SW, point_to[1] * SH
            side = "R" if txp0 >= x else "L"
            for sd in (side, "L" if side == "R" else "R"):
                up, fore = f"upperArm{sd}", f"foreArm{sd}"
                if up in bones_decl and fore in bones_decl:
                    u = 4.0 * s
                    sh = bones_decl[up]["pivot"]
                    el = bones_decl[fore]["pivot"]
                    xd = 50 + (txp0 - x) / u
                    yd = 100 - ((y - jump_h) - typ0) / u
                    rest = math.atan2(el[1] - sh[1], el[0] - sh[0])
                    want = math.atan2(yd - sh[1], xd - sh[0])
                    ang = (want - rest + math.pi) % (2 * math.pi) - math.pi
                    wig = 0.05 * math.sin(t * 2 * math.pi * 2.2)
                    bone_angles[up] = (ang + wig) * point_s
                    bone_angles.setdefault(fore, 0.0)
                    point_arm = (up, fore)
                    break
        draw_custom(d, x, y - jump_h, s, t, custom, mouth=mouth, wave=wave,
                    walk=walk, sy=sy, blink_t=blink_phase(t), g=g,
                    fonts=self.fonts, canvas=self._frame_img,
                    bones=bones_decl or None, bone_angles=bone_angles,
                    express=express)
        if point_s > 0 and point_to is not None:
            # weather-caster pointer v2: a rigid hand-held stick AIMED at the
            # target (never a screen-long pole, never a floating rod), the arm
            # itself aiming when the rig has bones; pulse ring marks the spot
            ss_ = self.ss
            u = 4.0 * s
            txp, typ = point_to[0] * SW, point_to[1] * SH
            if point_arm is not None:
                up, fore = point_arm
                ms = _bone_affines(bones_decl, bone_angles)
                ex, ey = _affine_apply(ms[fore], *bones_decl[fore]["pivot"])
                hx = x + (ex - 50) * u
                hy = (y - jump_h) - (100 - ey) * u
            else:
                hand_v = (86, 70) if txp >= x else (14, 70)
                hx = x + (hand_v[0] - 50) * u
                hy = (y - jump_h) - (100 - hand_v[1]) * u
            dx, dy = txp - hx, typ - hy
            dist = math.hypot(dx, dy) or 1.0
            wig = 0.05 * math.sin(t * 2 * math.pi * 2.2) * point_s
            base = math.atan2(dy, dx) + wig
            length = min(44 * u, dist * 0.88) * point_s
            x1 = hx + math.cos(base) * length
            y1 = hy + math.sin(base) * length
            al = point_s * a
            d.line([hx, hy, x1, y1], fill=(226, 230, 240, int(235 * al)),
                   width=max(2, int(7 * ss_)))
            d.ellipse([x1 - 10 * ss_, y1 - 10 * ss_, x1 + 10 * ss_, y1 + 10 * ss_],
                      fill=(255, 196, 80, int(255 * al)))
            tap = abs(math.sin(t * 2 * math.pi * 2.2))
            rr = (26 + 12 * tap) * ss_
            d.ellipse([txp - rr, typ - rr, txp + rr, typ + rr],
                      outline=(255, 214, 120, int(210 * al)),
                      width=max(2, int(5 * ss_)))
            r2 = rr * 1.55
            d.ellipse([txp - r2, typ - r2, txp + r2, typ + r2],
                      outline=(255, 214, 120, int(80 * al)),
                      width=max(2, int(3 * ss_)))

    def _draw_model3d(self, d, g, t, a, L):
        m = L["_model"]
        x, y = self._at(L, [0.5, 0.88])
        px_h = L["_height"] * self.SH
        speed, plays = L["_speed"], L["_plays"]
        prev = cur = None
        for p in plays:
            if t >= p["at"]:
                prev, cur = cur, p
            else:
                break
        if cur is None:
            verts = m.posed_verts(None, 0.0)
        else:
            tcur = (t - cur["at"]) * speed
            xfade = 0.35
            if prev is not None and (t - cur["at"]) < xfade:
                w = (t - cur["at"]) / xfade
                verts = m.posed_verts(prev["clip"], (t - prev["at"]) * speed,
                                      blend=(cur["clip"], tcur, w))
            else:
                verts = m.posed_verts(cur["clip"], tcur)
        lo, hi = m.rest_bounds
        scale = px_h / max(1e-6, float(hi[1] - lo[1]))
        rw = max(20 * self.ss, float(hi[0] - lo[0]) * scale * 0.62)
        d.ellipse([x - rw, y - rw * 0.17, x + rw, y + rw * 0.17],
                  fill=(10, 14, 24, int(70 * a)))
        gltf3d.draw_model(d, m, verts, x, y, px_h, L["_yaw"], a,
                          tint=L.get("_tint"))

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
        segs = _split_math(txt)
        cx, y = self._at(L, [0.5, 0.855])
        mh = int(f.size * 0.92)
        parts, tw = [], 0.0
        for is_math, s in segs:
            if is_math:
                im = _mathtext_rgba(s, INK, mh)
                parts.append((True, im, im.width))
                tw += im.width
            else:
                w = d.textlength(s, font=f)
                parts.append((False, s, w))
                tw += w
        d.rounded_rectangle([cx - tw / 2 - 26 * ss + 3 * ss, y - 14 * ss + 8 * ss,
                             cx + tw / 2 + 26 * ss + 3 * ss, y + f.size + 14 * ss + 8 * ss],
                            radius=26 * ss, fill=(4, 6, 14, int(55 * a)))
        d.rounded_rectangle([cx - tw / 2 - 26 * ss, y - 14 * ss,
                             cx + tw / 2 + 26 * ss, y + f.size + 14 * ss],
                            radius=26 * ss, fill=(8, 10, 20, int(150 * a)))
        x = cx - tw / 2
        for is_math, val, w in parts:
            if is_math:
                if self._frame_img is not None:
                    m = val.getchannel("A")
                    if a < 1:
                        m = m.point(lambda v, _a=a: int(v * _a))
                    self._frame_img.paste(val.convert("RGB"),
                                          (int(x), int(y + (f.size - val.height) / 2 + f.size * 0.12)), m)
            else:
                d.text((x, y), val, font=f, fill=(*INK, int(255 * a)))
            x += w

    def _draw_math(self, d, g, t, a, L):
        """A formula written straight onto the board from the scene's own `tex` string.

        No browser, no screenshot, no image file: the scene says what the maths IS and
        the module typesets it. `write` reveals it left to right over that many seconds,
        which is what reads as a hand writing on a blackboard.
        """
        if self._frame_img is None:
            return
        px_h = max(8, int(self.SH * float(L.get("h", 0.075))))
        im = _mathtext_rgba(str(L.get("tex") or ""),
                            self._color(L.get("color"), INK), px_h)
        cx, cy = self._at(L, [0.5, 0.45])
        mask = im.getchannel("A")
        if a < 1:
            mask = mask.point(lambda v, _a=a: int(v * _a))
        write = float(L.get("write", 0) or 0)
        if write > 0:
            p = clamp01((t - L["from"]) / write)
            edge = max(2.0, im.width * 0.035)          # a soft nib, not a hard wipe
            lead = p * (im.width + edge)
            ramp = Image.linear_gradient("L").resize((max(2, int(edge)), 1))
            band = Image.new("L", im.size, 0)
            solid = int(lead - edge)
            if solid > 0:
                band.paste(255, (0, 0, min(solid, im.width), im.height))
            if 0 < lead <= im.width + edge:
                x0 = max(0, int(lead - edge))
                wid = min(im.width - x0, int(edge))
                if wid > 0:
                    band.paste(ramp.transpose(Image.FLIP_LEFT_RIGHT).resize((wid, im.height)),
                               (x0, 0))
            mask = ImageChops.multiply(mask, band)
        self._frame_img.paste(im.convert("RGB"),
                              (int(cx - im.width / 2), int(cy - im.height / 2)), mask)

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
        d.rounded_rectangle([x0 + 4 * ss, y0 + 12 * ss,
                             x0 + cw + 4 * ss, y0 + chh + 12 * ss],
                            radius=36 * ss, fill=(4, 6, 14, int(70 * a)))
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
                [x0 + 3 * ss, y0 + 9 * ss, x0 + cw + 3 * ss, y0 + rh + 9 * ss],
                radius=30 * ss, fill=(4, 6, 14, int(50 * ar)))
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
            # RGBA, not RGB: convert("RGB") drops the alpha channel and leaves
            # whatever the transparent pixels happened to store — for a PNG written
            # with a transparent background that is white, so a chalk-white formula
            # on a blackboard came out white-on-white and unreadable (measured
            # 2026-09-03). A picture's own transparency is part of the picture.
            cache[key] = Image.open(L["_path"]).convert("RGBA")
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
        # the layer's fade and corner rounding MULTIPLY the picture's own alpha —
        # a transparent PNG lands as ink on whatever is behind it, and an opaque one
        # behaves exactly as it did before (its alpha is 255 everywhere).
        mask = ImageChops.multiply(mask, im.getchannel("A"))
        self._frame_img.paste(im.convert("RGB"),
                              (int(cx - wz / 2 + panx), int(cy - hz / 2)), mask)

    def _draw_sheet_sprite(self, t, a, L, sheets):
        """Play a saved character's drawn frames.

        `plays: [{action, at, for?}]` picks which sheet is running; without it the
        first action loops. Frames are pasted, never blended — a cross-dissolve
        between two poses shows both limbs at once (measured 2026-08-30, and it read
        as ghosting). Every frame is scaled by ONE factor and set on a common
        baseline: equalising each frame's height instead makes the character grow and
        shrink every frame, because a passing pose IS shorter than a contact pose.
        """
        if self._frame_img is None:
            return
        act, t0, travel = None, L["from"], 0
        for p in L.get("plays") or []:
            at = float(p.get("at", L["from"]))
            dur = p.get("for")
            end = at + float(dur) if dur is not None else L["to"]
            if at <= t < end and str(p.get("action") or "") in sheets:
                act, t0 = str(p["action"]), at
                tv = p.get("travel")
                travel = 0 if not tv else (-1 if str(tv) == "left" else 1)
        if act is None:
            act = next(iter(sheets))
        sh = sheets[act]
        cells = sh["cells"]
        order = _sheet_order(sh)
        i = _frame_index(sh, t, t0)
        cell_i = order[i % len(order)]
        x0, y0, x1, y1 = cells[cell_i]
        src = self._sheet_image(_sheet_file(sh, cell_i))
        piece = src.crop((x0, y0, x1 + 1, y1 + 1))
        # Frames drawn on separate canvases come back at separate sizes; cellScale puts them
        # back on one. It is 1.0 for every cell of a single-sheet action, where a height
        # difference is the pose and has to survive.
        cs = sh.get("cellScale") or [1.0] * len(cells)
        tall = max((c[3] - c[1] + 1) * cs[j] for j, c in enumerate(cells))
        scale = (self.SH * 0.42 * float(L.get("scale", 1.0))) / max(1.0, tall)
        w = max(1, int(round(piece.width * scale * cs[cell_i])))
        h = max(1, int(round(piece.height * scale * cs[cell_i])))
        piece = piece.resize((w, h), Image.LANCZOS)
        fc = sh.get("face")
        if fc:
            # The bank head, pasted over this frame's own at the frame's own head
            # anchor. Size comes from `fh` x the shared drawn height, so it is the
            # SAME number of pixels in every frame — the proportion lottery the
            # generator rolls per call ends here at zero, not merely small.
            key = (id(sh), fc["file"], tuple(fc["box"]))
            fcache = getattr(self, "_face_cache", None)
            if fcache is None:
                fcache = self._face_cache = {}
            bank = fcache.get(key)
            if bank is None:
                bx0, by0, bx1, by1 = fc["box"]
                bank = self._sheet_image(
                    sh["media"][fc["file"]] if isinstance(sh["media"], list)
                    else sh["media"]).crop((bx0, by0, bx1 + 1, by1 + 1))
                fcache[key] = bank
            hh = max(1, int(round(fc["fh"] * tall * scale)))
            hw = max(1, int(round(bank.width * hh / max(1, bank.height))))
            hd = bank.resize((hw, hh), Image.LANCZOS)
            hx = int(round(fc["ax"][cell_i] * w - fc["bax"] * hw))
            # Erase before pasting. Covering alone is not replacing: a real head has
            # a topknot and a headband tail that stick out past the bank's box in a
            # different place every frame, and those remnants put the variance right
            # back (measured 2026-09-01 — pasting over heungbu's frames moved the
            # head spread 8.1% -> 7.9%; erasing first is what ends it). Above the
            # neck line nothing but the head exists in a grounded action, so the
            # whole band goes; below it the frame keeps its own life.
            ey = min(piece.height, max(1, int(hh * 0.92)))
            piece.paste((0, 0, 0, 0), (0, 0, piece.width, ey))
            sx = max(0, -hx)
            dx = max(0, hx)
            cw_ = min(hd.width - sx, piece.width - dx)
            if cw_ > 0:
                piece.alpha_composite(
                    hd.crop((sx, 0, sx + cw_, min(hd.height, piece.height))), (dx, 0))
        alpha = piece.getchannel("A")
        if a < 0.999:
            alpha = alpha.point(lambda v: int(v * a))
        x, y = self._move_acts(L, t, *self._at(L, [0.5, 0.9]))
        # travel: let the stride decide the speed. Two steps per cycle, each one
        # stride long, so the ground passes at exactly the rate the legs are walking
        # and nothing skates. dir -1 walks back the way the drawing faces.
        # `i` and not `t`: the position steps with the drawing (see _travel_x).
        if travel and sh.get("stride"):
            per_cycle = 2.0 * sh["stride"] * (tall * scale)
            x = x + _travel_x(sh, i, per_cycle, travel)
        px = int(x - w / 2)
        # A contact shadow is what sets a character ON the ground rather than in front
        # of it — the same reason it does more for a photoreal render than any amount
        # of reflection. It is derived, not declared twice: `anchor` already says
        # whether this action stands on anything, so a flying sheet casts none.
        # Its width comes from the drawing's own feet, so it spreads as the legs part.
        if sh.get("anchor") != "body" and L.get("shadow", True) is not False:
            self._foot_shadow(piece, px, int(y), w, h,
                              a * float(L.get("shadow", 1.0) if isinstance(
                                  L.get("shadow"), (int, float)) else 1.0))
        if sh.get("anchor") == "body" and sh.get("bodyY"):
            # `at` is the body. Aligning bottoms would swing an airborne character by
            # the difference in frame heights, which for a bird is the wingspan.
            py = int(y - h * float(sh["bodyY"][cell_i]))
        else:
            py = int(y - h)                 # `at` is the feet
        # The frame buffer is RGB, so composite the way the image layer does.
        self._frame_img.paste(piece, (px, py), alpha)

    def _foot_shadow(self, piece, px, feet_y, w, h, a):
        """The shadow of whatever is touching the ground, squashed flat under it.

        Not an oval: an oval is a pool the character floats over, because the dark is
        deepest in the middle of the pool and the feet are at its edges. The shape
        here is the bottom of the silhouette itself, flattened — so the dark is under
        each foot, it parts as the legs part, and it is exactly as wide as whatever is
        standing there. Nothing about it is a walker's anatomy; a chair or a cart
        would cast its own outline the same way.
        """
        alpha = piece.getchannel("A")
        band_h = max(2, int(h * 0.10))
        band = alpha.crop((0, h - band_h, w, h))
        if not band.getbbox():
            return
        shh = max(4, int(h * 0.045))
        pad = shh * 3
        flat = band.resize((max(4, int(w * 1.06)), shh), Image.BILINEAR)
        sh_img = Image.new("L", (flat.width + pad * 2, shh + pad * 2), 0)
        sh_img.paste(flat.point(lambda v: int(v * 0.62 * max(0.0, min(1.0, a)))),
                     (pad, pad))
        sh_img = sh_img.filter(ImageFilter.GaussianBlur(max(1.5, shh * 0.5)))
        cx = px + w // 2
        # Straddling the ground line: the near half is behind the feet, which is what
        # makes it read as contact instead of as something lying further away.
        self._frame_img.paste((22, 20, 18),
                              (cx - sh_img.width // 2,
                               feet_y - sh_img.height // 2), sh_img)

    def _sheet_image(self, path):
        cache = getattr(self, "_sheet_cache", None)
        if cache is None:
            cache = self._sheet_cache = {}
        if path not in cache:
            if len(cache) > 8:
                cache.clear()
            cache[path] = load_sheet(path)
        return cache[path]

    def _draw_spritesheet(self, d, g, t, a, L):
        # Free game sprite sheets (and future canvas-baked sequences) as an
        # animated layer — one media file carries every frame in a grid, so a
        # long effect travels as a single image import instead of N files.
        key = ("sheet", L["_path"])
        cache = getattr(self, "_img_cache", None)
        if cache is None:
            cache = self._img_cache = {}
        if key not in cache:
            cache[key] = Image.open(L["_path"]).convert("RGBA")
        src = cache[key]
        cols, rows, count = L["_cols"], L["_rows"], L["_count"]
        cw, ch = src.width // cols, src.height // rows
        if cw < 2 or ch < 2:
            raise SceneError("spritesheet grid leaves cells under 2px — check cols/rows")
        el = max(0.0, t - L["from"])
        idx = int(el * L["_fps"])
        idx = (idx % count) if L.get("loop", True) else min(idx, count - 1)
        cell = src.crop(((idx % cols) * cw, (idx // cols) * ch,
                         (idx % cols + 1) * cw, (idx // cols + 1) * ch))
        w = self.SW * float(L.get("w", 0.4))
        h = w * ch / cw
        im = cell.resize((max(2, int(w)), max(2, int(h))), Image.LANCZOS)
        if a < 1:
            im.putalpha(im.getchannel("A").point(lambda v: int(v * a)))
        cx, cy = self._at(L, [0.5, 0.5])
        self._frame_img.paste(im, (int(cx - im.width / 2),
                                   int(cy - im.height / 2)), im)

    def _draw_shake(self, d, g, t, a, L):
        pass  # applied as a whole-frame offset in draw_frame

    def _draw_spark(self, d, g, t, a, L):
        ss = self.ss
        cx, cy = self._at(L, [0.5, 0.45])
        life = max(0.12, L["to"] - L["from"])
        p = clamp01((t - L["from"]) / life)
        col = self._color(L.get("color"), (255, 120, 60))
        size = float(L.get("size", 1.0))
        R = (55 + 150 * eob(p)) * ss * size
        # a spark's life IS its window — the default 0.4s layer fade would keep a
        # 0.3s flash from ever reaching full brightness, so it fades by p alone
        al = (1 - p) ** 1.5
        wpx = max(2, int(5 * ss * size))
        for angj, lj in L["_rays"]:
            ca, sa = math.cos(angj), math.sin(angj)
            x0, y0 = cx + ca * R * 0.25, cy + sa * R * 0.25
            x1, y1 = cx + ca * R * lj, cy + sa * R * lj
            d.line([x0, y0, x1, y1], fill=(*col, int(235 * al)), width=wpx)
            g.line([x0, y0, x1, y1], fill=(*col, int(120 * al)), width=wpx * 2)
        rr = R * 0.72
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                  outline=(255, 235, 200, int(140 * al)), width=max(2, int(3 * ss)))
        core = (26 * (1 - p) + 8) * ss * size
        d.ellipse([cx - core, cy - core, cx + core, cy + core],
                  fill=(255, 250, 235, int(255 * al)))
        g.ellipse([cx - core * 2, cy - core * 2, cx + core * 2, cy + core * 2],
                  fill=(*col, int(110 * al)))

    def _draw_speedlines(self, d, g, t, a, L):
        SW, SH, ss = self.SW, self.SH, self.ss
        sgn = -1.0 if str(L.get("dir", "left")) == "left" else 1.0
        for fy, flen, fw, ph in L["_lines"]:
            y = fy * SH
            span = flen * SW
            x = (ph * (SW + span) + t * 2.4 * SW * sgn) % (SW + span) - span
            d.line([x, y, x + span, y],
                   fill=(255, 255, 255, int(64 * a)), width=max(2, int(fw * ss)))

    def _draw_hpbar(self, d, g, t, a, L):
        ss, SW = self.ss, self.SW
        side = str(L.get("side", "left"))
        v0 = clamp01(float(L.get("value", 1.0)))
        v1 = clamp01(float(L.get("valueTo", v0)))
        p = eo3(clamp01((t - L["from"]) / max(0.2, min(0.6, L["to"] - L["from"]))))
        v = v0 + (v1 - v0) * p
        y = self._at(L, [0.5, 0.045])[1]
        w, h = SW * 0.42, 34 * ss
        if side == "left":
            x0 = SW * 0.045
        else:
            x0 = SW * 0.955 - w
        x1 = x0 + w
        d.rounded_rectangle([x0 + 2 * ss, y + 6 * ss, x1 + 2 * ss, y + h + 6 * ss],
                            radius=10 * ss, fill=(4, 6, 14, int(60 * a)))
        d.rounded_rectangle([x0, y, x1, y + h], radius=10 * ss,
                            fill=(18, 20, 30, int(205 * a)),
                            outline=(235, 238, 246, int(220 * a)),
                            width=max(2, int(2.5 * ss)))
        fw = max(0.0, (w - 6 * ss) * v)
        col = self._color(L.get("color"), (96, 220, 90))
        if fw > 1:
            if side == "left":
                fx0, fx1 = x0 + 3 * ss, x0 + 3 * ss + fw
            else:
                fx0, fx1 = x1 - 3 * ss - fw, x1 - 3 * ss
            d.rounded_rectangle([fx0, y + 3 * ss, fx1, y + h - 3 * ss],
                                radius=7 * ss, fill=(*col, int(235 * a)))
        label = str(L.get("label") or "")
        if label:
            f = self.fonts.get(26)
            lx = x0 + 6 * ss if side == "left" else x1 - 6 * ss \
                - d.textlength(label, font=f)
            self._shadow_text(d, (lx, y + h + 8 * ss), label, f,
                              (240, 243, 250), a)

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
        voice envelope for lipsync. Returns a wav path or None.

        A bgm shorter than the scene is repeated (see _tile_seamless) — before
        that the tail was silence and nothing said so."""
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

        def load(path, loop=False):
            data, rate = sf.read(path, always_2d=True)
            mono = data.mean(axis=1)
            if rate != RATE:
                mono = np.interp(np.linspace(0, len(mono), int(len(mono) * RATE / rate),
                                             endpoint=False),
                                 np.arange(len(mono)), mono)
            if loop and 0 < len(mono) < n:
                mono = _tile_seamless(mono, n, RATE)
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
            b = load(self.bgm, loop=self.bgm_loop) * (10 ** (self.bgm_gain_db / 20))
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
    _sweep_outputs()
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
        # Stills are an iteration aid, so they do NOT enter the media gallery: they
        # are written where the web server can show them and swept after a day.
        # Importing them made one review pass leave 148 permanent rows behind
        # (measured 2026-09-03) — the video is the deliverable, its contact sheets
        # are not. A scene can still point at one: media_path accepts user/media/**.
        os.makedirs(SCRATCH_DIR, exist_ok=True)
        urls = []
        for i, ts in enumerate(stills):
            ts = max(0.0, min(scene.dur, float(ts)))
            name = f"still-{tag}-{i}.png"
            Image.fromarray(scene.draw_frame(ts)).save(os.path.join(SCRATCH_DIR, name))
            urls.append("/user/media/_scratch/" + name)
        _sweep_scratch()
        return {"success": True,
                "data": {"stills": len(urls), "duration": scene.dur, "urls": urls,
                         "note": "stills only — served for review, swept after 24h, and "
                                 "kept out of the media gallery. Drop the stills field "
                                 "for the full video",
                         **({"layoutFixes": scene.layout_fixes} if scene.layout_fixes
                            else {})}}
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
    if inp.get("async"):
        return _job_submit(inp, scene)
    data = _encode_video(scene, tag)
    out = data.pop("_out_path")
    data["_mediaImport"] = {"path": _out(out), "contentType": "video/mp4",
                            "filenameHint": f"motion-{tag}"}
    if scene.layout_fixes:
        data["layoutFixes"] = scene.layout_fixes
    return {"success": True, "data": data}


def _encode_video(scene, tag, on_frame=None):
    """Render scene to mp4; returns the data dict. on_frame(i, n) reports progress."""
    import imageio_ffmpeg
    audio = scene.prepare_audio(OUT_DIR)
    out = os.path.join(OUT_DIR, f"video-{tag}.mp4")
    kwargs = dict(fps=scene.fps, quality=None, macro_block_size=8,
                  output_params=["-crf", "23", "-preset", "medium",
                                 "-movflags", "+faststart"])
    if audio:
        kwargs.update(audio_path=audio, audio_codec="aac")
    writer = imageio_ffmpeg.write_frames(out, (scene.W, scene.H), **kwargs)
    writer.send(None)
    n = int(scene.dur * scene.fps)
    for i in range(n):
        writer.send(scene.draw_frame(i / scene.fps).tobytes())
        if on_frame is not None and (i % 24 == 0 or i == n - 1):
            on_frame(i + 1, n)
    writer.close()
    if audio:
        try:
            os.remove(audio)
        except OSError:
            pass
    return {"duration": scene.dur, "fps": scene.fps,
            "size": f"{scene.W}x{scene.H}", "frames": n,
            "bytes": os.path.getsize(out),
            "_out_path": out}


JOB_ID_RE = re.compile(r"^[0-9a-f]{6,20}-[0-9]{1,10}$")


def _job_progress_path(jobdir):
    return os.path.join(jobdir, "progress.json")


def _job_write(jobdir, obj):
    tmp = os.path.join(jobdir, "progress.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, _job_progress_path(jobdir))


def _job_read(jobdir):
    try:
        with open(_job_progress_path(jobdir), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _sweep_outputs(now=None):
    """Drop day-old render leftovers. Media import COPIES the file into the
    store, so every delivered video/still would otherwise live here forever
    (measured 2026-08-26: 256MB of weather-video copies). A day keeps the
    `job` redeliver window honest — job dirs expire on the same clock."""
    now = time.time() if now is None else now
    if not os.path.isdir(OUT_DIR):
        return
    for name in os.listdir(OUT_DIR):
        if not name.startswith(("video-", "still-", "trim-")):
            continue
        p = os.path.join(OUT_DIR, name)
        try:
            if os.path.isfile(p) and now - os.path.getmtime(p) > 86400:
                os.remove(p)
        except OSError:
            pass

def _job_submit(inp, scene):
    """Accept a long render: validate now, hand the frame loop to a detached
    child, answer immediately with a job id the `job` action polls."""
    os.makedirs(JOB_DIR, exist_ok=True)
    now = time.time()
    _sweep_outputs(now)
    # sweep job dirs older than a day so the folder cannot grow unbounded
    for name in os.listdir(JOB_DIR):
        p = os.path.join(JOB_DIR, name)
        try:
            if now - os.path.getmtime(p) > 86400:
                for f in os.listdir(p):
                    os.remove(os.path.join(p, f))
                os.rmdir(p)
        except OSError:
            pass
    spec = {k: v for k, v in inp.items() if k not in ("async", "stills")}
    job_id = f"{_scene_hash(spec)}-{int(now) % 10 ** 9}"
    jobdir = os.path.join(JOB_DIR, job_id)
    os.makedirs(jobdir, exist_ok=True)
    with open(os.path.join(jobdir, "scene.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False)
    n = int(scene.dur * scene.fps)
    _job_write(jobdir, {"state": "running", "done": 0, "total": n, "t0": now})
    log = open(os.path.join(jobdir, "log.txt"), "w", encoding="utf-8")
    kw = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": log,
          "cwd": os.getcwd()}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED | NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--job", jobdir], **kw)
    log.close()
    return {"success": True,
            "data": {"jobId": job_id, "state": "accepted", "frames": n,
                     "note": "rendering in the background — poll with "
                             f"{{\"action\": \"job\", \"id\": \"{job_id}\"}}; "
                             "the call that sees it finished imports the video"}}


def run_job(jobdir):
    """Child process: render the scene spec left in the job dir."""
    try:
        with open(os.path.join(jobdir, "scene.json"), encoding="utf-8") as f:
            spec = json.load(f)
        scene = Scene(spec)
        prog = _job_read(jobdir) or {}
        t0 = prog.get("t0", time.time())

        def tick(done, total):
            _job_write(jobdir, {"state": "running", "done": done, "total": total,
                                "t0": t0})
        data = _encode_video(scene, _scene_hash(spec), on_frame=tick)
        _job_write(jobdir, {"state": "done", "t0": t0, "finished": time.time(),
                            "path": data.pop("_out_path"), "result": data})
    except Exception as e:  # noqa: BLE001 — the child's only reporting channel
        _job_write(jobdir, {"state": "error", "error": f"{type(e).__name__}: {e}"})


def action_job(inp):
    job_id = str(inp.get("id") or "").strip()
    if not JOB_ID_RE.match(job_id):
        return {"success": False,
                "error": "id must be a jobId returned by render with async:true"}
    jobdir = os.path.join(JOB_DIR, job_id)
    prog = _job_read(jobdir)
    if prog is None:
        return {"success": False,
                "error": f"unknown job {job_id!r} — job records are kept for a day"}
    state = prog.get("state")
    if state == "error":
        tail = ""
        try:
            with open(os.path.join(jobdir, "log.txt"), encoding="utf-8",
                      errors="replace") as f:
                tail = f.read()[-500:]
        except OSError:
            pass
        return {"success": False, "error": f"render failed: {prog.get('error')}"
                                           + (f" | log tail: {tail}" if tail.strip() else "")}
    if state == "running":
        done, total = int(prog.get("done", 0)), max(1, int(prog.get("total", 1)))
        elapsed = time.time() - float(prog.get("t0", time.time()))
        age = time.time() - os.path.getmtime(_job_progress_path(jobdir))
        if age > 180:
            return {"success": True,
                    "data": {"jobId": job_id, "state": "stalled",
                             "note": f"no progress for {int(age)}s — the worker "
                                     "likely died; submit the render again"}}
        eta = int(elapsed / max(done, 1) * (total - done)) if done else None
        return {"success": True,
                "data": {"jobId": job_id, "state": "running",
                         "framesDone": done, "framesTotal": total,
                         "progress": round(done / total, 3),
                         **({"etaSec": eta} if eta is not None else {})}}
    # done
    path = prog.get("path")
    if not path or not os.path.exists(path):
        return {"success": False, "error": "job finished but the file is gone"}
    if prog.get("delivered") and not inp.get("redeliver"):
        return {"success": True,
                "data": {"jobId": job_id, "state": "done",
                         "note": "already delivered to the media store — pass "
                                 "redeliver:true to import it again"}}
    prog["delivered"] = True
    _job_write(os.path.join(JOB_DIR, job_id), prog)
    result = dict(prog.get("result") or {})
    result.update({"jobId": job_id, "state": "done",
                   "renderSec": int(prog.get("finished", 0) - prog.get("t0", 0)),
                   "_mediaImport": {"path": _out(path), "contentType": "video/mp4",
                                    "filenameHint": f"motion-{job_id.split('-')[0]}"}})
    return {"success": True, "data": result}

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
    bangles = {str(k): math.radians(float(v))
               for k, v in (pose.get("bones") or {}).items()}
    draw_custom(d, Wc / 2, Hc - Hc * 0.02, Wc / 400.0 * 0.96, 1.3, parts,
                mouth=float(pose.get("mouth", 0.0)), wave=float(pose.get("wave", 0.0)),
                sy=float(pose.get("squash", 1.0)),
                blink_t=0.5 * float(pose["blink"]) if pose.get("blink") else None,
                text=txt, fonts=fonts, canvas=img,
                bones=(decl.get("bones") if isinstance(decl, dict) else None) or None,
                bone_angles=bangles)
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

def _sheet_order(sh):
    """The play order: which drawing is on screen for each frame of the cycle.

    A frames list can hold or repeat a drawing, so the cycle is often longer than
    the sheet -- the canonical eight-frame walk is seven drawings played
    [1,2,3,4,5,6,3,7]. Anything that counts frames counts these, not the cells.
    """
    return sh.get("order") or list(range(len(sh["cells"])))


def _frame_index(sh, t, t0):
    """Which frame of the cycle is on screen at `t`.

    Flooring is what holds one drawing for a whole beat when the sheet's fps is
    below the video's, and a non-looping action stops on its last drawing instead
    of running off the end of the order.
    """
    i = int((t - t0) * sh["fps"])
    n = len(_sheet_order(sh))
    if not sh["loop"] and i >= n:
        i = n - 1
    return i


def _travel_x(sh, frame_i, per_cycle, direction):
    """How far a walking sheet has carried itself by the time frame `frame_i`
    is on screen.

    The position moves on the DRAWING's beat, not on the video's. A sheet drawn
    at 8fps inside a 24fps video holds each picture for three video frames, and
    sliding the sprite under a frozen picture drags the planted foot along and
    snaps it back when the next drawing lands. Measured on the shipped walk
    (2026-09-01): the picture is provably frozen across the hold (98.3% IoU once
    the box shift is undone) while the sprite slides 14.8px a frame, so the
    planted foot saws 44px back and forth eight times a second -- 9.4% of the
    figure's height. Stepping the position with the drawing costs nothing, since
    the drawing is already held, and leaves only the drawings' own error: on the
    transitions where both sides show two separate feet, the held foot moves a
    median of 9px (1.8% of height), which is the sheet's business, not the
    clock's.

    The cycle is the order's length, not the sheet's. A frames list that repeats
    or holds a drawing has more frames than drawings, and dividing the ground
    speed by the drawings walks that character 14% too fast.
    """
    return (per_cycle * (frame_i / float(len(_sheet_order(sh))))
            * (1.0 if direction > 0 else -1.0))


def _sheet_file(sh, cell_i):
    """Which sheet file frame `cell_i` of this action was drawn on.

    `media` is a list once an action can span several sheets; a declaration saved
    before that is a bare string and stays readable.
    """
    m = sh.get("media")
    if isinstance(m, str):
        return m
    return m[(sh.get("cellOf") or [0] * len(m))[cell_i] if sh.get("cellOf") else 0]


def _sheet_masks(medias, cells, cell_of):
    """One boolean mask per frame, however many files the frames are spread over.

    An action's frames do not have to come from one picture. A dozen full-height
    figures do not fit on one generated sheet — measured 2026-08-30, a 4x3 walk
    sheet came back with its bottom row's feet cut off at the canvas edge — so a
    long cycle arrives as several sheets and is read here as one sequence.
    """
    loaded, out = {}, []
    for idx, (x0, y0, x1, y1) in zip(cell_of, cells):
        if idx not in loaded:
            loaded[idx] = np.asarray(load_sheet(medias[idx]))[:, :, 3] > 16
        out.append(loaded[idx][y0:y1 + 1, x0:x1 + 1])
    return out


def _head_extent(mask, bottom_frac=None):
    """Rows 0..neck of one frame's silhouette — the head, read off the shape.

    The neck is the narrowest row in the upper part of the figure. Precision is
    not the point: the bank head is pasted OVER whatever is there, so the cut
    only has to land between chin and shoulder. A silhouette with no waist in
    that band falls back to a fixed fraction, and `bottom` overrides both.
    Returns (cut_row, x0, x1, centroid_x) or None when there is nothing there.
    """
    h = mask.shape[0]
    if bottom_frac:
        cut = max(2, int(h * bottom_frac))
    else:
        w = mask.sum(1)
        lo, hi = int(h * 0.08), int(h * 0.40)
        band = w[lo:hi]
        if len(band) < 3:
            cut = int(h * 0.24)
        else:
            k = int(np.argmin(band))
            # a minimum sitting on the band's edge is a slope, not a neck
            cut = lo + k if 0 < k < len(band) - 1 else int(h * 0.24)
    ys, xs = np.where(mask[:cut])
    if len(xs) < 20:
        return None
    return cut, int(xs.min()), int(xs.max()), float(xs.mean())


def _sheet_face(face_spec, medias, all_cells, all_cell_of, used_cells, used_masks):
    """ONE head for every frame — the proportion fix that scaling cannot be.

    The generator redraws the whole figure each call and rolls the dice on the
    head every time: measured 2026-08-31, heads scattered 5~9% within a sheet
    and 14% across single calls, and no uniform scale can fix a PROPORTION
    difference. So the head is not normalised, it is replaced: the bank head
    (the biggest one on the sheet, or the frame the author names) is pasted
    over every frame's own at draw time. Variance ends at zero, not small.

    In a profile action the head is a rigid body that neither deforms nor
    rotates, which is what makes the paste honest; the biggest head is the
    default bank so it covers every smaller one underneath.
    """
    bottom = None
    if isinstance(face_spec, dict):
        bottom = face_spec.get("bottom")
        if bottom is not None:
            bottom = _num(bottom, "sheets.face.bottom", 0.08, 0.6)
    # per-used-cell anchors: the head band's centroid, as a fraction of cell width
    ax, areas = [], []
    for m in used_masks:
        he = _head_extent(m, bottom)
        if he is None:
            raise SceneError(
                "face: a frame has no head region to anchor to — the top of one "
                "silhouette is nearly empty. Drop that frame or set face.bottom")
        cut, hx0, hx1, cx = he
        ax.append(round(cx / max(1, m.shape[1]), 4))
        areas.append(int(m[:cut].sum()))
    # the bank: a named frame, or the largest head on the sheet (it covers the rest)
    if isinstance(face_spec, dict) and face_spec.get("from") is not None:
        fno = int(_num(face_spec["from"], "sheets.face.from", 1, len(all_cells)))
        bank_cell = all_cells[fno - 1]
        bank_file = all_cell_of[fno - 1]
        bank_mask = _sheet_masks(medias, [bank_cell], [bank_file])[0]
    else:
        bi = int(np.argmax(areas))
        bank_cell = used_cells[bi]
        # used_cells run parallel to used_masks; find the file the same way
        bank_file = all_cell_of[all_cells.index(list(bank_cell))] if list(
            bank_cell) in all_cells else 0
        bank_mask = used_masks[bi]
    he = _head_extent(bank_mask, bottom)
    if he is None:
        raise SceneError("face: the bank frame has no head region")
    cut, hx0, hx1, cx = he
    bx0, by0 = bank_cell[0], bank_cell[1]
    box = [bx0 + hx0, by0, bx0 + hx1, by0 + cut - 1]
    return {
        "file": int(bank_file),
        "box": [int(v) for v in box],
        # anchor x within the box — the same landmark the per-cell anchors use
        "bax": round((cx - hx0) / max(1, hx1 - hx0 + 1), 4),
        # head height as a fraction of its own cell height; cells are already on
        # one scale (the size gate), so this fraction of the drawn height is the
        # same number of output pixels in every frame
        "fh": round((cut) / float(max(1, bank_mask.shape[0])), 4),
        "ax": ax,
    }


def _sheet_foot_lift(masks):
    """How far each frame lifts a foot off the ground, as a fraction of leg length.

    A walk skims: at mid-swing the toe passes within a centimetre or two of the
    floor, one or two percent of leg length, directly under the hip. Lift the
    knee instead and the same drawing reads as a march — measured 2026-09-01, a
    generated cycle came back with its two passing frames at 27% and 46% and a
    viewer called it "the knee is at a right angle" without knowing why.

    Feet are the local MAXIMA of the bottom profile. Three earlier detectors got
    this wrong by trying to separate the two legs — below the crotch they merge
    into one blob — or by reading the space BETWEEN spread legs, where the lowest
    pixel is the trouser hem, as a foot in the air. That region is the profile's
    minimum; a foot, planted or airborne, is a downward bulge.
    """
    out = []
    for m in masks:
        h, w = m.shape
        cols = np.where(m.any(0))[0]
        if len(cols) < 8:
            out.append(0.0)
            continue
        y = np.full(w, -1.0)
        for x in cols:
            y[x] = np.where(m[:, x])[0].max()
        ground = float(y.max())
        cy = None
        for yy in range(int(h * 0.45), int(h * 0.92)):
            runs, prev = 0, False
            for v in m[yy]:
                if v and not prev:
                    runs += 1
                prev = v
            if runs >= 2:
                cy = yy
                break
        leg = (ground - cy) if cy else h * 0.45
        if leg < 8:
            out.append(0.0)
            continue
        lo, hi = int(cols.min()), int(cols.max())
        seg = y[lo:hi + 1].astype(float)
        k = max(3, int((hi - lo) * 0.03)) | 1
        sm = np.convolve(seg, np.ones(k) / k, mode="same")
        sm[:k], sm[-k:] = seg[:k], seg[-k:]
        prom = 0.06 * leg
        peaks, i = [], 1
        while i < len(sm) - 1:
            if sm[i] >= sm[i - 1] and sm[i] > sm[i + 1]:
                r = i
                while r < len(sm) - 1 and sm[r + 1] <= sm[i] and sm[i] - sm[r] <= prom:
                    r += 1
                l = i
                while l > 0 and sm[l - 1] <= sm[i] and sm[i] - sm[l] <= prom:
                    l -= 1
                if sm[i] - min(sm[l], sm[r]) > prom or sm[i] >= ground - 2:
                    peaks.append((float(sm[i]), i))
                i = max(i + 1, r)
            else:
                i += 1
        merged = []
        for v, x in sorted(peaks, key=lambda p: p[1]):
            if merged and x - merged[-1][1] < 0.25 * leg:
                if v > merged[-1][0]:
                    merged[-1] = (v, x)
            else:
                merged.append((v, x))
        gaps = [(ground - v) / leg for v, _ in merged]
        out.append(round(max(gaps) if gaps else 0.0, 3))
    return out


def _sheet_stride(masks):
    """Widest foot separation across the frames, as a fraction of frame height.

    Measured in the bottom tenth of each cell — that band is feet. Returns 0 when
    the action never separates them (a bird, a bow), which means "does not walk".

    Each cell is divided by its OWN height, not by the tallest one. The cells are
    the same character, so a cell's height IS the figure's height, and that is what
    cellScale then puts them all on. Dividing by the tallest instead only agrees
    while every drawing came back the same size: add a passing frame drawn on its
    own canvas, three times the cells beside it, and the stride reads 0.1355 where
    it should read 0.3896, so the walker covers a third of the ground its legs are
    walking and skates for the rest."""
    widest = 0.0
    for sub in masks:
        tall = sub.shape[0] or 1
        foot = sub[int(sub.shape[0] * 0.90):]
        on = foot.any(0)
        idx = np.where(on)[0]
        if len(idx) < 2:
            continue
        runs, st = [], None
        for i in range(len(on)):
            if on[i] and st is None:
                st = i
            elif not on[i] and st is not None:
                runs.append((st, i - 1))
                st = None
        if st is not None:
            runs.append((st, len(on) - 1))
        if len(runs) > 1:
            widest = max(widest, (runs[-1][0] - runs[0][1]) / float(tall))
    return round(widest, 4)


def _sheet_body_y(masks, work=128, rounds=15):
    """Where the part that does NOT move sits in each cell, as a fraction of height.

    Overlay every frame of an action and some of the drawing lands on itself — that
    is the character, and the rest is the motion. So the anchor is not a body part
    anybody has to name: line the frames up so the region common to ALL of them is
    as large as it can be, and pin that.

    Two named guesses came before this and both were wrong outside the case they
    were invented for. The centroid of the middle fifths tracked a bird's wing,
    which is attached mid-body and sweeps through exactly those columns. The
    midpoint between the silhouette's two ends is nose and tail on a swallow and a
    swinging hand and foot on a walking man. Measured across three real sheets, as
    the share of the average frame that every frame shares:

        swallow 6   feet .314   middle-fifths .168   nose-tail .410   this .495
        walker  8   feet .476   middle-fifths .491   nose-tail .315   this .503
        walker  4   feet .575   middle-fifths .570   nose-tail .427   this .590

    Coordinate descent, at a reduced size because the answer is a fraction: each
    frame in turn takes the offset that puts the most of itself onto the region the
    others all agree on. It settles in a few rounds.
    """
    subs = masks
    n = len(subs)
    if n < 2:
        return [0.5] * n
    tallest = max(s.shape[0] for s in subs)
    sc = work / float(tallest)
    small = []
    for s in subs:
        w = max(2, int(round(s.shape[1] * sc)))
        h = max(2, int(round(s.shape[0] * sc)))
        small.append(np.asarray(Image.fromarray((s * 255).astype(np.uint8))
                                .resize((w, h), Image.BILINEAR)) > 96)
    CW = max(s.shape[1] for s in small) + 4
    CH = work * 3
    xs = [(CW - s.shape[1]) // 2 for s in small]

    def stack(offs):
        st = np.zeros((n, CH, CW), bool)
        for j, sm in enumerate(small):
            h, w = sm.shape
            st[j, offs[j]:offs[j] + h, xs[j]:xs[j] + w] = sm
        return st

    offs = [(CH - s.shape[0]) // 2 for s in small]
    start = list(offs)
    # Frames of one action do not leap: bound the search so a frame cannot slide a
    # third of a body away and land its wing on someone else's back. Without this the
    # two-frame case aligns the raised wing onto the lowered one and the anchor comes
    # out past the end of the cell entirely (measured 2026-08-30).
    reach = max(4, work // 3)
    for _ in range(rounds):
        st = stack(offs)
        cnt = st.sum(0)
        moved = False
        for j, sm in enumerate(small):
            # What every OTHER frame agrees on. Falling back to all-but-one keeps a
            # single ragged frame from emptying the target.
            agreed = (cnt - st[j]) >= (n - 1)
            if agreed.sum() < 8:
                agreed = (cnt - st[j]) >= max(1, n - 2)
            h, w = sm.shape
            lo = max(0, start[j] - reach)
            hi = min(CH - h, start[j] + reach)
            win = np.lib.stride_tricks.sliding_window_view(
                agreed[:, xs[j]:xs[j] + w].astype(np.float32), (h, w))[:, 0][lo:hi + 1]
            best = lo + int(np.argmax(np.einsum('dhw,hw->d', win, sm.astype(np.float32))))
            if best != offs[j]:
                offs[j] = best
                moved = True
        if not moved:
            break
    core = stack(offs).all(0)
    if core.any():
        ref = float(np.average(np.arange(CH), weights=core.sum(1)))
    else:
        ref = CH / 2.0
    return [round(float(min(1.0, max(0.0, (ref - offs[j]) / max(1, small[j].shape[0])))), 4)
            for j in range(n)]


# Below this much scatter in cell height the frames differ because the generator drew the
# same character at slightly different sizes; above it they differ because the ACTION moves
# the body — a wing goes up, a figure crouches — and flattening that would delete the motion.
# Measured 2026-08-31 over every sheet on hand: five walk sheets scattered 0.9 / 0.9 / 2.8 /
# 5.9 / 8.3 %, while an eight-beat wingbeat ran 98.5 %. The two are an order of magnitude
# apart, so this is the middle of a wide valley and not a knife edge.
CELL_SIZE_GATE = 0.15


def _sheet_cell_scale(cells, cell_of, n_files):
    """One scale per cell, so every frame is the same character at the same size.

    Cell heights differ for two reasons that need opposite treatment. One is the ACTION:
    a raised wing makes the box taller, a crouch makes it shorter, and that has to survive.
    The other is the GENERATOR: asked for the same character twice it draws him a few percent
    different, and on screen that reads as his height dropping mid-stride. Telling them apart
    by anatomy needs a body part the pose does not move, and no general one was found —
    a colour-keyed torso works for one character, silhouette-overlap fitting scored 33% on a
    sheet already flat to 0.9%, and an invariant-band search made two sheets worse. What does
    separate them is SIZE: the two populations sit an order of magnitude apart (see
    CELL_SIZE_GATE), so the scatter itself says which one this is.

    Scatter under the gate: put every cell on the median height, across sheets and within
    one alike. Over it: leave the drawings alone and only put separate CANVASES on one scale,
    which is the older, narrower rule and is still right for a wingbeat.

    (The claim this function used to carry — that a seven-frame walk held its head-to-box
    ratio to 0.4% — was measured with a broken ruler and is withdrawn: re-measured by area
    the heads scattered 14.4%.)
    """
    if not cells:
        return []
    heights = [float(c[3] - c[1] + 1) for c in cells]
    cell_of = cell_of or [0] * len(cells)
    # The two treatments COMPOSE; they are not alternatives. Canvases first, then whatever
    # scatter is left over. Running them as a fork meant one borrowed drawing on its own
    # canvas took the whole sheet down the canvas branch and switched the per-cell
    # flattening off for every frame -- and that flattening is the thing that stops his
    # height dropping mid-stride. Measured: one frame came out 8% short (219px against
    # 237) because its own sheet had drawn it small and nothing was left to even it out.
    scale = [1.0] * len(cells)
    if n_files > 1:
        by_file = {}
        for h, f in zip(heights, cell_of):
            by_file.setdefault(f, []).append(h)
        med = {f: sorted(v)[len(v) // 2] for f, v in by_file.items()}
        # The target is the median CELL, so the size most of the drawings already are is
        # the size they all end up. Taking the largest canvas instead let one odd drawing
        # resize the character: a passing frame drawn alone at three times the cells
        # beside it scaled every other frame UP by three, so the same `scale: 0.5` sprite
        # came out 25% taller and was upsampled 3x to get there.
        # The LOWER median, so an even split resamples down rather than up: with two cells
        # and nothing to be a majority there is no evidence which size is the character's,
        # and downscaling is the one that does not invent detail.
        target = sorted(heights)[(len(heights) - 1) // 2]
        scale = [target / float(med[f]) for f in cell_of]
    adj = [h * s for h, s in zip(heights, scale)]
    mean = sum(adj) / len(adj)
    if mean > 0 and (max(adj) - min(adj)) / mean <= CELL_SIZE_GATE:
        target2 = sorted(adj)[len(adj) // 2]
        scale = [s * target2 / a for s, a in zip(scale, adj)]
    return [round(s, 4) for s in scale]


def validate_sheets(sheets):
    """`sheets: {action: {media, fps?, loop?, anchor?, cells?}}` — drawn animation, by name.

    An action is a sheet of real drawings, not a pose warped out of one picture.
    `cells` is found from the alpha when it is not given, so an author never
    types frame coordinates: the sheet is the original and the numbers are read
    off it.

    `anchor` says what `at` pins. 'feet' (default) puts the bottom of every frame on
    the same line, which is what standing on the ground means. 'body' pins the body
    instead, for an action that is not standing on anything: a flying bird's frame
    box is as tall as its raised wing, so aligning bottoms swings the whole bird up
    and down — measured 2026-08-30 on a six-frame swallow whose cells ran 172 to 354
    pixels tall and whose body moved 62px per cycle on feet and 0 on body.
    """
    if sheets is None:
        return None
    if not isinstance(sheets, dict) or not 1 <= len(sheets) <= 16:
        raise SceneError("sheets must be {action: {media, fps?, loop?}} — 1 to 16 actions")
    out = {}
    for act, spec in sheets.items():
        a = str(act).strip()
        if not a or len(a) > 24:
            raise SceneError("sheets: action name must be 1..24 chars")
        if not isinstance(spec, dict):
            raise SceneError(f"sheets[{a}] must be an object with a media path")
        # One action, one or several sheets. Twelve full-height figures do not fit on
        # one generated canvas — measured 2026-08-30, a 4x3 walk sheet came back with
        # the bottom row's feet cut off at the edge — so a long cycle is asked for in
        # parts and listed here in order. Frames are numbered straight through them.
        media = spec.get("media")
        medias = media if isinstance(media, list) else [media]
        if not (1 <= len(medias) <= 8) or not all(
                isinstance(m, str) and m.strip() for m in medias):
            raise SceneError(
                f"sheets[{a}].media must be a media-store path, or a list of 1..8 of "
                "them for an action drawn across several sheets")
        medias = [m.strip() for m in medias]
        anchor = str(spec.get("anchor") or "feet")
        if anchor not in ("feet", "body"):
            raise SceneError(
                f"sheets[{a}].anchor must be 'feet' (standing on the ground) or "
                "'body' (airborne — flying, jumping)")
        frames = spec.get("frames")
        cells = spec.get("cells")
        norm, cell_of = [], []
        if cells is None:
            for mi, m in enumerate(medias):
                found = find_sheet_cells(m)
                norm.extend(found)
                cell_of.extend([mi] * len(found))
        else:
            if len(medias) > 1:
                raise SceneError(
                    f"sheets[{a}].cells is for one sheet — across several sheets the "
                    "boxes are read off each of them")
            if not (isinstance(cells, list) and 1 <= len(cells) <= 32):
                raise SceneError(f"sheets[{a}].cells must be 1..32 [x0,y0,x1,y1] boxes")
            for j, c in enumerate(cells):
                if not (isinstance(c, (list, tuple)) and len(c) == 4):
                    raise SceneError(f"sheets[{a}].cells[{j}] must be [x0,y0,x1,y1]")
                norm.append([int(v) for v in c])
                cell_of.append(0)
        if not 1 <= len(norm) <= 48:
            raise SceneError(
                f"sheets[{a}] came to {len(norm)} frames — 1 to 48 across all its sheets")
        # `frames` = the order the drawings play in, counting them off the sheet from
        # 1. A generated sheet is not always a cycle: the swallow's six frames were
        # one wingbeat in three drawings plus three near-duplicates, and played in
        # sheet order the wing jumped about. [1,2,3,2] is that beat, and the same
        # field also drops a bad drawing or holds one for two beats.
        #
        # One number is a held pose. That is how a standing character and a walking one
        # come off the same sheets: `idle` takes the frame where he is on both feet,
        # `walk` takes the cycle and leaves that frame out. Asking the generator for a
        # standing pose alongside the cycle costs one cell and saves a second character.
        norm_all, cell_of_all = list(norm), list(cell_of)
        if frames is not None:
            if not (isinstance(frames, list) and 1 <= len(frames) <= 64):
                raise SceneError(f"sheets[{a}].frames must be 1..64 frame numbers")
            try:
                seq = [int(v) for v in frames]
            except (TypeError, ValueError):
                raise SceneError(f"sheets[{a}].frames must be whole numbers") from None
            bad = [v for v in seq if not 1 <= v <= len(norm)]
            if bad:
                raise SceneError(
                    f"sheets[{a}].frames has {bad[0]} but this sheet has "
                    f"{len(norm)} frames — they are numbered 1..{len(norm)} in the "
                    "order they are drawn, left to right then top to bottom")
            used = sorted({v - 1 for v in seq})
            norm = [norm[i] for i in used]
            cell_of = [cell_of[i] for i in used]
            order = [used.index(v - 1) for v in seq]
        else:
            order = None
        masks = _sheet_masks(medias, norm, cell_of)
        face_spec = spec.get("face")
        face = None
        # `face: {}` and `face: true` both mean "on, pick the bank yourself" — an
        # empty dict is falsy in Python, and gating on truthiness silently turned
        # the auto mode off (the two-way canary caught it before it shipped).
        if face_spec is not None and face_spec is not False:
            # face.from counts drawings off the sheets from 1, same as `frames` —
            # the bank may be a frame the play order leaves out (a clean portrait
            # cell generated alongside the cycle).
            face = _sheet_face(face_spec, medias, norm_all, cell_of_all, norm, masks)
        out[a] = {
            "media": medias,
            "cellOf": cell_of,
            "cells": norm,
            "cellScale": _sheet_cell_scale(norm, cell_of, len(medias)),
            "order": order,
            "fps": _num(spec.get("fps", 12), f"sheets[{a}].fps", 1, 30),
            "loop": bool(spec.get("loop", True)),
            # How far the feet travel across this action, measured off the drawings.
            # A walker whose translation is guessed by hand skates: the ground moves at
            # one speed and the legs at another, and the eye reads it instantly as a
            # race walk (measured 2026-08-30 — twelve steps taken while covering six
            # strides of ground). The stride is in the artwork, so read it there.
            # An airborne action has no stride by definition: the feet separating on a
            # flying bird is the tail and a wingtip, not a step.
            "stride": _sheet_stride(masks) if anchor == "feet" else 0.0,
            "anchor": anchor,
            # Where the body sits in each cell, for the 'body' anchor. Read off the
            # drawing at save time like the cells and the stride, so a scene never
            # carries frame geometry.
            "bodyY": _sheet_body_y(masks) if anchor == "body" else None,
            # ONE head for every frame — proportion variance replaced, not reduced.
            "face": face,
        }
    return out


def action_save_asset(inp):
    name = str(inp.get("name") or "").strip()
    try:
        sheets = validate_sheets(inp.get("sheets"))
    except SceneError as e:
        return {"success": False, "error": str(e)}
    # Feet on a sheet whose frames are wildly different heights is almost always the
    # wrong pin, and it is invisible in a still — it shows up as the character bobbing
    # once per cycle. Say so here rather than guessing: a bow bends low and IS on its
    # feet, so height alone cannot decide it.
    sheet_notes = []
    for _a, _v in (sheets or {}).items():
        # A drawing on BOTH sides of another means the motion runs there and comes straight
        # back through the same picture. On a wing that is right — up and down really are the
        # same arc reversed. On a walk it is the twitch you see at full stride, because the
        # two halves of a step are different drawings: the leg reaching to land (body high,
        # heel still up) is not the leg that just landed (body low, knee loaded). Measured
        # 2026-08-31 — [1,2,3,4,5,4,3,2] read as a hitch at both contacts and went away when
        # the two 'up' drawings were added and it became [1,2,3,4,5,6,3,7].
        _ord = _v.get("order")
        if _ord and len(_ord) > 2:
            _back = sorted({_ord[i] + 1 for i in range(len(_ord))
                            if _ord[(i - 1) % len(_ord)] == _ord[(i + 1) % len(_ord)]})
            if _back:
                sheet_notes.append(
                    f"'{_a}' plays the same drawing on both sides of frame(s) "
                    f"{', '.join(str(v) for v in _back)}, so the motion reverses there rather "
                    "than carrying on. That is right for a beat that really is symmetric (a "
                    "wing going up and back down) and wrong for a cycle that has to alternate "
                    "— a walk needs a separate drawing either side of full stride.")
        _sc = _v.get("cellScale") or []
        if _sc and (max(_sc) - min(_sc)) > 0.02:
            sheet_notes.append(
                f"'{_a}' frames came back {round((max(_sc) / min(_sc) - 1) * 100)}% apart in "
                "size and have been put on one scale. A character does not change height "
                "in the middle of an action, so a difference between whole sheets is the "
                "generator drawing him at different sizes. Inside ONE sheet the same "
                "difference past 15% is read as the action instead — a raised wing, a "
                "crouch — and those drawings are left alone.")
        # The scaled heights, not the drawn ones. Reading the raw ones announced a
        # rise-and-fall on an action whose sizes had just been normalised away: a passing
        # frame drawn on its own canvas is three times the cells beside it and lands on
        # exactly their height once cellScale is applied.
        hs = [int(round((c[3] - c[1] + 1) * (_sc[j] if j < len(_sc) else 1.0)))
              for j, c in enumerate(_v["cells"])]
        if _v.get("anchor") == "feet" and len(hs) > 1 and min(hs) < 0.75 * max(hs):
            sheet_notes.append(
                f"'{_a}' frames run {min(hs)}..{max(hs)}px tall and are pinned by the feet, "
                "so the character will rise and fall once per cycle. If this action is not "
                f"standing on the ground, save it with sheets.{_a}.anchor='body'.")
        # How a walk is told from a march, read off the drawings. Mid-swing in real
        # walking clears the floor by a centimetre or two — one or two percent of leg
        # length, the toe skimming under the hip. A generated cycle came back with its
        # passing frames at 27% and 46% and read as a march, and nothing said so until
        # someone watched the finished video.
        if _v.get("anchor") == "feet" and _v.get("stride") and len(_v["cells"]) > 2:
            lifts = _sheet_foot_lift(_sheet_masks(_v["media"], _v["cells"],
                                                  _v.get("cellOf") or [0] * len(_v["cells"])))
            hi = max(lifts) if lifts else 0.0
            # Only the march is reported. The opposite case — a cycle with no passing at
            # all — would need a "never lifts" note, and this reading cannot carry one: a
            # foot hidden directly behind the planted one leaves no trace in the bottom
            # profile, so "no lift seen" and "no lift drawn" are the same number here.
            # A knee raised high is always offset sideways, which is why THIS direction
            # is safe to name.
            if hi >= 0.25:
                worst = [(i + 1, v) for i, v in enumerate(lifts) if v >= 0.25]
                # Each frame's OWN number. Reporting only the highest flattened two
                # different faults into one: heungbu's passings measure 27% and 45%,
                # and the note said "frames 4, 7 lift a foot to 45%", which reads as
                # one fault in two places. It is two, and the second one is worse.
                note = (f"'{_a}' frame(s) "
                        + ', '.join(f"{i} ({round(v * 100)}%)" for i, v in worst)
                        + " lift a foot that far off the ground, as a share of leg "
                        "length. Walking skims: at mid-swing the toe passes a finger's "
                        "width above the floor, directly under the hip, with the thigh "
                        "near vertical. A knee raised this far reads as a march. Ask for "
                        "those frames again with the foot skimming, not the knee lifted.")
                lo = min(v for _, v in worst)
                # Unequal passings are a second fault on top of the march, and the one a
                # viewer names first -- the two halves of the cycle swing through at
                # different heights and it reads as a limp. Two thirds is set below the
                # one pair measured (27/45 = 0.60) with room to spare; this only decides
                # whether a sentence is printed, so erring loud costs a sentence.
                if len(worst) > 1 and lo < hi * (2.0 / 3.0):
                    note += (" They also do not match each other, so the two halves of "
                             "the cycle swing through at different heights -- that is "
                             "what a viewer calls a limp, and it is usually noticed "
                             "before the march is. Until the drawings are redone, naming "
                             "the lower one twice in `frames` makes the cycle even: one "
                             "passing drawing may serve both halves, since at passing the "
                             "legs are together and the silhouette is the same either way.")
                sheet_notes.append(note)
    # A sheet-only character carries no shape parts: its drawings ARE the asset.
    if sheets and inp.get("parts") is None:
        parts = []
    else:
        try:
            parts = validate_asset_decl(name, inp.get("parts"))
        except SceneError as e:
            return {"success": False,
                    "error": f"{e} — the assets action documents the part grammar"}
    try:
        bones = validate_bones(inp.get("bones"), parts)
        for q in parts:
            if q["shape"] == "image":
                media_path(q["media"])  # fail at save time, not first draw
    except SceneError as e:
        return {"success": False, "error": str(e)}
    os.makedirs(ASSET_DIR, exist_ok=True)
    replaced = os.path.isfile(_asset_path(name))
    with open(_asset_path(name), "w", encoding="utf-8") as fh:
        decl = {"parts": parts}
        if bones:
            decl["bones"] = bones
        if sheets:
            decl["sheets"] = sheets
        json.dump(decl, fh, ensure_ascii=False, indent=1)
    # The browsable face: a thumbnail lands in the media store as clip art. The
    # declaration stays the original — consumers re-render from it, never from this PNG.
    os.makedirs(OUT_DIR, exist_ok=True)
    if sheets and not parts:
        # The browsable face of a drawn character is its first frame.
        first = next(iter(sheets.values()))
        x0, y0, x1, y1 = first["cells"][0]
        thumb = load_sheet(_sheet_file(first, 0)).crop((x0, y0, x1 + 1, y1 + 1))
        thumb.thumbnail((480, 480), Image.LANCZOS)
    else:
        thumb = _custom_sticker_png({"parts": parts, "bones": bones or None}, 480, {})
    tp = os.path.join(OUT_DIR, f"asset-thumb-{name}.png")
    thumb.save(tp)
    return {"success": True,
            "data": {"asset": name, "parts": len(parts), "replaced": replaced,
                     **({"sheets": {k: {"frames": len(_sheet_order(v)),
                                        "anchor": v.get("anchor", "feet"),
                                        "stride": v.get("stride", 0),
                                        # Only when it did something. Like stride and cells,
                                        # this is measured here, not passed in — so the answer
                                        # is the only place an author can see it happened.
                                        **({"resized": [round(x, 3) for x in v["cellScale"]]}
                                           if max(v.get("cellScale") or [1.0])
                                           - min(v.get("cellScale") or [1.0]) > 0.001 else {})}
                                    for k, v in sheets.items()}}
                        if sheets else {}),
                     **({"note": " ".join(sheet_notes)} if sheet_notes else {}),
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
                               "layers:[...], audio?, stills?, quality?, async?}",
                     "sticker": "{action:'sticker', name, pose?, stickerSize?}",
                     "job": "{action:'job', id, redeliver?}"},
        "coordinates": "positions are normalized [x, y], 0..1, y grows downward; "
                       "times are seconds; every layer has from/to (fade windows "
                       "fadeIn/fadeOut, default 0.4s). WHAT `at` PINS DIFFERS BY "
                       "KIND: for card and list it is the TOP-CENTRE and the box "
                       "grows DOWNWARD one row at a time (list 158px/row at 1080 "
                       "base, card 130px + 50 padding), so a y that reads like the "
                       "middle of the frame puts the last row off the bottom — a "
                       "3-row list wants y <= 0.55, a 4-row card y <= 0.42. For "
                       "every other kind it is the centre. A box that would fall "
                       "off is moved up to fit and the render reports it in "
                       "layoutFixes, but placing it yourself is what controls the "
                       "spacing",
        "sizes": sorted(SIZES), "durationMax": DUR_MAX, "fpsRange": [FPS_MIN, FPS_MAX],
        "backgrounds": {
            "night": "built-in starry night — moon, hills, stars (default)",
            "studio": "{kind:'studio'} bright presenter stage — spotlight pool and "
                      "floor line, made for caster / info videos (top/bottom "
                      "colors overridable)",
            "gradient": "{kind:'gradient', top:[r,g,b], bottom:[r,g,b]}",
            "image": "{kind:'image', media:'/user/media/<file>'} cover-cropped; "
                     "generate one with image_gen first for photoreal scenes",
            "vignette": "any background takes vignette: 0..0.6 edge darkening "
                        "(defaults: night .22, studio .16, gradient .15, image .25; "
                        "0 disables)",
        },
        "motionClips": {
            "builtin": list_builtin_clips(),
            "what": "real mocap (CMU, free license) driving declared bones — add "
                    "clip:{name:'walk'|'punch'|'boxing'|'dance' | media:'<bvh in the "
                    "media store>', speed?, loop?, mirror?, start?, boneMap?} to a "
                    "sprite layer. Canonical bone names the default map drives: "
                    "upperArmR/foreArmR/upperArmL/foreArmL/thighR/shinR/thighL/shinL/"
                    "footR/footL/spine/neck. Angles are deltas vs the clip's first "
                    "frame, so any rig proportions work; paid mocap or your own BVH "
                    "plugs into media the same way",
        },
        "anims2d": {
            "builtin": sorted(_ANIMS_2D),
            "what": "hand-keyed cartoon keypose cycles — act {do:'anim', name:"
                    "'walk'|'run'|'idle'|'punch'|'dance', at, for?, speed?}. Loops "
                    "run for `for` seconds (default 2), one-shots (punch) play once "
                    "and settle. Same canonical bones as mocap clips, but distinct "
                    "key poses with snappy timing, holds and squash — prefer this "
                    "over clip for cutout/cartoon rigs (mocap projected to 2D reads "
                    "limp). pose acts speak the same language via ease:'smooth'|"
                    "'snap'|'overshoot'|'anticipate' and squash:0.4..1.6",
        },
        "models3d": {
            "builtin": list_builtin_models(),
            "what": "real 3D characters rendered server-side (pure-python toon "
                    "rasterizer — no browser): layer {kind:'model3d', media?, "
                    "clip:'<name>' | plays:[{clip, at}..], at?, height? (fraction of "
                    "screen height, default 0.55), yaw? (deg, default 22), speed?, "
                    "tint?:[r,g,b]}. media = a built-in name or a media-store .glb "
                    "(rigged glTF binary). Call model_info first — it lists the "
                    "model's clip names. plays switches clips on the timeline with "
                    "a 0.35s crossfade; without clip/plays the model stands in rest "
                    "pose. Flat-shaded cartoon look on purpose",
        },
        "sprites": {
            "what": "any clip-art declaration by name — seeds ship with the module, "
                    "saved ones come from save_asset; both are the same grammar and "
                    "both animate (enter, acts, roles)",
            "fields": {"at": "[x,y] of the feet (default [0.5,0.9])",
                       "shadow": "drawn-sheet characters standing on the ground get a "
                                 "soft contact shadow under the feet, spreading as the "
                                 "legs part. It is what sets a character ON the ground "
                                 "instead of in front of it. shadow:false turns it off "
                                 "(a floor that is not there, a silhouette scene); a "
                                 "number 0..1 dims it. An anchor:'body' action is "
                                 "airborne and casts none",
                       "scale": "1.0 default", "enter": "walk | peek | pop | none",
                       "lipsync": "true = talk acts follow audio.voice envelope",
                       "acts": "[{at, do:'wave'|'talk'|'jump'|'point'|'pose'|'anim'|'move'|'express', "
                               "for, to:[x,y], bones:{name:deg}, ease?, squash?, "
                               "name?}] — anim plays a built-in 2D keypose cycle "
                               "(see anims2d); point aims a presenter "
                               "stick at the normalized target and taps it "
                               "(weather-caster style); a rig with upperArmR/foreArmR (or L) bones raises that arm to aim along the stick. pose eases declared bones to "
                               "the given angles (degrees, + = clockwise) and holds — "
                               "chain pose acts for keyframe choreography (punch, "
                               "bow, kick). express {as:'<variant name>'} swaps the "
                               "crop of every part that declares that name for its "
                               "window, so the face changes while the body keeps "
                               "moving"},
        },
        "layers": {
            "bubble": "{text, at?, heart?, typing?} speech balloon, types itself out",
            "title": "{lines:[{text, size:'xl'|'lg'|'md'|'sm', color:'ink'|'amber'|"
                     "'cyan'|[r,g,b]}], at?} stacked display text with shadow",
            "caption": "{text, at?} subtitle pill, centred on `at` (default y 0.855, "
                       "near the bottom). Captions are a choice, not a transcript — "
                       "one short line per beat reads; a running transcript of the "
                       "narration does not. Whatever sits above one has to end "
                       "before it: default caption + a 3-row list is y 0.80 of room, "
                       "and content generally wants to stay inside y 0.08..0.92",
            "card": "{rows:[{label, value}], at?, w?, accent?} info card, slides in",
            "list": "{rows:[{lead, text, dots?:[[r,g,b]..], highlight?, tag?}], at?, w?} "
                    "staggered time-table rows; highlight = amber emphasis + tag badge",
            "math": "{tex, at?, h?, color?, write?} a formula the scene states as a "
                    "STRING and the module typesets — tex is TeX-ish source "
                    "(\\frac, ^{}, \\sqrt, |...|, \\ln, \\Longleftrightarrow), h is the "
                    "height as a fraction of the frame (default 0.075), write is how "
                    "many seconds it takes to appear left-to-right, which is what "
                    "reads as a hand writing on a board (0 = all at once). No image "
                    "file, no browser, no screenshot. `$...$` inside a caption's text "
                    "is typeset the same way, so Korean prose and maths share one line",
            "image": "{media, at?, w?, rounded?, kenburns?:{zoom, panx}} a picture from "
                     "the media store with optional Ken Burns drift. A PNG's own "
                     "transparency is kept, so a cut-out or a formula drops onto the "
                     "scene as ink rather than as a rectangle — rounded:false when the "
                     "picture already carries its own edge",
            "spritesheet": "{media, grid:[cols,rows], count?, fps?, at?, w?, loop?} "
                           "an animated frame-grid image — cells advance "
                           "left-to-right, top-to-bottom at fps (default 12) and "
                           "loop. Free game sprite sheets from the media store work "
                           "as-is; count trims unused trailing cells",
            "fireworks": "{density?} launching rockets and radial bursts",
            "hearts": "{at?} floating hearts",
            "confetti": "{at?} one confetti burst at `from`",
            "spark": "{at, color?, size?} radial impact flash — give it a short "
                     "window (0.2~0.35s) right on the hit frame",
            "shake": "{amp?} camera shake for the layer window — pair with spark "
                     "on hits (amp in px at 1080 base, default 14)",
            "speedlines": "{dir:'left'|'right'} streaking anime speed lines",
            "hpbar": "{side:'left'|'right', value:0..1, valueTo?, color?, label?} "
                     "fighting-game health bar; valueTo animates a hit drain over "
                     "the layer window",
        },
        "audio": {"bgm": "media path (flac/wav/mp3) — render one with the sing module. "
                         "A track shorter than the scene repeats to fill it, with a "
                         "0.25s crossfade hiding the loop point",
                  "voice": "one media path starting at t=0 (tts output); ducks the bgm "
                           "and drives lipsync. THE COST: one file has one start "
                           "time, so every layer after it is timed by guessing where "
                           "the narration got to — the visuals and the voice drift "
                           "apart over a minute. Right for a scene whose visuals do "
                           "not have to land on particular words; for anything "
                           "narrated point-by-point use voices",
                  "voices": "lines on the timeline: [{media, at}] (max 12) — dialogue "
                            "between characters AND single-narrator explainers, which "
                            "is most of them. One tts call per point, the duration "
                            "action per file, then each line starts where the previous "
                            "one ended: now the caption, card or list for that point "
                            "shares its `at` and its length, and the picture cannot "
                            "drift from the words. The mouth follows the mixed "
                            "envelope automatically",
                  "bgmGainDb": "default -8",
                  "bgmLoop": "default true — false plays the track once and leaves the "
                             "rest of the scene silent"},
        "voiceSync": "the recipe for BOTH dialogue and narration: tts each line → duration each file → for line i "
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
                       "shapes: roundedrect {radius}, text {height, bind:'text'|value}, "
                       "and image {media, crop:[[x,y]..] 3..60 pairs in 0..1 IMAGE "
                       "coords, at:[vx,vy], width in viewBox units, pivot?, flip?, variants?:{name: crop}} — "
                       "(variants = named alternate crops of the SAME picture; the "
                       "express act picks one, so generate the character as ONE "
                       "expression sheet and cut each face from it) — "
                       "cutout rigging: a polygon-cropped piece of a real picture "
                       "becomes a joint and animates with the same roles (crop a limb, "
                       "put pivot at its shoulder, give it swing or flap; mouth drops "
                       "the jaw piece with the voice). "
                       "Top level may set aspect (canvas h/w for stickers, 0.3..2) and "
                       "bones: {name: {pivot:[x,y], parent?}} (max 40) — FK chains: a "
                       "part tagged bone:'name' follows its bone, children follow "
                       "parents (shoulder→elbow→fist). Drive angles with the pose act "
                       "or sticker pose.bones {name: degrees}",
        },
        "stickers": {
            "what": "the sticker action exports any declaration (seed or saved) as a "
                    "transparent PNG — pose {wave, mouth, blink, squash} moves the "
                    "tagged parts, pose.text fills a text part (balloon)",
        },
        "moveAct": "sprite act {do:'move', at, for, to:[x,y], ease?} — eases the "
                   "sprite's position to a new screen point and holds; chain move "
                   "acts to travel a path (ease 'linear' for constant-speed "
                   "segments like a rolling ball, 'smooth' to settle at the end)",
        "camera": "scene-level zoom/pan keyframes: camera:[{at, zoom:1..4, "
                  "center:[x,y] 0..1, in? seconds}] — each keyframe eases from "
                  "the previous state and holds. This is THE way to zoom into a "
                  "region while its line is spoken (never swap whole background "
                  "images per segment). zoom:1 returns to full frame",
        "drawnCharacter": "save_asset {name, sheets:{<action>:{media, fps?, loop?, frames?, anchor?, face?}}} — media is one sheet or a LIST of them, since a long cycle does not fit on one canvas: 6 frames a sheet at 1536x1024 leaves each drawing room, 12 comes back with the bottom row cut off at the edge. Frames are numbered straight through the list. A character "
                      "whose actions are DRAWN frames, not a posed rig. " + 'Ask image_gen for: one action split into N distinct frames with the wing/limb position named for EACH frame and no two alike (asking for "8 frames" alone comes back as three drawings and five near-copies); the body held still so only the moving part moves; and a TRANSPARENT background, adding that if transparency is not possible it should use a flat solid backdrop of one stated colour (e.g. magenta #FF00FF) that appears NOWHERE on the character, since that colour is keyed out on import and any of it in the drawing is a hole. Stating the colour is followed closely — measured, #FF00FF came back as rgb(247,5,245) over 99.8% of the ground; saying only "transparent" came back three different ways (real alpha, green, a painted checkerboard).' + " "
                      "save it under an action name, and the frame boxes are found from the alpha "
                      "(a flat single-colour backdrop is keyed out on import, so a chroma-key "
                      "or checkerboard sheet works too). What comes back is often not a cycle "
                      "— frames:[1,2,3,2] says which drawings play and in what order, and ONE number is a "
                      "held pose — so ask for a standing frame alongside the cycle and let idle "
                      "take that one while walk lists the cycle without it, "
                      "counting them off the sheet from 1, which turns three good drawings into "
                      "a loop and leaves out the ones that do not fit "
                      "— no coordinates by hand. A scene plays it with {kind:'sprite', name, "
                      "plays:[{action, at, for?, travel?:'right'|'left'}]} and frames are pasted, "
                      "never blended. travel lets the STRIDE set the speed — the sheet's own foot "
                      "separation is measured at save time, so the ground passes at exactly the "
                      "rate the legs walk and nothing skates; moving a walker with a hand-written "
                      "move act is what makes it look like race walking. It advances on the "
                      "DRAWING's beat, not the video's, so fps is the whole of how smooth the "
                      "travel looks: at 8 on a 24fps video the character steps forward three "
                      "video frames at a time, which is what a held drawing does and what keeps "
                      "the planted foot still — sliding a frozen picture instead drags that foot "
                      "44px forward and snaps it back eight times a second (measured 2026-09-01, "
                      "9.4% of the figure's height). A sheet whose feet "
                      "never separate has no stride and travel does nothing for it — a "
                      "bird or a rolling ball crosses the screen with a move act, which "
                      "works on drawn characters exactly as it does on rigs. anchor says what `at` "
                      "pins — 'feet' (default) lines up the bottoms, which is standing on the "
                      "ground; 'body' pins whatever every frame of the action has in common "
                      "(overlay them: the part that lands on itself is the character, "
                      "the rest is the motion) and is what a flying or jumping action "
                      "needs, since a raised wing makes the frame box taller and aligning "
                      "bottoms would swing the character once per cycle. face: {} (or "
                      "{from: N, bottom?}) banks ONE head and wears it in every frame, "
                      "erase-then-paste at each frame's own neck anchor — the proportion "
                      "lottery the generator rolls per call cannot be scaled away (it is "
                      "non-uniform), so the head is replaced, not normalised: measured, seven "
                      "frames rendered identical to 0.0% against 4.2% unbanked. For actions "
                      "where only the head crosses the neck line — a walk, a bow; not a wave. "
                      "Playback fps is the "
                      "animation cadence, not the video's: 8 is anime's usual 3s, 12 is 2s. Sheets "
                      "and shape parts are alternatives: a drawn character needs no parts",
    "concat": "concat {clips:['<mp4>', '<mp4>', ...]} - joins 2..12 finished clips "
              "in order, ffmpeg stream copy, no re-encode. This is how a video "
              "longer than one scene is made: a 10s 1080p draft costs ~53s of "
              "render, so five minutes is ~30min whichever way it is cut - as one "
              "bake, fixing one line costs that again; as clips it costs the one "
              "clip plus a join measured in seconds. Every part must share size, "
              "fps and quality",
    "trim": "trim {media:'<mp4 in the media store or data/motion>', from?, to} "
                "or {media, segments:[{from,to}..up to 6]} — ffmpeg stream copy, "
                "no re-render: splitting a finished video is seconds, not minutes. "
                "Cuts snap to keyframes (edges may start up to ~1s early)",
        "textGlyphs": "server fonts carry Korean + basic latin only — emoji in "
                      "title/caption/card text render as tofu boxes. Weather/state "
                      "marks: write words (맑음, 비, 눈) or use colored dots, "
                      "never emoji",
        "iteration": "pass stills:[t1,t2,...] to get PNG frames in seconds instead of "
                     "a minutes-long video render — inspect, adjust, then render for "
                     "real. They come back as `urls` under /user/media/_scratch/, "
                     "viewable but NOT in the media gallery, and swept after a day: "
                     "a review pass is worth dozens of frames and none of them is the "
                     "deliverable",
        "longRenders": "renders longer than ~20s can outlive the tool roundtrip — "
                       "pass async:true to get a jobId immediately, then poll "
                       "{action:'job', id} (running: progress + etaSec); the poll "
                       "that sees state 'done' imports the finished video",
    }}

def action_trim(inp):
    """Cut segments out of an existing mp4 with ffmpeg stream copy — no
    re-render, no re-encode. Splitting a finished video used to mean drawing
    every frame again (measured 2026-08-26: a 45s weather short was fully
    re-rendered twice to become two files). Cuts snap to keyframes, so edges
    can land up to ~1s early — documented, not a bug."""
    import imageio_ffmpeg
    try:
        src_path = media_path(inp.get("media"))
    except SceneError as e:
        return {"success": False, "error": str(e)}
    segs = inp.get("segments")
    if segs is None:
        if inp.get("to") is None:
            return {"success": False,
                    "error": "trim needs {media, from?, to} or "
                             "{media, segments:[{from,to}..]} (seconds)"}
        segs = [{"from": inp.get("from", 0), "to": inp.get("to")}]
    if not isinstance(segs, list) or not 1 <= len(segs) <= 6:
        return {"success": False, "error": "segments: 1 to 6 {from,to} spans"}
    norm = []
    for i, s in enumerate(segs):
        try:
            f0 = float((s or {}).get("from", 0))
            t0 = float((s or {}).get("to"))
        except (TypeError, ValueError):
            return {"success": False, "error": f"segments[{i}] needs numeric from/to"}
        if not (0 <= f0 < t0 <= 6000):
            return {"success": False, "error": f"segments[{i}]: need 0 <= from < to"}
        norm.append((f0, t0))
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = hashlib.sha1(f"{src_path}:{norm}".encode()).hexdigest()[:10]
    imports, spans = [], []
    for i, (f0, t0) in enumerate(norm):
        out = os.path.join(OUT_DIR, f"trim-{tag}-{i}.mp4")
        r = subprocess.run(
            [ff, "-y", "-ss", str(f0), "-to", str(t0), "-i", src_path,
             "-c", "copy", "-movflags", "+faststart", out],
            capture_output=True, timeout=120)
        if r.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) < 1000:
            tail = r.stderr.decode("utf-8", "replace")[-300:]
            return {"success": False,
                    "error": f"segments[{i}] cut failed: {tail}"}
        spans.append({"from": f0, "to": t0, "bytes": os.path.getsize(out)})
        imports.append({"path": _out(out), "contentType": "video/mp4",
                        "filenameHint": f"motion-trim-{tag}-{i}"})
    return {"success": True,
            "data": {"segments": spans,
                     "note": "stream copy — cuts snap to the nearest keyframe, "
                             "so a boundary can start up to ~1s before the "
                             "requested second",
                     "_mediaImport": imports if len(imports) > 1 else imports[0]}}

def action_concat(inp):
    """Join finished mp4s into one, with ffmpeg stream copy - no re-render.

    The 90-second scene cap is not why a long story is built in clips. Measured
    2026-08-30 on this server, a 10-second 1920x1080 draft frame loop costs 53
    seconds of wall time, so five minutes is half an hour of rendering however it
    is cut. Baked as one file, fixing one caption costs that half hour again;
    baked as clips it costs the eight minutes of the clip that was wrong, plus
    this, which is seconds.

    Stream copy needs the parts to agree on codec, size and frame rate.
    Everything `render` makes does, because it makes them with the same settings.
    When they do not, ffmpeg's own complaint is reported rather than a guess.
    """
    import imageio_ffmpeg
    # `clips`, not `media`: media is declared a string for duration and trim, and a
    # union type resolves to that branch, so a list handed in as `media` arrived
    # flattened and this action refused every call (2026-09-03).
    media = inp.get("clips")
    if media is None and isinstance(inp.get("media"), list):
        media = inp.get("media")          # a caller that already had the list shape
    if not isinstance(media, list) or not 2 <= len(media) <= 12:
        return {"success": False,
                "error": "concat needs {clips:[<mp4>, <mp4>, ...]} - 2 to 12 clips "
                         "in the order they should play"}
    paths = []
    for i, m in enumerate(media):
        try:
            paths.append(media_path(m))
        except SceneError as e:
            return {"success": False, "error": f"media[{i}]: {e}"}
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = hashlib.sha1(":".join(paths).encode()).hexdigest()[:10]
    # Each part is linked into a scratch directory under a plain name before the
    # list file is written. A media name may carry a space or a quote, and the
    # demuxer would take a bare one as the end of the path and silently join the
    # wrong set - linking removes the question instead of escaping around it.
    work = os.path.join(OUT_DIR, "concat-" + tag)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    listing = os.path.join(work, "parts.txt")
    with open(listing, "w", encoding="utf-8") as fh:
        for i, path in enumerate(paths):
            link = os.path.join(work, "p%02d.mp4" % i)
            try:
                os.symlink(os.path.abspath(path), link)
            except OSError:
                shutil.copyfile(path, link)
            fh.write("file " + chr(39) + os.path.basename(link) + chr(39) + chr(10))
    out = os.path.join(OUT_DIR, f"concat-{tag}.mp4")
    r = subprocess.run(
        [ff, "-y", "-f", "concat", "-safe", "0", "-i", listing,
         "-c", "copy", "-movflags", "+faststart", out],
        capture_output=True, timeout=300)
    shutil.rmtree(work, ignore_errors=True)
    if r.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) < 1000:
        tail = r.stderr.decode("utf-8", "replace")[-400:]
        return {"success": False,
                "error": f"concat failed: {tail} - stream copy needs every clip at "
                         "the same size, fps and codec; render the parts with the "
                         "same size/fps/quality and join again"}
    return {"success": True,
            "data": {"parts": len(paths), "bytes": os.path.getsize(out),
                     "note": "stream copy - no re-encode, so the joined file is "
                             "exactly the quality of its parts",
                     "_mediaImport": {"path": _out(out), "contentType": "video/mp4",
                                      "filenameHint": f"motion-concat-{tag}"}}}


def action_model_info(inp):
    ref = str(inp.get("media") or "robot")
    try:
        m = gltf3d.load(_model_path(ref))
    except SceneError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001 — a broken GLB reports, not crashes
        return {"success": False, "error": f"{type(e).__name__}: {e}"}
    d = m.info()
    d["builtin"] = list_builtin_models()
    d["next"] = ("scene layer {kind:'model3d', media?, clip | plays:[{clip,at}..], "
                 "at?, height?, yaw?, speed?, tint?} — a clip loops for the layer "
                 "window; plays switches clips on the timeline with a crossfade")
    return {"success": True, "data": d}

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

    # The canary is two-way on purpose: a fitter that moved everything would look
    # just as green as one that moved nothing if only the overflowing case were checked.
    rows3 = [{"lead": "01", "text": "a"}, {"lead": "02", "text": "b"},
             {"lead": "03", "text": "c"}]
    over = Scene({**base, "size": "1920x1080",
                  "layers": [{"kind": "list", "from": 0, "to": 2, "at": [0.36, 0.59],
                              "rows": rows3}]})
    fitted_y = over.layers[0]["at"][1]
    ck("a 3-row list placed past the bottom is moved up, and says so",
       "y<0.59 + one note", (round(fitted_y, 3), len(over.layout_fixes)),
       fitted_y < 0.59 and len(over.layout_fixes) == 1
       and fitted_y + (2 * Scene.LIST_ROW + Scene.LIST_PLAIN) / 1080.0 <= 1.0001)
    ok_scene = Scene({**base, "size": "1920x1080",
                      "layers": [{"kind": "list", "from": 0, "to": 2, "at": [0.36, 0.30],
                                  "rows": rows3}]})
    ck("a list that already fits is left exactly where it was asked for",
       (0.30, 0), (ok_scene.layers[0]["at"][1], len(ok_scene.layout_fixes)),
       ok_scene.layers[0]["at"][1] == 0.30 and not ok_scene.layout_fixes)

    # Expression variants: the declaration keeps them, and a malformed one is
    # refused at save time rather than at the first frame of a paid render.
    base = {"shape": "image", "media": "x.png", "at": [50, 20], "width": 20,
            "crop": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]]}
    kept = validate_asset_decl("t", [dict(base, variants={
        "슬픔": [[0.5, 0.1], [0.8, 0.1], [0.8, 0.4], [0.5, 0.4]]})])[0]
    ck("a face part keeps its named alternate crops",
       ["슬픔"], list((kept.get("variants") or {}).keys()),
       list((kept.get("variants") or {}).keys()) == ["슬픔"]
       and kept["variants"]["슬픔"][1] == [0.8, 0.1])
    bad = None
    try:
        validate_asset_decl("t", [dict(base, variants={"x": [[0.1, 0.1]]})])
    except SceneError as e:
        bad = str(e)
    ck("a variant with too few points is refused at save time",
       "SceneError", bad, bad is not None and "variants" in bad)
    # The other half of the canary: no variants declared means the part is
    # untouched by any expression, so a scene that never asks still renders.
    plain = validate_asset_decl("t", [dict(base)])[0]
    ck("a part with no variants declares none",
       None, plain.get("variants"), plain.get("variants") is None)

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
       "6 seeds valid", f"{len(seeds)} seeds, valid={seed_ok}",
       len(seeds) == 6 and seed_ok)

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
                                          {"at": 0, "do": "talk", "for": 1.5},
                                          {"at": 0, "do": "point", "for": 1.5,
                                           "to": [0.75, 0.25]}]}]})
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
    trim_ok, trim_note = False, ""
    try:
        out = action_render({"action": "render", "duration": 0.6, "fps": 10,
                             "quality": "draft", "size": "1080x1080",
                             "layers": [{"kind": "confetti", "from": 0.1, "to": 0.6}]})
        enc_ok = out.get("success") and out["data"]["bytes"] > 2000
        enc_note = out["data"]["bytes"] if enc_ok else out.get("error", "")
        if enc_ok:
            vp = out["data"]["_mediaImport"]["path"]
            tr = action_trim({"media": vp, "from": 0.1, "to": 0.4})
            # a 0.6s clip is a single GOP, so a stream-copied cut can equal the
            # original byte-for-byte — the check is that the cut EXISTS and never
            # exceeds the source, not that keyframe granularity shrinks it
            trim_ok = tr.get("success") and                 1000 < tr["data"]["segments"][0]["bytes"] <= out["data"]["bytes"]
            trim_note = (tr["data"]["segments"][0]["bytes"] if trim_ok
                         else tr.get("error", ""))
            if trim_ok:
                os.remove(tr["data"]["_mediaImport"]["path"])
            os.remove(vp)
    except Exception as e:  # noqa: BLE001 — the check reports, not crashes
        enc_note = enc_note or repr(e)
        trim_note = trim_note or repr(e)
    ck("a tiny scene encodes to a real mp4", ">2000 bytes", enc_note, enc_ok)
    ck("trim stream-copies a cut without re-rendering",
       "cut exists, <= original", trim_note, trim_ok)

    cam_ok, cam_note = False, ""
    try:
        base = {"action": "render", "duration": 2.0, "quality": "draft",
                "size": "1080x1080",
                "layers": [{"kind": "sprite", "name": "한반도", "from": 0, "to": 2,
                            "enter": "none", "at": [0.5, 0.62], "scale": 2.2}]}
        f_plain = Scene(base).draw_frame(1.5)
        zoomed = dict(base, camera=[{"at": 0.5, "zoom": 2.0,
                                     "center": [0.7, 0.4], "in": 0.5}])
        f_zoom = Scene(zoomed).draw_frame(1.5)
        delta = int(np.abs(f_plain.astype(int) - f_zoom.astype(int)).sum())
        cam_ok = f_zoom.shape == f_plain.shape and delta > 500000
        cam_note = f"delta={delta}, shape={f_zoom.shape}"
    except Exception as e:  # noqa: BLE001
        cam_note = f"{type(e).__name__}: {e}"
    ck("camera keyframes zoom the composed frame (shape preserved)",
       "zoomed frame differs", cam_note, cam_ok)

    bone_note, bone_ok = "", False
    try:
        bones = validate_bones({"up": {"pivot": [50, 50]},
                                "fore": {"pivot": [70, 50], "parent": "up"}},
                               [{"shape": "rect", "bone": "fore"}])
        ms = _bone_affines(bones, {"up": math.radians(90),
                                   "fore": math.radians(-90)})
        px, py = _affine_apply(ms["fore"], 80, 50)
        bone_ok = abs(px - 60) < 0.01 and abs(py - 70) < 0.01
        bone_note = f"fore end -> ({px:.2f},{py:.2f})"
    except Exception as e:  # noqa: BLE001
        bone_note = f"{type(e).__name__}: {e}"
    ck("a two-bone FK chain composes child-after-parent", "(60.00,70.00)",
       bone_note, bone_ok)

    clip_note, clip_ok = "", False
    try:
        cur = _clip_curves(os.path.join(_CLIP_DIR, "walk.bvh"))
        spread = {k: float(np.ptp(v)) for k, v in cur["curves"].items()}
        moving = sum(1 for v in spread.values() if v > 0.3)
        clip_ok = len(cur["curves"]) >= 10 and moving >= 6 and cur["dur"] > 2.0
        clip_note = f"bones={len(cur['curves'])}, moving>0.3rad={moving}, " \
                    f"dur={cur['dur']:.1f}s"
    except Exception as e:  # noqa: BLE001
        clip_note = f"{type(e).__name__}: {e}"
    ck("the built-in walk mocap parses and animates most bones",
       ">=10 bones, >=6 moving", clip_note, clip_ok)

    an_note, an_ok = "", False
    try:
        b0, _, _ = _sample_anim(_ANIMS_2D["walk"], 0.0)
        b5, _, s5 = _sample_anim(_ANIMS_2D["walk"], 0.5)
        bp, _, _ = _sample_anim(_ANIMS_2D["punch"], 1.0)
        snap_ok = abs(ease2d("snap", 0.6) - 1.0) < 1e-9             and ease2d("anticipate", 0.1) < 0
        an_ok = (b0["thighR"] < 0 < b5["thighR"]
                 and b0["thighL"] > 0 > b5["thighL"]
                 and abs(bp.get("upperArmR", 99.0)) < 1e-9 and snap_ok)
        an_note = f"walk thighR {b0['thighR']:.0f}/{b5['thighR']:.0f}, "                   f"punch settled={abs(bp.get('upperArmR', 99.0)) < 1e-9}, "                   f"snap@0.6={ease2d('snap', 0.6):.3f}"
    except Exception as e:  # noqa: BLE001
        an_note = f"{type(e).__name__}: {e}"
    ck("2D keypose cycles: walk alternates legs, punch settles, snap eases",
       "legs mirror at half phase", an_note, an_ok)

    an2_note, an2_ok = "", False
    try:
        pr = [{"shape": "capsule", "ends": [[48, 40], [48, 58]], "width": 7,
               "fill": [200, 120, 60], "bone": "thighR"},
              {"shape": "capsule", "ends": [[52, 40], [52, 58]], "width": 7,
               "fill": [200, 120, 60], "bone": "thighL"},
              {"shape": "ellipse", "at": [50, 28], "size": [22, 26],
               "fill": [200, 120, 60], "bone": "spine"}]
        sv5 = action_save_asset({"name": "selftest-anim", "parts": pr,
                                 "bones": {"spine": {"pivot": [50, 40]},
                                           "thighR": {"pivot": [48, 40]},
                                           "thighL": {"pivot": [52, 40]}}})
        assert sv5.get("success"), sv5
        os.remove(sv5["data"]["_mediaImport"]["path"])
        sc5 = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                     "layers": [{"kind": "sprite", "name": "selftest-anim",
                                 "from": 0, "to": 2, "enter": "none",
                                 "acts": [{"at": 0, "do": "anim", "name": "walk",
                                           "for": 2.0},
                                          {"at": 0.2, "do": "pose", "for": 0.4,
                                           "ease": "overshoot", "squash": 0.9,
                                           "bones": {"spine": 6}}]}]})
        fa = sc5.draw_frame(0.6)
        fb = sc5.draw_frame(1.0)
        moved = int(np.abs(fa.astype(int) - fb.astype(int)).sum())
        warm = ((fa[:, :, 0].astype(int) - fa[:, :, 2].astype(int)) > 60).sum()
        action_delete_asset({"name": "selftest-anim"})
        an2_ok = warm > 3000 and moved > 100000
        an2_note = f"warm px={int(warm)}, frame delta={moved}"
    except Exception as e:  # noqa: BLE001
        an2_note = f"{type(e).__name__}: {e}"
    ck("an anim act renders and the cycle actually moves the rig between frames",
       "visible + moving", an2_note, an2_ok)

    fx_note, fx_ok = "", False
    try:
        scf = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                     "size": "1080x1080",
                     "layers": [{"kind": "spark", "from": 0.5, "to": 0.8,
                                 "at": [0.5, 0.5]},
                                {"kind": "shake", "from": 0.5, "to": 0.9, "amp": 20},
                                {"kind": "speedlines", "from": 0, "to": 2.0},
                                {"kind": "hpbar", "from": 0, "to": 2.0,
                                 "side": "left", "value": 1.0, "valueTo": 0.55}]})
        frf = scf.draw_frame(0.58)
        red = ((frf[:, :, 0].astype(int) - frf[:, :, 2].astype(int)) > 60).sum()
        fx_ok = red > 200 and frf.shape[0] == 1080
        fx_note = f"spark px={red}"
    except Exception as e:  # noqa: BLE001
        fx_note = f"{type(e).__name__}: {e}"
    ck("fight fx layers (spark+shake+speedlines+hpbar) draw", "spark px > 200",
       fx_note, fx_ok)

    cut_note, cut_ok = "", False
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        tpimg = os.path.join(OUT_DIR, "selftest-cut.png")
        src = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        dd = ImageDraw.Draw(src)
        dd.ellipse([40, 60, 160, 190], fill=(90, 140, 220, 255))
        dd.rectangle([120, 20, 190, 70], fill=(230, 120, 60, 255))
        src.save(tpimg)
        parts = [
            {"shape": "image", "media": tpimg, "crop": [[0.1, 0.25], [0.9, 0.25],
                                                        [0.9, 1.0], [0.1, 1.0]],
             "at": [50, 70], "width": 60},
            {"shape": "image", "media": tpimg, "crop": [[0.55, 0.05], [1.0, 0.05],
                                                        [1.0, 0.4], [0.55, 0.4]],
             "at": [78, 30], "width": 30, "role": "swing", "pivot": [64, 42]},
        ]
        sv = action_save_asset({"action": "save_asset", "name": "selftest-cut",
                                "parts": parts})
        assert sv.get("success"), sv
        os.remove(sv["data"]["_mediaImport"]["path"])
        sc3 = Scene({"action": "render", "duration": 1.2, "quality": "draft",
                     "layers": [{"kind": "sprite", "name": "selftest-cut", "from": 0,
                                 "to": 1.2, "enter": "none",
                                 "acts": [{"at": 0, "do": "wave", "for": 1.2}]}]})
        fr3 = sc3.draw_frame(0.6)
        blue = ((fr3[:, :, 2].astype(int) - fr3[:, :, 0].astype(int)) > 40).sum()
        st3 = action_sticker({"action": "sticker", "name": "selftest-cut",
                              "stickerSize": 200})
        st_ok = st3.get("success", False)
        if st_ok:
            os.remove(st3["data"]["_mediaImport"]["path"])
        action_delete_asset({"name": "selftest-cut"})
        os.remove(tpimg)
        cut_ok = blue > 2000 and st_ok
        cut_note = f"blue px={blue}, sticker={st_ok}"
    except Exception as e:  # noqa: BLE001
        cut_note = f"{type(e).__name__}: {e}"
    ck("an image-cutout part crops, rigs and draws in scene and sticker",
       "blue body visible + sticker ok", cut_note, cut_ok)

    mv_note, mv_ok = "", False
    try:
        scm = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                     "size": "1080x1080",
                     "layers": [{"kind": "sprite", "name": "heart", "from": 0,
                                 "to": 2, "enter": "none", "at": [0.2, 0.5],
                                 "acts": [{"at": 0.9, "do": "move", "for": 0.6,
                                           "to": [0.8, 0.5], "ease": "linear"}]}]})
        def wx(fr):
            warm = (fr[:, :, 0].astype(int) - fr[:, :, 2].astype(int)) > 60
            xs = np.nonzero(warm.any(axis=0))[0]
            return int(xs.mean()) if len(xs) else -1
        # sample after the scene's own 0.5s fade-in — a dim frame has no
        # pixels past the warm threshold and reads as "sprite missing"
        # ...and before the 0.55s tail fade-out, same reason
        x0, x1 = wx(scm.draw_frame(0.6)), wx(scm.draw_frame(1.35))
        mv_ok = 0 <= x0 < 500 and x1 > x0 + 400
        mv_note = f"centroid {x0} -> {x1}"
    except Exception as e:  # noqa: BLE001
        mv_note = f"{type(e).__name__}: {e}"
    ck("a move act carries a sprite across the screen and holds",
       "centroid shifts right", mv_note, mv_ok)

    sh_note, sh_ok = "", False
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        shimg = os.path.join(OUT_DIR, "selftest-sheet.png")
        sheet = Image.new("RGBA", (200, 200), (0, 0, 0, 255))
        dd = ImageDraw.Draw(sheet)
        for ci, col in enumerate([(220, 40, 40), (40, 200, 60),
                                  (60, 80, 220), (230, 200, 40)]):
            x, y = (ci % 2) * 100, (ci // 2) * 100
            dd.rectangle([x, y, x + 99, y + 99], fill=(*col, 255))
        sheet.save(shimg)
        scs = Scene({"action": "render", "duration": 3.0, "quality": "draft",
                     "size": "1080x1080",
                     "layers": [{"kind": "spritesheet", "media": shimg,
                                 "grid": [2, 2], "fps": 2, "from": 0, "to": 3}]})
        def cpx(tq):
            return scs.draw_frame(tq)[540, 540].astype(int)
        p1, p2, p3 = cpx(0.6), cpx(1.6), cpx(2.2)
        # fps 2: t=0.6 -> cell 1 (green), t=1.6 -> cell 3 (yellow),
        # t=2.2 -> index 4 wraps to cell 0 (red) = the loop is proven
        sh_ok = (p1[1] > p1[0] + 60 and p1[1] > p1[2] + 60
                 and p2[0] > 150 and p2[1] > 150 and p2[2] < 120
                 and p3[0] > p3[1] + 60 and p3[0] > p3[2] + 60)
        sh_note = f"center px g={list(p1)} y={list(p2)} r={list(p3)}"
        os.remove(shimg)
    except Exception as e:  # noqa: BLE001
        sh_note = f"{type(e).__name__}: {e}"
    ck("a spritesheet layer advances cells at fps and loops",
       "green -> yellow -> red at the center", sh_note, sh_ok)

    # Reading order, both ways: a short bottom-anchored figure must stay in its
    # row (its higher top once fell across a fixed band edge and swapped play
    # order with its neighbour -- the walk limped), and two REAL rows must still
    # come back as two rows read top-to-bottom.
    ro_note, ro_ok = "", False
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        rp = os.path.join(OUT_DIR, "selftest-roworder.png")
        ri = Image.new("RGBA", (600, 1000), (0, 0, 0, 0))
        rd = ImageDraw.Draw(ri)
        rd.ellipse([100, 100, 180, 380], fill=(30, 40, 90, 255))    # top-left
        rd.ellipse([400, 100, 480, 380], fill=(30, 40, 90, 255))    # top-right
        # bottom row, feet on one line at y=950; the LEFT one is drawn short, so its
        # top (570) sits across the old 18%-band edge from its neighbour's (520)
        rd.ellipse([100, 570, 180, 950], fill=(30, 40, 90, 255))    # bottom-left, short
        rd.ellipse([400, 520, 480, 950], fill=(30, 40, 90, 255))    # bottom-right, tall
        ri.save(rp)
        rc = find_sheet_cells(rp)
        xs = [c[0] for c in rc]
        ys = [c[1] for c in rc]
        ro_note = f"order x={xs} y={ys}"
        ro_ok = (len(rc) == 4 and ys[0] < 400 and ys[1] < 400          # top row first
                 and ys[2] > 400 and ys[3] > 400                       # then the bottom row
                 and xs[0] < xs[1] and xs[2] < xs[3])                  # left before right in each
        os.remove(rp)
    except Exception as e:  # noqa: BLE001
        ro_note = f"{type(e).__name__}: {e}"
    ck("reading order survives a short frame, and real rows stay rows",
       "TL, TR, BL(short), BR", ro_note, ro_ok)

    # Keying a flat backdrop, both ways: a sheet that needs it becomes readable,
    # and a picture that does not is returned with every pixel it had. One
    # direction alone would pass while the other silently ate real drawings.
    key_note, key_ok = "", False
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        kp = os.path.join(OUT_DIR, "selftest-chroma.png")
        flat = Image.new("RGB", (400, 200), (250, 250, 250))
        kd = ImageDraw.Draw(flat)
        for cx in (80, 300):
            kd.ellipse([cx - 50, 40, cx + 50, 160], fill=(40, 50, 90))
            # A white belly inside the figure: the backdrop's own colour, enclosed.
            kd.ellipse([cx - 25, 95, cx + 25, 140], fill=(252, 252, 252))
            # And a tiny enclosed hole: backdrop the flood cannot reach. This is the gap
            # between a headband tail and a neck, which reached a finished video as a pink
            # patch on the man's throat. Size is the only thing telling it from the belly.
            kd.ellipse([cx - 3, 57, cx + 3, 63], fill=(250, 250, 250))
        flat.save(kp)
        keyed_cells = find_sheet_cells(kp)
        _ka = np.asarray(load_sheet(kp))[:, :, 3]
        belly = _ka[118, 80]
        pocket = _ka[60, 80]

        # The negative canary: a photo-like sheet whose border is not one colour.
        pp = os.path.join(OUT_DIR, "selftest-nokey.png")
        grad = Image.new("RGB", (400, 200))
        gpx = grad.load()
        for gy in range(200):
            for gx in range(400):
                gpx[gx, gy] = (gx % 256, gy % 256, (gx + gy) % 256)
        grad.save(pp)
        untouched = np.asarray(_key_flat_background(
            Image.open(pp).convert("RGBA")))[:, :, 3].min() == 255

        key_note = (f"keyed cells={len(keyed_cells)} enclosed-belly-alpha={int(belly)} "
                    f"tiny-pocket-alpha={int(pocket)} gradient-untouched={untouched}")
        key_ok = (len(keyed_cells) == 2 and int(belly) > 240
                  and int(pocket) < 40 and untouched)
        os.remove(kp)
        os.remove(pp)
    except Exception as e:  # noqa: BLE001
        key_note = f"{type(e).__name__}: {e}"
    ck("a flat backdrop is keyed to alpha; a big enclosed area is kept, a tiny one is not",
       "keyed cells=2 belly>240 pocket<40 gradient-untouched=True", key_note, key_ok)

    # Frames drawn on separate canvases, both ways. Two sheets whose figures came back at
    # different sizes are put on one; a single sheet is left exactly as drawn, because there
    # a height difference is the pose and flattening it would delete a crouch.
    cs_note, cs_ok = "", False
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        cs_paths = []
        for idx, fig_h in enumerate((120, 90)):          # same character, two canvas sizes
            cp = os.path.join(OUT_DIR, f"selftest-scale{idx}.png")
            im2 = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
            ImageDraw.Draw(im2).ellipse([80, 190 - fig_h, 120, 190], fill=(30, 40, 90, 255))
            im2.save(cp)
            cs_paths.append(_out(cp))
        two = validate_sheets({"a": {"media": cs_paths}})["a"]["cellScale"]
        one = os.path.join(OUT_DIR, "selftest-scale-one.png")
        im3 = Image.new("RGBA", (400, 200), (0, 0, 0, 0))
        d3 = ImageDraw.Draw(im3)
        d3.ellipse([40, 70, 80, 190], fill=(30, 40, 90, 255))     # tall pose
        d3.ellipse([240, 100, 280, 190], fill=(30, 40, 90, 255))  # crouched pose
        im3.save(one)
        same = validate_sheets({"a": {"media": _out(one)}})["a"]["cellScale"]
        # The other side of the gate: the same two-cell sheet, but only 5% apart. That is
        # the generator drawing one character at two sizes, and it has to be flattened --
        # left alone it is the height dropping mid-stride that started all this.
        near = os.path.join(OUT_DIR, "selftest-scale-near.png")
        im4 = Image.new("RGBA", (400, 200), (0, 0, 0, 0))
        d4 = ImageDraw.Draw(im4)
        d4.ellipse([40, 70, 80, 190], fill=(30, 40, 90, 255))     # 120 tall
        d4.ellipse([240, 76, 280, 190], fill=(30, 40, 90, 255))   # 114 tall -> 5% scatter
        im4.save(near)
        small = validate_sheets({"a": {"media": _out(near)}})["a"]["cellScale"]
        cs_note = (f"across-sheets={[round(v, 2) for v in two]} "
                   f"far-apart-in-one-sheet={[round(v, 2) for v in same]} "
                   f"close-in-one-sheet={[round(v, 3) for v in small]}")
        cs_ok = (len(two) == 2 and abs(max(two) / min(two) - 120 / 90) < 0.08
                 and set(round(v, 3) for v in same) == {1.0}
                 and len(small) == 2 and abs(max(small) / min(small) - 120 / 114) < 0.03)
        for cp in cs_paths + [one, near]:
            os.remove(media_path(cp) if cp.startswith("/") else cp)
    except Exception as e:  # noqa: BLE001
        cs_note = f"{type(e).__name__}: {e}"
    ck("cell heights: scatter is flattened, motion is left alone",
       "across-sheets ~[1.0, 1.33], far-apart all 1.0, close ~[1.0, 1.053]", cs_note, cs_ok)

    # A move act has to carry a drawn-sheet character too. It was accepted and
    # ignored, which reads as "the scene is wrong" rather than "this does nothing".
    mv_note, mv_ok = "", False
    try:
        mvL = {"kind": "sprite", "name": "nongbu-selftest", "from": 0, "to": 2,
               "at": [0.2, 0.9], "plays": [{"action": "walk", "at": 0}],
               "acts": [{"at": 0, "do": "move", "for": 2, "to": [0.8, 0.9],
                         "ease": "linear"}]}
        mvs = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                     "layers": []})
        x_start, _ = mvs._move_acts(mvL, 0.0, *mvs._at(mvL, [0.5, 0.9]))
        x_end, _ = mvs._move_acts(mvL, 2.0, *mvs._at(mvL, [0.5, 0.9]))
        travelled = (x_end - x_start) / float(mvs.SW)
        mv_note = f"moved {travelled:.2f} of the width"
        mv_ok = 0.55 < travelled < 0.65
    except Exception as e:  # noqa: BLE001
        mv_note = f"{type(e).__name__}: {e}"
    ck("a move act carries a sprite whether it is drawn frames or a rig",
       "0.6 of the width", mv_note, mv_ok)

    # Travel is on the drawing's beat, not the clock's. Both directions: a sheet
    # slower than the video must not move between its drawings, and a sheet at the
    # video's own rate must come out exactly where the old continuous travel put it.
    tv_note, tv_ok = "", False
    try:
        PER, VF = 480.0, 24.0
        slow = {"fps": 8, "loop": True, "cells": [None] * 8}
        held = {round(_travel_x(slow, _frame_index(slow, f / VF, 0.0), PER, 1), 6)
                for f in (3, 4, 5)}          # the three video frames of one beat
        nxt = _travel_x(slow, _frame_index(slow, 6 / VF, 0.0), PER, 1)
        beat = (nxt - next(iter(held)))
        fast = {"fps": VF, "loop": True, "cells": [None] * 8}
        same = all(abs(_travel_x(fast, f, PER, 1) - PER * f / 8.0) < 1e-9
                   for f in range(8))
        tv_note = (f"one beat holds {sorted(held)}, next beat +{beat:.1f}px, "
                   f"a drawing per video frame matches continuous travel: {same}")
        tv_ok = len(held) == 1 and abs(beat - PER / 8.0) < 1e-9 and same
    except Exception as e:  # noqa: BLE001
        tv_note = f"{type(e).__name__}: {e}"
    ck("travel steps with the drawing, and is unchanged when they run at one rate",
       "one value per beat, +60px at the beat, fps=video identical", tv_note, tv_ok)

    # The ground speed is divided by the FRAMES, not the drawings. The canonical
    # walk is seven drawings played as eight frames; counting the drawings walks
    # that character 8/7 too fast, which is the skate the stride was measured to
    # avoid. Both directions: an order that is just the cells is unaffected.
    cy_note, cy_ok = "", False
    try:
        PER = 480.0
        seven = {"fps": 8, "loop": True, "cells": [None] * 7,
                 "order": [0, 1, 2, 3, 4, 5, 2, 6]}
        plain = {"fps": 8, "loop": True, "cells": [None] * 8}
        a = _travel_x(seven, 8, PER, 1)      # one full cycle of the frames list
        b = _travel_x(plain, 8, PER, 1)
        cy_note = (f"7 drawings / 8 frames: one cycle covers {a:.1f}px; "
                   f"8 drawings / 8 frames: {b:.1f}px")
        cy_ok = abs(a - PER) < 1e-9 and abs(b - PER) < 1e-9
    except Exception as e:  # noqa: BLE001
        cy_note = f"{type(e).__name__}: {e}"
    ck("one cycle covers one cycle of ground however the frames list is written",
       "both 480.0px", cy_note, cy_ok)

    # What `at` pins. Two frames with the body at the same height but very different
    # box heights: pinned by the feet they sit 100px apart, pinned by the body they
    # do not move at all. A still cannot show this — it is a once-per-cycle bob.
    an_note, an_ok = "", False
    try:
        ap = os.path.join(OUT_DIR, "selftest-anchor.png")
        # Four frames of one wingbeat. The body, nose and tail hold exactly still and
        # only the wing moves — attached mid-body, sweeping through the very columns a
        # middle-fifths average would have called "the body". Four and not two: what
        # every frame has in common is not a question two frames can answer.
        fly = Image.new("RGBA", (900, 300), (0, 0, 0, 0))
        ad = ImageDraw.Draw(fly)
        ink = (30, 40, 80, 255)
        for cx, tipy in ((110, 20), (330, 150), (550, 292), (770, 150)):
            ad.ellipse([cx - 40, 190, cx + 40, 235], fill=ink)
            ad.polygon([(cx + 38, 205), (cx + 85, 210), (cx + 38, 218)], fill=ink)
            ad.polygon([(cx - 38, 205), (cx - 88, 210), (cx - 38, 218)], fill=ink)
            near = 200 if tipy < 200 else 225
            ad.polygon([(cx - 20, near), (cx - 5, tipy), (cx + 14, near + 5)], fill=ink)
        fly.save(ap)
        cs = find_sheet_cells(ap)
        by = _sheet_body_y(_sheet_masks([ap], cs, [0] * len(cs)))
        hs = [c[3] - c[1] + 1 for c in cs]

        def nose_y(j, pin):
            """Screen y of the nose once cell j is pinned by `pin` ('feet'|'body')."""
            x0, y0, x1, y1 = cs[j]
            sub = np.asarray(load_sheet(ap))[y0:y1 + 1, x0:x1 + 1, 3] > 16
            h, w = sub.shape
            rows = np.where(sub[:, int(w * 0.97):].any(1))[0]
            n = float(np.median(rows)) if len(rows) else h / 2.0
            return n - (h if pin == "feet" else h * by[j])

        feet = [nose_y(j, "feet") for j in range(len(cs))]
        body = [nose_y(j, "body") for j in range(len(cs))]

        def common_share(pin):
            """Share of an average frame that EVERY frame shares, once pinned."""
            masks, offs = [], []
            src = np.asarray(load_sheet(ap))
            for j, (x0, y0, x1, y1) in enumerate(cs):
                m = src[y0:y1 + 1, x0:x1 + 1, 3] > 16
                masks.append(m)
                masks_h = m.shape[0]
                offs.append(masks_h if pin == "feet" else masks_h * by[j])
            H2 = int(max(m.shape[0] for m in masks) * 3)
            W2 = max(m.shape[1] for m in masks) + 4
            st = np.zeros((len(masks), H2, W2), bool)
            for j, m in enumerate(masks):
                h, w = m.shape
                top = int(H2 // 2 - offs[j])
                st[j, top:top + h, (W2 - w) // 2:(W2 - w) // 2 + w] = m
            return st.all(0).sum() / max(1.0, st.sum(axis=(1, 2)).mean())

        share_feet, share_body = common_share("feet"), common_share("body")
        an_note = (f"heights={hs} nose-on-feet={max(feet) - min(feet):.0f}px "
                   f"nose-on-body={max(body) - min(body):.0f}px "
                   f"common feet={share_feet:.2f} body={share_body:.2f}")
        try:
            validate_sheets({"x": {"media": ap, "anchor": "sideways"}})
            refused = False
        except SceneError:
            refused = True
        an_ok = ((max(feet) - min(feet)) > 30 and (max(body) - min(body)) < 6
                 and share_body > share_feet and refused)
        an_note += f" bad-anchor-refused={refused}"
        os.remove(ap)
    except Exception as e:  # noqa: BLE001
        an_note = f"{type(e).__name__}: {e}"
    ck("the body anchor lands on what every frame has in common",
       "nose still on body, and more of the drawing shared than on feet", an_note, an_ok)

    # The contact shadow: present under a grounded character, absent under an
    # airborne one, and wider when the legs are apart than when they pass.
    sd_note, sd_ok = "", False
    try:
        sdp = os.path.join(OUT_DIR, "selftest-shadow.png")
        fig = Image.new("RGBA", (440, 240), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fig)
        for cx, spread_legs in ((100, False), (330, True)):
            fd.ellipse([cx - 30, 40, cx + 30, 150], fill=(40, 60, 120, 255))
            off = 42 if spread_legs else 8
            for s_ in (-off, off):
                fd.polygon([(cx - 6, 140), (cx + 6, 140), (cx + s_ + 10, 225),
                            (cx + s_ - 10, 225)], fill=(40, 60, 120, 255))
        fig.save(sdp)
        sv2 = action_save_asset({"action": "save_asset", "name": "selftest-shadow",
                                 "sheets": {"walk": {"media": sdp, "fps": 2}}})
        if not sv2.get("success"):
            raise SceneError(str(sv2.get("error")))

        def ground_dark(layer, tq):
            """How much darker the ground goes just under the feet, 0..255."""
            scn = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                         "background": {"kind": "gradient", "top": [235, 235, 235],
                                        "bottom": [235, 235, 235], "vignette": 0},
                         "layers": [layer]})
            fr = scn.draw_frame(tq).astype(int)
            row = fr[int(0.915 * fr.shape[0]), :, :].mean(1)
            return int(np.median(row) - row.min())

        def ground_px(layer, tq):
            scn = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                         "background": {"kind": "gradient", "top": [255, 255, 255],
                                        "bottom": [255, 255, 255], "vignette": 0},
                         "layers": [layer]})
            fr = scn.draw_frame(tq)
            # the row just under the feet, where only a shadow can darken it
            row = fr[int(0.905 * fr.shape[0]), :, :].astype(int).sum(1)
            # Darker than the background of that same row, whatever it is.
            return int((row < int(np.median(row)) - 12).sum())

        base = {"kind": "sprite", "name": "selftest-shadow", "from": 0, "to": 2,
                "at": [0.5, 0.9], "plays": [{"action": "walk", "at": 0}]}
        # Past the 0.4s fade-in, so the sprite is at full alpha in both samples.
        together = ground_px(base, 1.1)
        apart = ground_px(base, 0.6)
        off_px = ground_px({**base, "shadow": False}, 0.6)
        deep = ground_dark(base, 0.6)
        sd_note = (f"together={together} apart={apart} shadow-off={off_px} "
                   f"darkest={deep}/255")
        # Wide enough to read as contact, and DARK enough to be seen. Asserting only
        # that it exists is how it shipped invisible once.
        sd_ok = together > 0 and apart > together and off_px == 0 and deep >= 28
        os.remove(sdp)
        action_delete_asset({"name": "selftest-shadow"})
    except Exception as e:  # noqa: BLE001
        sd_note = f"{type(e).__name__}: {e}"
    ck("a grounded character gets a contact shadow that spreads with the legs",
       "apart > together > 0, off = 0, darkest >= 28/255", sd_note, sd_ok)

    # A declared play order: which drawings, in which order, however they sit on the
    # sheet. A generated sheet is not always a cycle, and without this the only way
    # to fix one is to generate it again.
    or_note, or_ok = "", False
    try:
        orp = os.path.join(OUT_DIR, "selftest-order.png")
        row = Image.new("RGBA", (600, 160), (0, 0, 0, 0))
        rd = ImageDraw.Draw(row)
        for k, cx in enumerate((100, 300, 500)):          # three different heights
            rd.ellipse([cx - 45, 30 + k * 30, cx + 45, 130], fill=(30, 40, 80, 255))
        row.save(orp)
        sv3 = action_save_asset({"action": "save_asset", "name": "selftest-order",
                                 "sheets": {"beat": {"media": orp, "fps": 4,
                                                     "frames": [1, 2, 3, 2]}}})
        played = ((sv3.get("data") or {}).get("sheets") or {}).get("beat", {})
        decl = load_custom_asset("selftest-order")["sheets"]["beat"]
        try:
            validate_sheets({"x": {"media": orp, "frames": [1, 9]}})
            refused_hi = False
        except SceneError:
            refused_hi = True
        or_note = (f"played={played.get('frames')} order={decl.get('order')} "
                   f"cells={len(decl['cells'])} out-of-range-refused={refused_hi}")
        # And one number is a held pose — an idle taken off a walk sheet.
        sv5 = action_save_asset({"action": "save_asset", "name": "selftest-order",
                                 "sheets": {"beat": {"media": orp, "fps": 4,
                                                     "frames": [1, 2, 3, 2]},
                                            "stand": {"media": orp, "frames": [2]}}})
        held = load_custom_asset("selftest-order")["sheets"]["stand"]
        or_note += (f" held={len(held['cells'])}cell/{len(held.get('order') or [])}play"
                    f" saved={bool(sv5.get('success'))}")
        or_ok = (played.get("frames") == 4 and decl.get("order") == [0, 1, 2, 1]
                 and len(decl["cells"]) == 3 and refused_hi
                 and len(held["cells"]) == 1 and held.get("order") == [0])
        os.remove(orp)
        action_delete_asset({"name": "selftest-order"})
    except Exception as e:  # noqa: BLE001
        or_note = f"{type(e).__name__}: {e}"
    ck("a sheet can declare which frames play and in what order",
       "4 played from 3 cells as [0,1,2,1], a frame past the end refused",
       or_note, or_ok)

    # One action across several sheets. A dozen full-height figures do not fit on one
    # generated canvas, so a long cycle arrives in parts and has to read as one.
    ms_note, ms_ok = "", False
    try:
        paths = []
        for part in range(2):
            mp = os.path.join(OUT_DIR, f"selftest-multi{part}.png")
            sheet = Image.new("RGBA", (400, 160), (0, 0, 0, 0))
            md = ImageDraw.Draw(sheet)
            for k, cx in enumerate((100, 300)):
                md.ellipse([cx - 40, 30 + (part * 2 + k) * 12, cx + 40, 130],
                           fill=(60, 40, 90, 255))
            sheet.save(mp)
            paths.append(mp)
        sv4 = action_save_asset({"action": "save_asset", "name": "selftest-multi",
                                 "sheets": {"go": {"media": paths, "fps": 4}}})
        decl = load_custom_asset("selftest-multi")["sheets"]["go"]
        # The frames must come off BOTH files, in the order the files were listed.
        two_files = _sheet_file(decl, 0) != _sheet_file(decl, 3)
        ms_note = (f"frames={((sv4.get('data') or {}).get('sheets') or {}).get('go', {}).get('frames')} "
                   f"cellOf={decl.get('cellOf')} spans-both={two_files}")
        ms_ok = (len(decl["cells"]) == 4 and decl.get("cellOf") == [0, 0, 1, 1]
                 and two_files)
        for mp in paths:
            os.remove(mp)
        action_delete_asset({"name": "selftest-multi"})
    except Exception as e:  # noqa: BLE001
        ms_note = f"{type(e).__name__}: {e}"
    ck("one action can be drawn across several sheets and read as one sequence",
       "4 frames, cellOf [0,0,1,1], drawn from both files", ms_note, ms_ok)

    # The face bank, both ways: with `face` the two frames wear the SAME head (the
    # generator draws a different-sized one per call, and no uniform scale can fix a
    # proportion), and without it the difference must survive — a canary that only
    # checked one side would pass a paste that never happened.
    fb_note, fb_ok = "", False
    try:
        fbp = os.path.join(OUT_DIR, "selftest-face.png")
        sheet = Image.new("RGBA", (300, 260), (0, 0, 0, 0))
        fbd = ImageDraw.Draw(sheet)
        for cx, r in ((70, 16), (220, 24)):              # same man, two head sizes
            fbd.ellipse([cx - r, 30 - r + 24, cx + r, 30 + r + 24],
                        fill=(200, 40, 40, 255))         # head — red
            fbd.rectangle([cx - 5, 30 + r + 24, cx + 5, 30 + r + 38],
                          fill=(40, 60, 150, 255))       # neck — the narrow row
            fbd.ellipse([cx - 26, 30 + r + 38, cx + 26, 190],
                        fill=(40, 60, 150, 255))         # torso
            fbd.rectangle([cx - 14, 188, cx - 4, 250], fill=(40, 60, 150, 255))
            fbd.rectangle([cx + 4, 188, cx + 14, 250], fill=(40, 60, 150, 255))
        sheet.save(fbp)

        def red_px(with_face, tq):
            nm = "selftest-face"
            spec = {"media": fbp, "fps": 2}
            if with_face:
                spec["face"] = {}
            sv = action_save_asset({"action": "save_asset", "name": nm,
                                    "sheets": {"walk": spec}})
            if not sv.get("success"):
                raise SceneError(str(sv.get("error")))
            scn = Scene({"action": "render", "duration": 2.0, "quality": "draft",
                         "background": {"kind": "gradient", "top": [255, 255, 255],
                                        "bottom": [255, 255, 255], "vignette": 0},
                         "layers": [{"kind": "sprite", "name": nm, "from": 0, "to": 2,
                                     "at": [0.5, 0.9], "shadow": False,
                                     "plays": [{"action": "walk", "at": 0}]}]})
            fr = scn.draw_frame(tq).astype(int)
            return int(((fr[:, :, 0] > 150) & (fr[:, :, 1] < 120)
                        & (fr[:, :, 2] < 120)).sum())

        on1, on2 = red_px(True, 1.1), red_px(True, 0.6)      # cell 1, cell 2
        off1, off2 = red_px(False, 1.1), red_px(False, 0.6)
        decl = load_custom_asset("selftest-face")["sheets"]["walk"]
        action_delete_asset({"name": "selftest-face"})
        os.remove(fbp)
        ratio_on = max(on1, on2) / max(1.0, min(on1, on2))
        ratio_off = max(off1, off2) / max(1.0, min(off1, off2))
        fb_note = (f"face-on heads {on1}/{on2}px (x{ratio_on:.2f}) "
                   f"face-off {off1}/{off2}px (x{ratio_off:.2f}) "
                   f"decl={'yes' if not decl.get('face') else len(decl['face']['ax'])}anchors")
        fb_ok = (ratio_on < 1.12 and ratio_off > 1.5
                 and on1 > 200 and decl.get("face") is None)
    except Exception as e:  # noqa: BLE001
        fb_note = f"{type(e).__name__}: {e}"
    ck("`face` puts one head on every frame; without it the sizes differ",
       "face-on ratio < 1.12, face-off > 1.5", fb_note, fb_ok)

    # Walk vs march, both ways: a cycle whose swing foot skims must pass silently,
    # and one that lifts the knee must be named. Checking only the bad direction
    # would pass a detector that flags everything (three earlier ones did).
    gt_note, gt_ok = "", False
    try:
        def lift_note(lift_px):
            """A 3-frame walk whose middle frame lifts one foot by `lift_px`."""
            gp = os.path.join(OUT_DIR, "selftest-gait.png")
            im5 = Image.new("RGBA", (660, 300), (0, 0, 0, 0))
            g5 = ImageDraw.Draw(im5)
            for k, cx in enumerate((110, 330, 550)):
                g5.ellipse([cx - 34, 40, cx + 34, 150], fill=(40, 60, 120, 255))
                # middle frame = passing; its feet stay apart enough that the lifted
                # one is not hidden behind the planted one (which is the one thing this
                # reading cannot see through)
                spread = 46 if k != 1 else 22
                for si, s_ in enumerate((-spread, spread)):
                    # the middle frame lifts its BACK foot by lift_px
                    up = lift_px if (k == 1 and si == 0) else 0
                    g5.polygon([(cx - 7, 145), (cx + 7, 145),
                                (cx + s_ + 11, 280 - up), (cx + s_ - 11, 280 - up)],
                               fill=(40, 60, 120, 255))
            im5.save(gp)
            sv = action_save_asset({"action": "save_asset", "name": "selftest-gait",
                                    "sheets": {"walk": {"media": gp, "fps": 3}}})
            notes = " ".join((sv.get("data") or {}).get("notes") or []) or str(
                (sv.get("data") or {}).get("note") or "")
            action_delete_asset({"name": "selftest-gait"})
            os.remove(gp)
            return notes

        skim = lift_note(6)        # toe skims — must say nothing about a march
        march = lift_note(90)      # knee up — must be named
        gt_note = (f"skim-note={'march' in skim.lower()} "
                   f"march-note={'march' in march.lower()}")
        gt_ok = ("march" not in skim.lower()) and ("march" in march.lower())
    except Exception as e:  # noqa: BLE001
        gt_note = f"{type(e).__name__}: {e}"
    ck("a knee-high passing frame is named a march; a skimming one is not",
       "skim silent, march flagged", gt_note, gt_ok)

    # Two passing frames that lift by DIFFERENT amounts is a second fault on top of
    # the march, and the one a viewer names first -- heungbu's 27% and 45% were called
    # "one leg bends the knee and the other does not" before anyone mentioned marching.
    # Both ways again: an even pair must be called a march and NOT a limp.
    lm_note, lm_ok = "", False
    try:
        def pair_note(a_px, b_px):
            """A 4-frame walk whose two passing frames lift a_px and b_px."""
            lp = os.path.join(OUT_DIR, "selftest-limp.png")
            im6 = Image.new("RGBA", (880, 300), (0, 0, 0, 0))
            g6 = ImageDraw.Draw(im6)
            ups = (0, a_px, 0, b_px)
            for k, cx in enumerate((110, 330, 550, 770)):
                g6.ellipse([cx - 34, 40, cx + 34, 150], fill=(40, 60, 120, 255))
                spread = 46 if not ups[k] else 22
                for si, s_ in enumerate((-spread, spread)):
                    up = ups[k] if si == 0 else 0
                    g6.polygon([(cx - 7, 145), (cx + 7, 145),
                                (cx + s_ + 11, 280 - up), (cx + s_ - 11, 280 - up)],
                               fill=(40, 60, 120, 255))
            im6.save(lp)
            sv = action_save_asset({"action": "save_asset", "name": "selftest-limp",
                                    "sheets": {"walk": {"media": lp, "fps": 4}}})
            notes = " ".join((sv.get("data") or {}).get("notes") or []) or str(
                (sv.get("data") or {}).get("note") or "")
            action_delete_asset({"name": "selftest-limp"})
            os.remove(lp)
            return notes.lower()

        even, odd = pair_note(90, 90), pair_note(50, 100)
        lm_note = (f"even: march={'march' in even} limp={'limp' in even} | "
                   f"uneven: march={'march' in odd} limp={'limp' in odd}")
        lm_ok = ("march" in even and "limp" not in even
                 and "march" in odd and "limp" in odd)
    except Exception as e:  # noqa: BLE001
        lm_note = f"{type(e).__name__}: {e}"
    ck("two passings that lift by different amounts are named a limp; an even pair is not",
       "even = march only, uneven = march + limp", lm_note, lm_ok)

    # A drawing that came back three times the size of the others is put on one scale,
    # so it must change neither the stride nor the anchor advice. Both were read off raw
    # pixels and both were wrong the moment a passing frame arrived on its own canvas:
    # the stride fell to a third (the walker then skates for the other two) and the note
    # announced a rise-and-fall in the very frames it had just evened out.
    bg_note, bg_ok = "", False
    try:
        def sheet(path, muls, spread):
            """A row of side-view figures, each `mul` times life size, feet `spread` apart."""
            im7 = Image.new("RGBA", (int(320 * len(muls) * max(muls)), int(330 * max(muls))),
                            (0, 0, 0, 0))
            g7 = ImageDraw.Draw(im7)
            for k, mul in enumerate(muls):
                s = float(mul)
                ox = int(320 * max(muls)) * k
                g7.ellipse([ox + 110 * s, 40 * s, ox + 190 * s, 150 * s], fill=(40, 60, 120, 255))
                for dx in (-spread, spread):
                    g7.polygon([(ox + 146 * s, 145 * s), (ox + 154 * s, 145 * s),
                                (ox + (150 + dx + 12) * s, 285 * s),
                                (ox + (150 + dx - 12) * s, 285 * s)], fill=(40, 60, 120, 255))
            im7.save(path)
            return path

        # the wide sheet carries the generator's own few-percent scatter, which is what
        # the per-cell pass exists to flatten and what the canvas pass must not switch off
        wide = sheet(os.path.join(OUT_DIR, "selftest-big-a.png"), (1.0, 1.06, 0.94), 60)
        near_small = sheet(os.path.join(OUT_DIR, "selftest-big-b.png"), (1.0,), 20)
        near_big = sheet(os.path.join(OUT_DIR, "selftest-big-c.png"), (3.0,), 20)

        def saved(paths):
            sv = action_save_asset({"action": "save_asset", "name": "selftest-big",
                                    "sheets": {"walk": {"media": paths, "fps": 4}}})
            d_ = (sv.get("data") or {})
            out = (d_.get("sheets", {}).get("walk", {}).get("stride"),
                   " ".join(d_.get("notes") or []) or str(d_.get("note") or ""))
            action_delete_asset({"name": "selftest-big"})
            return out

        def scaled(paths):
            """Every cell's height after cellScale — one `scale` is measured against these."""
            cl, cf = [], []
            for fi, p in enumerate(paths):
                for c in find_sheet_cells(p):
                    cl.append(c); cf.append(fi)
            sc = _sheet_cell_scale(cl, cf, len(paths))
            return [(c[3] - c[1] + 1) * s for c, s in zip(cl, sc)]

        even_stride, _ = saved([wide, near_small])
        big_stride, big_msg = saved([wide, near_big])
        a_even, a_big = scaled([wide, near_small]), scaled([wide, near_big])
        for p in (wide, near_small, near_big):
            os.remove(p)
        rise = "rise and fall" in big_msg.lower()
        flat = (max(a_big) - min(a_big)) / (sum(a_big) / len(a_big))
        bg_note = (f"stride even {even_stride} vs one sheet 3x {big_stride}; "
                   f"drawn height {max(a_even):.0f} vs {max(a_big):.0f}; "
                   f"heights still {flat*100:.1f}% apart; rise-and-fall claimed: {rise}")
        bg_ok = (even_stride and big_stride
                 and abs(big_stride - even_stride) < 0.02 and not rise
                 and abs(max(a_big) - max(a_even)) < 0.1 * max(a_even)
                 and flat < 0.02)
    except Exception as e:  # noqa: BLE001
        bg_note = f"{type(e).__name__}: {e}"
    ck("a frame drawn at another size changes neither the stride nor the anchor advice",
       "same stride, no rise-and-fall", bg_note, bg_ok)

    m3_note, m3_ok = "", False
    try:
        inf = action_model_info({"media": "robot"})
        di = inf.get("data") or {}
        clips = {c["name"] for c in di.get("clips") or []}
        sc6 = Scene({"action": "render", "duration": 3.0, "quality": "draft",
                     "size": "1080x1080", "background": {"kind": "studio"},
                     "layers": [{"kind": "model3d", "from": 0, "to": 3,
                                 "at": [0.5, 0.8], "height": 0.55,
                                 "plays": [{"clip": "Walking", "at": 0},
                                           {"clip": "Punch", "at": 1.5}]}]})
        fw = sc6.draw_frame(1.0)     # mid-walk
        fx2 = sc6.draw_frame(1.65)   # inside the crossfade window
        warm = ((fw[:, :, 0].astype(int) - fw[:, :, 2].astype(int)) > 40).sum()
        moved = int(np.abs(fw.astype(int) - fx2.astype(int)).sum())
        try:
            Scene({"action": "render", "duration": 2, "layers": [
                {"kind": "model3d", "from": 0, "to": 2, "clip": "Moonwalk"}]})
            bad_ok = False
        except SceneError as e:
            bad_ok = "model_info" in str(e)
        m3_ok = (inf.get("success") and di.get("triangles", 0) > 1000
                 and len(clips) >= 10 and {"Walking", "Punch", "Dance"} <= clips
                 and warm > 5000 and moved > 100000 and bad_ok)
        m3_note = f"clips={len(clips)}, tris={di.get('triangles')}, "                   f"warm px={int(warm)}, xfade delta={moved}, badclip->hint={bad_ok}"
    except Exception as e:  # noqa: BLE001
        m3_note = f"{type(e).__name__}: {e}"
    ck("the bundled 3D robot parses, toon-renders in scene, and crossfades clips",
       ">=10 clips, visible, moving", m3_note, m3_ok)

    job_note, job_ok = "", False
    try:
        sub = action_render({"action": "render", "duration": 1.0, "fps": 10,
                             "quality": "draft", "async": True,
                             "background": {"kind": "studio"},
                             "layers": [{"kind": "confetti", "from": 0.1, "to": 0.9}]})
        jid = sub["data"]["jobId"]
        st = {}
        for _ in range(60):
            st = action_job({"action": "job", "id": jid})
            if not st.get("success") or st["data"].get("state") in ("done", "stalled"):
                break
            time.sleep(0.5)
        mi = (st.get("data") or {}).get("_mediaImport") or {}
        job_ok = (st.get("success") and st["data"].get("state") == "done"
                  and os.path.getsize(mi.get("path", "")) > 2000)
        again = action_job({"action": "job", "id": jid})
        job_ok = job_ok and again.get("success") \
            and "_mediaImport" not in (again.get("data") or {})
        job_note = f"state={st.get('data', st).get('state', st.get('error'))}, " \
                   f"redelivery guarded={'_mediaImport' not in (again.get('data') or {})}"
        if mi.get("path"):
            os.remove(mi["path"])
        jd = os.path.join(JOB_DIR, jid)
        for fn in os.listdir(jd):
            os.remove(os.path.join(jd, fn))
        os.rmdir(jd)
    except Exception as e:  # noqa: BLE001
        job_note = f"{type(e).__name__}: {e}"
    ck("an async render is accepted, polls to done, delivers once",
       "done + single delivery", job_note, job_ok)

    # A bgm shorter than the scene must fill it, not trail off into silence.
    # Measured on the tail second, which used to be exactly zero.
    rate = 44100
    one_sec = np.sin(2 * np.pi * 220 * np.arange(rate) / rate) * 0.5
    tiled = _tile_seamless(one_sec, rate * 5, rate)
    tail_rms = float(np.sqrt(np.mean(tiled[rate * 4:rate * 5] ** 2)))
    head_rms = float(np.sqrt(np.mean(tiled[:rate] ** 2)))
    seam_ok = bool(np.max(np.abs(np.diff(tiled[:rate * 5]))) < 0.2)
    ck("a short bgm tiles across the scene instead of going silent",
       "tail loud as head, no seam click",
       f"head={head_rms:.3f} tail={tail_rms:.3f} seam_ok={seam_ok}",
       tail_rms > head_rms * 0.7 and seam_ok)

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
        elif action == "model_info":
            out = action_model_info(inp)
        elif action == "trim":
            out = action_trim(inp)
        elif action == "concat":
            out = action_concat(inp)
        elif action == "job":
            out = action_job(inp)
        elif action == "save_asset":
            out = action_save_asset(inp)
        elif action == "delete_asset":
            out = action_delete_asset(inp)
        elif action == "selftest":
            out = action_selftest()
        else:
            out = {"success": False,
                   "error": f"unknown action {action!r} — one of: render, sticker, "
                            "assets, save_asset, delete_asset, duration, job, "
                            "model_info, trim, concat, selftest"}
    except SceneError as e:
        out = {"success": False,
               "error": f"{e} — call {{\"action\": \"assets\"}} for the scene grammar"}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--job":
        run_job(sys.argv[2])
    else:
        main()
