/**
 * A page app's declaration, and the single translation of it into browser policy.
 *
 * A page says what it is and what it needs; the framework turns that into sandbox tokens, an
 * `allow` attribute and a CSP. Two things depend on that translation — the route that serves the
 * app document (CSP header) and the page that frames it (sandbox / allow) — so it lives here once.
 * Split across both, one of them drifts, and the looser half is the one that decides.
 *
 * The point of declaring is that an app that does not work can be fixed **in its own declaration**,
 * with no framework change: the rule modules are already held to. What is not declared is refused
 * rather than defaulted open, because otherwise the pages that said the least would be allowed the
 * most.
 */

export type PageKind = 'post' | 'app';

export interface PageNeeds {
  /** Persistent per-page storage, held by the framework (the app has no origin of its own). */
  storage?: boolean;
  /** Modules this app may call through the bridge. */
  modules?: string[];
  /** Extra https hosts for the app's `script-src`. */
  scripts?: string[];
  worker?: boolean;
  fullscreen?: boolean;
  modals?: boolean;
  pointerLock?: boolean;
  popups?: boolean;
  downloads?: boolean;
}

export interface PageDeclaration {
  kind: PageKind;
  /** The app's own source directory, e.g. `user/pages/carom/`. */
  source?: string;
  needs: PageNeeds;
}

/** Read the declaration off a page's `head`. Mirrors `core/src/utils/page_declaration.rs`. */
export function readDeclaration(head: Record<string, any> | undefined | null): PageDeclaration {
  const h = head ?? {};
  const kind: PageKind = h.kind === 'app' ? 'app' : 'post';
  const source = typeof h.source === 'string' && h.source.trim() ? h.source.trim() : undefined;
  const n = (h.needs ?? {}) as Record<string, any>;
  return {
    kind,
    source,
    needs: {
      storage: n.storage === true,
      modules: Array.isArray(n.modules) ? n.modules.filter((m: any) => typeof m === 'string') : [],
      scripts: Array.isArray(n.scripts) ? n.scripts.filter(isGrantableScriptHost) : [],
      worker: n.worker === true,
      fullscreen: n.fullscreen === true,
      modals: n.modals === true,
      pointerLock: n.pointerLock === true,
      popups: n.popups === true,
      downloads: n.downloads === true,
    },
  };
}

/**
 * A script host the framework will grant.
 *
 * https only, and nothing that could carry a second CSP directive. Our own origin is never a
 * grantable host: the app runs on an opaque origin so it cannot act as the signed-in admin, and
 * `'self'` is already permitted for its own files — measured 2026-08-29, `'self'` resolves against
 * the document URL even on an opaque origin, so an app loads its own scripts without this.
 */
export function isGrantableScriptHost(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  const h = host.trim();
  return h.startsWith('https://') && h.length > 'https://'.length && !/[\s;'"]/.test(h);
}

/**
 * The iframe `sandbox` attribute.
 *
 * `allow-same-origin` is the one token that never appears, whatever a page declares. It is the
 * whole isolation: the session cookie is httpOnly, but the admin API accepts cookie auth, so a
 * same-origin app could act as the admin by fetching with credentials. Everything else an app lost
 * to sandboxing comes back here by declaration.
 */
export function sandboxTokens(needs: PageNeeds): string {
  const t = ['allow-scripts'];
  if (needs.modals) t.push('allow-modals');
  if (needs.pointerLock) t.push('allow-pointer-lock');
  if (needs.popups) t.push('allow-popups', 'allow-popups-to-escape-sandbox');
  if (needs.downloads) t.push('allow-downloads');
  return t.join(' ');
}

/** The iframe `allow` attribute — permissions policy, which sandbox tokens do not cover. */
export function frameAllow(needs: PageNeeds): string {
  const a: string[] = [];
  if (needs.fullscreen) a.push('fullscreen');
  return a.join('; ');
}

/**
 * The CSP the app document is served with.
 *
 * `'self'` covers the app's own files. `connect-src https:` is what inline apps already get: our
 * own origin is excluded on http, and after TLS an app still cannot read our API responses (no CORS
 * headers) or send cookies (its requests are cross-site) — measured. Server access is the bridge's
 * one path, not a fetch.
 */
export function appCsp(needs: PageNeeds): string {
  const scripts = ["'self'", "'unsafe-inline'", ...(needs.scripts ?? [])].join(' ');
  const styles = ["'self'", "'unsafe-inline'", ...(needs.scripts ?? [])].join(' ');
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    `style-src ${styles} https://fonts.googleapis.com`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' https: data:",
    'connect-src https:',
    // A worker is a capability, so it is declared. Without it `default-src 'none'` refuses one.
    needs.worker ? "worker-src 'self' blob:" : "worker-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
