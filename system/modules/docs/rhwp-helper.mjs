#!/usr/bin/env node
// rhwp read helper — spawned by docs/main.py for .hwp and .hwpx.
//
// Why a node helper: @rhwp/core is Rust-compiled-to-WASM (vendored in ./rhwp, MIT,
// version pinned by the vendored package.json). It parses what zip+xml walking cannot
// reach — legacy .hwp binaries, equations, text boxes, footnotes. The python side owns
// the envelope; this process turns one file into one JSON line on stdout and exits.
//
// stdin : {"op":"read","path":"<absolute file path>"}
// stdout: {"ok":true,"data":{"sections":N,"paragraphs":N,"text":"...","tables":[...],
//          "equations":[...]}}  |  {"ok":false,"error":"..."}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(msg) }) + "\n");
  process.exit(0);
}

async function main() {
  let req;
  try {
    req = JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch (e) {
    return fail(`stdin JSON: ${e}`);
  }
  if (req.op !== "read" || !req.path) return fail("expected {op:'read', path}");

  const mod = await import(pathToFileURL(path.join(HERE, "rhwp", "rhwp.js")).href);
  await mod.default({
    module_or_path: fs.readFileSync(path.join(HERE, "rhwp", "rhwp_bg.wasm")),
  });
  const { HwpDocument } = mod;

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
