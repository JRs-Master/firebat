# Pure-python GLB (glTF 2.0 binary) reader + skinned-pose sampler for the motion
# module's model3d layer. numpy + PIL only — no GPU, no browser, no system
# packages: the same constraint the whole module lives under. The renderer is a
# painter's-algorithm toon rasterizer (flat per-triangle color, banded diffuse),
# which is a deliberate style match for the module's cartoon output, not an
# attempt at PBR — GPU-grade visuals stay in the browser pipelines.
#
# Scope (enough for low-poly rigged characters like RobotExpressive):
#   meshes w/ POSITION, JOINTS_0/WEIGHTS_0, COLOR_0, TEXCOORD_0+baseColorTexture
#   node hierarchy (TRS or matrix), one skin per primitive, LINEAR/STEP anim
#   (CUBICSPLINE sampled at its value keys), quaternion nlerp, clip crossfade.
# Ignored on purpose: morph targets, multiple UV sets, PBR params, cameras.
import io
import json
import math
import os
import struct

import numpy as np
from PIL import Image

_DTYPES = {5120: "i1", 5121: "u1", 5122: "i2", 5123: "u2", 5125: "u4", 5126: "f4"}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class GlbError(ValueError):
    pass


def _read_glb(path):
    data = open(path, "rb").read()
    if len(data) < 12 or data[:4] != b"glTF":
        raise GlbError("not a GLB file (missing glTF magic)")
    _, length = struct.unpack_from("<II", data, 4)
    off, js, bin_ = 12, None, b""
    while off + 8 <= min(length, len(data)):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            bin_ = chunk
    if js is None:
        raise GlbError("GLB carries no JSON chunk")
    return js, bin_


