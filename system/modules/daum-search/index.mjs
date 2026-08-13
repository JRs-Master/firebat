/**
 * Firebat System Module: daum-search (web-search)
 * Daum search — web documents, video, images, blog, book, cafe.
 *
 * Named for the service, not its owner: the endpoints are Kakao's today
 * (`dapi.kakao.com`, `KakaoAK` auth) but the service itself is changing hands, and Naver just
 * demonstrated what that does to a host and a credential.
 *
 * Docs: https://developers.kakao.com/docs/latest/ko/daum-search/dev-guide
 * Auth: Authorization: KakaoAK {REST_API_KEY} — the same key kakao-map and kakao-talk already use.
 *
 * Item fields are named the way naver-search names them (title / link / description / datetime),
 * so a caller can swap vendors without rewriting whatever consumes the rows. This matters more
 * than usual here: Naver retired book search on 2026-07-31, and this is where books still answer.
 */

const BASE = 'https://dapi.kakao.com';
const TIMEOUT = 15000;

/**
 * Per-type endpoint, paging caps and sort vocabulary. Nearly every row differs from its
 * neighbours, which is why they are declared rather than assumed:
 *   - book lives on /v3 while everything else is on /v2
 *   - book sorts by `latest`; every other type calls the same idea `recency`
 *   - video pages to 15, not 50, and takes 30 per page, not 50
 *   - image takes 80 per page and defaults to 80, where the others default to 10
 */
const TYPES = {
  web: { path: '/v2/search/web', pageMax: 50, sizeMax: 50, sizeDefault: 10, sorts: ['accuracy', 'recency'] },
  vclip: { path: '/v2/search/vclip', pageMax: 15, sizeMax: 30, sizeDefault: 15, sorts: ['accuracy', 'recency'] },
  image: { path: '/v2/search/image', pageMax: 50, sizeMax: 80, sizeDefault: 80, sorts: ['accuracy', 'recency'] },
  blog: { path: '/v2/search/blog', pageMax: 50, sizeMax: 50, sizeDefault: 10, sorts: ['accuracy', 'recency'] },
  book: { path: '/v3/search/book', pageMax: 50, sizeMax: 50, sizeDefault: 10, sorts: ['accuracy', 'latest'] },
  cafe: { path: '/v2/search/cafe', pageMax: 50, sizeMax: 50, sizeDefault: 10, sorts: ['accuracy', 'recency'] },
};

/** `target` narrows a book search to one field; no other type accepts it. */
const BOOK_TARGETS = ['title', 'isbn', 'publisher', 'person'];

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });

/** i18n error — main's catch extracts errorKey/errorParams. */
class I18nError extends Error {
  constructor(key, params) {
    super(key);
    this.errorKey = key;
    this.errorParams = params || {};
  }
}

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

