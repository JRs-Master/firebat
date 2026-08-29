'use client';

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
 *
 * Which is also why this component exists on the client: an app with no origin has no storage and
 * no way to prove which page it is, so it posts a message here and this page — already
 * authenticated for this viewer — makes the call. The app's own transport, the way stdin/stdout is
 * a module's.
 */
import { useCallback, useEffect, useRef } from 'react';
import { sandboxTokens, frameAllow, type PageNeeds } from '../../../lib/page-app';

/** The same full-bleed lock the inline app path uses (page.tsx `isApp`): header and footer hidden,
 *  page scroll off, so the only scroll is the app's own. Identical on purpose — two apps on this
 *  site should not sit differently depending on where their bytes came from. */
const LOCK_CSS =
  '[data-cms-header],[data-cms-footer]{display:none!important}' +
  'html{scrollbar-gutter:auto}html,body{margin:0;padding:0;overflow:hidden;height:auto}' +
  'body>main{margin:0;padding:0}' +
  '.firebat-cms-content{margin:0!important;padding:0!important;max-width:none!important}';

interface StoreMessage {
  v?: number;
  fb?: string;
  slug?: string;
  op?: string;
  key?: string;
  value?: string;
}

export function AppFrame({
  slug,
  needs,
  title,
}: {
  slug: string;
  needs: PageNeeds;
  title?: string;
}) {
  // The entry file, named — not the directory. A directory URL is 308-redirected to the
  // slash-less form, and every relative `src="app.js"` in the document would then resolve one level
  // too high (measured 2026-08-30: `/user/pages/carom` + `carom-app.js` → `/user/pages/carom-app.js`,
  // a 404 with nothing on screen to say why).
  const src = `/user/pages/${slug.split('/').map(encodeURIComponent).join('/')}/index.html`;
  const allow = frameAllow(needs);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const relay = useCallback(
    async (msg: StoreMessage) => {
      try {
        const res = await fetch('/api/page-store', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug, op: msg.op, key: msg.key, value: msg.value }),
        });
        const json = await res.json().catch(() => null);
        if (!json?.ok) {
          // A write refused for the page's budget has to reach the app somehow — its setItem
          // already returned, so this arrives as a message it can listen for and, failing that, as
          // a console error rather than silence.
          frameRef.current?.contentWindow?.postMessage(
            { fb: 'store:error', op: msg.op, key: msg.key, error: json?.error ?? 'store failed' },
            '*',
          );
        }
      } catch {
        /* a dropped write is not worth breaking the app over */
      }
    },
    [slug],
  );

  useEffect(() => {
    if (!needs.storage) return;
    const onMessage = (e: MessageEvent) => {
      // Only this frame, and only for this page. The frame has an opaque origin, so `e.origin` is
      // "null" and proves nothing — identity here is the window itself.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as StoreMessage | null;
      if (!d || d.fb !== 'store' || d.slug !== slug) return;
      if (d.op !== 'set' && d.op !== 'delete') return;
      void relay(d);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [needs.storage, relay, slug]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LOCK_CSS }} />
      <main className="bg-white">
        <iframe
          ref={frameRef}
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
