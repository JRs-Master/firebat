import { getCore } from '../../lib/singleton';
import { BASE_URL } from '../../infra/config';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

/** 루트 페이지 SEO 메타데이터 — SEO 모듈 설정에서 로드 */
export async function generateMetadata(): Promise<Metadata> {
  const seo = getCore().getSeoSettings();
  const siteUrl = seo.siteUrl || BASE_URL;

  const ogImage = `${siteUrl}/api/og?title=${encodeURIComponent(seo.siteTitle)}&description=${encodeURIComponent(seo.siteDescription)}`;

  return {
    title: seo.siteTitle,
    description: seo.siteDescription,
    openGraph: {
      title: seo.siteTitle,
      description: seo.siteDescription,
      url: siteUrl,
      siteName: seo.siteTitle,
      images: [ogImage],
      type: 'website',
    },
    robots: 'index, follow',
  };
}

export default function PublicPage() {
  return (
    <div className="h-dvh bg-white flex flex-col items-center justify-center font-sans tracking-tight overflow-hidden">
      <div className="text-center px-6">
        <h1 className="text-3xl sm:text-5xl font-extrabold text-black mb-3">Just Imagine.</h1>
        <p className="text-lg sm:text-2xl text-slate-500 font-semibold tracking-wide">Firebat runs.</p>
      </div>
    </div>
  );
}
