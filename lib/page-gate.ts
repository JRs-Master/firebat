/**
 * May this request see this page? One answer, for every surface that has to ask.
 *
 * The page RSC, the app-asset route and the app-store route all need the same verdict, and a policy
 * copied three times is a policy where the loosest copy decides. The rules are the page's own:
 * `resolvePageVisibility` (page → project → public), the admin cookie as a private preview, and the
 * `fp_<project>` / `fp_<slug>` cookie for a password page.
 *
 * An asset or a store call cannot render a password form, so it gets `denied` and the page renders
 * the form — the same reason a missing page and a forbidden one both answer 404 there: existence is
 * not something to leak.
 */
import { cookies } from 'next/headers';
import { get as getPage, verifyPassword as verifyPagePasswordRpc } from './api-gen/page';
import { verifyPassword as verifyProjectPasswordRpc } from './api-gen/project';
import { parsePageRecord, type ParsedPageSpec } from './util/page-pb-convert';
import { resolvePageVisibility } from './page-visibility';
import { SESSION_COOKIE_NAME } from './config';

export type PageGate =
  | { ok: true; spec: ParsedPageSpec; visibility: 'public' | 'password' | 'private' }
  | { ok: false; reason: 'missing' | 'denied' };

export async function gatePage(slug: string): Promise<PageGate> {
  const res = await getPage({ slug });
  if (!res.ok || !res.data) return { ok: false, reason: 'missing' };
  const spec = parsePageRecord(res.data);
  const visibility = await resolvePageVisibility(spec);

  if (visibility === 'private') {
    const jar = await cookies();
    const admin = jar.get(SESSION_COOKIE_NAME)?.value || jar.get('firebat_admin_token')?.value;
    if (!admin) return { ok: false, reason: 'denied' };
  } else if (visibility === 'password') {
    const isProjectPassword = spec._visibility !== 'password' && !!spec.project;
    const jar = await cookies();
    const saved = jar.get(isProjectPassword ? `fp_${spec.project}` : `fp_${slug}`)?.value;
    let verified = false;
    if (saved) {
      const pw = decodeURIComponent(saved);
      const r = isProjectPassword && spec.project
        ? await verifyProjectPasswordRpc({ project: spec.project, password: pw })
        : await verifyPagePasswordRpc({ slug, password: pw });
      verified = r.ok && r.data === true;
    }
    if (!verified) return { ok: false, reason: 'denied' };
  }
  return { ok: true, spec, visibility };
}
