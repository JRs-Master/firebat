import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readFileBinary } from '../../../../lib/api-gen/storage';
import { getPage, verifyPassword as verifyPagePasswordRpc } from '../../../../lib/api-gen/page';
import { verifyPassword as verifyProjectPasswordRpc } from '../../../../lib/api-gen/project';
import { parsePageRecord } from '../../../../lib/util/page-pb-convert';
import { resolvePageVisibility } from '../../../../lib/page-visibility';
import { readDeclaration, appCsp } from '../../../../lib/page-app';
import { SESSION_COOKIE_NAME } from '../../../../lib/config';

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
    const res = await getPage({ slug });
    if (!res.ok || !res.data) continue;
    const spec = parsePageRecord(res.data);
    const decl = readDeclaration(spec.head);
    if (decl.kind !== 'app' || !decl.source) continue;
    return {
      slug,
      spec,
      decl,
      rest: path.slice(take),
      visibility: await resolvePageVisibility(spec),
    };
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

  if (visibility === 'private') {
    // Admin preview only — same allowance the page itself makes.
    const jar = await cookies();
    const adminToken = jar.get(SESSION_COOKIE_NAME)?.value || jar.get('firebat_admin_token')?.value;
    if (!adminToken) return notFound();
  } else if (visibility === 'password') {
    const isProjectPassword = spec?._visibility !== 'password' && !!spec?.project;
    const jar = await cookies();
    const cookieKey = isProjectPassword ? `fp_${spec?.project}` : `fp_${name}`;
    const saved = jar.get(cookieKey)?.value;
    let verified = false;
    if (saved) {
      const pw = decodeURIComponent(saved);
      if (isProjectPassword && spec?.project) {
        const r = await verifyProjectPasswordRpc({ project: spec.project, password: pw });
        verified = r.ok && r.data === true;
      } else {
        const r = await verifyPagePasswordRpc({ slug: name, password: pw });
        verified = r.ok && r.data === true;
      }
    }
    // No form here — the page renders that. An unverified asset is simply not there.
    if (!verified) return notFound();
  }

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

  const buf = Buffer.from(file.base64, 'base64');
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
