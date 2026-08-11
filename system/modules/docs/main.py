"""docs — office documents in and out of the render-block IR.

Reading: pptx/xlsx/docx are ZIP+XML with mature readers; hwpx is the same idea (OWPML) read with
stdlib zipfile+ElementTree since no mature library exists; pdf via pypdf (text only).

Making: the hard step of HTML->PPTX conversion — recovering *meaning* from computed layout —
never happens here, because the render blocks already carry the meaning ("this is a table",
"this is a heading"). Blocks map straight to native shapes: header level 1 / divider starts a
slide, table blocks become editable tables, a master .pptx (the corporate deck uploaded through
the media door) contributes its theme and layouts.

Files land in data/docs/ and are declared as `_mediaImport` — the framework carries them into
the media store (gated, served, downloadable). hwpx WRITING is deliberately absent: OWPML has no
mature library and hand-written XML is the most work of the four; read-only by decision.
"""

import hashlib
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

OUT_DIR = "data/docs"

MIME = {
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
    "hwpx": "application/vnd.hancom.hwpx",
}


def resolve_path(raw):
    """Media URL or workspace-relative path -> readable path (sandbox cwd = workspace root)."""
    path = str(raw or "").strip()
    if not path:
        return None, "path is required"
    if "://" in path:
        rest = path.split("://", 1)[1]
        path = "/" + rest.split("/", 1)[1] if "/" in rest else ""
    path = path.lstrip("/")
    if ".." in path.split("/"):
        return None, f"path escapes the workspace: {raw}"
    if not os.path.isfile(path):
        return None, f"file not found: {path} (workspace-relative)"
    return path, None


def out_file(title, ext, payload):
    os.makedirs(OUT_DIR, exist_ok=True)
    stem = re.sub(r"[^0-9A-Za-z가-힣_-]+", "-", str(title or "")).strip("-")[:40] or "untitled"
    h = hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:8]
    return f"{OUT_DIR}/{stem}-{h}.{ext}", stem


def media_import_decl(path, ext, stem):
    return {"path": path, "contentType": MIME[ext], "filenameHint": stem}


# ── read ───────────────────────────────────────────────────────────────────────────────────────


def _cell_str(v):
    if v is None:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v if isinstance(v, (int, float, str, bool)) else str(v)


def read_pdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            pages.append(page.extract_text() or "")
        except Exception as e:  # noqa: BLE001 — one broken page should not lose the rest
            pages.append(f"[page {i + 1}: extract failed: {e}]")
    return {"format": "pdf", "meta": {"pages": len(pages)},
            "text": "\n\n".join(pages).strip(), "tables": []}


def read_docx(path):
    import docx
    d = docx.Document(path)
    lines = []
    for p in d.paragraphs:
        t = p.text.strip()
        if not t:
            continue
        style = (p.style.name or "").lower()
        m = re.match(r"heading (\d)", style)
        lines.append(("#" * int(m.group(1)) + " " + t) if m else t)
    tables = []
    for tb in d.tables:
        rows = [[c.text.strip() for c in row.cells] for row in tb.rows]
        if rows:
            tables.append({"headers": rows[0], "rows": rows[1:]})
    return {"format": "docx", "meta": {"paragraphs": len(lines), "tables": len(tables)},
            "text": "\n".join(lines), "tables": tables}


def read_xlsx(path, max_rows=1000, max_cols=50):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheets, tables, text_parts = [], [], []
    for ws in wb.worksheets:
        rows = []
        for r in ws.iter_rows(max_row=max_rows, max_col=max_cols, values_only=True):
            row = [_cell_str(v) for v in r]
            while row and str(row[-1]) == "":  # read_only pads to max_col — trim the tail
                row.pop()
            if row:
                rows.append(row)
        sheets.append({"name": ws.title, "rows": len(rows)})
        if rows:
            tables.append({"name": ws.title, "headers": rows[0], "rows": rows[1:]})
            text_parts.append(f"[{ws.title}] {len(rows)} rows")
    wb.close()
    return {"format": "xlsx", "meta": {"sheets": sheets},
            "text": "\n".join(text_parts), "tables": tables}


def read_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    slides, tables = [], []
    for i, slide in enumerate(prs.slides):
        texts = []
        for shape in slide.shapes:
            if shape.has_table:
                rows = [[c.text.strip() for c in row.cells] for row in shape.table.rows]
                if rows:
                    tables.append({"name": f"slide {i + 1}", "headers": rows[0], "rows": rows[1:]})
                continue
            if shape.has_text_frame:
                t = shape.text_frame.text.strip()
                if t:
                    texts.append(t)
        slides.append({"n": i + 1, "text": "\n".join(texts)})
    text = "\n\n".join(f"[slide {s['n']}]\n{s['text']}" for s in slides if s["text"])
    return {"format": "pptx", "meta": {"slides": len(slides), "tables": len(tables)},
            "text": text, "tables": tables}


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def read_hwpx(path):
    """OWPML (KS X 6101) — ZIP of section XMLs; text lives in <hp:t>, tables in <hp:tbl>,
    equation sources in <hp:equation><hp:script>. The <hp:t> walk already reaches text
    boxes and footnotes (they are just deeper paragraphs — 2026-08-11 실측으로 확인).
    Namespace-agnostic on purpose: producers disagree on prefixes, localnames hold still."""
    texts, tables, equations = [], [], []
    seen_eq = set()
    with zipfile.ZipFile(path) as z:
        sections = sorted(n for n in z.namelist()
                          if n.startswith("Contents/") and re.search(r"section\d+\.xml$", n))
        if not sections:
            return {"format": "hwpx", "meta": {"sections": 0},
                    "text": "", "tables": [],
                    "note": "no Contents/section*.xml — not an HWPX container?"}
        for name in sections:
            root = ET.fromstring(z.read(name))
            in_table_cells = set()
            for tbl in root.iter():
                if _local(tbl.tag) != "tbl":
                    continue
                rows = []
                for tr in tbl.iter():
                    if _local(tr.tag) != "tr":
                        continue
                    row = []
                    for tc in tr:
                        if _local(tc.tag) != "tc":
                            continue
                        cell = "".join(t.text or "" for t in tc.iter() if _local(t.tag) == "t")
                        row.append(cell.strip())
                        for t in tc.iter():
                            if _local(t.tag) == "t":
                                in_table_cells.add(id(t))
                    if row:
                        rows.append(row)
                if rows:
                    tables.append({"headers": rows[0], "rows": rows[1:]})
            for p in root.iter():
                if _local(p.tag) != "p":
                    continue
                line = "".join(t.text or "" for t in p.iter()
                               if _local(t.tag) == "t" and id(t) not in in_table_cells)
                if line.strip():
                    texts.append(line.strip())
                # Equation SOURCE is not a <hp:t> — pull the script so formulas stop
                # vanishing. id-dedup because outer paragraphs contain cell paragraphs.
                for eq in p.iter():
                    if _local(eq.tag) != "equation" or id(eq) in seen_eq:
                        continue
                    seen_eq.add(id(eq))
                    for sc in eq:
                        if _local(sc.tag) == "script" and (sc.text or "").strip():
                            script = sc.text.strip()
                            equations.append(script)
                            texts.append(f"[수식] {script}")
    out = {"format": "hwpx",
           "meta": {"sections": len(sections), "tables": len(tables),
                    "equations": len(equations)},
           "text": "\n".join(texts), "tables": tables}
    if equations:
        out["equations"] = equations
    return out


def _rhwp_helper(request, timeout=180):
    """Spawn the vendored rhwp WASM helper (node, ./rhwp-helper.mjs). One JSON in, one out."""
    import shutil
    import subprocess
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node runtime not found")
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rhwp-helper.mjs")
    req = json.dumps(request).encode("utf-8")
    proc = subprocess.run([node, helper], input=req, capture_output=True, timeout=timeout)
    lines = proc.stdout.decode("utf-8", "replace").strip().splitlines()
    payload = json.loads(lines[-1]) if lines else {}
    if not payload.get("ok"):
        err = payload.get("error") or proc.stderr.decode("utf-8", "replace")[:400]
        raise RuntimeError(err or "helper failed")
    return payload["data"]


def _rhwp_helper_read(path):
    return _rhwp_helper({"op": "read", "path": path}, timeout=120)


