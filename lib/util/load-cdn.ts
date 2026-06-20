/**
 * Lazy-load JS/CSS from a CDN — heavy libraries (highlight.js / mermaid / katex / swiper) are
 * fetched only at render time so they stay out of the initial bundle. Client-only: window/document
 * are touched at call time (returns immediately during SSR). De-dupes by src and resolves once loaded.
 */
export function loadCdn(opts: { js?: string[]; css?: string[]; globalCheck?: () => boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    if (opts.globalCheck?.()) return resolve();
    for (const css of opts.css ?? []) {
      if (!document.querySelector(`link[href="${css}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = css;
        document.head.appendChild(l);
      }
    }
    const jsList = opts.js ?? [];
    if (jsList.length === 0) return resolve();
    let pending = jsList.length;
    const onDone = () => { pending--; if (pending === 0) resolve(); };
    for (const js of jsList) {
      const existing = document.querySelector(`script[src="${js}"]`) as HTMLScriptElement | null;
      if (existing) {
        if ((existing as any)._loaded) onDone();
        else existing.addEventListener('load', onDone);
      } else {
        const s = document.createElement('script');
        s.src = js;
        s.onload = () => { (s as any)._loaded = true; onDone(); };
        s.onerror = onDone;
        document.head.appendChild(s);
      }
    }
  });
}
