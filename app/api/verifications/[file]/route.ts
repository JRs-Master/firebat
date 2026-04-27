/**
 * 사이트 소유권 인증 파일 통합 응답 — CMS verifications 배열에서 매칭.
 *
 * `/google1234.html`, `/naverabc.html`, `/BingSiteAuth.xml`, `/yandex_xxx.html`,
 * `/ads.txt` 등 모든 인증 서비스 파일을 next.config.mjs rewrites 로 받아 raw 응답.
 *
 * 새 인증 서비스 추가 시 코드 변경 0 — 어드민 CMS UI 의 verifications 배열에
 * (filename, content) 추가하면 됨.
 *
 * Content-Type: 확장자 자동 추론 (.txt → text/plain, .html → text/html, .xml → application/xml).
 * 미매칭 시 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

export const dynamic = 'force-dynamic';

function contentTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'txt') return 'text/plain; charset=utf-8';
  if (ext === 'html' || ext === 'htm') return 'text/html; charset=utf-8';
  if (ext === 'xml') return 'application/xml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  // path traversal 차단
  if (!file || file.includes('/') || file.includes('..')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const cms = getCore().getCmsSettings();
  const match = cms.verifications.find(v => v.filename === file);
  if (!match) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return new NextResponse(match.content, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(file),
      // 인증 파일은 자주 fetch 되지 않으므로 1시간 캐시. 변경 시 어드민이 admin UI 에서 즉시 갱신.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
