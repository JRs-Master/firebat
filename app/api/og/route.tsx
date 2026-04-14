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
  const title = searchParams.get('title') || seo.siteTitle || 'Firebat';
  const description = searchParams.get('description') || seo.siteDescription || '';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
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
            background: 'linear-gradient(90deg, #2563eb, #60a5fa, #2563eb)',
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
            background: 'radial-gradient(circle, rgba(37,99,235,0.06) 0%, transparent 70%)',
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
            background: 'radial-gradient(circle, rgba(37,99,235,0.04) 0%, transparent 70%)',
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

        {/* 중앙 로고 + 텍스트 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '20px',
              background: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '42px',
              color: 'white',
              fontWeight: 900,
              boxShadow: '0 8px 32px rgba(15,23,42,0.15)',
            }}
          >
            F
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: title.length > 20 ? '32px' : '48px', fontWeight: 900, color: '#0f172a', letterSpacing: '-0.02em' }}>
              {title}
            </span>
            <span style={{ fontSize: '20px', fontWeight: 500, color: '#94a3b8', letterSpacing: '0.05em' }}>
              {description}
            </span>
          </div>
        </div>

        {/* 하단 도메인 */}
        <div
          style={{
            position: 'absolute',
            bottom: '32px',
            right: '48px',
            fontSize: '16px',
            fontWeight: 600,
            color: '#cbd5e1',
          }}
        >
          firebat.co.kr
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
