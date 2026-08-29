import { NextRequest, NextResponse } from 'next/server';
import { readFileBinary } from '../../../../lib/api-gen/storage';
import { readDeclaration, appCsp, appBootstrap, injectBootstrap } from '../../../../lib/page-app';
import { appStore } from '../../../../lib/api-gen/page';
import { gatePage } from '../../../../lib/page-gate';

/**
 * GET /user/pages/<name>/<...file> — a published page project's own browser assets.
 *
 * A page whose app is split into files cannot live inside a PageSpec: an `Html` block carrying a
 * script is forced into an iframe whose CSP has no `'self'`, so the page's own 200-served script is
 * blocked with no error and a blank screen. Those apps are served from disk instead — which is why
 * this route exists at all.
 *
 * Caddy has been serving `/user/pages/*` straight off the filesystem, which is fast and knows
 * nothing: a private or password-protected project's files came back to anyone who asked, and the
 * directory is the same one that is about to hold module code and sqlite. Putting the bytes behind
 * this route puts "what may be served" and "who may see it" in the same place — the whole reason
 * the page-project layout went this way (2026-08-29 decision). The Caddy `@pages` block is deleted
 * once this ships; until then it shadows this route, which is the safe order (the reverse is an
 * instant 404 on every published app).
 *
 * The gate mirrors the page RSC exactly — same resolver, same cookies, same admin preview — because
 * two copies of one policy is how one of them ends up looser. An asset cannot render a password
 * form, so an unauthenticated request 404s here and the page itself shows the form.
 */

/** Path segments are file names, nothing else. Rust's `resolve_safe_path` refuses traversal too;
 *  this refuses it before a request is even made, and keeps the 404 indistinguishable from a miss. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface BinaryRead {
  base64?: string;
  mimeType?: string;
  size?: number;
}

const notFound = () => new NextResponse('Not found', { status: 404 });

/** The app page this URL addresses, if it addresses one.
 *
 *  The URL is keyed by slug and the disk path comes from that page's declaration — `head.source`.
 *  Nothing is served because a directory happens to exist: a page must say `kind: "app"` and name
 *  its own source, so a folder someone drops under `user/` is not reachable by guessing its name.
 *
 *  A slug may nest (`docs/manual`), so the longest prefix that resolves to an app page wins. Two
 *  segments is as deep as this looks — an app is addressed by its own name, and each extra step is
 *  another lookup on every asset request. */
