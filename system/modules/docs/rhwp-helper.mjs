#!/usr/bin/env node
// rhwp read helper — spawned by docs/main.py for .hwp and .hwpx.
//
// Why a node helper: @rhwp/core is Rust-compiled-to-WASM (vendored in ./rhwp, MIT,
// version pinned by the vendored package.json). It parses what zip+xml walking cannot
// reach — legacy .hwp binaries, equations, text boxes, footnotes. The python side owns
// the envelope; this process turns one file into one JSON line on stdout and exits.
//
// stdin : {"op":"read","path":"<abs>"}
//       | {"op":"make","donor":"<abs .hwp>","out":"<abs>","format":"hwpx"|"hwp",
//          "title":"...","blocks":[{type,props},...]}
// stdout: {"ok":true,"data":{...}} | {"ok":false,"error":"..."} — one JSON line.
//
// MAKE seeds from a REAL Hancom blank (the donor) instead of createEmpty: the blank
// document ships no charPr/paraPr/faceName tables, so exports from it reference styles
// that do not exist — Hancom then draws garbage (2026-08-11 해부로 확정). The donor
// carries 함초롬 tables and both exportHwp and exportHwpx pass. Equation font size is
// HWPUNIT (1pt = 100): 1000, never 10 — 10 renders a microscopic dot.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(msg) }) + "\n");
  process.exit(0);
}

function makeFromBlocks(doc, blocks, title) {
  const stats = { paragraphs: 0, tables: 0 };
  let para = 0;
  let off = 0;
  const write = (text, fmt) => {
    const t = String(text ?? "");
    if (!t) return;
    doc.insertText(0, para, off, t);
    const start = off;
    off += t.length;
    if (fmt) {
      try { doc.applyCharFormat(0, para, start, off, JSON.stringify(fmt)); } catch {}
    }
  };
  const newPara = () => {
    doc.insertParagraph(0, para + 1);
    para += 1;
    off = 0;
    stats.paragraphs += 1;
  };
  const H_SIZE = { 1: 1600, 2: 1300, 3: 1150 };
  if (title) {
    write(title, { bold: true, fontSize: 1800 });
    newPara();
  }
  for (const b of blocks || []) {
    const t = String((b && b.type) || "");
    const p = (b && b.props) || {};
    if (t === "header") {
      const lv = Math.max(1, Math.min(3, Number(p.level) || 2));
      write(p.text, { bold: true, fontSize: H_SIZE[lv] });
      newPara();
    } else if (t === "text") {
      write(p.content);
      newPara();
    } else if (t === "list") {
      for (const it of p.items || []) {
        write(`• ${it}`);
        newPara();
      }
    } else if (t === "metric") {
      const delta = p.delta != null && p.delta !== "" ? ` (${p.delta})` : "";
      write(`${p.label ?? ""}: ${p.value ?? ""}${p.unit || ""}${delta}`);
      newPara();
    } else if (t === "divider") {
      newPara();
    } else if (t === "table") {
      let headers = (p.headers || []).map(String);
      let rows = p.rows || [];
      if (!headers.length && rows.length) {
        headers = rows[0].map(String);
        rows = rows.slice(1);
      }
      if (!headers.length) continue;
      const cc = headers.length;
      const all = [headers, ...rows];
      const ret = JSON.parse(doc.createTable(0, para, off, all.length, cc));
      for (let r = 0; r < all.length; r++) {
        for (let c = 0; c < cc; c++) {
          const v = all[r] && all[r][c] != null ? String(all[r][c]) : "";
          if (!v) continue;
          try {
            doc.insertTextInCell(0, ret.paraIdx, ret.controlIdx, r * cc + c, 0, 0, v);
            if (r === 0) {
              doc.applyCharFormatInCell(0, ret.paraIdx, ret.controlIdx, r * cc + c,
                                        0, 0, v.length, JSON.stringify({ bold: true }));
            }
          } catch {}
        }
      }
      stats.tables += 1;
      // Land the cursor on a fresh paragraph BELOW the table.
      doc.insertParagraph(0, ret.paraIdx + 1);
      para = ret.paraIdx + 1;
      off = 0;
      stats.paragraphs += 1;
    }
  }
  return stats;
}

