/**
 * `/notfound` route — (user) route group 안 미존재 slug / 비공개 페이지 안 `redirect('/notfound')` 박은 target.
 *
 * `/404` 안 박지 X 박은 사유 — Next.js App Router 안 reserved path 가능성 (`app/404/page.tsx`
 * 안 명시 매칭 안 박는 영역). `/notfound` 안 박은 영역 = 안전한 일반 path.
 *
 * 정공 흐름:
 *   1. `(user)/[...slug]/page.tsx` 안 `notFound()` 호출 시 = (user)/layout.tsx 안 자동 wrap (header 박힘)
 *   2. 대신 `redirect('/notfound')` 박음 → `/notfound` route 박힘 → root layout 만 (header 0)
 *   3. 본 page 안 `notFound()` 호출 → `app/not-found.tsx` render + **진짜 404 status**
 *
 * final 응답 = 308 redirect + 404 status (SEO 정공). header 0 + 단순 404 화면.
 */
import { notFound } from 'next/navigation';

export default function NotFoundRoute(): never {
  notFound();
}
