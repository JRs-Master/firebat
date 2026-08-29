import { NextRequest, NextResponse } from 'next/server';
import { appStore } from '../../../lib/api-gen/page';
import { gatePage } from '../../../lib/page-gate';
import { readDeclaration } from '../../../lib/page-app';

/**
 * POST /api/page-store — a published app's own storage.
 *
 * The app cannot call this itself: it runs on an opaque origin, so its fetches go out cross-site
 * with no cookies and it has no way to prove which page it is. It posts a message to the page that
 * frames it, and the page — which the browser already authenticated for this viewer — calls here.
 * That is the same shape a module has: isolated, speaking through an envelope, with the framework
 * on the other side deciding.
 *
 * Two gates, neither of them here by choice: `gatePage` answers whether this viewer may see the
 * page at all (private/password), and AppManager answers whether the page declared storage. A page
 * that declared nothing gets nothing.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { slug?: string; op?: string; key?: string; value?: string }
    | null;
  const slug = String(body?.slug ?? '').trim();
  const op = String(body?.op ?? '').trim();
  if (!slug || !op) {
    return NextResponse.json({ ok: false, error: 'slug and op are required' }, { status: 400 });
  }

  const gate = await gatePage(slug);
  // Missing and forbidden answer alike — a store is not a way to learn a page exists.
  if (!gate.ok) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const decl = readDeclaration(gate.spec.head);
  if (decl.kind !== 'app') {
    return NextResponse.json({ ok: false, error: 'not an app page' }, { status: 404 });
  }

  const r = await appStore({ slug, op, key: body?.key, value: body?.value });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.message }, { status: 500 });
  const d = r.data as { ok?: boolean; error?: string; value?: string; entriesJson?: string; bytes?: bigint | number } | undefined;
  return NextResponse.json({
    ok: d?.ok === true,
    ...(d?.error ? { error: d.error } : {}),
    ...(d?.value !== undefined ? { value: d.value } : {}),
    ...(d?.entriesJson ? { entries: JSON.parse(d.entriesJson) } : {}),
    bytes: Number(d?.bytes ?? 0),
  });
}
