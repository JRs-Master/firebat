/**
 * Firebat system module: kasb — accounting standards as the Korea Accounting Standards Board
 * publishes them at db.kasb.or.kr (K-IFRS and the general standards for non-listed companies).
 *
 * The site is a single-page app with no published API. These are the JSON endpoints its own
 * screens call; all of them answer without an account. Each action makes exactly ONE request:
 * the site checks callers' IPs (/api/standard/check-ip) and the text is the board's, so this
 * module reads what a question needs and never walks a whole standard.
 *
 *   search     /api/standard?searchWord=            hit count per standard
 *   paragraphs /api/search/total/paragraphs         hits inside one standard
 *   toc        /api/standard-indexes/<std>          the standard's tree (name, parts, chapters)
 *   section    /api/paragraphs/<std>/<doc>          every paragraph of one tree node
 *   paragraph  /api/paragraphs/content/<std>/<para> one paragraph in full
 */

const BASE = 'https://db.kasb.or.kr';
const TIMEOUT = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SNIPPET = 400;

function readStdin() {
  return new Promise((resolve, reject) => {
    let d = '';
    process.stdin.on('data', (c) => { d += c.toString('utf-8'); });
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', reject);
  });
}

function out(ok, payload) {
  process.stdout.write(JSON.stringify(ok ? { success: true, data: payload }
                                         : { success: false, error: payload }) + '\n');
}

class Refusal extends Error {}

/** One GET against the site, JSON back. Failures say what failed and what to try. */
async function get(path, query) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    const why = e.name === 'AbortError' ? `no answer in ${TIMEOUT / 1000}s` : `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`;
    throw new Refusal(`db.kasb.or.kr unreachable: ${why}. The request was not answered; trying again later is safe.`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (res.status === 429 || res.status === 403) {
    throw new Refusal(`db.kasb.or.kr refused the request (HTTP ${res.status}) — the site limits callers by IP. Wait before the next call; do not retry in a loop.`);
  }
  if (!res.ok) throw new Refusal(`db.kasb.or.kr answered HTTP ${res.status} for ${url.pathname}: ${body.slice(0, 200)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Refusal(`db.kasb.or.kr answered ${url.pathname} with something that is not JSON — the site may have changed its screens' endpoints. First bytes: ${body.slice(0, 120)}`);
  }
}

const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", middot: '·' };

