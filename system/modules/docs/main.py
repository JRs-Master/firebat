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
    """OWPML (KS X 6101) — ZIP of section XMLs; text lives in <hp:t>, tables in <hp:tbl>.
    Namespace-agnostic on purpose: producers disagree on prefixes, localnames hold still."""
    texts, tables = [], []
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
    return {"format": "hwpx", "meta": {"sections": len(sections), "tables": len(tables)},
            "text": "\n".join(texts), "tables": tables}


READERS = {"pdf": read_pdf, "docx": read_docx, "xlsx": read_xlsx,
           "pptx": read_pptx, "hwpx": read_hwpx}


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


def make_pptx_file(blocks, title, master_path, out_path):
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation(master_path) if master_path else Presentation()
    blank = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[-1]
    sw, sh = prs.slide_width, prs.slide_height

    if title:
        layout = prs.slide_layouts[0]
        slide = prs.slides.add_slide(layout)
        placed = False
        for ph in slide.placeholders:
            if ph.placeholder_format.idx == 0:
                ph.text = str(title)
                placed = True
                break
        if not placed:
            tb = slide.shapes.add_textbox(Inches(0.8), Inches(2.5), sw - Inches(1.6), Inches(1.5))
            tb.text_frame.text = str(title)
            tb.text_frame.paragraphs[0].font.size = Pt(40)

    slide_count = 1 if title else 0
    for chunk in _split_slides(blocks):
        slide = prs.slides.add_slide(blank)
        slide_count += 1
        y = Inches(0.4)
        for b in chunk:
            t, p = str(b.get("type") or ""), b.get("props") or {}
            if t == "header":
                tb = slide.shapes.add_textbox(Inches(0.6), y, sw - Inches(1.2), Inches(0.8))
                tf = tb.text_frame
                tf.text = str(p.get("text") or "")
                tf.paragraphs[0].font.size = Pt(28 if int(p.get("level") or 2) == 1 else 20)
                tf.paragraphs[0].font.bold = True
                y += Inches(0.9)
            elif t == "table":
                headers = [str(h) for h in (p.get("headers") or [])]
                rows = p.get("rows") or []
                if not headers and rows:
                    headers = [str(c) for c in rows[0]]
                    rows = rows[1:]
                if not headers:
                    continue
                n_rows, n_cols = len(rows) + 1, len(headers)
                height = Inches(0.35) * n_rows
                shape = slide.shapes.add_table(
                    n_rows, n_cols, Inches(0.6), y, sw - Inches(1.2), height)
                table = shape.table
                for c, h in enumerate(headers):
                    table.cell(0, c).text = str(h)
                for r, row in enumerate(rows):
                    for c in range(n_cols):
                        val = row[c] if c < len(row) else ""
                        table.cell(r + 1, c).text = "" if val is None else str(val)
                y += height + Inches(0.2)
            elif t == "image":
                src = str(p.get("src") or "")
                img_path, _ = resolve_path(src)
                if img_path:
                    try:
                        slide.shapes.add_picture(img_path, Inches(0.6), y, height=Inches(2.5))
                        y += Inches(2.7)
                    except Exception:  # noqa: BLE001 — a bad image loses itself, not the deck
                        pass
            else:
                lines = _block_lines(b)
                if not lines:
                    continue
                tb = slide.shapes.add_textbox(Inches(0.7), y, sw - Inches(1.4),
                                              Inches(0.3) * len(lines) + Inches(0.1))
                tf = tb.text_frame
                tf.word_wrap = True
                for i, line in enumerate(lines):
                    para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    para.text = line
                    para.font.size = Pt(14)
                y += Inches(0.3) * len(lines) + Inches(0.2)
            if y > sh - Inches(0.6):
                break  # overflow: stop placing rather than paint off-canvas
    prs.save(out_path)
    return slide_count


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
        slides = make_pptx_file(blocks, title, master_path, out_path)
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
            ws.append([v if isinstance(v, (int, float)) else ("" if v is None else str(v))
                       for v in row])
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
  <hp:p><hp:run><hp:t>두 번째 문단</hp:t></hp:run></hp:p>
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
    except Exception as e:  # noqa: BLE001
        ck(f"hwpx read crashed: {e}", False)

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
