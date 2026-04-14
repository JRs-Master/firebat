import { getCore } from '../../lib/singleton';
import { SeoScripts } from './seo-scripts';

/** User 페이지 레이아웃 — SEO head/body 스크립트 주입 */
export default function UserLayout({ children }: { children: React.ReactNode }) {
  const seo = getCore().getSeoSettings();

  return (
    <>
      <SeoScripts headScripts={seo.headScripts} bodyScripts={seo.bodyScripts} />
      {children}
    </>
  );
}