async function main() {
  let req;
  try {
    req = JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch (e) {
    return fail(`stdin JSON: ${e}`);
  }
  if (!(req.op === "read" && req.path)
      && !(req.op === "make" && req.donor && req.out)) {
    return fail("expected {op:'read', path} or {op:'make', donor, out, blocks}");
  }

  const mod = await import(pathToFileURL(path.join(HERE, "rhwp", "rhwp.js")).href);
  await mod.default({
    module_or_path: fs.readFileSync(path.join(HERE, "rhwp", "rhwp_bg.wasm")),
  });
  const { HwpDocument } = mod;

  if (req.op === "make") {
    try {
      const doc = new HwpDocument(fs.readFileSync(req.donor));
      const stats = makeFromBlocks(doc, req.blocks, String(req.title || ""));
      const bytes = req.format === "hwp" ? doc.exportHwp() : doc.exportHwpx();
      fs.writeFileSync(req.out, bytes);
      process.stdout.write(JSON.stringify(
        { ok: true, data: { ...stats, bytes: bytes.length } }) + "\n");
    } catch (e) {
      fail(`make: ${e}`);
    }
    return;
  }

  let doc;
  try {
    doc = new HwpDocument(fs.readFileSync(req.path));
  } catch (e) {
    return fail(`parse: ${e}`);
  }

  const textParts = [];
  const tables = [];
  const equations = [];
  let paragraphs = 0;
  const sections = doc.getSectionCount();
  for (let s = 0; s < sections; s++) {
    const pc = doc.getParagraphCount(s);
    for (let pi = 0; pi < pc; pi++) {
      paragraphs += 1;
      let line = "";
      try {
        const len = doc.getParagraphLength(s, pi);
        line = len > 0 ? doc.getTextRange(s, pi, 0, len) : "";
      } catch {}
      if (line) textParts.push(line);

      let positions = [];
      try {
        positions = JSON.parse(doc.getControlTextPositions(s, pi)) || [];
      } catch {}
      for (let ci = 0; ci < positions.length; ci++) {
        // Classification is attempt-driven — the API has no control-type getter, but a
        // table answers getTableDimensions and an equation answers getEquationProperties.
        let handled = false;
        try {
          const dim = JSON.parse(doc.getTableDimensions(s, pi, ci));
          const flat = [];
          for (let cell = 0; cell < (dim.cellCount || 0); cell++) {
            const cellText = [];
            let cps = 0;
            try {
              cps = doc.getCellParagraphCount(s, pi, ci, cell);
            } catch {}
            for (let cp = 0; cp < cps; cp++) {
              try {
                const t = doc.getTextInCell(s, pi, ci, cell, cp, 0, 65535);
                if (t) cellText.push(t);
              } catch {}
            }
            flat.push(cellText.join("\n"));
          }
          const cols = Math.max(1, dim.colCount || 1);
          const rows = [];
          for (let r = 0; r < Math.max(1, dim.rowCount || 1); r++) {
            rows.push(flat.slice(r * cols, (r + 1) * cols));
          }
          tables.push({ name: `표 ${tables.length + 1}`, rows });
          textParts.push(`[표 ${dim.rowCount}x${dim.colCount}]`);
          handled = true;
        } catch {}
        if (handled) continue;
        for (const cellArgs of [[-1, -1], [0, 0]]) {
          try {
            const raw = doc.getEquationProperties(s, pi, ci, cellArgs[0], cellArgs[1]);
            const props = JSON.parse(raw);
            const script = props.script || props.eqEdit || props.text || null;
            if (script) {
              equations.push(script);
              textParts.push(`[수식] ${script}`);
            }
            handled = true;
            break;
          } catch {}
        }
        if (handled) continue;
        // Everything else — text boxes, footnotes/endnotes, shapes — falls through to the
        // HTML exporter, the one API that renders ANY control's inner paragraphs.
        try {
          const html = doc.exportControlHtml(s, pi, "[]", ci);
          const inner = String(html)
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim();
          if (inner) textParts.push(inner);
        } catch {}
      }
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      data: {
        sections,
        paragraphs,
        text: textParts.join("\n"),
        tables,
        equations,
      },
    }) + "\n",
  );
}

main().catch((e) => fail(e && e.stack ? e.stack : e));