async function resolveApp(path: string[]) {
  for (let take = Math.min(2, path.length); take >= 1; take--) {
    const slug = path.slice(0, take).join('/');
    const gate = await gatePage(slug);
    if (!gate.ok) {
      // A page that exists but refuses this viewer stops the walk: falling through to a shorter
      // prefix would answer with a different page's files.
      if (gate.reason === 'denied') return null;
      continue;
    }
    const decl = readDeclaration(gate.spec.head);
    if (decl.kind !== 'app' || !decl.source) continue;
    return { slug, spec: gate.spec, decl, rest: path.slice(take), visibility: gate.visibility };
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  if (!path?.length || path.some(seg => !SAFE_SEGMENT.test(seg))) return notFound();

  const app = await resolveApp(path);
  if (!app) return notFound();
  const { slug: name, spec, decl, rest, visibility } = app;

  // The URL space maps into the declared source directory and nowhere else. That is the boundary:
  // whatever else the page's folder holds — module code, its store — has no URL at all, not a
  // blocked one, an absent one. A deny list would have to keep pace with whatever gets added there;
  // this cannot fall behind ([[feedback_boundary_not_blocklist]]).
  //
  // A directory URL means its index, the way a file server resolves it. Asked for only after the
  // direct read misses, so the common path stays one call.
  const dir = decl.source!.replace(/\/+$/, '');
  const tail = rest.join('/');
  const base = `${dir}${tail ? `/${tail}` : ''}`;
  let read = await readFileBinary({ path: base });
  if (!read.ok || !(read.data as BinaryRead)?.base64) {
    read = await readFileBinary({ path: `${base}/index.html` });
  }
  const file = read.ok ? (read.data as BinaryRead) : null;
  if (!file?.base64) return notFound();

  // A navigation into this space is not how an app is opened, and mostly not how anything here is
  // meant to be reached. The frame is the app's transport: it relays storage writes and module calls,
  // because an app on an opaque origin cannot prove which page it is. Reached directly there is no
  // relay — `localStorage` resolves to the browser's own instead of the page's, and every
  // `firebat.call` hangs until it times out, while the app still draws (measured 2026-08-30:
  // `/user/pages/carom` painted its canvas and its buttons did nothing).
  //
  // Serving the document properly is not on the table — it would put the app on our own origin, the
  // one grant the sandbox never makes. And the escape is not limited to HTML: an `.svg` or `.xhtml`
  // navigated to top-level is a *document* on our origin, and this response's own CSP allows its
  // inline script, with the admin's cookie in scope. Deciding it by file type would be a list that
  // has to keep pace with what browsers agree to render ([[feedback_boundary_not_blocklist]]).
  //
  // So a navigation is refused unless the page declared `downloads`, and a page that did gets its
  // bytes as an attachment — never as a document. The app document itself has no address either way.
  // `Sec-Fetch-Dest` tells a navigation from the frame's own request (`document` vs `iframe`); a
  // request without the header is served as before, since this decides how many URLs an app has and
  // not who may read it — that is `gatePage`, above, and it has already run.
  let attachment: string | null = null;
  if ((req.headers.get('sec-fetch-dest') || '') === 'document') {
    if (!decl.needs.downloads || (file.mimeType || '').startsWith('text/html')) return notFound();
    // Segments are already `[A-Za-z0-9._-]` only, so the quoted name needs no further escaping.
    attachment = `attachment; filename="${base.split('/').pop()}"`;
  }

  let buf = Buffer.from(file.base64, 'base64');
  // The entry document gets the bootstrap for whatever this page declared — the storage shim seeded
  // with what it already holds (so the app's first synchronous read finds its data), and the module
  // client for the modules it named. Only the HTML: a .js file is the app's own.
  const wantsBootstrap = decl.needs.storage || (decl.needs.modules?.length ?? 0) > 0;
  if (wantsBootstrap && (file.mimeType || '').startsWith('text/html')) {
    let seed: Record<string, string> = {};
    if (decl.needs.storage) {
      const seedRes = await appStore({ slug: name, op: 'entries' });
      const raw = (seedRes.ok ? (seedRes.data as { entriesJson?: string } | undefined)?.entriesJson : '') || '{}';
      try { seed = JSON.parse(raw); } catch { /* an unreadable seed is an empty one, not a broken page */ }
    }
    const boot = appBootstrap(name, seed, {
      storage: !!decl.needs.storage,
      modules: decl.needs.modules ?? [],
    });
    if (boot) buf = Buffer.from(injectBootstrap(buf.toString('utf8'), boot), 'utf8');
  }
  const total = buf.length;
  const headers: Record<string, string> = {
    'Content-Type': file.mimeType || 'application/octet-stream',
    // The app's own policy, translated from what it declared. Same source of truth as the sandbox
    // tokens the page frames it with — split them and the looser half decides.
    'Content-Security-Policy': appCsp(decl.needs),
    // A gated project must not sit in a shared cache, and an app under active editing should not
    // be pinned for long anywhere. Public assets keep the five minutes Caddy was giving them.
    'Cache-Control': visibility === 'public' ? 'public, max-age=300' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    // This answers differently to a navigation than to the frame's own request (above).
    Vary: 'Sec-Fetch-Dest',
    ...(attachment ? { 'Content-Disposition': attachment } : {}),
    // The app frames on an opaque origin, so every request it makes for its own files is
    // cross-origin. A classic `<script src>` does not care; a `<script type="module">` is fetched
    // with CORS and is BLOCKED without this header — measured 2026-08-30 on carom, where the
    // engine (classic) loaded, the app (module) did not, and the page came up with a canvas and
    // dead buttons. Never with credentials: the frame's requests carry no cookies by design, and
    // a gated page's files are still refused upstream by `gatePage`.
    'Access-Control-Allow-Origin': '*',
  };

  // Range — media inside a page project needs seek, and the file server this replaces had it.
  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      return new NextResponse('Range Not Satisfiable', {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${total}` },
      });
    }
    const chunk = buf.subarray(start, end + 1);
    return new NextResponse(chunk, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(chunk.length),
      },
    });
  }

  return new NextResponse(buf, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(total) },
  });
}