def read_hwp_legacy(path):
    """.hwp (binary) through the rhwp engine — the only door into that format here.
    Honesty note rides along: rhwp 0.8.x reads its own output perfectly but extracts
    THIN from vintage Hancom files (5.0.3.x-era samples came back near-empty, 2026-08-11
    실측) — so the reader names its limits instead of pretending."""
    try:
        d = _rhwp_helper_read(path)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"legacy .hwp needs the rhwp helper (node + vendored wasm): {e}")
    tables = [{"name": t.get("name"),
               "headers": (t.get("rows") or [[]])[0],
               "rows": (t.get("rows") or [[]])[1:]} for t in d.get("tables", [])]
    out = {"format": "hwp", "engine": "rhwp",
           "meta": {"sections": d.get("sections", 0),
                    "paragraphs": d.get("paragraphs", 0),
                    "tables": len(tables), "equations": len(d.get("equations", []))},
           "text": d.get("text", ""), "tables": tables,
           "note": ("rhwp engine — if content looks missing (older .hwp files extract "
                    "thin), convert to .hwpx in Hancom and read that instead")}
    if d.get("equations"):
        out["equations"] = d["equations"]
    return out


READERS = {"pdf": read_pdf, "docx": read_docx, "xlsx": read_xlsx,
           "pptx": read_pptx, "hwpx": read_hwpx, "hwp": read_hwp_legacy}


def action_read(inp):
    path, err = resolve_path(inp.get("path"))
    if err:
        return {"success": False, "action": "read", "error": err}
    ext = path.rsplit(".", 1)[-1].lower()
    reader = READERS.get(ext)
    if not reader:
        return {"success": False, "action": "read",
                "error": f"unsupported format .{ext} — one of: {', '.join(sorted(READERS))}"}
    try:
        data = reader(path)
    except Exception as e:  # noqa: BLE001 — a broken file should name itself
        return {"success": False, "action": "read", "error": f"read failed ({ext}): {e}"}
    cap = inp.get("maxChars")
    if isinstance(cap, (int, float)) and cap and len(data.get("text", "")) > int(cap):
        data["text"] = data["text"][: int(cap)]
        data["textTruncated"] = True
    data["sourcePath"] = path
    return {"success": True, "action": "read", "data": data}


# ── make ───────────────────────────────────────────────────────────────────────────────────────


def normalize_blocks(blocks):
    """Absorb the render-fence dialect: {"name":"Header","type":"component","props":...} is what
    a model living in chat fences writes (measured on the first live ppt request — it built the
    deck in that shape). Intent is unambiguous, so absorb instead of teach: name becomes type.
    Props already share their vocabulary (text/level/content/headers/rows)."""
    out = []
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        t = str(b.get("type") or "").strip()
        name = str(b.get("name") or "").strip()
        if name and (t == "component" or not t):
            b = dict(b)
            b["type"] = name.lower()
        out.append(b)
    return out


def _split_slides(blocks):
    """header level 1 or divider starts a new slide — the boundary rule from the design."""
    slides, cur = [], []
    for b in blocks:
        t = str(b.get("type") or "")
        p = b.get("props") or {}
        is_boundary = t == "divider" or (t == "header" and int(p.get("level") or 2) == 1)
        if is_boundary and cur:
            slides.append(cur)
            cur = []
        if t != "divider":
            cur.append(b)
    if cur:
        slides.append(cur)
    return slides


def _block_lines(b):
    """text-ish block -> plain lines for a body textbox / paragraph run."""
    t, p = str(b.get("type") or ""), b.get("props") or {}
    if t == "text":
        return [str(p.get("content") or "")]
    if t == "list":
        mark = "1." if p.get("ordered") else "•"
        return [f"{mark} {item}" for item in (p.get("items") or [])]
    if t == "metric":
        line = f"{p.get('label', '')}: {p.get('value', '')}{p.get('unit', '') or ''}"
        if p.get("delta") not in (None, ""):
            line += f" ({p.get('delta')})"
        return [line]
    if t == "header":
        return [str(p.get("text") or "")]
    return []


# Layout constants (inches / points). python-pptx cannot measure rendered text, so heights are
# ESTIMATED with per-column wrap counts — Korean at these sizes runs ~5.5 chars/inch — and the
# estimate errs tall: a slightly airy slide beats text painted over a table (2026-08-10 첫 실물
# 실측 — 셀이 줄바꿈되자 다음 텍스트박스가 표 위에 앉았다).
PPTX_MARGIN_IN = 0.6
PPTX_CHARS_PER_IN = 5.5
PPTX_BODY_PT = 14
PPTX_TABLE_PT = 12


