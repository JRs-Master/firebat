/**
 * AppFrame — a page whose body is its own app, served from files.
 *
 * `kind: "app"` says the page IS the app: no site chrome, viewport locked, and the content comes
 * from the files the page declared rather than from blocks in its spec. The app is delivered as a
 * real document by the route beside it, so it may split itself into files, run workers and load
 * what it declared — none of which an `Html` block can do, since that goes into an iframe `srcdoc`
 * whose CSP has no `'self'` and blocks the page's own scripts with no error at all.
 *
 * It is still framed, and the frame is still sandboxed without `allow-same-origin`. That is not a
 * leftover restriction — it is the isolation. The session cookie is httpOnly, but the admin API
 * accepts cookie auth, so a same-origin app could act as the signed-in admin. Measured 2026-08-29:
 * inside this sandbox the app's own requests carry no cookies and go out cross-site, while the
 * frame navigation itself still carries them so the visibility gate works.
 */
import { sandboxTokens, frameAllow, type PageNeeds } from '../../../lib/page-app';

/** The same full-bleed lock the inline app path uses (page.tsx `isApp`): header and footer hidden,
 *  page scroll off, so the only scroll is the app's own. Identical on purpose — two apps on this
 *  site should not sit differently depending on where their bytes came from. */
const LOCK_CSS =
  '[data-cms-header],[data-cms-footer]{display:none!important}' +
  'html{scrollbar-gutter:auto}html,body{margin:0;padding:0;overflow:hidden;height:auto}' +
  'body>main{margin:0;padding:0}' +
  '.firebat-cms-content{margin:0!important;padding:0!important;max-width:none!important}';

export function AppFrame({ slug, needs, title }: { slug: string; needs: PageNeeds; title?: string }) {
  const src = `/user/pages/${slug.split('/').map(encodeURIComponent).join('/')}/`;
  const allow = frameAllow(needs);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LOCK_CSS }} />
      <main className="bg-white">
        <iframe
          src={src}
          title={title || slug}
          sandbox={sandboxTokens(needs)}
          {...(allow ? { allow } : {})}
          style={{ display: 'block', width: '100%', height: '100dvh', border: 0 }}
        />
      </main>
    </>
  );
}
