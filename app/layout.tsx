import './globals.css';
import type { Metadata, Viewport } from 'next';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

// metadataBase — Next.js 가 OG 이미지·Twitter 카드 URL 을 절대경로로 해석할 때 기준.
// 미설정 시 localhost:3000 으로 폴백되어 SNS 크롤러가 이미지 못 가져옴.
// 우선순위: NEXT_PUBLIC_BASE_URL env → firebat.co.kr (기본) → 로컬 개발 fallback.
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL
  || (process.env.NODE_ENV === 'production' ? 'https://firebat.co.kr' : 'http://localhost:3000');

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