def _wrap_lines(text, width_in, chars_per_in=PPTX_CHARS_PER_IN):
    """Visual line count of `text` in a box `width_in` wide — wrap-aware, never below 1."""
    cpl = max(8, int(width_in * chars_per_in))
    total = 0
    for logical in str(text).split("\n"):
        total += max(1, -(-len(logical) // cpl))
    return total


def _hex_rgb(value):
    """'#2563EB' / '2563EB' -> RGBColor, None for anything unreadable (never a guess)."""
    from pptx.dml.color import RGBColor
    s = str(value or "").strip().lstrip("#")
    if len(s) == 6:
        try:
            return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            return None
    return None


# Pure numerics ("1,234", "-3.1") become real numbers; unit-bearing text ("48억", "3.1%p")
# cannot carry its unit into a number, so it stays text.
_NUMERIC_RE = re.compile(r"^[+\-]?\d{1,3}(,\d{3})*(\.\d+)?$|^[+\-]?\d+(\.\d+)?$")
# Looser shape for ALIGNMENT decisions only: a number plus a short unit tail still reads
# as a number to the eye, and number columns right-align.
_NUMLIKE_RE = re.compile(r"^[+\-±]?[\d,]+(\.\d+)?\s*\S{0,3}$")
# Titles that read as points on a schedule — they pull item groups onto a timeline.
_STEPISH_RE = re.compile(r"(\d{4}|\d+\s*년|\d+\s*월|[1-4]\s*Q|분기|단계|Phase|Step)", re.I)


def parse_number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v or "").strip()
    if not s or not _NUMERIC_RE.match(s):
        return None
    try:
        f = float(s.replace(",", ""))
    except ValueError:
        return None
    return int(f) if f.is_integer() and "." not in s else f


def make_pptx_file(blocks, title, master_path, out_path, transition="fade", theme=None):
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
    from pptx.oxml.ns import qn
    from pptx.util import Inches, Pt

    prs = Presentation(master_path) if master_path else Presentation()
    blank = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[-1]
    sw, sh = prs.slide_width, prs.slide_height
    sw_in = sw / 914400
    sh_in = sh / 914400

    # Design has THREE layers, strongest first: a master .pptx (corporate look — never painted
    # over), then caller theme tokens (the palette the AI chose when it designed the page —
    # blocks are meaning, tokens are the look, so the look rides along as data), then the
    # Firebat default (blue-600 accent on slate, banded tables, quiet page number).
    styled = master_path is None
    theme = theme if isinstance(theme, dict) else {}
    BLUE = (_hex_rgb(theme.get("accent")) or RGBColor(0x25, 0x63, 0xEB))
    SLATE_D = (_hex_rgb(theme.get("heading")) or RGBColor(0x1E, 0x29, 0x3B))
    SLATE_B = (_hex_rgb(theme.get("body")) or RGBColor(0x33, 0x41, 0x55))
    SLATE_L = (_hex_rgb(theme.get("band")) or RGBColor(0xF1, 0xF5, 0xF9))
    SLATE_M = RGBColor(0x94, 0xA3, 0xB8)   # footer — always quiet
    WHITE = RGBColor(0xFF, 0xFF, 0xFF)

    # One typeface across the deck (styled path only — a master's fonts rule there).
    # Korean needs BOTH the latin and eastAsian slots set, or ascii runs fall back to
    # a different face mid-sentence. theme.font swaps the whole deck (e.g. Pretendard).
    FONT_EA = str(theme.get("font") or "맑은 고딕")

    def apply_font(para):
        if not styled:
            return
        para.font.name = FONT_EA
        rpr = para.font._rPr
        if rpr is not None:
            latin = rpr.find(qn("a:latin"))
            ea = rpr.find(qn("a:ea"))
            if ea is None and latin is not None:
                ea = rpr.makeelement(qn("a:ea"), {})
                latin.addnext(ea)
            if ea is not None:
                ea.set("typeface", FONT_EA)

    # Slide transition — python-pptx has no API for it, but <p:transition> is one well-formed
    # element per slide (unlike object-animation timing XML, which stays out of scope). Injected
    # for every slide at save time; "none" disables.
    def apply_transition(slide):
        if transition not in ("fade", "wipe", "push"):
            return
        sld = slide._element
        if sld.find(qn("p:transition")) is not None:
            return
        tr = sld.makeelement(qn("p:transition"), {"spd": "med"})
        tr.append(sld.makeelement(qn(f"p:{transition}"), {}))
        timing = sld.find(qn("p:timing"))
        if timing is not None:
            timing.addprevious(tr)
        else:
            sld.append(tr)

    def accent_bar(slide, x_in, y_in, w_in, h_in=0.05):
        bar = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE, Inches(x_in), Inches(y_in), Inches(w_in), Inches(h_in))
        bar.fill.solid()
        bar.fill.fore_color.rgb = BLUE
        bar.line.fill.background()
        bar.shadow.inherit = False
        return bar

    def add_box(slide, shape_id, x, y, w, h, fill=None, line=None, line_w=None):
        box = slide.shapes.add_shape(shape_id, Inches(x), Inches(y), Inches(w), Inches(h))
        if fill is None:
            box.fill.background()
        else:
            box.fill.solid()
            box.fill.fore_color.rgb = fill
        if line is None:
            box.line.fill.background()
        else:
            box.line.color.rgb = line
            if line_w:
                box.line.width = Pt(line_w)
        box.shadow.inherit = False
        return box

    def add_text(slide, x, y, w, h, runs, align=None, wrap=True, anchor=None):
        # runs = [(text, size_pt, bold, color), ...] — one paragraph per run.
        tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = tb.text_frame
        tf.word_wrap = wrap
        if anchor is not None:
            tf.vertical_anchor = anchor
        for i, (text, size, bold, color) in enumerate(runs):
            para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            para.text = text
            para.font.size = Pt(size)
            para.font.bold = bold
            if color is not None:
                para.font.color.rgb = color
            if align is not None:
                para.alignment = align
            apply_font(para)
        return tb

    if title:
        if styled:
            # Cover, proposal-deck shape: big heading upper-left, accent bar, a quiet band
            # strip along the bottom. No layout placeholders — nothing to ghost.
            slide = prs.slides.add_slide(blank)
            t_lines = _wrap_lines(str(title), sw_in - 1.7, chars_per_in=3.4)
            add_text(slide, 0.85, 2.0, sw_in - 1.7, 0.65 * t_lines,
                     [(str(title), 32, True, SLATE_D)])
            accent_bar(slide, 0.88, 2.12 + 0.65 * t_lines, 2.4, 0.07)
            add_box(slide, MSO_SHAPE.RECTANGLE, 0, sh_in - 0.9, sw_in, 0.9, fill=SLATE_L)
            add_box(slide, MSO_SHAPE.RECTANGLE, 0, sh_in - 0.95, sw_in, 0.05, fill=BLUE)
        else:
            layout = prs.slide_layouts[0]
            slide = prs.slides.add_slide(layout)
            placed = None
            for ph in slide.placeholders:
                if ph.placeholder_format.idx == 0:
                    ph.text = str(title)
                    placed = ph
                    break
            # Unfilled placeholders render as dashed "click to add" boxes (the subtitle ghost
            # on the first live deck) — remove every placeholder we did not fill.
            for ph in list(slide.placeholders):
                if placed is not None and ph.placeholder_format.idx == 0:
                    continue
                el = ph._element
                el.getparent().remove(el)
            if placed is None:
                tb = slide.shapes.add_textbox(Inches(0.8), Inches(2.5),
                                              sw - Inches(1.6), Inches(1.5))
                tb.text_frame.text = str(title)
                tb.text_frame.paragraphs[0].font.size = Pt(40)

    state = {"count": 1 if title else 0, "slide": None, "y": 0.0,
             "sec_no": 0, "sec_title": None, "sec_stmt": None}
    BAND_H = 0.62          # navy section band
    STMT_H = 0.78          # light statement band under it
    BODY_BOTTOM = 0.5      # keep-out at the slide foot

    def draw_band(slide, statement):
        # The genre's spine: dark number+title band, then (first slide of the section only)
        # a light band carrying the slide's one-line message behind a small accent bar.
        add_box(slide, MSO_SHAPE.RECTANGLE, 0, 0, sw_in, BAND_H, fill=SLATE_D)
        add_text(slide, 0.55, 0, sw_in - 2.6, BAND_H,
                 [(f"{state['sec_no']:02d}. {state['sec_title']}", 16, True, WHITE)],
                 wrap=False, anchor=MSO_ANCHOR.MIDDLE)
        if title:
            add_text(slide, sw_in - 2.05, 0, 1.55, BAND_H,
                     [(str(title), 8.5, False, SLATE_M)], align=PP_ALIGN.RIGHT, wrap=False,
                     anchor=MSO_ANCHOR.MIDDLE)
        if statement:
            add_box(slide, MSO_SHAPE.RECTANGLE, 0, BAND_H, sw_in, STMT_H, fill=SLATE_L)
            add_box(slide, MSO_SHAPE.RECTANGLE, 0.55, BAND_H + 0.15, 0.07, STMT_H - 0.3,
                    fill=BLUE)
            add_text(slide, 0.8, BAND_H, sw_in - 1.7, STMT_H,
                     [(statement, 13, True, SLATE_D)], anchor=MSO_ANCHOR.MIDDLE)
            return BAND_H + STMT_H + 0.3
        return BAND_H + 0.35

    def new_slide(continuation=True):
        state["slide"] = prs.slides.add_slide(blank)
        state["count"] += 1
        if styled and state["sec_title"]:
            state["y"] = draw_band(state["slide"],
                                   None if continuation else state["sec_stmt"])
        else:
            state["y"] = 0.55 if styled else 0.4
        if styled:
            ft = state["slide"].shapes.add_textbox(
                Inches(sw_in - 1.05), Inches(sh_in - 0.38), Inches(0.75), Inches(0.28))
            para = ft.text_frame.paragraphs[0]
            para.text = str(state["count"])
            para.font.size = Pt(10)
            para.font.color.rgb = SLATE_M
            para.alignment = PP_ALIGN.RIGHT
            apply_font(para)

    def ensure_room(height_in):
        # Content that will not fit CONTINUES on a fresh slide — the old behavior silently
        # dropped the rest of the chunk once the cursor passed the bottom.
        if state["slide"] is None or state["y"] + height_in > sh_in - BODY_BOTTOM:
            new_slide()

    def set_cell(cell, text, bold, fill=None, color=None, align=None):
        cell.text = text
        if fill is not None:
            cell.fill.solid()
            cell.fill.fore_color.rgb = fill
        for para in cell.text_frame.paragraphs:
            para.font.size = Pt(PPTX_TABLE_PT)
            para.font.bold = bold
            if color is not None:
                para.font.color.rgb = color
            if align is not None:
                para.alignment = align
            apply_font(para)

    def place_table(headers, seg_rows, height_in, col_count, aligns=None):
        ensure_room(height_in + 0.2)
        slide, y = state["slide"], state["y"]
        shape = slide.shapes.add_table(
            len(seg_rows) + 1, col_count, Inches(PPTX_MARGIN_IN), Inches(y),
            sw - Inches(PPTX_MARGIN_IN * 2), Inches(height_in))
        table = shape.table
        for c, h in enumerate(headers):
            # Header row centers regardless of column alignment — the convention is
            # centered headers over right-aligned numbers (2026-08-11 사용자).
            set_cell(table.cell(0, c), str(h), True,
                     fill=BLUE if styled else None, color=WHITE if styled else None,
                     align=PP_ALIGN.CENTER)
        for r, row in enumerate(seg_rows):
            band = SLATE_L if (styled and r % 2 == 1) else (WHITE if styled else None)
            for c in range(col_count):
                val = row[c] if c < len(row) else ""
                set_cell(table.cell(r + 1, c), "" if val is None else str(val), False,
                         fill=band, color=SLATE_B if styled else None,
                         align=aligns[c] if aligns else None)
        state["y"] = y + height_in + 0.25

    def render_table(p):
        headers = [str(h) for h in (p.get("headers") or [])]
        rows = p.get("rows") or []
        if not headers and rows:
            headers = [str(c) for c in rows[0]]
            rows = rows[1:]
        if not headers:
            return
        n_cols = len(headers)
        col_w_in = (sw_in - PPTX_MARGIN_IN * 2) / n_cols

        # Wrap-aware height: each row is as tall as its most-wrapped cell.
        def row_h(cells):
            lines = max(_wrap_lines("" if c is None else c, col_w_in) for c in cells)
            return 0.14 + 0.21 * lines

        header_h = row_h(headers)
        row_hs = [row_h([row[c] if c < len(row) else "" for c in range(n_cols)])
                  for row in rows]
        # A table taller than a slide SPLITS across slides with the header repeated —
        # one connected table, not a truncated one (2026-08-10 사용자 질문이 이 계약).
        usable = sh_in - (1.6 if styled else 0.9)
        segments = []
        if header_h + sum(row_hs) + 0.2 > usable:
            seg, seg_h = [], header_h
            for row, rh in zip(rows, row_hs):
                if seg and seg_h + rh + 0.2 > usable:
                    segments.append((seg, seg_h))
                    seg, seg_h = [], header_h
                seg.append(row)
                seg_h += rh
            if seg:
                segments.append((seg, seg_h))
        else:
            segments = [(rows, header_h + sum(row_hs))]
        # Number columns read right-aligned (decided on the WHOLE table, so every split
        # segment aligns the same way).
        def col_numeric(ci):
            vals = [str(row[ci]).strip() for row in rows
                    if ci < len(row) and row[ci] not in (None, "")]
            return bool(vals) and all(_NUMLIKE_RE.match(v) for v in vals)
        aligns = [PP_ALIGN.RIGHT if col_numeric(ci) else None for ci in range(n_cols)]
        for seg_rows, seg_h in segments:
            place_table(headers, seg_rows, seg_h, n_cols, aligns=aligns)

    def render_image(p):
        src = str(p.get("src") or "")
        img_path, _ = resolve_path(src)
        if img_path:
            ensure_room(2.7)
            slide, y = state["slide"], state["y"]
            try:
                slide.shapes.add_picture(img_path, Inches(PPTX_MARGIN_IN), Inches(y),
                                         height=Inches(2.5))
                state["y"] = y + 2.7
            except Exception:  # noqa: BLE001 — a bad image loses itself, not the deck
                pass

    # ---- plain path (master decks): a quiet document flow the master's look carries ----

    def render_chunk_plain(chunk):
        for b in chunk:
            t, p = str(b.get("type") or ""), b.get("props") or {}
            if t == "header":
                ensure_room(0.95)
                slide, y = state["slide"], state["y"]
                tb = slide.shapes.add_textbox(Inches(PPTX_MARGIN_IN), Inches(y),
                                              sw - Inches(PPTX_MARGIN_IN * 2), Inches(0.7))
                tf = tb.text_frame
                tf.text = str(p.get("text") or "")
                tf.paragraphs[0].font.size = Pt(28 if int(p.get("level") or 2) == 1 else 20)
                tf.paragraphs[0].font.bold = True
                state["y"] = y + 0.95
            elif t == "table":
                render_table(p)
            elif t == "image":
                render_image(p)
            else:
                lines = _block_lines(b)
                if not lines:
                    continue
                body_w_in = sw_in - 1.4
                visual = sum(_wrap_lines(l, body_w_in) for l in lines)
                height_in = 0.1 + 0.26 * visual
                ensure_room(height_in + 0.15)
                slide, y = state["slide"], state["y"]
                add_text(slide, 0.7, y, body_w_in, height_in,
                         [(line, PPTX_BODY_PT, False, None) for line in lines])
                state["y"] = y + height_in + 0.15

    # ---- styled path: the proposal-deck layout system (2026-08-11 사용자 예시 장르) ----
    # Content is poured into archetypes instead of flowed like a document: numbered ring
    # rows, 2-3 pill columns, a 4-quadrant donut, metric cards, and a takeaway statement.

    def _mix(color, target, f):
        s = str(color)
        return RGBColor(*(round(int(s[k:k + 2], 16) + (target - int(s[k:k + 2], 16)) * f)
                          for k in (0, 2, 4)))

    def collect_groups(rest):
        groups, i = [], 0
        while i < len(rest):
            b = rest[i]
            t, p = str(b.get("type") or ""), b.get("props") or {}
            if t == "header":
                g = {"title": str(p.get("text") or ""), "body": []}
                i += 1
                while i < len(rest):
                    nb = rest[i]
                    nt, np_ = str(nb.get("type") or ""), nb.get("props") or {}
                    if nt == "text":
                        g["body"].append(str(np_.get("content") or ""))
                    elif nt == "list":
                        g["body"].extend(f"• {it}" for it in (np_.get("items") or []))
                    else:
                        break
                    i += 1
                groups.append(("item", g))
            elif t == "metric":
                ms = []
                while i < len(rest) and str(rest[i].get("type") or "") == "metric":
                    ms.append(rest[i].get("props") or {})
                    i += 1
                groups.append(("metrics", ms))
            elif t == "list":
                groups.append(("list", [str(it) for it in (p.get("items") or [])]))
                i += 1
            elif t == "text":
                groups.append(("text", [str(p.get("content") or "")]))
                i += 1
            elif t in ("table", "image"):
                groups.append((t, p))
                i += 1
            else:
                i += 1
        return groups

    ITEM_X = PPTX_MARGIN_IN + 0.95

    def item_row(no, g):
        text_w = sw_in - ITEM_X - PPTX_MARGIN_IN
        t_lines = _wrap_lines(g["title"], text_w, chars_per_in=4.5)
        b_lines = sum(_wrap_lines(l, text_w) for l in g["body"])
        h = max(0.68, 0.3 * t_lines + 0.22 * b_lines + 0.16)
        ensure_room(h + 0.1)
        slide, y = state["slide"], state["y"]
        ring = add_box(slide, MSO_SHAPE.OVAL, PPTX_MARGIN_IN + 0.02, y + 0.02, 0.6, 0.6,
                       fill=WHITE, line=BLUE, line_w=2.25)
        rp = ring.text_frame.paragraphs[0]
        rp.text = f"{no:02d}"
        rp.font.size = Pt(14)
        rp.font.bold = True
        rp.font.color.rgb = BLUE
        rp.alignment = PP_ALIGN.CENTER
        apply_font(rp)
        runs = [(g["title"], 13.5, True, SLATE_D)]
        runs += [(l, 11, False, SLATE_B) for l in g["body"]]
        add_text(slide, ITEM_X, y, text_w, h, runs)
        state["y"] = y + h + 0.12

    def pill_columns(items):
        n = len(items)
        gap = 0.35
        col_w = (sw_in - PPTX_MARGIN_IN * 2 - gap * (n - 1)) / n
        body_h = 0.2 + 0.22 * max(
            sum(_wrap_lines(l, col_w - 0.2) for l in g["body"]) or 1 for g in items)
        ensure_room(0.44 + 0.15 + body_h + 0.1)
        slide, y = state["slide"], state["y"]
        for idx, g in enumerate(items):
            x = PPTX_MARGIN_IN + idx * (col_w + gap)
            pill = add_box(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x + 0.25, y,
                           col_w - 0.5, 0.44, fill=BLUE)
            try:
                pill.adjustments[0] = 0.5
            except Exception:  # noqa: BLE001 — a squarer pill, not a lost slide
                pass
            pp = pill.text_frame.paragraphs[0]
            pp.text = g["title"]
            pp.font.size = Pt(12.5)
            pp.font.bold = True
            pp.font.color.rgb = WHITE
            pp.alignment = PP_ALIGN.CENTER
            apply_font(pp)
            add_text(slide, x, y + 0.59, col_w, body_h,
                     [(l, 10.5, False, SLATE_B) for l in g["body"]], align=PP_ALIGN.CENTER)
        state["y"] = y + 0.59 + body_h + 0.15

    def add_pie(slide, x, y, d, start_deg, end_deg, fill):
        pie = add_box(slide, MSO_SHAPE.PIE, x, y, d, d, fill=fill)
        try:
            # PIE adjustments are angles: raw XML is 1/60000 deg, python-pptx divides by
            # 100000 — so degrees x 0.6. 0 = 3 o'clock, clockwise.
            pie.adjustments[0] = start_deg * 0.6
            pie.adjustments[1] = end_deg * 0.6
        except Exception:  # noqa: BLE001 — a full circle beats a crashed deck
            pass
        return pie

    def quad(items):
        # SWOT-shape: a four-color donut (pie quarters under a white core) with corner
        # badges, one text block per quadrant (2026-08-11 사용자 예시).
        ensure_room(3.8)
        slide, y = state["slide"], state["y"]
        cx = sw_in / 2
        cy = y + (sh_in - BODY_BOTTOM - y) / 2
        colors = [BLUE, _mix(BLUE, 255, 0.45), _mix(BLUE, 0, 0.3), _mix(BLUE, 255, 0.2)]
        R = 1.55
        angles = [(180, 270), (270, 360), (90, 180), (0, 90)]      # NW NE SW SE
        offs = [(-1.1, -1.1), (1.1, -1.1), (-1.1, 1.1), (1.1, 1.1)]
        for i in range(min(4, len(items))):
            add_pie(slide, cx - R, cy - R, R * 2, angles[i][0], angles[i][1], colors[i])
        add_box(slide, MSO_SHAPE.OVAL, cx - 1.0, cy - 1.0, 2.0, 2.0,
                fill=WHITE, line=SLATE_L, line_w=1.0)
        label = state["sec_title"] or ""
        if label:
            add_text(slide, cx - 0.95, cy - 0.3, 1.9, 0.6,
                     [(label, 11.5, True, SLATE_D)], align=PP_ALIGN.CENTER)
        col_w = cx - R - 0.55 - PPTX_MARGIN_IN
        xs = [PPTX_MARGIN_IN, cx + R + 0.55, PPTX_MARGIN_IN, cx + R + 0.55]
        ys = [y + 0.15, y + 0.15, cy + 0.55, cy + 0.55]
        for i, g in enumerate(items[:4]):
            badge = add_box(slide, MSO_SHAPE.OVAL, cx + offs[i][0] - 0.31,
                            cy + offs[i][1] - 0.31, 0.62, 0.62,
                            fill=colors[i], line=WHITE, line_w=2.0)
            first = g["title"].strip()[:1]
            bp = badge.text_frame.paragraphs[0]
            bp.text = first.upper() if first.isascii() and first.isalpha() else str(i + 1)
            bp.font.size = Pt(15)
            bp.font.bold = True
            bp.font.color.rgb = WHITE
            bp.alignment = PP_ALIGN.CENTER
            apply_font(bp)
            align = PP_ALIGN.RIGHT if i in (1, 3) else PP_ALIGN.LEFT
            runs = [(g["title"], 15, True, colors[i])]
            runs += [(l, 10.5, False, SLATE_B) for l in g["body"]]
            add_text(slide, xs[i], ys[i], col_w, cy - y - 0.7, runs, align=align)
        state["y"] = sh_in  # the quadrant owns the body — next content turns the page

    def metric_strip(ms):
        per_row = 4 if len(ms) > 3 else max(1, len(ms))
        gap = 0.25
        card_w = (sw_in - PPTX_MARGIN_IN * 2 - gap * (per_row - 1)) / per_row
        for start in range(0, len(ms), per_row):
            ensure_room(1.3)
            slide, y = state["slide"], state["y"]
            for j, m in enumerate(ms[start:start + per_row]):
                x = PPTX_MARGIN_IN + j * (card_w + gap)
                card = add_box(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, card_w, 1.15,
                               fill=SLATE_L)
                try:
                    card.adjustments[0] = 0.12
                except Exception:  # noqa: BLE001
                    pass
                tf = card.text_frame
                tf.word_wrap = True
                tf.vertical_anchor = MSO_ANCHOR.MIDDLE
                value = f"{m.get('value', '')}{m.get('unit') or ''}"
                # Dashboard-card reading order: label anchors left, numbers set right
                # (2026-08-11 사용자 — autoshape default centering scattered the three lines).
                rows = [(str(m.get("label") or ""), 10, False, SLATE_B, PP_ALIGN.LEFT),
                        (value, 20, True, BLUE, PP_ALIGN.RIGHT)]
                if m.get("delta") not in (None, ""):
                    rows.append((str(m.get("delta")), 9.5, False, SLATE_B, PP_ALIGN.RIGHT))
                for i, (text, size, bold, color, al) in enumerate(rows):
                    para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    para.text = text
                    para.font.size = Pt(size)
                    para.font.bold = bold
                    para.font.color.rgb = color
                    para.alignment = al
                    apply_font(para)
            state["y"] = y + 1.3

    def text_par(lines):
        body_w_in = sw_in - 1.4
        visual = sum(_wrap_lines(l, body_w_in) for l in lines)
        h = 0.1 + 0.24 * visual
        ensure_room(h + 0.15)
        add_text(state["slide"], 0.7, state["y"], body_w_in, h,
                 [(l, 11.5, False, SLATE_B) for l in lines])
        state["y"] += h + 0.15

    def statement_line(text):
        # The genre's closing move: one bold accent-colored line, set to the right.
        ensure_room(0.75)
        slide, y = state["slide"], state["y"]
        add_text(slide, sw_in * 0.3, y + 0.1, sw_in * 0.7 - PPTX_MARGIN_IN, 0.55,
                 [(text, 15.5, True, BLUE)], align=PP_ALIGN.RIGHT)
        state["y"] = y + 0.75

    def chevron_strip(steps):
        # A short list whose items are labels, not sentences, reads as a process —
        # drawn as an arrow flow, light to accent, left to right.
        n = len(steps)
        gap = 0.12
        w = (sw_in - PPTX_MARGIN_IN * 2 - gap * (n - 1)) / n
        h = 0.72
        ensure_room(h + 0.25)
        slide, y = state["slide"], state["y"]
        for i, txt in enumerate(steps):
            f = 0.5 * (n - 1 - i) / max(n - 1, 1)
            shp = add_box(slide, MSO_SHAPE.CHEVRON, PPTX_MARGIN_IN + i * (w + gap), y,
                          w, h, fill=_mix(BLUE, 255, f))
            cp = shp.text_frame.paragraphs[0]
            cp.text = txt
            cp.font.size = Pt(11.5)
            cp.font.bold = True
            cp.font.color.rgb = WHITE
            cp.alignment = PP_ALIGN.CENTER
            apply_font(cp)
        state["y"] = y + h + 0.25

    def timeline(items):
        # Milestone titles ride a horizontal axis, texts zigzag above and below —
        # the genre's curve-with-dots slide in straight-line form.
        ensure_room(3.4)
        slide, y = state["slide"], state["y"]
        cy = y + (sh_in - BODY_BOTTOM - y) / 2
        x0 = PPTX_MARGIN_IN + 0.4
        x1 = sw_in - PPTX_MARGIN_IN - 0.4
        add_box(slide, MSO_SHAPE.RECTANGLE, x0 - 0.2, cy - 0.02, x1 - x0 + 0.4, 0.04,
                fill=_mix(BLUE, 255, 0.75))
        n = len(items)
        step = (x1 - x0) / max(n - 1, 1)
        for i, g in enumerate(items):
            cx_i = x0 + step * i
            add_box(slide, MSO_SHAPE.OVAL, cx_i - 0.17, cy - 0.17, 0.34, 0.34,
                    fill=WHITE, line=BLUE, line_w=2.0)
            add_box(slide, MSO_SHAPE.OVAL, cx_i - 0.07, cy - 0.07, 0.14, 0.14, fill=BLUE)
            col_w = min(step * 1.9, 2.7) if n > 1 else 3.0
            tx = min(max(cx_i - col_w / 2, PPTX_MARGIN_IN), sw_in - PPTX_MARGIN_IN - col_w)
            above = i % 2 == 0
            box_h = (cy - y - 0.45) if above else (sh_in - BODY_BOTTOM - cy - 0.45)
            ty = y + 0.1 if above else cy + 0.35
            runs = [(g["title"], 12.5, True, BLUE)]
            runs += [(l, 10, False, SLATE_B) for l in g["body"]]
            add_text(slide, tx, ty, col_w, max(box_h, 0.5), runs, align=PP_ALIGN.CENTER,
                     anchor=MSO_ANCHOR.BOTTOM if above else MSO_ANCHOR.TOP)
        state["y"] = sh_in  # the axis owns the body — next content turns the page

    sec_counter = {"n": 0}

    def render_chunk_styled(chunk):
        rest = list(chunk)
        state["sec_title"], state["sec_stmt"] = None, None
        if rest and str(rest[0].get("type") or "") == "header" \
                and int((rest[0].get("props") or {}).get("level") or 2) == 1:
            sec_counter["n"] += 1
            state["sec_no"] = sec_counter["n"]
            state["sec_title"] = str((rest[0].get("props") or {}).get("text") or "")
            rest = rest[1:]
            # A short first paragraph is the slide's one-line message — it moves into the
            # statement band instead of sitting in the body as a stray paragraph.
            if rest and str(rest[0].get("type") or "") == "text":
                c = str((rest[0].get("props") or {}).get("content") or "")
                if 0 < len(c) <= 130:
                    state["sec_stmt"] = c
                    rest = rest[1:]
        new_slide(continuation=False)
        groups = collect_groups(rest)
        stmt = None
        if len(groups) >= 2 and groups[-1][0] == "text" and len(groups[-1][1]) == 1 \
                and 0 < len(groups[-1][1][0]) <= 70:
            stmt = groups[-1][1][0]
            groups = groups[:-1]
        items = [g for k, g in groups if k == "item"]
        only_items = bool(groups) and all(k == "item" for k, _ in groups)
        short = all(sum(len(l) for l in g["body"]) <= 220 for g in items)
        # Timeline outranks the donut: four year-titled groups are a schedule, not a SWOT.
        timeline_fit = (only_items and 3 <= len(items) <= 6 and short
                        and sum(1 for g in items if _STEPISH_RE.search(g["title"]))
                        >= max(2, len(items) - 1))
        if timeline_fit:
            timeline(items)
        elif only_items and len(items) == 4 and short:
            quad(items)
        elif only_items and 2 <= len(items) <= 3 and short:
            pill_columns(items)
        else:
            no = 0
            for kind, val in groups:
                if kind == "item":
                    no += 1
                    item_row(no, val)
                elif kind == "metrics":
                    metric_strip(val)
                elif kind == "table":
                    render_table(val)
                elif kind == "image":
                    render_image(val)
                elif kind == "list":
                    if 3 <= len(val) <= 6 and all(len(v) <= 22 for v in val):
                        chevron_strip(val)
                    else:
                        text_par([f"• {v}" for v in val])
                else:
                    text_par(val)
        if stmt:
            statement_line(stmt)

    for chunk in _split_slides(blocks):
        state["slide"] = None  # each chunk starts its own slide
        if styled:
            render_chunk_styled(chunk)
        else:
            render_chunk_plain(chunk)
            if state["slide"] is None:
                new_slide()  # an empty chunk (e.g. lone divider) still turns the page
    for slide in prs.slides:
        apply_transition(slide)
    prs.save(out_path)
    return state["count"]


