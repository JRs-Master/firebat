interface Props {
  headScripts: string;
  bodyScripts: string;
}

/** SEO 스크립트 SSR 주입 — 관리자가 설정한 HTML 을 초기 server-rendered HTML 에 박음.
 *
 *  이전 client-side useEffect 방식은 AdSense 같은 crawler 가 JS 실행 안 해서 발견 불가.
 *  SSR 박으면 초기 HTML 에 그대로 들어가 crawler 인식 OK.
 *
 *  Layout 은 Next.js App Router 의 nested layout 이라 한 번만 렌더 (페이지 이동 시 re-render X).
 *  즉 script 중복 주입 위험 0 — cleanup 불필요.
 *
 *  보안: admin 만 설정 가능 (CMS 모듈 인증 게이트). XSS 위험은 운영자 자기 책임.
 */
export function SeoScripts({ headScripts, bodyScripts }: Props) {
  if (!headScripts && !bodyScripts) return null;
  return (
    <>
      {headScripts && (
        <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: headScripts }} />
      )}
      {bodyScripts && (
        <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: bodyScripts }} />
      )}
    </>
  );
}