/** i18n error response — resolve_sysmod_error maps module.daum-search.{key}. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);

    const restKey = process.env['KAKAO_REST_API_KEY'];
    if (!restKey) return outErr('error.api_key_missing', {});

    const action = data?.action || 'search';
    if (action !== 'search') return outErr('error.unknown_action', { action: String(action) });

    await handleSearch({ restKey }, data);
  } catch (e) {
    if (e instanceof I18nError) outErr(e.errorKey, e.errorParams);
    else outErr('error.runtime', { message: e.message });
  }
});

const strip = (s) => (s || '')
  .replace(/<\/?b>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function handleSearch(ctx, data) {
  const query = data?.query;
  if (!query) return outErr('error.query_required', {});

  const type = data.type || 'web';
  const spec = TYPES[type];
  if (!spec) {
    return outErr('error.unknown_type', { type: String(type), types: Object.keys(TYPES).join(', ') });
  }

  const notes = [];
  const params = new URLSearchParams({ query: String(query) });

  if (data.sort) {
    if (spec.sorts.includes(data.sort)) params.set('sort', data.sort);
    else {
      // `recency` and `latest` mean the same thing and only one of them is valid per type, so a
      // caller who learned one word gets an error on the other. Translate rather than reject.
      const synonym = { recency: 'latest', latest: 'recency' }[data.sort];
      if (synonym && spec.sorts.includes(synonym)) {
        params.set('sort', synonym);
        notes.push(`sort "${data.sort}" was translated to "${synonym}": ${type} search calls newest-first by that name.`);
      } else {
        notes.push(`sort "${data.sort}" was dropped: ${type} accepts ${spec.sorts.join(' | ')}.`);
      }
    }
  }

  if (data.page !== undefined) {
    const page = Math.min(Math.max(Number(data.page) || 1, 1), spec.pageMax);
    params.set('page', String(page));
    if (Number(data.page) > spec.pageMax) notes.push(`page was capped at ${spec.pageMax} for ${type} search.`);
  }
  if (data.size !== undefined) {
    const size = Math.min(Math.max(Number(data.size) || spec.sizeDefault, 1), spec.sizeMax);
    params.set('size', String(size));
    if (Number(data.size) > spec.sizeMax) notes.push(`size was capped at ${spec.sizeMax} for ${type} search.`);
  }

  if (data.target) {
    if (type !== 'book') notes.push(`target was dropped: only book search narrows by field.`);
    else if (!BOOK_TARGETS.includes(data.target)) notes.push(`target "${data.target}" was dropped: book accepts ${BOOK_TARGETS.join(' | ')}.`);
    else params.set('target', data.target);
  }

  const resp = await fetch(`${BASE}${spec.path}?${params}`, {
    headers: { Authorization: `KakaoAK ${ctx.restKey}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return outErr('error.search_api_status', { status: String(resp.status), body: t });
  }

  const json = await resp.json();
  const meta = json.meta || {};
  const items = (json.documents || []).map(d => shapeDocument(type, d));

  // `total_count` counts matches; `pageable_count` counts what paging can actually reach, and the
  // gap is enormous — the vendor's own example shows 897,323 against 775. Reporting only the first
  // invites "there are 897,323 results" and a page 40 that comes back empty.
  notes.push(`total ${meta.total_count ?? 0} matched, but only ${meta.pageable_count ?? 0} are reachable by paging (page * size beyond that returns nothing). isEnd tells you when to stop.`);
  notes.push('Daily quota: 30,000 calls for this search type, 50,000 across all Daum search types.');

  out(true, {
    total: meta.total_count ?? 0,
    pageableTotal: meta.pageable_count ?? 0,
    isEnd: meta.is_end ?? true,
    items,
    _note: notes.join(' '),
  });
}

/**
 * Maps a Kakao document onto the field names naver-search uses, so rows from either vendor drop
 * into the same table. Vendor-specific extras keep their own names.
 */
function shapeDocument(type, d) {
  const base = { datetime: d.datetime || '' };

  if (type === 'image') {
    // Image results have no title: the link is the image and `doc_url` is the page holding it.
    return {
      ...base,
      link: d.image_url || '',
      thumbnail: d.thumbnail_url || '',
      width: d.width ?? null,
      height: d.height ?? null,
      sitename: d.display_sitename || '',
      docLink: d.doc_url || '',
      collection: d.collection || '',
    };
  }

  base.title = strip(d.title);
  base.link = d.url || '';
  if (d.contents !== undefined) base.description = strip(d.contents);

  switch (type) {
    case 'vclip':
      base.thumbnail = d.thumbnail || '';
      base.playTimeSec = d.play_time ?? null;
      base.author = strip(d.author);
      break;
    case 'blog':
      base.blogname = strip(d.blogname);
      base.thumbnail = d.thumbnail || '';
      break;
    case 'cafe':
      base.cafename = strip(d.cafename);
      base.thumbnail = d.thumbnail || '';
      break;
    case 'book':
      base.authors = Array.isArray(d.authors) ? d.authors : [];
      base.translators = Array.isArray(d.translators) ? d.translators : [];
      base.publisher = d.publisher || '';
      base.isbn = d.isbn || '';
      base.price = d.price ?? null;
      base.salePrice = d.sale_price ?? null;
      base.thumbnail = d.thumbnail || '';
      // Sale status is free text the vendor may reword, so it is passed through for display and
      // must not be compared against a literal.
      base.status = d.status || '';
      break;
  }
  return base;
}