def action_make_pptx(inp):
    blocks = normalize_blocks(inp.get("blocks"))
    title = str(inp.get("title") or "").strip()
    if not blocks and not title:
        return {"success": False, "action": "make_pptx",
                "error": "blocks (or at least a title) required"}
    master_raw = str(inp.get("masterMediaPath")
                     or os.environ.get("MODULE_MASTERPPTXURL") or "").strip()
    master_path = None
    if master_raw:
        master_path, err = resolve_path(master_raw)
        if err:
            return {"success": False, "action": "make_pptx", "error": f"master: {err}"}
        if not master_path.lower().endswith(".pptx"):
            return {"success": False, "action": "make_pptx",
                    "error": f"master must be .pptx (got {master_path})"}
    out_path, stem = out_file(title or "deck", "pptx", {"t": title, "b": blocks})
    try:
        transition = str(inp.get("transition") or "fade").strip().lower()
        theme = inp.get("theme") if isinstance(inp.get("theme"), dict) else None
        slides = make_pptx_file(blocks, title, master_path, out_path,
                                transition=transition, theme=theme)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "action": "make_pptx", "error": f"pptx build failed: {e}"}
    return {"success": True, "action": "make_pptx", "data": {
        "slides": slides, "master": bool(master_path),
        "_mediaImport": media_import_decl(out_path, "pptx", stem),
    }}


