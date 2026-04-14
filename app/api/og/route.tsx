/**
 * OG 이미지 자동 생성 API
 *
 * GET /api/og → 1200×630 PNG 브랜드 카드 이미지
 * GET /api/og?title=제목&description=설명 → 페이지별 OG 이미지
 */
import { ImageResponse } from 'next/og';
import { getCore } from '../../../lib/singleton';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const seo = getCore().getSeoSettings();
  const rawTitle = searchParams.get('title');
  const rawDesc = searchParams.get('description');
  const isPageOg = !!rawTitle; // 페이지별 OG vs 기본 브랜드 OG
  const title = rawTitle || seo.siteTitle || 'Firebat';
  const description = rawDesc || seo.siteDescription || 'Just Imagine. Firebat Runs.';
  const bgColor = seo.ogBgColor || '#f8fafc';
  const accentColor = seo.ogAccentColor || '#2563eb';
  const domain = seo.ogDomain || 'firebat.co.kr';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: bgColor,
          fontFamily: 'sans-serif',
          position: 'relative',
        }}
      >
        {/* 상단 블루 라인 */}
        <div
          style={{
            position: 'absolute',
            top: '0',
            left: '0',
            right: '0',
            height: '5px',
            background: `linear-gradient(90deg, ${accentColor}, ${accentColor}88, ${accentColor})`,
          }}
        />

        {/* 배경 장식 */}
        <div
          style={{
            position: 'absolute',
            top: '-100px',
            right: '-100px',
            width: '500px',
            height: '500px',
            borderRadius: '50%',
            background: `radial-gradient(circle, ${accentColor}0F 0%, transparent 70%)`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: '-120px',
            left: '-80px',
            width: '450px',
            height: '450px',
            borderRadius: '50%',
            background: `radial-gradient(circle, ${accentColor}0A 0%, transparent 70%)`,
          }}
        />

        {/* 그리드 패턴 */}
        <div
          style={{
            position: 'absolute',
            inset: '0',
            backgroundImage: 'linear-gradient(rgba(0,0,0,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.03) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />

        {/* 중앙 브랜드 카드 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
          {/* 유령 로고 */}
          <div
            style={{
              width: '120px',
              height: '120px',
              borderRadius: '32px',
              background: `${accentColor}15`,
              border: `4px solid ${accentColor}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `0 16px 48px ${accentColor}26`,
            }}
          >
            <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 10h.01" />
              <path d="M15 10h.01" />
              <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
            </svg>
          </div>

          {/* 사이트 이름 */}
          <span style={{ fontSize: '120px', fontWeight: 900, color: '#0f172a', letterSpacing: '-0.04em', lineHeight: 1 }}>
            {isPageOg ? '' : title}
          </span>

          {/* 타이틀 (페이지별 OG일 때만) */}
          {isPageOg && (
            <span style={{ fontSize: title.length > 20 ? '72px' : '96px', fontWeight: 900, color: '#0f172a', letterSpacing: '-0.03em', lineHeight: 1.1, textAlign: 'center', maxWidth: '1000px' }}>
              {title}
            </span>
          )}

          {/* 설명 */}
          <span style={{ fontSize: '36px', fontWeight: 500, color: '#94a3b8', letterSpacing: '0.03em', textAlign: 'center', maxWidth: '900px', lineHeight: 1.4 }}>
            {description}
          </span>
        </div>

        {/* 하단 도메인 */}
        <div
          style={{
            position: 'absolute',
            bottom: '32px',
            right: '48px',
            fontSize: '20px',
            fontWeight: 600,
            color: '#cbd5e1',
          }}
        >
          {domain}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