/** A paragraph's HTML as plain lines: list markers stay on their item's line, table cells split by " | ". */
function text(html) {
  if (!html) return '';
  return String(html)
    // <div …>(1)</div><div …>item</div> → "(1) item" — a cell holding only a list marker
    // ((1) · (가) · ① · 가. · (i)) belongs on its item's line
    .replace(/<div[^>]*>\s*(\(?[0-9A-Za-z가-힣ⅰ-ⅻ①-⑳]{1,4}[).]?)\s*<\/div>\s*<div[^>]*>\s*/g, '<div>$1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

/** Paragraph numbers a paragraph points at (the site marks them as mundan-finder spans). */
function refs(html) {
  const seen = new Set();
  for (const m of String(html || '').matchAll(/data-id="([^"]+)"/g)) seen.add(m[1]);
  return [...seen];
}

const clip = (s) => (s.length > SNIPPET ? `${s.slice(0, SNIPPET)}…` : s);

function needStd(d) {
  const std = Number(d.std);
  if (!Number.isInteger(std) || std <= 0) {
    throw new Refusal('`std` is the standard number as an integer, e.g. 1109 for 기업회계기준서 제1109호. `search` returns the numbers that exist.');
  }
  return std;
}

function needText(d, key, example) {
  const v = typeof d[key] === 'string' ? d[key].trim() : '';
  if (!v) throw new Refusal(`\`${key}\` is required, e.g. ${example}.`);
  return v;
}

async function search(d) {
  const query = needText(d, 'query', '상각후원가');
  const r = await get('/api/standard', { searchWord: query });
  const counts = r?.standards?.stdCountObj || {};
  const standards = Object.entries(counts)
    .map(([std, count]) => ({ std: Number(std), count: Number(count) }))
    .sort((a, b) => b.count - a.count || a.std - b.std);
  const data = { query, total: Number(r?.standards?.totalCount ?? 0), standards };
  if (!standards.length) {
    data.empty = 'No paragraph of any standard contains this text. The search matches the standards\' own wording — try the term the standards use, or a shorter word.';
  }
  return data;
}

async function paragraphs(d) {
  const query = needText(d, 'query', '상각후원가');
  const std = needStd(d);
  const part = typeof d.part === 'string' ? d.part.trim() : '';
  const r = await get('/api/search/total/paragraphs', { searchWord: query, stdNum: std });
  let rows = (r?.paragraphs || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const parts = [...new Set(rows.map((p) => p.breadcrumb?.[0]?.title).filter(Boolean))];
  if (part) rows = rows.filter((p) => (p.breadcrumb?.[0]?.title || '').includes(part));
  const data = {
    std,
    query,
    total: rows.length,
    standardType: rows[0]?.standardType ?? r?.paragraphs?.[0]?.standardType ?? null,
    parts,
    paragraphs: rows.map((p) => ({
      para: p.paraNum,
      part: p.breadcrumb?.[0]?.title ?? '',
      path: (p.breadcrumb || []).slice(1).map((b) => b.title).join(' › '),
      text: clip(text(p.fullContent_snippet || (p.fullContent || []).join(' … '))),
    })),
  };
  if (!data.total) {
    data.empty = part && parts.length
      ? `No hit in a part named like 「${part}」. Parts with hits: ${parts.join(' · ')}.`
      : `No paragraph of ${std} contains this text. \`search\` shows which standards do.`;
  }
  return data;
}

async function toc(d) {
  const std = needStd(d);
  const part = typeof d.part === 'string' ? d.part.trim() : '';
  const r = await get(`/api/standard-indexes/${std}`);
  const all = (r?.standardIndexes || []).filter((x) => !x.delYn);
  const roots = all.filter((x) => x.level === 0);
  if (!roots.length) throw new Refusal(`No standard numbered ${std}. \`search\` returns the numbers in use.`);
  const root = (part ? roots.find((x) => (x.title || '').includes(part)) : roots[0]);
  if (!root) throw new Refusal(`${std} has no part named like 「${part}」. Its parts: ${roots.map((x) => x.title).join(' · ')}.`);
  const under = (x, id) => (x.parentDocumentIds || []).includes(id);
  const name = (all.find((x) => x.level === 1 && under(x, roots[0].documentId)) || {}).title || '';
  const entries = all
    .filter((x) => under(x, root.documentId) && x.level >= 1 && x.level <= 3 && !x.isHidden)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((x) => ({ level: x.level, title: x.title, ref: x.ref || '', doc: x.documentId }));
  return { identity: `${std} = ${name}`, std, name, part: root.title, parts: roots.map((x) => x.title), toc: entries };
}

async function section(d) {
  const std = needStd(d);
  const doc = needText(d, 'doc', 'a `doc` from toc');
  const r = await get(`/api/paragraphs/${std}/${encodeURIComponent(doc)}`);
  const clauses = r?.clauses || [];
  if (!clauses.length) {
    throw new Refusal(`${std} holds no paragraphs under doc ${doc}. Use a \`doc\` from \`toc\` of the same std; a chapter-level entry may hold only its sections — open a section entry instead.`);
  }
  return {
    identity: `${std} ${r.mainTitle || doc}`,
    std,
    title: r.mainTitle || '',
    paragraphs: clauses.map((c) => (c.paraNum
      ? { para: c.paraNum, text: text(c.paraContent || c.fullContent) }
      : { title: text(c.paraContent || c.fullContent || c.title) })),
  };
}

async function paragraph(d) {
  const std = needStd(d);
  const para = needText(d, 'para', '4.1.2');
  const r = await get(`/api/paragraphs/content/${std}/${encodeURIComponent(para)}`);
  const p = (r?.paraContents || [])[0];
  if (!p) {
    throw new Refusal(`No paragraph ${para} in ${std}. Numbers are exactly as \`paragraphs\` or \`section\` return them (4.1.2 · B4.1.1 · BC4.150).`);
  }
  return {
    identity: `${std} 문단 ${p.paraNum}`,
    std,
    para: p.paraNum,
    text: text(p.paraContent || p.fullContent),
    refs: refs(p.paraContent),
    qna: String(p.faqDocNumbers || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const ACTIONS = { search, paragraphs, toc, section, paragraph };

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { return out(false, 'stdin is not JSON.'); }
  const d = input.data ?? {};
  const run = ACTIONS[String(d.action || '')];
  if (!run) return out(false, `Unknown action 「${d.action}」. Actions: ${Object.keys(ACTIONS).join(' · ')}.`);
  try {
    out(true, await run(d));
  } catch (e) {
    if (e instanceof Refusal) return out(false, e.message);
    console.error(e);
    out(false, `kasb ${d.action} failed: ${e.message}`);
  }
}

main();