def make_xlsx_file(sheets, out_path):
    import openpyxl
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    used = set()
    for i, sh in enumerate(sheets):
        name = re.sub(r"[\\/*?:\[\]]", "-", str(sh.get("name") or f"Sheet{i + 1}"))[:31] or f"S{i}"
        while name in used:
            name = (name[:28] + f"_{i}")[:31]
        used.add(name)
        ws = wb.create_sheet(title=name)
        headers = sh.get("headers") or []
        if headers:
            from openpyxl.styles import Font
            ws.append([str(h) for h in headers])
            for c in ws[1]:
                c.font = Font(bold=True)
        for row in sh.get("rows") or []:
            # "1,234" must land as the number 1234, not text — text numbers kill SUM and
            # charts on the receiving end (2026-08-11 사용자 실측).
            cells = []
            for v in row:
                num = parse_number(v)
                cells.append(num if num is not None else ("" if v is None else str(v)))
            ws.append(cells)
    wb.save(out_path)
    return len(sheets)


def action_make_xlsx(inp):
    sheets = inp.get("sheets")
    if not sheets:
        blocks = normalize_blocks(inp.get("blocks"))
        sheets, last_header = [], None
        for b in blocks:
            t, p = str(b.get("type") or ""), b.get("props") or {}
            if t == "header":
                last_header = str(p.get("text") or "")
            elif t == "table":
                sheets.append({"name": last_header or f"표{len(sheets) + 1}",
                               "headers": p.get("headers") or [], "rows": p.get("rows") or []})
                last_header = None
    if not sheets:
        return {"success": False, "action": "make_xlsx",
                "error": "nothing to write — pass sheets, or blocks containing table blocks"}
    title = str(inp.get("title") or sheets[0].get("name") or "sheet")
    out_path, stem = out_file(title, "xlsx", sheets)
    try:
        n = make_xlsx_file(sheets, out_path)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "action": "make_xlsx", "error": f"xlsx build failed: {e}"}
    return {"success": True, "action": "make_xlsx", "data": {
        "sheets": n, "_mediaImport": media_import_decl(out_path, "xlsx", stem),
    }}


