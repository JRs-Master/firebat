'use client';

/**
 * /admin/cms — CMS 풀페이지 + 라이브 미리보기.
 *
 * 진입 게이트: sessionStorage 'firebat_cms_entry' === '1' 일 때만 렌더.
 *   설정 모달 → 시스템 모듈 → CMS 클릭 시 flag set + router.push.
 *   페이지 mount 후 flag 즉시 소비 (one-shot). 직접 URL 진입 시 flag 없음 → /admin redirect.
 *
 * 보안 차원이라기보다 UX — 어드민 진입 흐름 안에서만 자연 노출.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CmsFullPage } from '../components/CmsFullPage';

export default function AdminCmsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flag = sessionStorage.getItem('firebat_cms_entry');
    if (flag !== '1') {
      router.replace('/admin');
      return;
    }
    // flag 일회성 소비 — 새로고침 시 다시 게이트 통과 안 함
    sessionStorage.removeItem('firebat_cms_entry');
    setAllowed(true);
  }, [router]);

  if (!allowed) return null;
  return (
    <CmsFullPage
      onClose={() => router.push('/admin')}
      onBack={() => router.push('/admin')}
    />
  );
}
