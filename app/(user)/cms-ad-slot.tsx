'use client';
/**
 * CMS AdSlot — Phase 4 Step 6. 어드민이 박은 슬롯 ID 로 AdSense 광고 단위 표시.
 *
 * `<ins class="adsbygoogle">` + `data-ad-client` (publisher ID) + `data-ad-slot` (슬롯 ID).
 * `useEffect` 로 `(adsbygoogle = window.adsbygoogle || []).push({})` 호출 — 광고 fetch 트리거.
 *
 * 빈 슬롯 ID 면 미렌더 (조건부 호출 — layout.tsx 가 처리).
 */
import { useEffect } from 'react';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

export function CmsAdSlot({ publisherId, slotId, format = 'auto' }: {
  publisherId: string;
  slotId: string;
  format?: string;
}) {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // AdSense script 미로드 또는 차단 — silent
    }
  }, []);

  return (
    <div className="firebat-cms-content" style={{ paddingTop: '12px', paddingBottom: '12px' }}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', textAlign: 'center' }}
        data-ad-client={publisherId}
        data-ad-slot={slotId}
        data-ad-format={format}
        data-full-width-responsive="true"
      />
    </div>
  );
}