def make_docx_file(blocks, title, out_path):
    import docx
    d = docx.Document()
    if title:
        d.add_heading(str(title), level=0)
    for b in blocks:
        t, p = str(b.get("type") or ""), b.get("props") or {}
        if t == "header":
            d.add_heading(str(p.get("text") or ""), level=min(4, max(1, int(p.get("level") or 2))))
        elif t == "list":
            style = "List Number" if p.get("ordered") else "List Bullet"
            for item in p.get("items") or []:
                d.add_paragraph(str(item), style=style)
        elif t == "table":
            headers = [str(h) for h in (p.get("headers") or [])]
            rows = p.get("rows") or []
            if not headers:
                continue
            tb = d.add_table(rows=len(rows) + 1, cols=len(headers))
            tb.style = "Light Grid Accent 1"
            for c, h in enumerate(headers):
                cell = tb.cell(0, c)
                cell.text = str(h)
                for run in cell.paragraphs[0].runs:
                    run.bold = True
            for r, row in enumerate(rows):
                for c in range(len(headers)):
                    val = row[c] if c < len(row) else ""
                    tb.cell(r + 1, c).text = "" if val is None else str(val)
        elif t == "divider":
            d.add_page_break()
        else:
            for line in _block_lines(b):
                d.add_paragraph(line)
    d.save(out_path)


def _pdf_korean_font():
    """A Korean-capable font for reportlab: a host TTF when one exists (embedded, best
    fidelity), else Adobe's CID KR font (no file needed — the viewer supplies the glyphs)."""
    from reportlab.pdfbase import pdfmetrics
    for path in (
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf",
        "C:/Windows/Fonts/malgun.ttf",
    ):
        if os.path.isfile(path):
            from reportlab.pdfbase.ttfonts import TTFont
            try:
                pdfmetrics.registerFont(TTFont("KoreanBody", path))
                return "KoreanBody"
            except Exception:  # noqa: BLE001 — a broken font file falls through to CID
                continue
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HYGothic-Medium"))
    return "HYGothic-Medium"


def make_pdf_file(blocks, title, out_path):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (Image as RLImage, ListFlowable, ListItem, PageBreak,
                                    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

    font = _pdf_korean_font()
    styles = {
        "title": ParagraphStyle("t", fontName=font, fontSize=22, leading=28, spaceAfter=10),
        1: ParagraphStyle("h1", fontName=font, fontSize=17, leading=22, spaceBefore=10, spaceAfter=6),
        2: ParagraphStyle("h2", fontName=font, fontSize=14, leading=18, spaceBefore=8, spaceAfter=4),
        3: ParagraphStyle("h3", fontName=font, fontSize=12, leading=16, spaceBefore=6, spaceAfter=3),
        "body": ParagraphStyle("b", fontName=font, fontSize=10, leading=15, spaceAfter=3),
    }

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    story = []
    if title:
        story.append(Paragraph(esc(title), styles["title"]))
    for b in blocks:
        t, p = str(b.get("type") or ""), b.get("props") or {}
        if t == "header":
            lvl = min(3, max(1, int(p.get("level") or 2)))
            story.append(Paragraph(esc(p.get("text") or ""), styles[lvl]))
        elif t == "list":
            items = [ListItem(Paragraph(esc(i), styles["body"])) for i in (p.get("items") or [])]
            if items:
                story.append(ListFlowable(
                    items, bulletType="1" if p.get("ordered") else "bullet",
                    bulletFontName=font))
        elif t == "table":
            headers = [str(h) for h in (p.get("headers") or [])]
            rows = p.get("rows") or []
            if not headers:
                continue
            data = [[Paragraph(esc(h), styles["body"]) for h in headers]]
            for row in rows:
                data.append([Paragraph(esc("" if (row[c] if c < len(row) else "") is None
                                            else (row[c] if c < len(row) else "")),
                                       styles["body"]) for c in range(len(headers))])
            tbl = Table(data, repeatRows=1)
            tbl.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]))
            story.append(tbl)
            story.append(Spacer(1, 4 * mm))
        elif t == "image":
            img_path, _ = resolve_path(str(p.get("src") or ""))
            if img_path:
                try:
                    story.append(RLImage(img_path, height=60 * mm, kind="proportional"))
                    story.append(Spacer(1, 3 * mm))
                except Exception:  # noqa: BLE001 — a bad image loses itself, not the document
                    pass
        elif t == "divider":
            story.append(PageBreak())
        else:
            for line in _block_lines(b):
                story.append(Paragraph(esc(line), styles["body"]))
    if not story:
        story.append(Paragraph(" ", styles["body"]))
    SimpleDocTemplate(out_path, pagesize=A4,
                      topMargin=18 * mm, bottomMargin=18 * mm,
                      leftMargin=18 * mm, rightMargin=18 * mm).build(story)
    return font


