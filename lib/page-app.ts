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

/** JSON that is safe to sit inside a `<script>` element.
 *
 *  A stored value containing `</script>` ends the element and the rest of it becomes markup — the
 *  app's own saved data turning into an injection. The HTML parser only looks for `<`, so escaping
 *  that (plus the line separators JS treats as newlines) is the whole fix. */
function embed(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The bootstrap injected into an app's entry document when it declared storage.
 *
 * An app on an opaque origin gets a `localStorage` that throws on touch, so without this the first
 * `getItem` crashes the app — which is why the inline path has carried an in-memory shim for months.
 * This is that shim with the data actually kept: the framework holds it, the serving route seeds it
 * here so reads answer **synchronously**, and writes go out as a message to the page that frames
 * this document, which is the only party able to prove which page this is.
 *
 * `sessionStorage` stays in-memory on purpose — a session store that outlived the session would be
 * a different thing wearing its name.
 *
 * A write refused for the page's budget cannot throw from `setItem` (it already returned), so it
 * arrives as a `store:error` message and, unhandled, as a console error. An app that cares can
 * listen for it.
 */
export function appBootstrap(
  slug: string,
  seed: Record<string, string>,
  opts: { storage: boolean; modules: string[] },
): string {
  const parts: string[] = [];
  if (opts.storage) parts.push(STORAGE_SHIM);
  if (opts.modules.length) parts.push(MODULE_CLIENT);
  if (!parts.length) return '';
  return `<script>(function(){
var SLUG=${embed(slug)},S=${embed(seed)},MODULES=${embed(opts.modules)},SEQ=0,PEND={};
function post(m){try{m.v=1;m.slug=SLUG;parent.postMessage(m,'*')}catch(e){}}
addEventListener('message',function(e){var d=e.data;if(!d)return;
 if(d.fb==='store:error'){console.error('[firebat] storage: '+d.error);return}
 if(d.fb==='call:done'&&PEND[d.id]){var p=PEND[d.id];delete PEND[d.id];d.ok?p.res(d.data):p.rej(new Error(d.error||'call failed'))}});
${parts.join('\n')}
})()</script>`;
}

/** The `localStorage` an opaque origin refuses to give — reads from the seed, writes through the
 *  frame. Without it the app's first `getItem` throws and takes the app with it. */
const STORAGE_SHIM = `
function mk(store,persist){return{
 getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(store,k)?store[k]:null},
 setItem:function(k,v){k=String(k);v=String(v);store[k]=v;if(persist)post({fb:'store',op:'set',key:k,value:v})},
 removeItem:function(k){k=String(k);delete store[k];if(persist)post({fb:'store',op:'delete',key:k})},
 clear:function(){Object.keys(store).forEach(function(k){if(persist)post({fb:'store',op:'delete',key:k});delete store[k]})},
 key:function(i){return Object.keys(store)[i]||null},
 get length(){return Object.keys(store).length}}}
function install(name,shim){try{window[name]&&window[name].getItem('__fb')}catch(e){try{Object.defineProperty(window,name,{value:shim,configurable:true})}catch(_){}}}
install('localStorage',mk(S,true));
install('sessionStorage',mk({},false));`;

/** `firebat.call(module, input)` — the app's one way to reach the server, and only for the modules
 *  its page declared. Refusals name the fix, so an app that needs another module is a declaration
 *  edit rather than a mystery. */
const MODULE_CLIENT = `
window.firebat={modules:MODULES,call:function(module,input){
 if(MODULES.indexOf(module)<0)return Promise.reject(new Error("this page did not declare '"+module+"' — add it to needs.modules and republish"));
 var id=String(++SEQ);
 return new Promise(function(res,rej){PEND[id]={res:res,rej:rej};post({fb:'call',id:id,module:module,input:input||{}});
  setTimeout(function(){if(PEND[id]){delete PEND[id];rej(new Error('module call timed out'))}},120000)})}};`;


/**
 * Put the bootstrap into an HTML document before anything of the app's own runs.
 *
 * After `<head>` when there is one, otherwise at the very top: the app's first script must not be
 * able to touch storage before the shim is installed.
 */
export function injectBootstrap(html: string, bootstrap: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + bootstrap + html.slice(at);
  }
  return bootstrap + html;
}
