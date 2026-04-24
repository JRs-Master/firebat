import './globals.css';
import type { Metadata, Viewport } from 'next';

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

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: 'Firebat',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="antialiased bg-white text-gray-900">
        {children}
      </body>
    </html>
  );
}