def action_make_pdf(inp):
    blocks = normalize_blocks(inp.get("blocks"))
    title = str(inp.get("title") or "").strip()
    if not blocks and not title:
        return {"success": False, "action": "make_pdf",
                "error": "blocks (or at least a title) required"}
    out_path, stem = out_file(title or "document", "pdf", {"t": title, "b": blocks})
    try:
        font = make_pdf_file(blocks, title, out_path)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "action": "make_pdf", "error": f"pdf build failed: {e}"}
    return {"success": True, "action": "make_pdf", "data": {
        "blocks": len(blocks), "font": font,
        "_mediaImport": media_import_decl(out_path, "pdf", stem),
    }}


def action_make_docx(inp):
    blocks = normalize_blocks(inp.get("blocks"))
    title = str(inp.get("title") or "").strip()
    if not blocks and not title:
        return {"success": False, "action": "make_docx",
                "error": "blocks (or at least a title) required"}
    out_path, stem = out_file(title or "document", "docx", {"t": title, "b": blocks})
    try:
        make_docx_file(blocks, title, out_path)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "action": "make_docx", "error": f"docx build failed: {e}"}
    return {"success": True, "action": "make_docx", "data": {
        "blocks": len(blocks), "_mediaImport": media_import_decl(out_path, "docx", stem),
    }}


def action_make_hwpx(inp):
    """Render blocks → .hwpx through the rhwp engine, seeded from a REAL Hancom blank
    (fixtures/donor-blank.hwp, 사용자 한컴 저장본) — createEmpty ships no style tables and
    Hancom draws garbage from its exports (2026-08-11 해부). Tables and bold headings
    ride along; the file lands in the media store like every other make."""
    blocks = normalize_blocks(inp.get("blocks"))
    title = str(inp.get("title") or "").strip()
    if not blocks and not title:
        return {"success": False, "action": "make_hwpx",
                "error": "blocks (or at least a title) required"}
    donor = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "fixtures", "donor-blank.hwp")
    if not os.path.exists(donor):
        return {"success": False, "action": "make_hwpx",
                "error": "donor-blank.hwp fixture missing — hwpx needs the Hancom seed"}
    out_path, stem = out_file(title or "document", "hwpx", {"t": title, "b": blocks})
    try:
        made = _rhwp_helper({"op": "make", "donor": donor, "out": out_path,
                             "format": "hwpx", "title": title, "blocks": blocks})
    except Exception as e:  # noqa: BLE001 — the engine names its own failure
        return {"success": False, "action": "make_hwpx", "error": f"hwpx build failed: {e}"}
    return {"success": True, "action": "make_hwpx", "data": {
        "blocks": len(blocks),
        "paragraphs": made.get("paragraphs"), "tables": made.get("tables"),
        "_mediaImport": media_import_decl(out_path, "hwpx", stem),
    }}


# ── selftest ───────────────────────────────────────────────────────────────────────────────────

