/**
 * `/404` route — (user) route group 안 미존재 slug / 비공개 페이지 안 `redirect('/404')` 박은 target.
 *
 * 정공 흐름:
 *   1. `(user)/[...slug]/page.tsx` 안 `notFound()` 호출 시 = (user)/layout.tsx 안 자동 wrap (header 박힘)
 *   2. 대신 `redirect('/404')` 박음 → `/404` route 박힘 → root layout 만 (header 0)
 *   3. 본 page 안 `notFound()` 호출 → `app/not-found.tsx` render + **진짜 404 status**
 *
 * final 응답 = 308 redirect + 404 status (SEO 정공). header 0 + 단순 404 화면.
 */
import { notFound } from 'next/navigation';

export default function NotFoundRoute(): never {
  notFound();
}
