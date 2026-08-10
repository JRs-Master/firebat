interface Props {
  headScripts: string;
  bodyScripts: string;
}

/** SEO 스크립트 SSR 주입 — head 행은 문자열이 아니라 **진짜 엘리먼트**로 렌더한다.
 *
 *  measured defect (2026-08-10, 구 node 서버 실측 — rust CMS 도 같은 모양이었다):
 *  "headScripts" 를 dangerouslySetInnerHTML <div> 로 렌더하면 그 div 는 **body** 에 남는다.
 *  AdSense 심사 크롤러는 원본 HTML 의 <head> 에서 로더 태그를 찾으므로, 관리자가 head 스크립트
 *  칸에 넣은 태그가 심사에는 보이지 않았다 — 반려가 반복된 유력 원인.
 *
 *  React 19 hoistables 가 정공: `<script async src>` · `<meta>` · `<link>` 를 트리 어디서
 *  렌더하든 SSR 초기 HTML 의 <head> 로 끌어올린다. 그래서 입력 문자열에서 그 셋을 파싱해
 *  엘리먼트로 렌더하고(→ head 착지), 나머지(인라인 script 등 호이스팅 불가분)는 기존대로
 *  body div 폴백 — 기능은 동일하고, 크롤러가 head 에서 봐야 하는 것들만 자리를 찾아간다.
 *
 *  Layout 은 nested layout 이라 한 번만 렌더 — 중복 주입 위험 0, cleanup 불필요.
 *  보안: admin 만 설정 가능 (CMS 모듈 인증 게이트). XSS 위험은 운영자 자기 책임 (기존과 동일).
 */

const HOISTABLE_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<meta\b[^>]*\/?>|<link\b[^>]*\/?>/gi;

/** HTML attribute 이름 → React prop 이름 (DOM 예약어만; data-* 등은 그대로 통과). */
const REACT_ATTR: Record<string, string> = {
  crossorigin: 'crossOrigin',
  referrerpolicy: 'referrerPolicy',
  hreflang: 'hrefLang',
  charset: 'charSet',
  'http-equiv': 'httpEquiv',
  fetchpriority: 'fetchPriority',
  imagesrcset: 'imageSrcSet',
  imagesizes: 'imageSizes',
};

function parseAttrs(tag: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const inner = tag.replace(/^<[a-zA-Z]+/, '').replace(/\/?\s*>[\s\S]*$/, '');
  const re = /([a-zA-Z_][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    out[REACT_ATTR[name] ?? name] = value === undefined ? true : value;
  }
  return out;
}

export function SeoScripts({ headScripts, bodyScripts }: Props) {
  if (!headScripts && !bodyScripts) return null;

  const hoisted: React.ReactNode[] = [];
  let rest = headScripts || '';
  if (headScripts) {
    rest = headScripts.replace(HOISTABLE_RE, (tag) => {
      const lower = tag.toLowerCase();
      if (lower.startsWith('<script')) {
        const attrs = parseAttrs(tag);
        // 외부 async 로더만 호이스팅 — defer/inline 은 순서·실행 의미가 있어 자리 보존.
        if (typeof attrs.src === 'string' && attrs.async) {
          hoisted.push(<script key={hoisted.length} {...attrs} />);
          return '';
        }
        return tag; // 폴백 유지분
      }
      const attrs = parseAttrs(tag);
      if (lower.startsWith('<meta')) {
        hoisted.push(<meta key={hoisted.length} {...attrs} />);
      } else {
        hoisted.push(<link key={hoisted.length} {...attrs} />);
      }
      return '';
    });
    rest = rest.trim();
  }

  return (
    <>
      {hoisted}
      {rest && (
        <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: rest }} />
      )}
      {bodyScripts && (
        <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: bodyScripts }} />
      )}
    </>
  );
}
