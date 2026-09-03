#!/usr/bin/env node
/**
 * Firebat wordpress sysmod — publish to WordPress over the REST API.
 *
 * A post's body is GUTENBERG BLOCKS, not a lump of HTML. WordPress stores block markup as HTML
 * comments around the rendered element, and that is what lets the site's theme style a post AND
 * lets a person open it in the editor afterwards and fix one paragraph. Raw HTML arrives as a
 * single "custom HTML" block: it renders, and it is uneditable. So the render blocks this module
 * is handed are TRANSLATED, one to one, into the WordPress block that means the same thing.
 *
 * Where the vocabulary comes from: `system/components.json` is the original list of render
 * components; this file declares only the MAPPING. A component with neither a mapping nor an
 * explicit "no WordPress equivalent" entry is a hole, and selftest names it rather than letting
 * the translator drop it in silence — which is what the RSS lowering next door does.
 *
 * Credentials are per site, in the module's own settings: WordPress Application Passwords over
 * Basic auth. WordPress refuses to issue those over plain http, so a site url must be https.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const MEDIA_ROOTS = ['user/media/', 'user/attachments/', 'system/media/'];

/* ─────────────────────────── envelope ─────────────────────────── */

function readStdin() {
  return new Promise((resolve, reject) => {
    let d = '';
    process.stdin.on('data', c => { d += c.toString('utf-8'); });
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', reject);
  });
}

function out(ok, payload) {
  process.stdout.write(JSON.stringify(ok ? { success: true, data: payload }
                                         : { success: false, error: payload }) + '\n');
}

/* ─────────────────────────── settings ─────────────────────────── */

/** The registered sites. Settings arrive as MODULE_<KEY>; absent means nothing is configured. */
function loadSites() {
  const raw = process.env.MODULE_SITES;
  if (!raw || !raw.trim()) return [];
  let v;
  try { v = JSON.parse(raw); } catch { return null; }   // null = unreadable, told apart from empty
  return Array.isArray(v) ? v : null;
}

/** Which site this call runs against. One registered site needs no naming; several do. */
function pickSite(sites, wanted) {
  const want = String(wanted || '').trim();
  if (!want) {
    if (sites.length === 1) return sites[0];
    return { error: `여러 사이트가 등록돼 있으니 \`site\` 를 지정해야 합니다: `
      + sites.map(s => s.id).filter(Boolean).join(', ')
      + ` — 각 사이트의 글쓰기 지침은 sites 액션이 돌려줍니다.` };
  }
  const hit = sites.find(s => String(s.id || '').toLowerCase() === want.toLowerCase())
    || sites.find(s => String(s.url || '').toLowerCase().includes(want.toLowerCase()));
  if (!hit) {
    return { error: `\`${want}\` 라는 사이트가 설정에 없습니다. 등록된 것: `
      + (sites.map(s => s.id).filter(Boolean).join(', ') || '없음')
      + ` — sites 액션이 목록과 각 사이트의 지침을 돌려줍니다.` };
  }
  return hit;
}

/** What a site is missing before it can be called at all. */
function siteFault(site) {
  const url = String(site.url || '').trim();
  if (!url) return `사이트 \`${site.id}\` 에 주소가 없습니다 — 설정에서 url 을 채워 주세요.`;
  if (!/^https:\/\//i.test(url)) {
    return `사이트 \`${site.id}\` 의 주소가 https 가 아닙니다 (${url}). 워드프레스는 평문 http `
      + `에서는 애플리케이션 비밀번호를 아예 발급하지 않으므로, 이 경로로는 발행할 수 없습니다.`;
  }
  if (!String(site.user || '').trim() || !String(site.appPassword || '').trim()) {
    return `사이트 \`${site.id}\` 의 계정 또는 애플리케이션 비밀번호가 비어 있습니다 — `
      + `워드프레스 [사용자 → 프로필 → 애플리케이션 비밀번호]에서 발급해 설정에 넣어 주세요.`;
  }
  return null;
}

/* ─────────────────────────── the WordPress REST call ─────────────────────────── */

function apiBase(site) {
  return String(site.url).replace(/\/+$/, '') + '/wp-json/wp/v2';
}

function authHeader(site) {
  // Application Passwords are issued with spaces for readability; WordPress ignores them.
  const pw = String(site.appPassword).replace(/\s+/g, '');
  return 'Basic ' + Buffer.from(`${site.user}:${pw}`, 'utf-8').toString('base64');
}

/** One REST call, with the vendor's own complaint carried through instead of a bare status. */
async function wp(site, path, { method = 'GET', json, body, headers = {} } = {}) {
  const url = apiBase(site) + path;
  const h = { Authorization: authHeader(site), Accept: 'application/json', ...headers };
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body });
  } catch (e) {
    throw new Error(`${site.url} 에 닿지 못했습니다 (${e?.message || e}). 주소가 맞는지, `
      + `사이트가 살아 있는지 확인해 주세요.`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json — kept as text below */ }
  if (!res.ok) {
    const vendor = (parsed && (parsed.message || parsed.code)) || text.slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`워드프레스가 인증을 거부했습니다 (${res.status}: ${vendor}). 계정 이름과 `
        + `애플리케이션 비밀번호를 확인하고, 그 계정이 글을 쓸 수 있는 권한인지 보세요. `
        + `일반 로그인 암호는 REST 에서 통하지 않습니다.`);
    }
    if (res.status === 404 && /rest_no_route/.test(text)) {
      throw new Error(`이 주소에 REST API 가 없습니다 (${url}). 워드프레스가 맞는지, `
        + `퍼머링크가 켜져 있는지, 보안 플러그인이 /wp-json 을 막고 있지 않은지 확인해 주세요.`);
    }
    throw new Error(`워드프레스가 거부했습니다 (${res.status}: ${vendor}) — ${method} ${path}`);
  }
  return parsed;
}