def _accessor(js, bin_, idx):
    a = js["accessors"][idx]
    n = _NCOMP[a["type"]]
    dt = np.dtype("<" + _DTYPES[a["componentType"]])
    count = a["count"]
    if "bufferView" not in a:  # all-zeros accessor (spec allows it)
        return np.zeros((count, n), dtype=np.float32)
    bv = js["bufferViews"][a["bufferView"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    packed = n * dt.itemsize
    stride = bv.get("byteStride") or packed
    if stride == packed:
        arr = np.frombuffer(bin_, dtype=dt, count=count * n, offset=base)
        arr = arr.reshape(count, n)
    else:  # interleaved — gather bytes per element, then view as the real dtype
        buf = np.frombuffer(bin_, dtype=np.uint8)
        rows = base + stride * np.arange(count)[:, None] + np.arange(packed)[None, :]
        arr = buf[rows].copy().view(dt).reshape(count, n)
    arr = arr.astype(np.float32)
    if a.get("normalized"):
        arr /= float(np.iinfo(np.dtype(_DTYPES[a["componentType"]])).max)
    return arr


def _quat_mats(q):
    """(K,4) xyzw quaternions → (K,3,3) rotation matrices, vectorized."""
    q = q / np.maximum(1e-9, np.linalg.norm(q, axis=-1, keepdims=True))
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.empty(q.shape[:-1] + (3, 3), dtype=np.float32)
    m[..., 0, 0] = 1 - 2 * (y * y + z * z)
    m[..., 0, 1] = 2 * (x * y - z * w)
    m[..., 0, 2] = 2 * (x * z + y * w)
    m[..., 1, 0] = 2 * (x * y + z * w)
    m[..., 1, 1] = 1 - 2 * (x * x + z * z)
    m[..., 1, 2] = 2 * (y * z - x * w)
    m[..., 2, 0] = 2 * (x * z - y * w)
    m[..., 2, 1] = 2 * (y * z + x * w)
    m[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return m


def _trs_mat(t, q, s):
    m = np.eye(4, dtype=np.float32)
    m[:3, :3] = _quat_mats(np.asarray(q, dtype=np.float32)) * np.asarray(s, dtype=np.float32)[None, :]
    m[:3, 3] = t
    return m


class _Channel:
    __slots__ = ("node", "path", "times", "values", "step")

    def __init__(self, node, path, times, values, interp):
        self.node, self.path = node, path
        self.times, self.step = times[:, 0], interp == "STEP"
        if interp == "CUBICSPLINE":  # (K, 3*C): keep the value keys, drop tangents
            c = values.shape[1] // 3
            values = values.reshape(len(times), 3, c)[:, 1, :]
        self.values = values

    def sample(self, t):
        ts, vs = self.times, self.values
        if t <= ts[0]:
            return vs[0]
        if t >= ts[-1]:
            return vs[-1]
        i = int(np.searchsorted(ts, t, side="right"))
        if self.step:
            return vs[i - 1]
        f = (t - ts[i - 1]) / max(1e-9, ts[i] - ts[i - 1])
        a, b = vs[i - 1], vs[i]
        if self.path == "rotation" and float(np.dot(a, b)) < 0:
            b = -b
        return a + (b - a) * f


class Model:
    """A parsed GLB: pose it at a clip time, get world-space vertices + triangles."""

    def __init__(self, path):
        js, bin_ = _read_glb(path)
        self.path = path
        nodes = js.get("nodes") or []
        self.n_nodes = len(nodes)
        self.parents = np.full(self.n_nodes, -1, dtype=np.int64)
        self.children = [n.get("children") or [] for n in nodes]
        for i, kids in enumerate(self.children):
            for k in kids:
                self.parents[k] = i
        scene = (js.get("scenes") or [{}])[js.get("scene", 0)]
        self.roots = scene.get("nodes") or list(range(self.n_nodes))
        # rest-pose local TRS (matrix nodes keep their matrix; anim overrides TRS)
        self.rest = []
        for n in nodes:
            if "matrix" in n:
                self.rest.append(("m", np.array(n["matrix"], dtype=np.float32)
                                  .reshape(4, 4).T))
            else:
                self.rest.append(("trs",
                                  (np.array(n.get("translation", [0, 0, 0]), dtype=np.float32),
                                   np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float32),
                                   np.array(n.get("scale", [1, 1, 1]), dtype=np.float32))))
        # skins
        self.skins = []
        for sk in js.get("skins") or []:
            ibm = _accessor(js, bin_, sk["inverseBindMatrices"]) \
                .reshape(-1, 4, 4).transpose(0, 2, 1) if "inverseBindMatrices" in sk \
                else np.tile(np.eye(4, dtype=np.float32), (len(sk["joints"]), 1, 1))
            self.skins.append({"joints": np.array(sk["joints"], dtype=np.int64),
                               "ibm": ibm.astype(np.float32)})
        # materials → flat base colors (texture sampled per vertex at load)
        mat_cols = []
        for m in js.get("materials") or []:
            pbr = m.get("pbrMetallicRoughness") or {}
            col = pbr.get("baseColorFactor", [1, 1, 1, 1])[:3]
            mat_cols.append(np.array(col, dtype=np.float32))
        tex_cache = {}

        def tex_pixels(ti):
            if ti not in tex_cache:
                src = js["images"][js["textures"][ti]["source"]]
                bv = js["bufferViews"][src["bufferView"]]
                raw = bin_[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
                tex_cache[ti] = np.asarray(
                    Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.float32) / 255.0
            return tex_cache[ti]

        # flatten every (node, primitive) into one vertex/triangle soup
        pos_all, tris_all, tricol_all = [], [], []
        self.prims = []  # (v0, n_verts, skin_idx|-1, node_idx)
        v0 = 0
        for ni, n in enumerate(nodes):
            if "mesh" not in n:
                continue
            mesh = js["meshes"][n["mesh"]]
            skin_idx = n.get("skin", -1) if isinstance(n.get("skin", -1), int) else -1
            for prim in mesh.get("primitives") or []:
                if prim.get("mode", 4) != 4:  # triangles only
                    continue
                att = prim["attributes"]
                pos = _accessor(js, bin_, att["POSITION"])
                nv = len(pos)
                idx = _accessor(js, bin_, prim["indices"]).astype(np.int64).reshape(-1) \
                    if "indices" in prim else np.arange(nv, dtype=np.int64)
                tris = idx.reshape(-1, 3)
                base = np.ones((nv, 3), dtype=np.float32)
                mi = prim.get("material")
                if mi is not None and mi < len(mat_cols):
                    base = base * mat_cols[mi][None, :]
                    tex = ((js["materials"][mi].get("pbrMetallicRoughness") or {})
                           .get("baseColorTexture"))
                    if tex is not None and "TEXCOORD_0" in att:
                        uv = _accessor(js, bin_, att["TEXCOORD_0"])
                        px = tex_pixels(tex["index"])
                        h, w = px.shape[:2]
                        xi = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(np.int64)
                        yi = np.clip((uv[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(np.int64)
                        base = base * px[yi, xi]
                if "COLOR_0" in att:
                    base = base * _accessor(js, bin_, att["COLOR_0"])[:, :3]
                sk = -1
                if skin_idx >= 0 and "JOINTS_0" in att and "WEIGHTS_0" in att:
                    sk = skin_idx
                    j = _accessor(js, bin_, att["JOINTS_0"]).astype(np.int64)
                    wgt = _accessor(js, bin_, att["WEIGHTS_0"])
                    wgt = wgt / np.maximum(1e-9, wgt.sum(axis=1, keepdims=True))
                    self.prims.append((v0, nv, sk, ni, j, wgt))
                else:
                    self.prims.append((v0, nv, -1, ni, None, None))
                pos_all.append(pos)
                tris_all.append(tris + v0)
                tricol_all.append(base[tris].mean(axis=1))  # flat per-triangle color
                v0 += nv
        if not pos_all:
            raise GlbError("GLB contains no triangle meshes")
        self.pos = np.concatenate(pos_all).astype(np.float32)
        self.tris = np.concatenate(tris_all)
        self.tri_col = np.clip(np.concatenate(tricol_all), 0, 1)
        # animations
        self.clips = {}
        for anim in js.get("animations") or []:
            chans, dur = [], 0.0
            for ch in anim.get("channels") or []:
                tgt = ch.get("target") or {}
                if tgt.get("path") not in ("translation", "rotation", "scale") \
                        or tgt.get("node") is None:
                    continue
                sa = anim["samplers"][ch["sampler"]]
                times = _accessor(js, bin_, sa["input"])
                vals = _accessor(js, bin_, sa["output"])
                chans.append(_Channel(tgt["node"], tgt["path"], times, vals,
                                      sa.get("interpolation", "LINEAR")))
                dur = max(dur, float(times[-1, 0]))
            if chans and dur > 0:
                self.clips[anim.get("name") or f"clip{len(self.clips)}"] = \
                    {"channels": chans, "dur": dur}
        rest_v = self.posed_verts(None, 0.0)
        self.rest_bounds = (rest_v.min(axis=0), rest_v.max(axis=0))

    # ── posing ──────────────────────────────────────────────────────────
    def _locals(self, overrides):
        mats = np.empty((self.n_nodes, 4, 4), dtype=np.float32)
        for i, (kind, val) in enumerate(self.rest):
            ov = overrides.get(i) if overrides else None
            if ov is None:
                mats[i] = val if kind == "m" else _trs_mat(*val)
            else:
                t0, q0, s0 = val if kind == "trs" else (
                    np.zeros(3, np.float32), np.array([0, 0, 0, 1], np.float32),
                    np.ones(3, np.float32))
                mats[i] = _trs_mat(ov.get("translation", t0), ov.get("rotation", q0),
                                   ov.get("scale", s0))
        return mats

    def _worlds(self, local_mats):
        world = np.empty_like(local_mats)
        stack = [(r, None) for r in self.roots]
        while stack:
            i, p = stack.pop()
            world[i] = local_mats[i] if p is None else world[p] @ local_mats[i]
            for k in self.children[i]:
                stack.append((k, i))
        return world

    def _sample_clip(self, name, t):
        clip = self.clips[name]
        t = t % clip["dur"]
        ov = {}
        for ch in clip["channels"]:
            ov.setdefault(ch.node, {})[ch.path] = ch.sample(t)
        return ov

    def posed_verts(self, clip, t, blend=None):
        """World-space (N,3) vertices. blend = (other_clip, other_t, w 0..1) crossfades
        node-locals (nlerp for rotations via straight lerp + renorm in _trs_mat)."""
        ov = self._sample_clip(clip, t) if clip else {}
        if blend is not None and blend[0]:
            ov2 = self._sample_clip(blend[0], blend[1])
            w = float(blend[2])
            for node in set(ov) | set(ov2):
                a, b = ov.get(node, {}), ov2.get(node, {})
                merged = {}
                for k in set(a) | set(b):
                    va, vb = a.get(k), b.get(k)
                    if va is None or vb is None:
                        merged[k] = vb if va is None else va
                    else:
                        if k == "rotation" and float(np.dot(va, vb)) < 0:
                            vb = -vb
                        merged[k] = va + (vb - va) * w
                ov[node] = merged
        world = self._worlds(self._locals(ov))
        out = np.empty((len(self.pos), 3), dtype=np.float32)
        ph = np.concatenate([self.pos, np.ones((len(self.pos), 1), np.float32)], axis=1)
        for (v0, nv, sk, ni, joints, weights) in self.prims:
            seg = ph[v0:v0 + nv]
            if sk >= 0:
                skin = self.skins[sk]
                jm = world[skin["joints"]] @ skin["ibm"]  # (J,4,4)
                acc = np.zeros((nv, 3), dtype=np.float32)
                for k in range(joints.shape[1]):
                    mk = jm[joints[:, k]]                       # (nv,4,4)
                    acc += weights[:, k:k + 1] * np.einsum("nij,nj->ni", mk, seg)[:, :3]
                out[v0:v0 + nv] = acc
            else:
                out[v0:v0 + nv] = (seg @ world[ni].T)[:, :3]
        return out

    def info(self):
        lo, hi = self.rest_bounds
        return {"clips": [{"name": k, "dur": round(v["dur"], 2)}
                          for k, v in sorted(self.clips.items())],
                "triangles": int(len(self.tris)),
                "vertices": int(len(self.pos)),
                "height": round(float(hi[1] - lo[1]), 3)}


# ── model cache (parse once per file) ───────────────────────────────────────
_CACHE = {}


def load(path):
    key = (os.path.abspath(path), os.path.getmtime(path))
    if key not in _CACHE:
        while len(_CACHE) >= 4:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = Model(path)
    return _CACHE[key]


# ── toon rasterizer ─────────────────────────────────────────────────────────
_LIGHT = np.array([-0.42, 0.72, 0.55], dtype=np.float32)
_LIGHT = _LIGHT / np.linalg.norm(_LIGHT)


def draw_model(d, model, verts, cx, cy, px_height, yaw_deg, alpha,
               pitch_deg=8.0, tint=None):
    """Paint the posed model into a PIL ImageDraw (painter's algorithm, toon bands).
    cx, cy = screen feet anchor px; px_height = rest-pose height on screen."""
    lo, hi = model.rest_bounds
    scale = px_height / max(1e-6, float(hi[1] - lo[1]))
    center = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2],
                      dtype=np.float32)
    ya, pa = math.radians(yaw_deg), math.radians(pitch_deg)
    cyw, syw = math.cos(ya), math.sin(ya)
    cp, sp = math.cos(pa), math.sin(pa)
    ry = np.array([[cyw, 0, syw], [0, 1, 0], [-syw, 0, cyw]], dtype=np.float32)
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], dtype=np.float32)
    v = (verts - center) @ (rx @ ry).T
    tv = v[model.tris]                                    # (T,3,3)
    n = np.cross(tv[:, 1] - tv[:, 0], tv[:, 2] - tv[:, 0])
    keep = n[:, 2] > 1e-9                                 # camera looks along -z
    if not keep.any():
        return
    tv, n = tv[keep], n[keep]
    col = model.tri_col[keep]
    n = n / np.maximum(1e-9, np.linalg.norm(n, axis=1, keepdims=True))
    lum = np.clip(tv[:, :, 2].mean(axis=1), None, None)
    order = np.argsort(lum)                               # far (small z) first
    diff = np.clip(n @ _LIGHT, 0.0, 1.0)
    band = np.where(diff < 0.25, 0.52, np.where(diff < 0.62, 0.76, 1.0)) \
        .astype(np.float32)
    shade = np.clip(col * (0.28 + 0.78 * band[:, None]), 0, 1)
    if tint is not None:
        shade = np.clip(shade * np.asarray(tint, dtype=np.float32)[None, :], 0, 1)
    sx = cx + tv[:, :, 0] * scale
    sy = cy - tv[:, :, 1] * scale
    a255 = int(255 * max(0.0, min(1.0, alpha)))
    rgb = (shade * 255).astype(np.uint8)
    for i in order:
        d.polygon([(sx[i, 0], sy[i, 0]), (sx[i, 1], sy[i, 1]),
                   (sx[i, 2], sy[i, 2])],
                  fill=(int(rgb[i, 0]), int(rgb[i, 1]), int(rgb[i, 2]), a255))
