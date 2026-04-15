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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/** 공통 키 파일 경로 (~/.firebat/gcp-oauth.keys.json) */
const FIREBAT_DIR = path.join(/* turbopackIgnore: true */ os.homedir(), '.firebat');
const KEYS_PATH = path.join(FIREBAT_DIR, 'gcp-oauth.keys.json');

/** 서비스별 스코프 + credentials 경로 */
const OAUTH_SERVICES: Record<string, {
  credentialsPath: string;
  legacyPaths?: string[];  // 외부 MCP 패키지가 참조하는 경로 (호환용, 같이 저장)
  scopes: string[];
}> = {
  gmail: {
    credentialsPath: path.join(FIREBAT_DIR, 'credentials-gmail.json'),
    legacyPaths: [path.join(/* turbopackIgnore: true */ os.homedir(), '.gmail-mcp', 'credentials.json')],
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  },
  drive: {
    credentialsPath: path.join(FIREBAT_DIR, 'credentials-drive.json'),
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
    ],
  },
  calendar: {
    credentialsPath: path.join(FIREBAT_DIR, 'credentials-calendar.json'),
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  },
};

/** Nginx 리버스 프록시 뒤에서도 올바른 origin 반환 */
export function getOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost';
  return `${proto}://${host}`;
}

/** Google OAuth 키 파일 파싱 */
export function readOAuthKeys(): { clientId: string; clientSecret: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
    const cred = raw.web || raw.installed;
    if (!cred) return null;
    return { clientId: cred.client_id, clientSecret: cred.client_secret };
  } catch {
    return null;
  }
}

/** 서비스 키 찾기 (serverName에 gmail/drive/calendar 포함 시 매칭) */
export function findServiceKey(serverName: string): string | undefined {
  return Object.keys(OAUTH_SERVICES).find(k => serverName.toLowerCase().includes(k));
}

/** 서비스 설정 가져오기 */
export function getServiceConfig(key: string) {
  return OAUTH_SERVICES[key];
}

/** POST — OAuth URL 생성 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { serverName } = await req.json();
    if (!serverName) {
      return NextResponse.json({ success: false, error: 'serverName 필수' }, { status: 400 });
    }

    const serviceKey = findServiceKey(serverName);
    if (!serviceKey) {
      return NextResponse.json({ success: false, error: `'${serverName}'에 대한 OAuth 설정을 찾을 수 없습니다. 지원: ${Object.keys(OAUTH_SERVICES).join(', ')}` }, { status: 400 });
    }

    const service = OAUTH_SERVICES[serviceKey];

    // 키 파일 읽기
    if (!fs.existsSync(KEYS_PATH)) {
      return NextResponse.json({
        success: false,
        error: `OAuth 키 파일을 찾을 수 없습니다: ${KEYS_PATH}\n\nGoogle Cloud Console에서 OAuth 클라이언트 ID(웹 애플리케이션)를 만들고 JSON을 다운받아 위 경로에 배치하세요.`,
      }, { status: 400 });
    }

    const keys = readOAuthKeys();
    if (!keys) {
      return NextResponse.json({ success: false, error: 'OAuth 키 파일 파싱 실패. web 또는 installed 필드가 필요합니다.' }, { status: 400 });
    }

    // 이미 credentials가 있는지 확인
    if (fs.existsSync(service.credentialsPath)) {
      return NextResponse.json({
        success: true,
        alreadyAuthenticated: true,
        message: '이미 인증된 credentials가 존재합니다. 재인증하려면 기존 credentials를 삭제하세요.',
      });
    }

    // Google OAuth URL 생성
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
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** DELETE — credentials 삭제 (재인증용) */
export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const serverName = req.nextUrl.searchParams.get('server');
  if (!serverName) {
    return NextResponse.json({ success: false, error: 'server 필수' }, { status: 400 });
  }

  const serviceKey = findServiceKey(serverName);
  if (!serviceKey) {
    return NextResponse.json({ success: false, error: '알 수 없는 서버' }, { status: 400 });
  }

  const service = OAUTH_SERVICES[serviceKey];
  const allPaths = [service.credentialsPath, ...(service.legacyPaths ?? [])];
  for (const p of allPaths) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  return NextResponse.json({ success: true, message: 'credentials 삭제됨. 재인증 가능.' });
}
