import './globals.css';
// Pretendard self-host — Edge/Brave Tracking Prevention 에 막히던 jsdelivr CDN 대체.
// Next.js 가 woff2 hash + /_next/static/ 자동 처리.
import 'pretendard/dist/web/variable/pretendardvariable.css';
// KaTeX — AI 가 보내는 LaTeX 수식($...$ / \dfrac 등) 렌더용 CSS. 전역 1회 로드 (admin·user·hub·share 공통).
import 'katex/dist/katex.min.css';
import type { Metadata, Viewport } from 'next';

// force-dynamic — build 시 Rust core (127.0.0.1:50051) 미접근. root layout 의
// generateMetadata + RootLayout 가 모두 typed client 통과 → prerender 시도 시
// connection refused → build fail (NotFound + 모든 자식 페이지 영향).
// runtime (production server) 에서 Rust core 가 떠 있어 정상 응답.
export const dynamic = 'force-dynamic';
import { getCmsSettings, getComponentVendorKeys } from '../lib/api-gen/module';
import { resolveSiteUrl } from '../lib/site-url';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

// metadataBase — the origin Next resolves relative OG image / Twitter card URLs against.
// Same origin as every other page (resolveSiteUrl: CMS siteUrl → env → request host → dev fallback),
// so a bare deployment behind a domain doesn't advertise localhost.
export async function generateMetadata(): Promise<Metadata> {
  const seoRes = await getCmsSettings();
  const seo = (seoRes.ok ? seoRes.data : {}) as any;
  return {
    metadataBase: new URL(await resolveSiteUrl(seo.siteUrl)),
    title: seo.siteTitle,
    description: seo.siteDescription,
    // 커스텀 favicon — /user/media/... 또는 외부 URL. 미지정 시 Next.js 기본 (app/icon.svg).
    ...(seo.faviconUrl ? { icons: { icon: seo.faviconUrl } } : {}),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // SEO 설정 lang — 검색엔진 언어 인식 + 접근성. 미설정 시 'ko'.
  const seoRes = await getCmsSettings();
  const seo = (seoRes.ok ? seoRes.data : {}) as any;
  // 컴포넌트가 선언한 브라우저용 벤더 키(components.json `vendorKey`) — 렌더러가 자기 키 이름으로
  // 꺼내 쓴다. user / admin 양쪽 컨텍스트에서 쓰여 root layout 에서 한 번 주입.
  const vendorRes = await getComponentVendorKeys();
  const vendorKeys = (vendorRes.ok && vendorRes.data && typeof vendorRes.data === 'object') ? vendorRes.data : {};
  return (
    <html lang={seo.siteLang || 'ko'}>
      <body className="antialiased bg-white text-gray-900">
        {Object.keys(vendorKeys).length > 0 && (
          <script
            dangerouslySetInnerHTML={{ __html: `window.__VENDOR_KEYS=${JSON.stringify(vendorKeys)};` }}
          />
        )}
        {children}
      </body>
    </html>
  );
}
