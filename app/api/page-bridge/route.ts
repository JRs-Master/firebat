import { NextRequest, NextResponse } from 'next/server';
import { appStore, appModule } from '../../../lib/api-gen/page';
import { gatePage } from '../../../lib/page-gate';
import { readDeclaration } from '../../../lib/page-app';
import { moduleActionDenied } from '../../../lib/page-binding-gate';

/**
 * POST /api/page-bridge — the server side of a published app's envelope.
 *
 * The app cannot call this itself: it runs on an opaque origin, so its fetches go out cross-site
 * with no cookies and it has no way to prove which page it is. It posts a message to the page that
 * frames it, and that page — which the browser already authenticated for this viewer — calls here.
 * Same shape as a module: isolated, speaking through an envelope, with the framework on the other
 * side deciding.
 *
 * One route because there is one envelope. Storage and module calls differ in what they do, not in
 * who may do it, and splitting them would be two places to keep the same gate.
 *
 * Three gates, none of them optional: `gatePage` (may this viewer see the page at all),
 * `AppManager` (did the page declare this — storage, or this module by name), and for a module the
 * approval class is refused outright, sharing `moduleActionDenied` with the page-form callback so
 * the two surfaces cannot drift into different answers about real-money actions.
 */
export const dynamic = 'force-dynamic';

// Per-IP cap, mirroring the page-form callback. In-memory and single-instance: a restart resets it,
// which is harmless for what it defends against.
const RATE_MAX = 120;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = hits.get(ip);
  if (!h || now - h.t > RATE_WINDOW_MS) {
    hits.set(ip, { n: 1, t: now });
    return false;
  }
  h.n += 1;
  return h.n > RATE_MAX;
}

const deny = (error: string, status = 403) => NextResponse.json({ ok: false, error }, { status });

/**
 * The largest single value a page may store.
 *
 * Not a taste call: the gRPC hop refuses a message over 4 MiB, so without a check here a big write
 * comes back as "decoded message length too large" — a transport error, in bytes, with nothing an
 * app could show a person or act on. Measured 2026-08-30 with a 6 MB write. One megabyte leaves the
 * page's 5 MB budget reachable across several keys, which is the limit that was meant to bite.
 */
const VALUE_MAX_BYTES = 1024 * 1024;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { slug?: string; op?: string; key?: string; value?: string; module?: string; input?: unknown }
    | null;
  const slug = String(body?.slug ?? '').trim();
  const op = String(body?.op ?? '').trim();
  if (!slug || !op) return deny('slug and op are required', 400);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) return deny('too many requests', 429);

  const gate = await gatePage(slug);
  // Missing and forbidden answer alike — the bridge is not a way to learn a page exists.
  if (!gate.ok) return deny('not found', 404);
  const decl = readDeclaration(gate.spec.head);
  if (decl.kind !== 'app') return deny('not an app page', 404);

  if (op === 'module.run') {
    const moduleName = String(body?.module ?? '').trim();
    if (!moduleName) return deny('module is required', 400);
    const input = (body?.input ?? {}) as Record<string, unknown>;
    const action = typeof input.action === 'string' ? input.action : '';
    // Real-money and other approval-class actions are refused on this surface outright, the same
    // answer the anonymous form callback gives. A page declaring such a module does not change it.
    if (await moduleActionDenied(moduleName, action)) {
      return deny('this module cannot be run from a page');
    }
    const r = await appModule({ slug, module: moduleName, inputJson: JSON.stringify(input) });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.message }, { status: 500 });
    const d = r.data as { ok?: boolean; error?: string; outputJson?: string } | undefined;
    return NextResponse.json({
      ok: d?.ok === true,
      ...(d?.error ? { error: d.error } : {}),
      ...(d?.outputJson ? { data: JSON.parse(d.outputJson) } : {}),
    });
  }

  const storeOp = op.startsWith('storage.') ? op.slice('storage.'.length) : op;
  if (storeOp === 'set') {
    const size = Buffer.byteLength(String(body?.value ?? ''), 'utf8');
    if (size > VALUE_MAX_BYTES) {
      return deny(
        `value too large: ${size} bytes, the limit for one key is ${VALUE_MAX_BYTES}. ` +
          'Split it across keys, or store less per key.',
        413,
      );
    }
  }
  const r = await appStore({ slug, op: storeOp, key: body?.key, value: body?.value });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.message }, { status: 500 });
  const d = r.data as
    | { ok?: boolean; error?: string; value?: string; entriesJson?: string; bytes?: bigint | number }
    | undefined;
  return NextResponse.json({
    ok: d?.ok === true,
    ...(d?.error ? { error: d.error } : {}),
    ...(d?.value !== undefined ? { value: d.value } : {}),
    ...(d?.entriesJson ? { entries: JSON.parse(d.entriesJson) } : {}),
    bytes: Number(d?.bytes ?? 0),
  });
}