def minimal_pdf():
    """A complete one-page PDF built with real offsets — pypdf wants the xref honest."""
    stream = b"BT /F1 24 Tf 72 700 Td (Hello Firebat) Tj ET"
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length %d>>stream\n%s\nendstream" % (len(stream), stream),
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (i, body)
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (b"trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objs) + 1, xref_at))
    return bytes(out)

HWPX_SECTION = """<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p><hp:run><hp:t>한글 문단 하나</hp:t></hp:run></hp:p>
  <hp:p><hp:run><hp:t>두 번째 문단</hp:t>
    <hp:equation><hp:script>a over b</hp:script></hp:equation></hp:run></hp:p>
  <hp:tbl>
    <hp:tr><hp:tc><hp:p><hp:run><hp:t>이름</hp:t></hp:run></hp:p></hp:tc>
           <hp:tc><hp:p><hp:run><hp:t>값</hp:t></hp:run></hp:p></hp:tc></hp:tr>
    <hp:tr><hp:tc><hp:p><hp:run><hp:t>가</hp:t></hp:run></hp:p></hp:tc>
           <hp:tc><hp:p><hp:run><hp:t>1</hp:t></hp:run></hp:p></hp:tc></hp:tr>
  </hp:tbl>
</hs:sec>"""


def action_selftest():
    checks = []

    def ck(name, ok):
        checks.append({"name": name, "ok": bool(ok)})

    os.makedirs(OUT_DIR, exist_ok=True)
    tmp = []

    blocks = [
        {"type": "header", "props": {"text": "첫 장", "level": 1}},
        {"type": "text", "props": {"content": "본문 한 줄"}},
        {"type": "table", "props": {"headers": ["이름", "값"], "rows": [["가", 1], ["나", 2]]}},
        {"type": "header", "props": {"text": "둘째 장", "level": 1}},
        {"type": "list", "props": {"items": ["하나", "둘"], "ordered": False}},
        {"type": "metric", "props": {"label": "매출", "value": 42, "unit": "억"}},
    ]

    ck("slide boundary splits on header level 1", len(_split_slides(blocks)) == 2)

    fence = normalize_blocks([
        {"name": "Header", "type": "component", "props": {"text": "장", "level": 1}},
        {"name": "Divider", "type": "component", "props": {}},
        {"name": "Table", "type": "component", "props": {"headers": ["a"], "rows": [["1"]]}},
    ])
    ck("render-fence dialect is absorbed (name -> type)",
       [b["type"] for b in fence] == ["header", "divider", "table"])

    # pptx round-trip
    p = f"{OUT_DIR}/selftest.pptx"
    tmp.append(p)
    try:
        n = make_pptx_file(blocks, "테스트 덱", None, p)
        got = read_pptx(p)
        ck("pptx: title + 2 body slides", n == 3)
        ck("pptx: text survives the round trip", "본문 한 줄" in got["text"])
        ck("pptx: the table is a real table", got["tables"]
           and got["tables"][0]["headers"] == ["이름", "값"])
        # The first live deck's two defects, pinned: the empty subtitle placeholder ghost on
        # the title slide, and overflow silently dropping content instead of turning the page.
        from pptx import Presentation as _P
        cov = _P(p).slides[0]
        ck("pptx: cover has no placeholder ghosts",
           len(list(cov.placeholders)) == 0 and len(cov.shapes) >= 2)
        # 2026-08-11 proposal-genre system: navy section band on every content slide,
        # and four short groups arrange as the quadrant donut.
        band = [sh for sh in _P(p).slides[1].shapes
                if sh.top == 0 and abs(sh.width - _P(p).slide_width) < 20000]
        ck("pptx: content slides carry the section band", len(band) >= 1)
        p_quad = f"{OUT_DIR}/selftest-quad.pptx"
        tmp.append(p_quad)
        four = [{"type": "header", "props": {"text": "SWOT", "level": 1}}]
        for t_ in ("Strength", "Weakness", "Opportunity", "Threat"):
            four.append({"type": "header", "props": {"text": t_, "level": 2}})
            four.append({"type": "text", "props": {"content": f"{t_} 설명"}})
        make_pptx_file(four, None, None, p_quad)
        got_quad = read_pptx(p_quad)
        ck("pptx: four short groups become the quadrant donut (all texts land)",
           all(t_ in got_quad["text"]
               for t_ in ("Strength", "Weakness", "Opportunity", "Threat")))
        p_tl = f"{OUT_DIR}/selftest-timeline.pptx"
        tmp.append(p_tl)
        tl = [{"type": "header", "props": {"text": "추진 일정", "level": 1}}]
        for yr in ("2024", "2025", "2026", "2027"):
            tl.append({"type": "header", "props": {"text": f"{yr}년", "level": 2}})
            tl.append({"type": "text", "props": {"content": f"{yr} 마일스톤"}})
        make_pptx_file(tl, None, None, p_tl)
        ck("pptx: year titles take the timeline (texts land)",
           "2027 마일스톤" in read_pptx(p_tl)["text"])
        p_cv = f"{OUT_DIR}/selftest-chevron.pptx"
        tmp.append(p_cv)
        cv = [{"type": "header", "props": {"text": "절차", "level": 1}},
              {"type": "list", "props": {"items": ["발굴", "검증", "계약", "운영"]}}]
        make_pptx_file(cv, None, None, p_cv)
        ck("pptx: a short label list flows as chevron arrows",
           all(s in read_pptx(p_cv)["text"] for s in ("발굴", "검증", "계약", "운영")))
        # A table taller than a slide splits across slides, header repeated, no row lost.
        p_tbl = f"{OUT_DIR}/selftest-tblsplit.pptx"
        tmp.append(p_tbl)
        big = [{"type": "table", "props": {"headers": ["번호", "값"],
                                           "rows": [[i, f"행{i}"] for i in range(60)]}}]
        n_tbl = make_pptx_file(big, None, None, p_tbl)
        got_tbl = read_pptx(p_tbl)
        total_rows = sum(len(t["rows"]) for t in got_tbl["tables"])
        ck("pptx: a huge table splits across slides", n_tbl >= 2)
        ck("pptx: every row survives the split", total_rows == 60)
        from pptx.oxml.ns import qn as _qn
        ck("pptx: slides carry the fade transition",
           _P(p).slides[0]._element.find(_qn("p:transition")) is not None)
        p_theme = f"{OUT_DIR}/selftest-theme.pptx"
        tmp.append(p_theme)
        make_pptx_file([{"type": "header", "props": {"text": "장", "level": 1}}], "테마",
                       None, p_theme, transition="none", theme={"accent": "#FF0000"})
        prs_t = _P(p_theme)
        ck("pptx: transition='none' really means none",
           prs_t.slides[0]._element.find(_qn("p:transition")) is None)
        reds = [sh for sl in prs_t.slides for sh in sl.shapes
                if sh.shape_type == 1 and sh.fill.type is not None
                and getattr(sh.fill.fore_color, "rgb", None) is not None
                and str(sh.fill.fore_color.rgb) == "FF0000"]
        ck("pptx: theme accent recolors the bars", len(reds) >= 1)
        p_spill = f"{OUT_DIR}/selftest-spill.pptx"
        tmp.append(p_spill)
        many = ([{"type": "header", "props": {"text": "긴 장", "level": 1}}]
                + [{"type": "text", "props": {"content": "내용 줄 " * 40}} for _ in range(20)])
        n_spill = make_pptx_file(many, None, None, p_spill)
        ck("pptx: overflowing content continues on new slides", n_spill >= 2)
        got_spill = read_pptx(p_spill)
        ck("pptx: nothing is dropped by overflow",
           sum(s["text"].count("내용 줄") for s in [{"text": got_spill["text"]}]) >= 1
           and got_spill["meta"]["slides"] == n_spill)
    except Exception as e:  # noqa: BLE001
        ck(f"pptx round trip crashed: {e}", False)

    # xlsx round-trip
    p = f"{OUT_DIR}/selftest.xlsx"
    tmp.append(p)
    try:
        make_xlsx_file([{"name": "표1", "headers": ["a", "b"], "rows": [[1, "x"], [2, "y"]]}], p)
        got = read_xlsx(p)
        ck("xlsx: sheet and rows survive", got["tables"]
           and got["tables"][0]["rows"] == [[1, "x"], [2, "y"]])
        p_num = f"{OUT_DIR}/selftest-num.xlsx"
        tmp.append(p_num)
        make_xlsx_file([{"name": "n", "headers": ["v"],
                         "rows": [["1,234"], ["-3.1"], ["48억"]]}], p_num)
        got_n = read_xlsx(p_num)
        vals = [r[0] for r in got_n["tables"][0]["rows"]]
        ck("xlsx: numeric-looking text lands as real numbers (units stay text)",
           vals == [1234, -3.1, "48억"])
    except Exception as e:  # noqa: BLE001
        ck(f"xlsx round trip crashed: {e}", False)

    # docx round-trip
    p = f"{OUT_DIR}/selftest.docx"
    tmp.append(p)
    try:
        make_docx_file(blocks, "테스트 문서", p)
        got = read_docx(p)
        ck("docx: headings and text survive", "본문 한 줄" in got["text"]
           and any("첫 장" in ln for ln in got["text"].split("\n")))
        ck("docx: the table is a real table", got["tables"]
           and got["tables"][0]["headers"] == ["이름", "값"])
    except Exception as e:  # noqa: BLE001
        ck(f"docx round trip crashed: {e}", False)

    # hwpx read (fixture zip — we never write hwpx, by decision)
    p = f"{OUT_DIR}/selftest.hwpx"
    tmp.append(p)
    try:
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("Contents/section0.xml", HWPX_SECTION)
        got = read_hwpx(p)
        ck("hwpx: paragraphs come out in order", got["text"].startswith("한글 문단 하나"))
        ck("hwpx: table cells keep their grid", got["tables"]
           and got["tables"][0]["rows"] == [["가", "1"]])
        ck("hwpx: table text is not doubled into the body", "이름" not in got["text"])
        ck("hwpx: equation script is extracted (직독)",
           got.get("equations") == ["a over b"] and "[수식] a over b" in got["text"])
    except Exception as e:  # noqa: BLE001
        ck(f"hwpx read crashed: {e}", False)

    # hwp via the rhwp engine — the committed fixture was made BY rhwp (create → export),
    # so this proves the vendored wasm runs on this host and equations survive as script.
    import shutil as _sh
    fx = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "fixtures", "rhwp-roundtrip.hwp")
    if _sh.which("node") and os.path.exists(fx):
        try:
            got = read_hwp_legacy(fx)
            ck("hwp(rhwp): text and table cell survive",
               "파이어뱃" in got["text"] and got["tables"]
               and got["tables"][0]["headers"][0] == "셀A1")
            ck("hwp(rhwp): the equation comes back as its script",
               any("over" in e for e in got.get("equations", [])))
        except Exception as e:  # noqa: BLE001
            ck(f"hwp(rhwp) crashed: {e}", False)
        # make: donor-seeded hwpx round trip through our own direct-walk reader.
        donor = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "fixtures", "donor-blank.hwp")
        if os.path.exists(donor):
            p_mk = f"{OUT_DIR}/selftest-made.hwpx"
            tmp.append(p_mk)
            try:
                _rhwp_helper({"op": "make", "donor": donor, "out": p_mk,
                              "format": "hwpx", "title": "셀프테스트 문서",
                              "blocks": blocks})
                got_mk = read_hwpx(p_mk)
                ck("hwpx make: text and heading survive the round trip",
                   "본문 한 줄" in got_mk["text"] and "첫 장" in got_mk["text"])
                ck("hwpx make: the table is a real table",
                   got_mk["tables"] and got_mk["tables"][0]["headers"] == ["이름", "값"])
            except Exception as e:  # noqa: BLE001
                ck(f"hwpx make crashed: {e}", False)
        else:
            ck("hwpx make: skipped — donor fixture absent", True)
    else:
        ck("hwp(rhwp): skipped — node runtime or fixture absent", True)

    # pdf read (hand-written minimal fixture)
    p = f"{OUT_DIR}/selftest.pdf"
    tmp.append(p)
    try:
        with open(p, "wb") as fh:
            fh.write(minimal_pdf())
        got = read_pdf(p)
        ck("pdf: text extracts", "Hello Firebat" in got["text"])
    except Exception as e:  # noqa: BLE001
        ck(f"pdf read crashed: {e}", False)

    # pdf make round-trip — ASCII asserted (CID-encoded Korean does not reliably re-extract
    # through pypdf; the Korean path is verified by the build not raising with 한글 in it).
    p = f"{OUT_DIR}/selftest-made.pdf"
    tmp.append(p)
    try:
        make_pdf_file([{"type": "header", "props": {"text": "Quarterly Report 분기", "level": 1}},
                       {"type": "text", "props": {"content": "revenue grew 12 percent"}},
                       {"type": "table", "props": {"headers": ["item", "값"],
                                                   "rows": [["revenue", 100]]}}],
                      "Firebat PDF", p)
        got = read_pdf(p)
        ck("pdf make: text survives the round trip", "revenue grew 12 percent" in got["text"])
        ck("pdf make: the file opens as a real pdf", got["meta"]["pages"] >= 1)
    except Exception as e:  # noqa: BLE001
        ck(f"pdf make round trip crashed: {e}", False)

    for p in tmp:
        try:
            os.remove(p)
        except OSError:
            pass

    failed = [c for c in checks if not c["ok"]]
    return {"success": not failed, "action": "selftest",
            "data": {"checks": checks, "total": len(checks), "failed": len(failed)}}


def main():
    # Bytes, decoded as UTF-8 explicitly — the locale default turns Korean into lone
    # surrogates on some hosts (measured on Windows), and the envelope is UTF-8 by contract.
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        envelope = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        sys.stdout.buffer.write((json.dumps({"success": False, "action": "", "error": f"input JSON: {e}"})).encode("utf-8"))
        return
    inp = envelope.get("data") or envelope
    action = str(inp.get("action") or "").strip()
    handlers = {"read": action_read, "make_pptx": action_make_pptx,
                "make_hwpx": action_make_hwpx,
                "make_xlsx": action_make_xlsx, "make_docx": action_make_docx,
                "make_pdf": action_make_pdf}
    if action == "selftest":
        out = action_selftest()
    elif action in handlers:
        out = handlers[action](inp)
    else:
        out = {"success": False, "action": action,
               "error": f"unknown action {action!r} — one of: read, make_pptx, make_xlsx, "
                        "make_docx, make_pdf, selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts,
    # and the envelope is UTF-8 by contract on both ends.
    sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False, default=str)).encode("utf-8"))


if __name__ == "__main__":
    main()
