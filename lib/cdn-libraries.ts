/**
 * CDN 라이브러리 카탈로그 — Frontend 전용.
 *
 * AI 가 render_html 도구 호출 시 dependencies 배열만 선언 (예: ["d3", "echarts"]).
 * Frontend HtmlComp 가 이 카탈로그 보고 CDN script/link 태그 합성 후 iframe srcDoc 에 주입.
 *
 * Core 가 CDN URL 직접 다루지 않음 — BIBLE Core 순수성 원칙. v2.0 Rust 전환 시 이 파일은 frontend 에 그대로 남음.
 */

export const CDN_LIBRARIES: Record<string, string> = {
  d3: '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>',
  mermaid: '<script src="https://cdn.jsdelivr.net/npm/mermaid@10"></script>',
  leaflet: '<link rel="stylesheet" href="https://unpkg.com/leaflet@1/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1/dist/leaflet.js"></script>',
  threejs: '<script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js"></script>',
  animejs: '<script src="https://cdn.jsdelivr.net/npm/animejs@3/lib/anime.min.js"></script>',
  tailwindcss: '<script src="https://cdn.tailwindcss.com"></script>',
  katex: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"/><script src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js"></script>',
  hljs: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css"/><script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>',
  marked: '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
  cytoscape: '<script src="https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js"></script>',
  mathjax: '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>',
  echarts: '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
  p5: '<script src="https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js"></script>',
  lottie: '<script src="https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie.min.js"></script>',
  datatables: '<link rel="stylesheet" href="https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css"/><script src="https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js"></script><script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>',
  swiper: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css"/><script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
};

/** dependencies 배열 → CDN 태그 문자열 합성. 미등록 키는 silently skip. */
export function buildCdnTags(deps?: string[]): string {
  if (!deps || deps.length === 0) return '';
  return deps.map(k => CDN_LIBRARIES[k]).filter(Boolean).join('\n');
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
 * 일반 로직 — 특정 도구·콘텐츠별 분기 X. 모든 render_html / inline html 통과.
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
