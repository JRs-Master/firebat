'use client';

/**
 * User 영역 error boundary — 페이지 render 안 throw 박힌 영역 안 client-side redirect to `/500`.
 *
 * 옛 영역 안 자체 500 page render 박은 영역 = (user) layout 안 자동 wrap (header 박힘).
 * 사용자 의도 X. 새 흐름 — useEffect 안 router.replace('/500') 박음. `/500` route 안 root
 * layout 만 wrap (header 0).
 *
 * render 박지 X (null 반환) — FOUC 미세. error 정보 (digest 등) 안 표시 X — `/500` page
 * 안 단순 안내만.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Error({
  error: _error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    router.replace('/500');
  }, [router]);
  return null;
}
