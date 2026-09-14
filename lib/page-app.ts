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
  /**
   * https hosts this app may embed in a frame of its own — a video, a map, a player.
   *
   * ⚠️ Only a vouched app gets these. A framed app is sandboxed, and a nested frame inherits its
   * parent's sandbox, so the embedded page would have no origin either and most embeds refuse to
   * run that way. Opening `frame-src` there would have looked like a feature and delivered nothing.
   */
  frames?: string[];
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
  /**
   * The operator vouches for this app's code, so it is served as a page of this site rather than
   * framed on an origin of its own.
   *
   * The sandbox exists for one reason: the admin API takes cookie auth, so an app on our origin
   * could act as the signed-in admin. That danger is real when someone ELSE wrote the app. When the
   * operator wrote it, the app already has every privilege the operator has — framing it guards
   * nothing and costs six things we measured: no real address, F5 loses the place, no SEO, no
   * embedded frames, none of our own components, and (2026-09-14, Edge 153) the frame does not
   * survive at all.
   *
   * ⛔ Default off, and a hub tenant can never set it: a tenant vouching for their own code is the
   * exact thing the boundary is for. This is the operator's signature, not the author's.
   *
   * ⚠️ Not the end state. With a domain, apps get an origin of their own and even un-vouched ones
   * stop needing the frame — this declaration then costs nothing and guards nothing. It is written
   * so that day changes one function, not every app.
   */
  trust: boolean;
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
    trust: h.trust === true,
    needs: {
      storage: n.storage === true,
      modules: Array.isArray(n.modules) ? n.modules.filter((m: any) => typeof m === 'string') : [],
      scripts: Array.isArray(n.scripts) ? n.scripts.filter(isGrantableScriptHost) : [],
      frames: Array.isArray(n.frames) ? n.frames.filter(isGrantableScriptHost) : [],
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
/**
 * The policy for a vouched app — a page of this site, not a prisoner of it.
 *
 * The differences from the jail are the ones the jail existed to impose: this document may frame
 * what it declared (a lesson can embed the video it is about), it may talk to our own origin (the
 * bridge is a same-origin call now, not a message to a parent), and it may be navigated to, because
 * being navigated to is how a page is opened. `'self'` finally means something here.
 *
 * Still not `default-src *`: an app that never declared a host should not reach one, and a typo in
 * a URL should fail loudly rather than fetch a stranger.
 */
export function trustedAppCsp(needs: PageNeeds): string {
  const hosts = (needs.scripts ?? []).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${hosts}`.trim(),
    `style-src 'self' 'unsafe-inline' ${hosts} https://fonts.googleapis.com`.trim(),
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' https: data:",
    "connect-src 'self' https:",
    needs.worker ? "worker-src 'self' blob:" : "worker-src 'none'",
    // The one the jail could never give: an embedded player, a map, a video the lesson is about.
    needs.frames?.length ? `frame-src ${needs.frames.join(' ')}` : "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

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
  opts: { storage: boolean; modules: string[]; direct?: boolean },
): string {
  const parts: string[] = [];
  if (opts.storage) parts.push(STORAGE_SHIM);
  if (opts.modules.length) parts.push(opts.direct ? MODULE_CLIENT_DIRECT : MODULE_CLIENT);
  if (!parts.length) return '';
  // ⭐ The app's side of the contract does not change between the two: the same shimmed
  // `localStorage`, the same `firebat.call`, the same page store behind both. Only the WIRE
  // differs — framed, the app has no origin and has to ask its parent to speak for it; vouched, it
  // is a page of this site and calls the bridge itself. An app must not have to know which it is,
  // or vouching for one would mean editing it.
  const transport = opts.direct
    ? `function post(m){try{fetch('/api/page-bridge',{method:'POST',credentials:'same-origin',
 headers:{'content-type':'application/json'},
 body:JSON.stringify({slug:SLUG,op:'storage.'+m.op,key:m.key,value:m.value})})
 .then(function(r){return r.json()}).then(function(j){
  if(j&&j.ok===false)console.error('[firebat] storage: '+(j.error||'store failed'))})
 .catch(function(){})}catch(e){}}`
    : `function post(m){try{m.v=1;m.slug=SLUG;parent.postMessage(m,'*')}catch(e){}}
addEventListener('message',function(e){var d=e.data;if(!d)return;
 if(d.fb==='store:error'){console.error('[firebat] storage: '+d.error);return}
 if(d.fb==='call:done'&&PEND[d.id]){var p=PEND[d.id];delete PEND[d.id];d.ok?p.res(d.data):p.rej(new Error(d.error||'call failed'))}});`;
  return `<script>(function(){
var SLUG=${embed(slug)},S=${embed(seed)},MODULES=${embed(opts.modules)},SEQ=0,PEND={};
${transport}
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
window.firebat=window.firebat||{};window.firebat.modules=MODULES;
window.firebat.call=function(module,input){
 if(MODULES.indexOf(module)<0)return Promise.reject(new Error("this page did not declare '"+module+"' — add it to needs.modules and republish"));
 var id=String(++SEQ);
 return new Promise(function(res,rej){PEND[id]={res:res,rej:rej};post({fb:'call',id:id,module:module,input:input||{}});
  setTimeout(function(){if(PEND[id]){delete PEND[id];rej(new Error('module call timed out'))}},120000)})};`;

/** The same `firebat.call`, without a parent to relay it. Same refusal text, so an app that names
 *  an undeclared module reads the same sentence either way.
 *
 *  ⚠️ Both clients ADD to `window.firebat` rather than replacing it. A vouched app is told where it
 *  is mounted by a script that runs before this one, and assigning a fresh object here wiped that —
 *  the later injection must not silently delete what the earlier one declared. */
const MODULE_CLIENT_DIRECT = `
window.firebat=window.firebat||{};window.firebat.modules=MODULES;
window.firebat.call=function(module,input){
 if(MODULES.indexOf(module)<0)return Promise.reject(new Error("this page did not declare '"+module+"' — add it to needs.modules and republish"));
 return fetch('/api/page-bridge',{method:'POST',credentials:'same-origin',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({slug:SLUG,op:'module.run',module:module,input:input||{}})})
 .then(function(r){return r.json()})
 .then(function(j){if(!j||!j.ok)throw new Error((j&&j.error)||'call failed');return j.data})};`;


/**
 * What a vouched app's document needs in its head — and the repair that need costs.
 *
 * A vouched app is served AT its slug (`/sixty`) while its files stay at `/user/pages/sixty/`, so
 * every relative `src="app.js"` in it resolves one level too high — the miss that left carom with a
 * canvas and dead buttons on 2026-08-30. `<base>` names the directory once and fixes all of them,
 * which is what keeps an app from having to be edited in order to be vouched for.
 *
 * ⭐ But `<base>` is not a subresource setting. A fragment-only `href="#/l/x"` resolves against it
 * too, so the first internal click threw the app off its own address: the bar read
 * `/user/pages/sixty/#/l/as-markets` (measured 2026-09-14), and `href="#quiz"` became a whole
 * document load that landed on a blank screen — a router that correctly ignores a non-route hash
 * renders nothing when that hash arrives on a fresh load. One tag, two jobs, opposite values.
 *
 * Aiming the base at the public address only moves the damage. `/sixty/` is 308'd back to `/sixty`
 * by the framework's trailing-slash rule (measured the same day), so a fragment link would resolve
 * to a DIFFERENT path than the document it sits in and every click would cost a full reload plus a
 * redirect. The address cannot become a directory without turning that rule off for the whole site.
 *
 * So the two jobs are separated: the base keeps resolving subresources, and fragment navigation is
 * put back where it was before we added a base the app never asked for. ⚠️ This repairs OUR side
 * effect rather than patching the app — the same document un-vouched behaves identically, which is
 * the property that lets `trust` be one field ([[feedback_richer_surface_must_be_superset]]).
 *
 * On `window`, so it runs after everything the app itself has to say: click bubbles target → …→
 * document → window, and an app that stops a link of its own (SIXTY's footer "준비 중" links) has
 * already set `defaultPrevented` by the time this sees it.
 *
 * ⭐ `firebat.mount` is the other half: **an app cannot route on the path unless it is told where it
 * was mounted.** It knows its own files (that is the base) and it can read `location`, but it cannot
 * tell which leading segments are the framework's address and which are its own route — and getting
 * that wrong turns every deep link into a wrong page. It is not something the app can fix in itself
 * ([[feedback_fixable_in_the_module]]), so the framework says it. An app that finds it absent is
 * not vouched and has no address of its own to route on, which is the honest signal to fall back.
 */
export function trustedHead(dirUrl: string, mount: string): string {
  return `<base href="${dirUrl}"><script>window.firebat=window.firebat||{};window.firebat.mount=${embed(mount)};
(function(){window.addEventListener('click',function(e){
 if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;
 var w=a.getAttribute('target');if(w&&w!=='_self')return;
 var h=a.getAttribute('href');if(!h||h.charAt(0)!=='#')return;
 e.preventDefault();var n=h.slice(1);
 var c=document.getElementById(n);
 if(location.hash.replace(/^#/,'')===n){if(c)c.scrollIntoView();return}
 location.hash=n})})();</script>`;
}

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
