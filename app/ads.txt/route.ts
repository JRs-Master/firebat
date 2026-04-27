/**
 * /ads.txt — 광고 publisher 인증 (AdSense / 다른 ad 네트워크).
 *
 * 형식 (IAB 표준):
 *   google.com, pub-XXXXXXXX, DIRECT, f08c47fec0942fa0
 *   (또는 여러 줄 — adsTxt 텍스트 자체는 사용자가 어드민 SEO 모듈에서 자유 입력)
 *
 * Content-Type: text/plain (필수 — IAB 스펙).
 * 미설정 시 빈 응답 (404 아님 — 광고 미사용 사이트도 정상).
 */
import { getCore } from '../../lib/singleton';

export const dynamic = 'force-dynamic';

export async function GET() {
  const seo = getCore().getCmsSettings();
  const content = seo.adsTxt || '';
  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
