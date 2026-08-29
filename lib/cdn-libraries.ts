/**
 * CDN 라이브러리 카탈로그 — Frontend 전용.
 *
 * AI 가 render_iframe 도구 호출 시 dependencies 배열만 선언 (예: ["d3", "echarts"]).
 * Frontend HtmlComp 가 이 카탈로그 보고 CDN script/link 태그 합성 후 iframe srcDoc 에 주입.
 *
 * Core 가 CDN URL 직접 다루지 않음 — BIBLE Core 순수성 원칙. v2.0 Rust 전환 시 이 파일은 frontend 에 그대로 남음.
 */

/**
 * 전용 render_* 컴포넌트로 흡수된 라이브러리는 이 카탈로그에서 제외 — render_iframe 우회 차단.
 *  - leaflet/kakao map → render_map
 *  - mermaid → render_diagram
 *  - katex → render_math
 *  - hljs → render_code
 *  - swiper → render_slideshow
 *  - lottie-web → render_lottie
 *  - cytoscape → render_network
 *
 * 여기 남는 키는 진짜 generic 시각화 (자유 d3 / threejs 3D / animejs / tailwind utility / mathjax / echarts / p5 / datatables / marked).
 */
export const CDN_LIBRARIES: Record<string, string> = {
  d3: '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>',
  threejs: '<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js"></script>', // r150+ 는 UMD(build/three.min.js, 전역 THREE) 제거 → r149.0 고정(전역 THREE 로딩 보장, 3D 게임용)
  animejs: '<script src="https://cdn.jsdelivr.net/npm/animejs@3/lib/anime.min.js"></script>',
  tailwindcss: '<script src="https://cdn.tailwindcss.com"></script>',
  marked: '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
  mathjax: '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>',
  echarts: '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
  p5: '<script src="https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js"></script>',
  datatables: '<link rel="stylesheet" href="https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css"/><script src="https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js"></script><script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>',
};

/** A resolved `dependencies` list: tags to inject, hosts they need, and what we could not place. */
export interface ResolvedDeps {
  tags: string;
  /** Hosts to grant in this block's CSP, on top of the standing allowlist. */
  hosts: string[];
  /** Names that matched nothing — reported, never dropped in silence. */
  unknown: string[];
}

const HOST_RE = /https:\/\/[a-z0-9.-]+/gi;

/**
 * `dependencies` -> the tags to put in the frame.
 *
 * Two forms are accepted. A **name** from the catalog above is the shortcut. An **https URL** is
 * the escape hatch: a page needing a library the catalog never heard of should be fixable in its
 * own declaration, not by editing this file and shipping a frontend build. `.css` becomes a
 * stylesheet, anything else a script, and the host is granted in that block's CSP — otherwise the
 * tag would load into a policy that refuses it, which is the silent blank frame again.
 *
 * Anything else comes back in `unknown`. It used to be `filter(Boolean)`: the name was accepted,
 * dropped, and nothing anywhere said so — the exact shape of a declaration that does not work and
 * cannot be fixed by whoever wrote it.
 */
export function resolveDeps(deps?: string[]): ResolvedDeps {
  const out: ResolvedDeps = { tags: '', hosts: [], unknown: [] };
  if (!deps?.length) return out;
  const tags: string[] = [];
  for (const raw of deps) {
    const d = String(raw ?? '').trim();
    if (!d) continue;
    const known = CDN_LIBRARIES[d];
    if (known) {
      tags.push(known);
      out.hosts.push(...(known.match(HOST_RE) ?? []));
      continue;
    }
    if (/^https:\/\/[^\s"'<>]+$/.test(d)) {
      tags.push(/\.css($|\?)/i.test(d) ? `<link rel="stylesheet" href="${d}"/>` : `<script src="${d}"></script>`);
      out.hosts.push(...(d.match(HOST_RE) ?? []));
      continue;
    }
    out.unknown.push(d);
  }
  out.tags = tags.join('\n');
  out.hosts = [...new Set(out.hosts)];
  return out;
}

/** Back-compat shim for callers that only want the tags. */
export function buildCdnTags(deps?: string[]): string {
  return resolveDeps(deps).tags;
}

/** A console line inside the frame for names we could not place — the only surface an already-
 *  rendered page has to say "this dependency did nothing". */
export function unknownDepsNotice(unknown: string[]): string {
  if (!unknown.length) return '';
  const list = JSON.stringify(unknown);
  const keys = JSON.stringify(Object.keys(CDN_LIBRARIES));
  return `<script>console.error('[firebat] unknown dependencies: ' + ${list}.join(', ') + ' — use one of ' + ${keys}.join(', ') + ', or give the full https:// URL of the script.')</script>`;
}

/** AI 에 노출할 사용 가능 라이브러리 키 목록 — prompt 에서 enumerate */
export const CDN_LIBRARY_KEYS = Object.keys(CDN_LIBRARIES);

/**
 * Iframe srcdoc 안에서 동작할 CSP — defense-in-depth.
 *
 * sandbox="allow-scripts" 가 이미 origin 격리하지만, 추가로 script-src 를 신뢰 CDN 화이트리스트로 제한 →
 * AI 가 hallucinate 한 외부 도메인 (예: malicious cryptominer CDN) 또는 인젝션 시도된 외부 script 차단.
 * 'unsafe-inline' 은 CDN 라이브러리 초기화 코드 (mermaid.initialize() 등) 가 inline 으로 들어가야 하므로 허용.
 *
 * 화이트리스트 — 위 CDN_LIBRARIES 가 사용하는 호스트만:
 *   - cdn.jsdelivr.net (대부분), unpkg.com (leaflet), cdnjs.cloudflare.com (예비),
 *   - cdn.tailwindcss.com (tailwind), cdn.datatables.net (datatables css)
 *
 * frame-src 'none' — 중첩 iframe 차단 (clickjacking + 외부 사이트 임베딩 방지).
 * connect-src https: — D3 fetch 등 데이터 가져오기 허용 (HTTPS 만).
 * img-src 'self' data: https: — base64 + 외부 이미지 허용.
 * 일반 로직 — 특정 도구·콘텐츠별 분기 X. 모든 render_iframe / inline html 통과.
 */
export const IFRAME_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://cdn.datatables.net; " +
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://cdn.datatables.net https://fonts.googleapis.com; " +
  "img-src 'self' data: blob: https:; " +
  "font-src https: data:; " +
  "connect-src https:; " +
  "frame-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none';";

/** CSP meta tag — srcdoc head 에 prepend. */
export const IFRAME_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">`;

/**
 * The same policy, widened by the hosts this block's own dependencies need.
 *
 * The standing allowlist covers the catalog. A block that named a URL outside it would otherwise
 * get its tag injected and then blocked — served, not executed, with nothing on the page to say so.
 * Granting exactly what the block declared keeps the policy closed to everything else.
 */
export function iframeCspMeta(extraHosts: string[]): string {
  const hosts = [...new Set(extraHosts.filter(h => /^https:\/\/[a-z0-9.-]+$/i.test(h)))];
  if (!hosts.length) return IFRAME_CSP_META;
  const extra = ' ' + hosts.join(' ');
  const csp = IFRAME_CSP
    .replace('script-src ', 'script-src' + extra + ' ')
    .replace('style-src ', 'style-src' + extra + ' ');
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
}
