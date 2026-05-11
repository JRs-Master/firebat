'use client';

/**
 * User 영역 error boundary — 페이지 렌더 중 throw 발생 시 표시 (500).
 *
 * 'use client' 필수 — Next.js error.tsx 규칙. (user) layout 의 header/footer 자동 적용.
 * design tokens 통합. reset() 호출 시 페이지 재시도, 또는 홈으로 이동.
 *
 * 옛 transient 자동 reload 로직 제거 (2026-05-08) — root cause 안 잡힌 채로 무한 새로고침 회피.
 * digest 설정된 에러는 진짜 server-side issue 라 자동 reload 가 회복 못 함. 사용자 명시 클릭으로.
 */
import { usePublicTranslations } from '../../lib/i18n';

export default function Error({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = usePublicTranslations();

  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--cms-bg)' }}
    >
      <section className="firebat-cms-content text-center" style={{ paddingTop: '64px', paddingBottom: '64px' }}>
        <div
          className="text-7xl sm:text-8xl font-extrabold tracking-tighter mb-2"
          style={{
            color: 'var(--cms-down)',
            fontFamily: 'var(--cms-font-heading)',
            lineHeight: 1,
          }}
        >
          500
        </div>
        <h1
          className="text-2xl sm:text-3xl font-bold tracking-tight m-0"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          {t('page.error_title')}
        </h1>
        <p className="mt-3 text-base max-w-xl mx-auto" style={{ color: 'var(--cms-text-muted)' }}>
          {t('page.error_message')}
        </p>
        {error.digest && (
          <p className="mt-2 text-xs font-mono" style={{ color: 'var(--cms-text-muted)' }}>
            {t('page.error_id')}: {error.digest}
          </p>
        )}
      </section>
    </main>
  );
}