/* ─────────────────────────── render blocks → Gutenberg ─────────────────────────── */

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const wrap = (name, attrs, inner) => {
  const a = attrs && Object.keys(attrs).length ? ' ' + JSON.stringify(attrs) : '';
  return `<!-- wp:${name}${a} -->\n${inner}\n<!-- /wp:${name} -->`;
};

const para = t => wrap('paragraph', null, `<p>${t}</p>`);

/**
 * componentType → the WordPress block that means the same thing.
 * A component that WordPress has no block for is listed in NO_WP_BLOCK with the reason, so the
 * difference between "we forgot" and "there is nothing to map it to" stays visible.
 */
const TO_WP = {
  Header: p => {
    const lvl = Math.min(Math.max(Number(p.level) || 2, 1), 6);
    return wrap('heading', lvl === 2 ? null : { level: lvl },
      `<h${lvl} class="wp-block-heading">${esc(p.text)}</h${lvl}>`);
  },
  Text: p => para(esc(p.content)),
  List: p => {
    const items = Array.isArray(p.items) ? p.items : [];
    const tag = p.ordered ? 'ol' : 'ul';
    const li = items.map(i => wrap('list-item', null, `<li>${esc(i)}</li>`)).join('');
    return wrap('list', p.ordered ? { ordered: true } : null,
      `<${tag} class="wp-block-list">${li}</${tag}>`);
  },
  Table: p => {
    const headers = Array.isArray(p.headers) ? p.headers : [];
    const rows = Array.isArray(p.rows) ? p.rows : [];
    const thead = headers.length
      ? `<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
    const tbody = `<tbody>${rows.map(r =>
      `<tr>${(Array.isArray(r) ? r : [r]).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return wrap('table', null,
      `<figure class="wp-block-table"><table>${thead}${tbody}</table></figure>`);
  },
  Callout: p => {
    const title = p.title ? `<strong>${esc(p.title)}</strong> ` : '';
    return wrap('quote', null,
      `<blockquote class="wp-block-quote">${para(title + esc(p.message))}</blockquote>`);
  },
  Image: p => imageBlock({ src: p.src, alt: p.alt }),
  Divider: () => wrap('separator', null,
    '<hr class="wp-block-separator has-alpha-channel-opacity"/>'),
  Code: p => wrap('code', null,
    `<pre class="wp-block-code"><code>${esc(p.code)}</code></pre>`),
  Metric: p => {
    const unit = p.unit ? ' ' + esc(p.unit) : '';
    const delta = p.delta != null && p.delta !== '' ? ` (${esc(p.delta)})` : '';
    return para(`<strong>${esc(p.label)}</strong>: ${esc(p.value)}${unit}${delta}`);
  },
  KeyValue: p => {
    const items = Array.isArray(p.items) ? p.items : [];
    const rows = items.map(i =>
      `<tr><td>${esc(i?.key)}</td><td>${esc(i?.value)}</td></tr>`).join('');
    return wrap('table', null,
      `<figure class="wp-block-table"><table><tbody>${rows}</tbody></table></figure>`);
  },
  Badge: p => para(`<strong>${esc(p.text)}</strong>`),
  StatusBadge: p => {
    const items = Array.isArray(p.items) ? p.items : [];
    return para(items.map(i =>
      `<strong>${esc(i?.label ?? i?.text ?? i)}</strong>${i?.value != null ? ': ' + esc(i.value) : ''}`
    ).join(' · '));
  },
  Math: p => (p.block
    ? wrap('code', null, `<pre class="wp-block-code"><code>${esc(p.expression)}</code></pre>`)
    : para(`<code>${esc(p.expression)}</code>`)),
  // Containers: WordPress has a group, and the children are blocks in their own right.
  Card: (p, walk) => {
    const head = p.title ? TO_WP.Header({ text: p.title, level: 3 }) : '';
    const lead = p.content || p.text || p.description || p.body;
    const inner = [head, lead ? para(esc(lead)) : '', walk(p.children)].filter(Boolean).join('\n');
    return inner ? wrap('group', null, `<div class="wp-block-group">${inner}</div>`) : '';
  },
  Grid: (p, walk) => {
    const inner = walk(p.children);
    return inner ? wrap('group', null, `<div class="wp-block-group">${inner}</div>`) : '';
  },
};

/** Components WordPress has no block for. The reason is the point — it is why selftest passes. */
const NO_WP_BLOCK = {
  chart: '차트는 워드프레스 블록으로 옮길 수 없다 (스크립트가 실행되지 않는다)',
  stock_chart: '차트는 워드프레스 블록으로 옮길 수 없다',
  live_chart: '실시간 스트림은 발행된 글에서 살 수 없다',
  live_stock_chart: '실시간 스트림은 발행된 글에서 살 수 없다',
  live_feed: '실시간 스트림은 발행된 글에서 살 수 없다',
  function_plot: '수식 그래프는 그려서 이미지로 넣어야 한다',
  diagram: '다이어그램은 그려서 이미지로 넣어야 한다',
  network: '그래프 시각화는 그려서 이미지로 넣어야 한다',
  map: '지도는 임베드가 필요하다 (워드프레스 쪽 플러그인 몫)',
  lottie: '애니메이션은 스크립트가 필요하다',
  slideshow: '워드프레스 갤러리와 의미가 다르다 — 이미지 여러 장으로 넣는다',
  carousel: '워드프레스 갤러리와 의미가 다르다',
  player: '미디어는 워드프레스 미디어 블록의 몫 (v1 미지원)',
  karaoke: '노래방 무대는 발행된 글의 물건이 아니다',
  timeline: '목록으로 쓰는 편이 낫다',
  compare: '표로 쓰는 편이 낫다',
  progress: '값 하나는 문장으로 쓰는 편이 낫다',
  countdown: '시간이 흐르는 표시는 저장된 글에서 뜻이 없다',
  form: '입력 폼은 워드프레스 쪽 플러그인 몫',
  button: '버튼은 링크로 쓴다',
  slider: '조작 컨트롤은 저장된 글에서 뜻이 없다',
  tabs: '탭은 스크립트가 필요하다',
  accordion: '아코디언은 스크립트가 필요하다',
  plan_card: '파이어뱃 내부 카드다',
  quiz: '학습 컴포넌트 — 발행 글의 물건이 아니다',
  quiz_group: '학습 컴포넌트',
  sentence: '학습 컴포넌트',
  vocab: '학습 컴포넌트',
  passage: '학습 컴포넌트',
  concept: '학습 컴포넌트',
  listening: '학습 컴포넌트',
};

/** blocks → { html, unsupported[] }. What could not be translated is named, never dropped. */
/** One spelling for a block name, whichever spelling arrived.

    A component has two published names: components.json declares `componentType: "Header"`
    and `name: "header"`, and `search_components` — which the `blocks` parameter tells the
    caller to use — hands over the lowercase one. The table below is keyed on the Pascal one,
    so a caller that followed that instruction had every block dropped. Measured 2026-09-03:
    a cron turn wrote a six-section article, obeyed the site's writing instruction, and
    published a post with an empty body — reported as `success: true`, with the loss visible
    only in `unsupported: ["header","text"]`.

    Folding case and separators means neither spelling is the right one; both resolve. It is
    a rule rather than a second list, so a component added tomorrow is covered. */
const canon = t => String(t || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const TO_WP_BY_CANON = new Map(Object.entries(TO_WP).map(([k, v]) => [canon(k), v]));
const CANON_TO_TYPE = new Map(Object.keys(TO_WP).map(k => [canon(k), k]));

export function blocksToGutenberg(blocks) {
  const unsupported = [];
  const walk = list => (Array.isArray(list) ? list : []).map(b => {
    if (!b || typeof b !== 'object') return '';
    const t = String(b.type || '');
    const p = b.props || {};
    if (canon(t) === 'html') return wrap('html', null, String(p.content ?? ''));
    const fn = TO_WP_BY_CANON.get(canon(t));
    if (!fn) { unsupported.push(t || '(이름 없는 블록)'); return ''; }
    return fn(p, walk);
  }).filter(Boolean).join('\n\n');
  return { html: walk(blocks), unsupported };
}

function imageBlock({ src, alt, caption, id }) {
  if (!src) return '';
  // `wp-element-caption`, not `wp-block-image__caption`. The old name is pre-6.2 and no longer
  // what the image block's save() produces, so a post carrying it fails the editor's validation
  // the moment someone opens it — and the resolution the editor picks is to convert the block to
  // custom HTML. The post still LOOKS right, which is why this was reported as "the image came in
  // as custom HTML" rather than as an error. Measured on the live site 2026-09-02: 23 captions,
  // all `wp-element-caption`, none of the old name. Re-serialising also stamped defaults onto the
  // other blocks (`hasFixedLayout` on tables) — that stamp is the fingerprint of what happened,
  // and it doubles as the audit: every other block survived as its own type, so only this one
  // was failing validation.
  const cap = caption
    ? `<figcaption class="wp-element-caption">${esc(caption)}</figcaption>` : '';
  const cls = id ? ` class="wp-image-${id}"` : '';
  return wrap('image', id ? { id, sizeSlug: 'large' } : null,
    `<figure class="wp-block-image size-large">`
    + `<img src="${esc(src)}" alt="${esc(alt || '')}"${cls}/>${cap}</figure>`);
}

/* ─────────────────────────── media ─────────────────────────── */

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
};

/** A source the caller gave us → bytes. Workspace media paths and http(s) both. */
async function fetchBytes(src) {
  const s = String(src || '').trim();
  if (!s) throw new Error('이미지 경로가 비어 있습니다.');
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s);
    if (!r.ok) throw new Error(`이미지를 받지 못했습니다 (${r.status}): ${s}`);
    return { buf: Buffer.from(await r.arrayBuffer()), name: basename(new URL(s).pathname) || 'image' };
  }
  const rel = s.replace(/^\/+/, '');
  if (!MEDIA_ROOTS.some(r => rel.startsWith(r))) {
    throw new Error(`\`${s}\` 는 읽을 수 있는 자리가 아닙니다. `
      + `/user/media/... 경로(image_gen 이 돌려주는 주소)나 http(s) 주소를 주세요.`);
  }
  if (!existsSync(rel)) throw new Error(`파일이 없습니다: ${s}`);
  return { buf: readFileSync(rel), name: basename(rel) };
}

/**
 * A picture the site ALREADY has, or null if this is something to upload.
 *
 * Re-uploading a file the library already holds is the quiet wrong answer: it succeeds, the post
 * looks right, and the library grows a duplicate nobody asked for — and the copy is not the one
 * the operator curated, so replacing the original later changes nothing. So an attachment id and
 * a url on the site's own host both resolve to the attachment that is already there.
 */
async function existingMedia(site, src) {
  const s = String(src || '').trim();
  const asId = /^\d+$/.test(s) ? Number(s)
    : /^id:(\d+)$/i.test(s) ? Number(s.match(/^id:(\d+)$/i)[1]) : null;
  if (asId) {
    const m = await wp(site, `/media/${asId}`);
    if (!m?.id) throw new Error(`이 사이트의 미디어 ${asId} 번을 찾지 못했습니다 — media 액션으로 `
      + `목록을 확인해 주세요.`);
    return { id: m.id, url: m.source_url, name: m.slug, reused: true };
  }
  if (!/^https?:\/\//i.test(s)) return null;
  let host, siteHost;
  try { host = new URL(s).host; siteHost = new URL(site.url).host; } catch { return null; }
  if (host !== siteHost) return null;                 // someone else's picture — upload a copy
  // The library's own url: find the attachment instead of making a second one.
  const file = basename(new URL(s).pathname).replace(/\.[a-z0-9]+$/i, '');
  const found = await wp(site, `/media?search=${encodeURIComponent(file)}&per_page=20`);
  const hit = (found || []).find(m => m.source_url === s)
    || (found || []).find(m => String(m.source_url || '').includes(file));
  if (hit) return { id: hit.id, url: hit.source_url, name: hit.slug, reused: true };
  throw new Error(`\`${s}\` 는 이 사이트 주소인데 미디어 라이브러리에서 찾지 못했습니다. `
    + `media 액션으로 검색해 id 를 확인하거나, 다른 자리의 파일이면 그 원본 경로를 주세요.`);
}

/** Upload to the site's media library and return what WordPress now calls it. */
async function uploadMedia(site, src, alt) {
  const already = await existingMedia(site, src);
  if (already) return already;
  const { buf, name } = await fetchBytes(src);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const type = MIME[ext];
  if (!type) {
    throw new Error(`\`${name}\` 은 올릴 수 있는 그림 형식이 아닙니다 `
      + `(${Object.keys(MIME).join(', ')} 중 하나여야 합니다).`);
  }
  const created = await wp(site, '/media', {
    method: 'POST',
    body: buf,
    headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` },
  });
  if (alt && created?.id) {
    try { await wp(site, `/media/${created.id}`, { method: 'POST', json: { alt_text: alt } }); }
    catch (e) { process.stderr.write(`alt_text 설정 실패: ${e.message}\n`); }
  }
  return { id: created?.id, url: created?.source_url, name };
}

/* ─────────────────────────── taxonomy ─────────────────────────── */

/** Names → term ids, creating what the site does not have yet. */
async function termIds(site, kind, names) {
  const list = (Array.isArray(names) ? names : []).map(n => String(n).trim()).filter(Boolean);
  const ids = [];
  for (const name of list) {
    const found = await wp(site, `/${kind}?search=${encodeURIComponent(name)}&per_page=100`);
    const hit = (found || []).find(t => String(t.name).toLowerCase() === name.toLowerCase());
    if (hit) { ids.push(hit.id); continue; }
    const made = await wp(site, `/${kind}`, { method: 'POST', json: { name } });
    if (made?.id) ids.push(made.id);
  }
  return ids;
}


/* ─────────────────────────── status is the operator's, not the caller's ───────────────────────────
   The site row says what a NEW post is. That is the operator's decision, so nothing a caller passes
   at creation time can raise it — `publish` no longer reads a status at all.

   Changing a post that already exists is a different question, and it lives in `update`. There the
   guard is that a run with nobody watching cannot lift a post above what the site declared.
   Measured 2026-09-03: a cron turn wrote status:"publish" into a draft-locked site and the post
   went live. `publish` IS declared approval-gated, so a person would have seen the card — but cron
   bypasses that gate by design, which is exactly the path with nobody there to look. */
const STATUS_RANK = { draft: 0, pending: 1, private: 2, publish: 3 };
const STATUSES = Object.keys(STATUS_RANK);

/** True when this run has no human in front of it (the framework sets this for cron). */
function unattended() {
  return String(process.env.FIREBAT_UNATTENDED || '') === '1';
}

/** The status an update may set, or an error saying why not. */
function allowedStatus(site, want) {
  const s = String(want);
  if (!(s in STATUS_RANK)) {
    return { error: `\`status\` 는 ${STATUSES.join(' / ')} 중 하나입니다 — 받은 값: \`${s}\`` };
  }
  const ceiling = site.status || 'draft';
  if (unattended() && STATUS_RANK[s] > STATUS_RANK[ceiling]) {
    return { error: `예약 실행은 글을 사이트 설정(\`${ceiling}\`)보다 더 공개로 올릴 수 없습니다. `
      + `\`${s}\` 로 바꾸려면 사람이 보는 자리에서 부르거나, 모듈 설정에서 이 사이트의 발행 `
      + `상태를 바꾸세요. 사람이 부르면 승인 카드가 뜨지만 예약 실행은 그 카드를 건너뜁니다.` };
  }
  return { status: s };
}

/** blocks|html (+ inline images) → Gutenberg body. Shared so publish and update cannot drift. */
async function composeBody(site, d) {
  let body = '';
  let unsupported = [];
  if (Array.isArray(d.blocks) && d.blocks.length) {
    const t = blocksToGutenberg(d.blocks);
    body = t.html;
    unsupported = [...new Set(t.unsupported)];
  } else if (typeof d.html === 'string' && d.html.trim()) {
    body = wrap('html', null, d.html);
  } else {
    return { none: true };
  }
  // Every block dropped means an empty post, and an empty post that reports success is worse
  // than a refusal: the caller has already spent the composing, the id is issued, and the loss
  // shows up only to whoever reads `unsupported`. Measured 2026-09-03 — a full article landed
  // as a blank draft this way. A refusal costs one round and says which names to use.
  if (!body.trim()) {
    return {
      error: `본문이 비었습니다 — 준 블록 ${unsupported.length}개가 모두 워드프레스로 옮겨지지 `
        + `않았습니다 (${[...new Set(unsupported)].join(', ')}). \`type\` 은 컴포넌트 이름이고 `
        + `대소문자·밑줄은 가리지 않습니다(\`header\` = \`Header\`). 옮길 수 있는 것 = `
        + `${Object.keys(TO_WP).join(', ')}, Html. 대응 블록이 없는 컴포넌트는 \`html\` 로 `
        + `직접 넘기세요.`,
    };
  }

  // Images go into the site's own library first: a post that points at our media store would
  // break the moment that file moves, and WordPress cannot make it a thumbnail from outside.
  const uploaded = [];
  for (const im of (Array.isArray(d.images) ? d.images : [])) {
    const got = await uploadMedia(site, im?.src, im?.alt);
    uploaded.push({ ...got, alt: im?.alt, caption: im?.caption, after: im?.after });
  }
  if (uploaded.length) {
    const parts = body ? body.split('\n\n') : [];
    const tail = [];
    for (const u of uploaded) {
      const blk = imageBlock({ src: u.url, alt: u.alt, caption: u.caption, id: u.id });
      const at = Number.isInteger(u.after) ? Math.max(0, Math.min(u.after, parts.length)) : null;
      if (at === null) tail.push(blk); else parts.splice(at, 0, blk);
    }
    body = [...parts, ...tail].join('\n\n');
  }
  return { body, unsupported, uploaded };
}

const NO_BODY = '본문이 없습니다 — `blocks`(권장) 또는 `html` 중 하나를 주세요. blocks 는 워드프레스 '
  + '편집기에서 문단 단위로 고칠 수 있는 글이 되고, html 은 통째로 커스텀 HTML 블록 하나가 됩니다.';

/* ─────────────────────────── actions ─────────────────────────── */

async function actionPublish(site, d) {
  const title = String(d.title || '').trim();
  if (!title) return out(false, '제목(`title`)이 필요합니다.');

  const made = await composeBody(site, d);
  if (made.none) return out(false, NO_BODY);
  if (made.error) return out(false, made.error);
  const { body, unsupported, uploaded } = made;

  let featured = null;
  if (d.thumbnail) featured = await uploadMedia(site, d.thumbnail, title);

  const cats = [...(d.categories || []), ...(site.category ? [site.category] : [])];
  // The status of a new post is the site row's, full stop — see the note above STATUS_RANK.
  // A site row that never said anything files a draft: nobody declared "publish this live", and
  // absence is not consent on the one field that decides who can read it.
  const status = site.status || 'draft';
  const post = { title, content: body, status };
  if (d.excerpt) post.excerpt = String(d.excerpt);
  if (featured?.id) post.featured_media = featured.id;
  const catIds = await termIds(site, 'categories', cats);
  if (catIds.length) post.categories = catIds;
  const tagIds = await termIds(site, 'tags', d.tags);
  if (tagIds.length) post.tags = tagIds;

  const created = await wp(site, '/posts', { method: 'POST', json: post });

  return out(true, {
    // Which site, and which instruction the writing was supposed to follow — read back off the
    // settings the call actually resolved to, so a post written for the wrong blog says so here.
    identity: `${site.id} = ${site.url}`,
    promptUsed: site.prompt ? String(site.prompt).slice(0, 200) : null,
    url: created?.link,
    id: created?.id,
    status: created?.status,
    statusFrom: site.status ? `사이트 설정 (${site.status})`
      : '사이트에 발행 상태가 없어 초안으로 넣었습니다 — 모듈 설정에서 정하세요',
    changeStatus: '이 글의 상태를 바꾸려면 `update {id, status}` 를 쓰세요. `publish` 는 새 글만 만들고, 상태는 사이트 설정이 정합니다.',
    thumbnail: featured ? featured.url : null,
    images: uploaded.map(u => u.url),
    categories: cats,
    tags: d.tags || [],
    ...(unsupported.length ? {
      unsupported,
      unsupportedNote: unsupported.map(t =>
        `${t}: ${NO_WP_BLOCK[wpName(t)] || '워드프레스에 대응 블록이 없어 본문에서 빠졌습니다'}`),
    } : {}),
  });
}

async function actionUpdate(site, d) {
  const id = String(d.id ?? '').trim();
  if (!id) {
    return out(false, '고칠 글의 `id` 가 필요합니다 — `posts` 로 목록을 받아 그 id 를 쓰세요.');
  }
  const patch = {};
  if (typeof d.title === 'string' && d.title.trim()) patch.title = d.title.trim();
  if (typeof d.excerpt === 'string') patch.excerpt = String(d.excerpt);

  const made = await composeBody(site, d);
  if (made.error) return out(false, made.error);
  let uploaded = [];
  let unsupported = [];
  if (!made.none) {
    patch.content = made.body;
    uploaded = made.uploaded;
    unsupported = made.unsupported;
  }
  if (d.thumbnail) {
    const featured = await uploadMedia(site, d.thumbnail, patch.title || id);
    if (featured?.id) patch.featured_media = featured.id;
  }
  if (Array.isArray(d.categories) && d.categories.length) {
    const ids = await termIds(site, 'categories', d.categories);
    if (ids.length) patch.categories = ids;
  }
  if (Array.isArray(d.tags) && d.tags.length) {
    const ids = await termIds(site, 'tags', d.tags);
    if (ids.length) patch.tags = ids;
  }
  if (d.status) {
    const ok = allowedStatus(site, d.status);
    if (ok.error) return out(false, ok.error);
    patch.status = ok.status;
  }
  if (!Object.keys(patch).length) {
    return out(false, '바꿀 것이 없습니다 — status / title / blocks / html / excerpt / thumbnail / '
      + 'categories / tags 중 최소 하나를 주세요.');
  }

  // Read first, so the answer can say what actually moved. An update that reports only the new
  // value cannot be told apart from one that changed nothing.
  const before = await wp(site, `/posts/${encodeURIComponent(id)}?context=edit`);
  const after = await wp(site, `/posts/${encodeURIComponent(id)}`, { method: 'POST', json: patch });
  return out(true, {
    identity: `${site.id} = ${site.url}`,
    id: after?.id,
    url: after?.link,
    status: after?.status,
    statusWas: before?.status,
    changed: Object.keys(patch),
    title: after?.title?.raw ?? after?.title?.rendered,
    images: uploaded.map(u => u.url),
    ...(unsupported.length ? {
      unsupported,
      unsupportedNote: unsupported.map(t =>
        `${t}: ${NO_WP_BLOCK[wpName(t)] || '워드프레스에 대응 블록이 없어 본문에서 빠졌습니다'}`),
    } : {}),
  });
}

async function actionTrash(site, d) {
  const id = String(d.id ?? '').trim();
  if (!id) {
    return out(false, '지울 글의 `id` 가 필요합니다 — `posts` 로 목록을 받아 그 id 를 쓰세요.');
  }
  // Trash by default: WordPress keeps it and a person can put it back. `force` skips the bin and
  // the post is gone for good, which is why it is opt-in rather than the default.
  const force = d.force === true;
  const before = await wp(site, `/posts/${encodeURIComponent(id)}?context=edit`);
  const gone = await wp(site, `/posts/${encodeURIComponent(id)}${force ? '?force=true' : ''}`,
    { method: 'DELETE' });
  return out(true, {
    identity: `${site.id} = ${site.url}`,
    id: before?.id,
    title: before?.title?.raw ?? before?.title?.rendered,
    was: before?.status,
    now: force ? 'deleted' : (gone?.status || 'trash'),
    permanent: force,
    note: force
      ? '완전히 지웠습니다 — 되돌릴 수 없습니다.'
      : '휴지통으로 보냈습니다. 워드프레스 [글 → 휴지통]에서 복구할 수 있습니다.',
  });
}

/** componentType (Pascal) → the components.json name (snake), for the reason table. */
function wpName(componentType) {
  // The reason table is keyed on components.json's `name`, and the caller may have used
  // either spelling — resolve back to the declared componentType first so it is found.
  const declared = CANON_TO_TYPE.get(canon(componentType)) || String(componentType);
  return declared.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

async function actionPosts(site, d) {
  // One post by id comes back with the block markup AS STORED. Without this the module can write
  // a post and never read one, so "the editor shows a block error" has no ground truth on this
  // side and the only way to look is to guess at what was probably serialized.
  if (d.id != null && String(d.id).trim() !== '') {
    const p = await wp(site, `/posts/${encodeURIComponent(String(d.id).trim())}?context=edit`);
    return out(true, {
      identity: `${site.id} = ${site.url}`,
      id: p?.id,
      title: p?.title?.raw ?? p?.title?.rendered,
      url: p?.link,
      status: p?.status,
      featured_media: p?.featured_media || null,
      content: p?.content?.raw ?? p?.content?.rendered ?? '',
    });
  }
  const n = Math.min(Math.max(Number(d.limit) || 10, 1), 50);
  const list = await wp(site, `/posts?per_page=${n}&status=any&orderby=date&order=desc`);
  return out(true, {
    identity: `${site.id} = ${site.url}`,
    items: (list || []).map(p => ({
      id: p.id, title: p.title?.rendered, url: p.link, status: p.status, date: p.date,
    })),
  });
}

async function actionMedia(site, d) {
  const n = Math.min(Math.max(Number(d.limit) || 20, 1), 50);
  const q = String(d.query || '').trim();
  const list = await wp(site, `/media?per_page=${n}&orderby=date&order=desc&media_type=image`
    + (q ? `&search=${encodeURIComponent(q)}` : ''));
  return out(true, {
    identity: `${site.id} = ${site.url}`,
    items: (list || []).map(m => ({
      id: m.id,
      url: m.source_url,
      title: m.title?.rendered,
      alt: m.alt_text || null,
      date: m.date,
    })),
    note: '여기 있는 그림을 쓰려면 publish 의 `thumbnail` 이나 `images[].src` 에 그 `id` 를 '
      + '그대로 넣으세요. 사본이 생기지 않고 이 그림이 그대로 쓰입니다.',
  });
}

async function actionCategories(site) {
  const list = await wp(site, '/categories?per_page=100&orderby=count&order=desc');
  return out(true, {
    identity: `${site.id} = ${site.url}`,
    items: (list || []).map(c => ({ id: c.id, name: c.name, count: c.count })),
  });
}

/* ─────────────────────────── selftest ─────────────────────────── */

async function selftest() {
  const checks = [];
  const ck = (name, want, got, ok) => checks.push({ name, want, got: String(got), ok: !!ok });

  // Every component either translates or is on the record as having no WordPress block. The list
  // of components is NOT kept here — it is read from the file that owns it.
  let coverage = '';
  let covered = false;
  try {
    const comps = JSON.parse(readFileSync('system/components.json', 'utf-8'));
    const real = new Set(comps.map(c => c.name));
    const mapped = comps.filter(c => TO_WP[c.componentType] || c.componentType === 'Html');
    const named = comps.filter(c => !TO_WP[c.componentType] && c.componentType !== 'Html'
      && NO_WP_BLOCK[c.name]);
    // Forward: a component that is neither translated nor on the record is a hole.
    const holes = comps
      .filter(c => !TO_WP[c.componentType] && !NO_WP_BLOCK[c.name] && c.componentType !== 'Html')
      .map(c => c.name);
    // Backward: an entry naming no component is dead weight, and it is what makes the tally lie —
    // without this the two sides can add up past the catalog and still report zero holes.
    const dead = Object.keys(NO_WP_BLOCK).filter(n => !real.has(n));
    const double = mapped.filter(c => NO_WP_BLOCK[c.name]).map(c => c.name);
    coverage = `${comps.length}종 = 매핑 ${mapped.length} + 대응없음 ${named.length} + 구멍 `
      + `${holes.length}${holes.length ? ` (${holes.join(', ')})` : ''}`
      + (dead.length ? ` · 죽은 항목 ${dead.join(', ')}` : '')
      + (double.length ? ` · 양쪽에 있음 ${double.join(', ')}` : '');
    covered = holes.length === 0 && dead.length === 0 && double.length === 0
      && mapped.length + named.length === comps.length;
  } catch (e) {
    coverage = `components.json 을 읽지 못했습니다: ${e.message}`;
  }
  ck('컴포넌트 전수가 매핑이거나 대응없음이고, 그 합이 카탈로그와 같다',
    '구멍 0 · 죽은 항목 0 · 합 = 46', coverage, covered);

  // A block becomes WordPress block markup, not bare HTML — that is what keeps a post editable.
  const t = blocksToGutenberg([
    { type: 'Header', props: { text: '제목', level: 2 } },
    { type: 'Text', props: { content: '본문 <b>이스케이프</b>' } },
    { type: 'List', props: { items: ['a', 'b'] } },
    { type: 'Table', props: { headers: ['h'], rows: [['v']] } },
  ]);
  const wanted = ['wp:heading', 'wp:paragraph', 'wp:list', 'wp:list-item', 'wp:table'];
  const missing = wanted.filter(w => !t.html.includes(`<!-- ${w}`));
  ck('렌더 블록이 구텐베르크 블록 주석으로 나온다', '다섯 종 전부',
    missing.length ? `빠짐: ${missing.join(', ')}` : '전부 있음', missing.length === 0);
  ck('본문 텍스트는 이스케이프된다', '&lt;b&gt;',
    t.html.includes('&lt;b&gt;') ? '&lt;b&gt;' : t.html.slice(0, 60),
    t.html.includes('&lt;b&gt;'));

  // The other direction: an unmapped block must be REPORTED, never silently dropped. That is the
  // one thing the RSS lowering next door does not do.
  const u = blocksToGutenberg([
    { type: 'Text', props: { content: 'ok' } },
    { type: 'StockChart', props: {} },
  ]);
  ck('옮길 수 없는 블록은 이름이 보고된다', 'StockChart',
    u.unsupported.join(',') || '(없음)',
    u.unsupported.includes('StockChart') && u.html.includes('<!-- wp:paragraph'));

  // The block markup has to match what the CURRENT block's save() produces, or the editor calls
  // the post invalid and quietly converts the block to custom HTML — the page still renders, so
  // nothing complains except a person opening the editor. The caption class is the one name in
  // this file that WordPress has renamed (`wp-block-image__caption` -> `wp-element-caption`, 6.2),
  // so it is the one worth pinning.
  const img = imageBlock({ src: 'https://x/y.png', alt: 'a', caption: '캡션', id: 7 });
  ck('이미지 블록이 지금 워드프레스의 캡션 클래스를 쓴다',
    'wp-element-caption, 옛 이름 없음',
    (img.match(/figcaption class="[^"]*"/) || ['(캡션 없음)'])[0],
    img.includes('class="wp-element-caption"') && !img.includes('wp-block-image__caption'));
  ck('이미지는 wp:image 로 나간다 (wp:html 이 아니라)', '<!-- wp:image',
    img.slice(0, img.indexOf('\n')),
    img.startsWith('<!-- wp:image ') && !img.includes('wp:html'));

  // https is not a preference: WordPress will not issue an application password without it.
  const bad = siteFault({ id: 'x', url: 'http://a.com', user: 'u', appPassword: 'p' });
  const good = siteFault({ id: 'x', url: 'https://a.com', user: 'u', appPassword: 'p' });
  ck('http 사이트는 발행 전에 거부된다', 'http 거부 / https 통과',
    `http=${bad ? '거부' : '통과'} https=${good ? '거부' : '통과'}`, !!bad && !good);

  // One site needs no naming; several do, and the refusal lists them.
  const one = pickSite([{ id: 'a', url: 'https://a.com' }], '');
  const many = pickSite([{ id: 'a' }, { id: 'b' }], '');
  const wrong = pickSite([{ id: 'a' }, { id: 'b' }], 'zzz');
  ck('사이트가 하나면 생략되고, 여럿이면 목록과 함께 거부된다',
    '하나=선택 / 여럿=거부 / 오타=거부',
    `하나=${one.error ? '거부' : one.id} 여럿=${many.error ? '거부' : '통과'} `
    + `오타=${wrong.error ? '거부' : '통과'}`,
    !one.error && one.id === 'a' && !!many.error && many.error.includes('a, b') && !!wrong.error);

  // Both spellings of a block name resolve. The lowercase one is what search_components
  // hands over and what the `blocks` parameter tells the caller to use, so it was the one
  // that had to work — and it was the one that silently dropped every block.
  const lower = blocksToGutenberg([
    { type: 'header', props: { text: '제목', level: 2 } },
    { type: 'text', props: { content: '본문' } },
  ]);
  const pascal = blocksToGutenberg([
    { type: 'Header', props: { text: '제목', level: 2 } },
    { type: 'Text', props: { content: '본문' } },
  ]);
  ck('소문자 이름(search_components 가 주는 것)도 파스칼과 같게 옮겨진다',
    '두 철자 동일 · unsupported 0',
    `lower=${lower.unsupported.length} pascal=${pascal.unsupported.length} `
    + `같은결과=${lower.html === pascal.html}`,
    lower.unsupported.length === 0 && pascal.unsupported.length === 0
      && lower.html === pascal.html && lower.html.includes('wp:heading'));
  const snake = blocksToGutenberg([{ type: 'stock_chart', props: {} }]);
  const camel = blocksToGutenberg([{ type: 'StockChart', props: {} }]);
  ck('옮길 수 없는 것은 두 철자 모두에서 이름이 보고된다', '양쪽 다 1건',
    `snake=${snake.unsupported.join(',')} camel=${camel.unsupported.join(',')}`,
    snake.unsupported.length === 1 && camel.unsupported.length === 1);

  // A post whose blocks all fell through is empty. Refusing costs a round; succeeding costs
  // an article and a person noticing later.
  // composeBody is async (it uploads images), so this check has to be awaited — a `.then`
  // here would resolve after the checks array is already serialised, and a canary that
  // reports nothing is indistinguishable from one that passes.
  const allDropped = await composeBody(
    { id: 'x', url: 'https://a.com', user: 'u', appPassword: 'p' },
    { blocks: [{ type: 'StockChart', props: {} }] });
  const kept = await composeBody(
    { id: 'x', url: 'https://a.com', user: 'u', appPassword: 'p' },
    { blocks: [{ type: 'text', props: { content: 'ok' } }] });
  ck('블록이 전부 안 옮겨지면 빈 글을 올리지 않고 거부한다 (하나라도 남으면 통과)',
    '전부드롭=거부(이름 댐) / 하나남음=통과',
    `전부드롭=${allDropped.error ? '거부' : '통과'} 하나남음=${kept.error ? '거부' : '통과'}`,
    !!allDropped.error && allDropped.error.includes('StockChart') && !kept.error);

  // The status ladder, both ways. A guard canaried only on the blocked case looks just as green
  // as one that blocks everything — and blocking everything would mean a person can never publish
  // a draft, which is the whole point of the action.
  const site = { id: 'x', url: 'https://a.com', user: 'u', appPassword: 'p', status: 'draft' };
  const was = process.env.FIREBAT_UNATTENDED;
  process.env.FIREBAT_UNATTENDED = '1';
  const cronUp = allowedStatus(site, 'publish');
  const cronDown = allowedStatus(site, 'draft');
  process.env.FIREBAT_UNATTENDED = '0';
  const humanUp = allowedStatus(site, 'publish');
  const open = allowedStatus({ ...site, status: 'publish' }, 'publish');
  const bogus = allowedStatus(site, 'live');
  if (was === undefined) delete process.env.FIREBAT_UNATTENDED;
  else process.env.FIREBAT_UNATTENDED = was;
  ck('초안 잠금 사이트: 예약 실행은 못 올리고, 사람은 올린다',
    '크론↑거부 / 크론↓통과 / 사람↑통과',
    `크론↑=${cronUp.error ? '거부' : '통과'} 크론↓=${cronDown.error ? '거부' : '통과'} `
    + `사람↑=${humanUp.error ? '거부' : '통과'}`,
    !!cronUp.error && !cronDown.error && !humanUp.error);
  ck('사이트가 이미 공개면 예약 실행도 공개로 둘 수 있다', '통과',
    open.error ? '거부' : '통과', !open.error);
  ck('없는 상태 이름은 거부된다', 'live 거부',
    bogus.error ? '거부' : '통과', !!bogus.error);

  // `publish` must not read a status at all any more: the argument's only possible effect was to
  // raise the operator's default at creation time, and cron proved it does exactly that.
  const pubSrc = actionPublish.toString();
  ck('publish 는 호출 인자의 status 를 읽지 않는다', 'd.status 없음',
    /d\.status/.test(pubSrc) ? 'd.status 를 읽고 있음' : '안 읽음', !/d\.status/.test(pubSrc));
  ck('상태를 안 적은 사이트는 초안으로 들어간다 (공개 아님)', "site.status || 'draft'",
    /site\.status \|\| 'draft'/.test(pubSrc) ? "|| 'draft'" : '(못 찾음)',
    /site\.status \|\| 'draft'/.test(pubSrc));

  // A post that can be made but never changed or removed is what sent a measurement post live
  // with no way back. The lifecycle is the capability, not the create call.
  const upd = actionUpdate.toString();
  const trs = actionTrash.toString();
  ck('글은 만들기만 하는 게 아니라 고치고 지울 수 있다',
    'update=POST /posts/<id> · trash=DELETE',
    `update=${/method: 'POST'/.test(upd) ? 'POST' : '?'} trash=`
    + `${/method: 'DELETE'/.test(trs) ? 'DELETE' : '?'}`,
    /posts\/\$\{encodeURIComponent\(id\)\}/.test(upd) && /method: 'POST'/.test(upd)
      && /method: 'DELETE'/.test(trs));
  ck('지우기는 기본이 휴지통이고 완전 삭제는 명시해야 한다', "force === true 일 때만 force=true",
    /d\.force === true/.test(trs) && /\?force=true/.test(trs) ? '휴지통 기본' : '(못 찾음)',
    /d\.force === true/.test(trs) && /\?force=true/.test(trs));

  const passed = checks.filter(c => c.ok).length;
  return out(true, { passed, total: checks.length, checks });
}

/* ─────────────────────────── main ─────────────────────────── */

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); }
  catch { return out(false, 'stdin 을 JSON 으로 읽지 못했습니다.'); }
  const d = input.data ?? {};
  const action = String(d.action || '');

  if (action === 'selftest') return await selftest();

  const sites = loadSites();
  if (sites === null) {
    return out(false, '설정의 사이트 목록이 JSON 배열이 아닙니다 — 모듈 설정 화면에서 '
      + '사이트 행을 다시 저장해 주세요.');
  }
  if (!sites.length) {
    return out(false, '등록된 워드프레스 사이트가 없습니다. 모듈 설정 [사이트] 탭에서 주소·계정·'
      + '애플리케이션 비밀번호·글쓰기 지침을 넣어 주세요. 비밀번호는 워드프레스 '
      + '[사용자 → 프로필 → 애플리케이션 비밀번호]에서 발급합니다.');
  }

  if (action === 'sites') {
    return out(true, {
      // The prompt IS the payload: the caller reads it and writes to it. Credentials are not
      // part of that and never leave the settings.
      items: sites.map(s => ({
        id: s.id,
        url: s.url,
        prompt: s.prompt || null,
        status: s.status || 'publish',
        category: s.category || null,
        ready: !siteFault(s),
        fault: siteFault(s) || undefined,
      })),
      note: '글은 그 사이트의 `prompt` 를 지침으로 삼아 씁니다. 지침이 비어 있는 사이트는 '
        + '설정에서 채우기 전까지 일반적인 글이 나갑니다.',
    });
  }

  const site = pickSite(sites, d.site);
  if (site.error) return out(false, site.error);
  const fault = siteFault(site);
  if (fault) return out(false, fault);

  try {
    if (action === 'publish') return await actionPublish(site, d);
    if (action === 'update') return await actionUpdate(site, d);
    if (action === 'trash') return await actionTrash(site, d);
    if (action === 'posts') return await actionPosts(site, d);
    if (action === 'media') return await actionMedia(site, d);
    if (action === 'categories') return await actionCategories(site);
    return out(false, `알 수 없는 액션 \`${action}\` — sites / publish / update / trash / posts / media / categories`);
  } catch (e) {
    return out(false, e?.message || String(e));
  }
}

main();
