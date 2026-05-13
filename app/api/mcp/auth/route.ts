/**
 * MCP 서버 OAuth 인증 헬퍼
 *
 * POST /api/mcp/auth — OAuth URL 생성 (팝업 → 콜백 자동 처리)
 *   body: { serverName: string }
 *   response: { authUrl: string, redirectUri: string }
 *
 * DELETE /api/mcp/auth?server=xxx — credentials 삭제 (재인증용)
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';

// fs/path/os는 Turbopack NFT 추적 방지를 위해 함수 내부에서 동적 로드
function getFs(): typeof import('fs') { return require('fs'); }
function getPath(): typeof import('path') { return require('path'); }
function getOs(): typeof import('os') { return require('os'); }

/** 공통 키 파일 경로 (~/.firebat/gcp-oauth.keys.json) — lazy 초기화 */
function getFirebatDir() { return getPath().join(getOs().homedir(), '.firebat'); }
function getKeysPath() { return getPath().join(getFirebatDir(), 'gcp-oauth.keys.json'); }

/** 서비스별 스코프 + credentials 경로 */
function getOAuthServices(): Record<string, {
  credentialsPath: string;
  legacyPaths?: string[];
  scopes: string[];
}> {
  const p = getPath();
  const dir = getFirebatDir();
  return {
    gmail: {
      credentialsPath: p.join(dir, 'credentials-gmail.json'),
      legacyPaths: [p.join(getOs().homedir(), '.gmail-mcp', 'credentials.json')],
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
    },
    drive: {
      credentialsPath: p.join(dir, 'credentials-drive.json'),
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.file',
      ],
    },
    calendar: {
      credentialsPath: p.join(dir, 'credentials-calendar.json'),
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
      ],
    },
  };
}

/** Nginx 리버스 프록시 뒤에서도 올바른 origin 반환 */
export function getOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost';
  return `${proto}://${host}`;
}

/** Google OAuth 키 파일 파싱 */
export function readOAuthKeys(): { clientId: string; clientSecret: string } | null {
  try {
    const raw = JSON.parse(getFs().readFileSync(getKeysPath(), 'utf-8'));
    const cred = raw.web || raw.installed;
    if (!cred) return null;
    return { clientId: cred.client_id, clientSecret: cred.client_secret };
  } catch {
    return null;
  }
}

/** 서비스 키 찾기 (serverName에 gmail/drive/calendar 포함 시 매칭) */
export function findServiceKey(serverName: string): string | undefined {
  return Object.keys(getOAuthServices()).find(k => serverName.toLowerCase().includes(k));
}

/** 서비스 설정 가져오기 */
export function getServiceConfig(key: string) {
  return getOAuthServices()[key];
}

/** POST — OAuth URL 생성 */
export const POST = withAuth(async (req: NextRequest) => {
  const { serverName } = await req.json();
  if (!serverName) {
    return NextResponse.json({ success: false, error: 'serverName 필수' }, { status: 400 });
  }

  const serviceKey = findServiceKey(serverName);
  if (!serviceKey) {
    return NextResponse.json({ success: false, error: `'${serverName}'에 대한 OAuth 설정을 찾을 수 없습니다. 지원: ${Object.keys(getOAuthServices()).join(', ')}` }, { status: 400 });
  }

  const service = getOAuthServices()[serviceKey];
  const keysPath = getKeysPath();

  if (!getFs().existsSync(keysPath)) {
    return NextResponse.json({
      success: false,
      error: `OAuth 키 파일을 찾을 수 없습니다: ${keysPath}\n\nGoogle Cloud Console에서 OAuth 클라이언트 ID(웹 애플리케이션)를 만들고 JSON을 다운받아 위 경로에 배치하세요.`,
    }, { status: 400 });
  }

  const keys = readOAuthKeys();
  if (!keys) {
    return NextResponse.json({ success: false, error: 'OAuth 키 파일 파싱 실패. web 또는 installed 필드가 필요합니다.' }, { status: 400 });
  }

  if (getFs().existsSync(service.credentialsPath)) {
    return NextResponse.json({
      success: true,
      alreadyAuthenticated: true,
      message: '이미 인증된 credentials가 존재합니다. 재인증하려면 기존 credentials를 삭제하세요.',
    });
  }

  const redirectUri = `${getOrigin(req)}/api/mcp/auth/callback`;
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(keys.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(service.scopes.join(' '))}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${encodeURIComponent(serviceKey)}`;

  return NextResponse.json({
    success: true,
    authUrl,
    redirectUri,
    configKey: serviceKey,
  });
});

/** DELETE — credentials 삭제 (재인증용) */
export const DELETE = withAuth(async (req: NextRequest) => {
  const serverName = req.nextUrl.searchParams.get('server');
  if (!serverName) {
    return NextResponse.json({ success: false, error: 'server 필수' }, { status: 400 });
  }

  const serviceKey = findServiceKey(serverName);
  if (!serviceKey) {
    return NextResponse.json({ success: false, error: '알 수 없는 서버' }, { status: 400 });
  }

  const service = getOAuthServices()[serviceKey];
  const allPaths = [service.credentialsPath, ...(service.legacyPaths ?? [])];
  const f = getFs();
  for (const p of allPaths) {
    if (f.existsSync(p)) f.unlinkSync(p);
  }

  return NextResponse.json({ success: true, message: 'credentials 삭제됨. 재인증 가능.' });
});
