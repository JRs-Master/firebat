import './globals.css';
import type { Metadata, Viewport } from 'next';
import { getCore } from '../lib/singleton';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

// metadataBase — Next.js 가 OG 이미지·Twitter 카드 URL 을 절대경로로 해석할 때 기준.
// 범용 플랫폼이라 특정 도메인 하드코딩 X. 우선순위:
//   1. NEXT_PUBLIC_BASE_URL env (배포 시 명시)
//   2. dev fallback (localhost:3000)
// 동적 페이지 (blog/slug 등) 는 자체 generateMetadata 에서 SEO.siteUrl 기준 override 가능.
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

export async function generateMetadata(): Promise<Metadata> {
  const seo = getCore().getCmsSettings();
  return {
    metadataBase: new URL(BASE_URL),
    title: seo.siteTitle,
    description: seo.siteDescription,
    // 커스텀 favicon — /user/media/... 또는 외부 URL. 미지정 시 Next.js 기본 (app/icon.svg).
    ...(seo.faviconUrl ? { icons: { icon: seo.faviconUrl } } : {}),
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // SEO 설정 lang — 검색엔진 언어 인식 + 접근성. 미설정 시 'ko'.
  const seo = getCore().getCmsSettings();
  // 카카오맵 JS 키 — render_map 컴포넌트가 user / admin 양쪽 컨텍스트에서 모두 사용.
  // (user) layout 만 박으면 admin 채팅 미리보기에서 Leaflet 폴백 됨 → root layout 으로 통합.
  const kakaoMapJsKey = getCore().getKakaoMapJsKey() || '';
  return (
    <html lang={seo.siteLang || 'ko'}>
      <body className="antialiased bg-white text-gray-900">
        {kakaoMapJsKey && (
          <script
            dangerouslySetInnerHTML={{ __html: `window.__KAKAO_MAP_JS_KEY=${JSON.stringify(kakaoMapJsKey)};` }}
          />
        )}
        {children}
      </body>
    </html>
  );
}
