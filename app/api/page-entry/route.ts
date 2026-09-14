import { NextRequest, NextResponse } from 'next/server';
import { get as getPageRpc } from '../../../lib/api-gen/page';
import { parsePageRecord } from '../../../lib/util/page-pb-convert';
import { readDeclaration } from '../../../lib/page-app';
import { pageOrAbsent } from '../../../lib/page-lookup';

/**
 * GET /api/page-entry?slug=<slug> — is this slug a vouched app, and where does its entry live?
 *
 * Middleware runs before routing and cannot reach the core directly, so it asks here. Nothing
 * secret is answered: the reply says only what a vouched app's URL already says out loud, and a
 * page that is not one gets the same `{}` as a slug that does not exist.
 *
 * ⚠️ The gate is NOT run here and must not be — this answers "how is this page delivered", and the
 * route that then serves the bytes asks "may this viewer have them" (`gatePage`). Folding the two
 * would put the same policy in two places, which is how one of them ends up looser.
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(slug)) return NextResponse.json({});
  try {
    const record = pageOrAbsent(await getPageRpc({ slug }), `page '${slug}'`);
    if (!record) return NextResponse.json({});
    const decl = readDeclaration(parsePageRecord(record).head);
    if (decl.kind !== 'app' || !decl.source || !decl.trust) return NextResponse.json({});
    const entry = `/user/pages/${slug.split('/').map(encodeURIComponent).join('/')}/index.html`;
    return NextResponse.json({ entry });
  } catch {
    // A lookup that failed is not a page that is missing — but here the honest answer to "could not
    // ask" is the same as "not a vouched app": deliver it the ordinary way rather than guess.
    return NextResponse.json({});
  }
}
