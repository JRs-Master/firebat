/**
 * /api/auth/setup — 첫 부팅 시 초기 설정 wizard.
 *
 * GET   — `{ isAdminSetup: boolean }` 응답 (인증 불필요). frontend `/login` 이 호출 →
 *         false 면 SetupWizard 컴포넌트 렌더.
 * POST  — `{ adminId, adminPassword, siteLang, timezone }` 받아 Vault 저장 + 자동 로그인
 *         (세션 쿠키 발급). 인증 불필요.
 *
 * 보안:
 *   - GET = boolean 만 노출 (정보 누출 없음)
 *   - POST = 이미 설정 완료 시 403 거부 (재설정 차단). 변경은 어드민 설정 화면 경유.
 *   - proxy.ts 가 두 endpoint 인증 면제 처리.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { SESSION_MAX_AGE_SECONDS } from '../../../../lib/config';
import { isHttpsRequest } from '../../../../lib/cookie-helpers';

export async function GET(_req: NextRequest) {
  const core = getCore();
  // RustCoreProxy 의 autoUnwrapProtoEnvelope 박혀 BoolRequest `{value: bool}` 자동 unwrap.
  const isAdminSetup = await core.isAdminSetup();
  return NextResponse.json({ isAdminSetup: Boolean(isAdminSetup) });
}

export async function POST(req: NextRequest) {
  const core = getCore();

  // 이미 설정됨 = 재실행 거부 (변경은 어드민 설정 모달 경유).
  // RustCoreProxy autoUnwrap 박혀 isAdminSetup 직접 boolean 응답.
  if (await core.isAdminSetup()) {
    return NextResponse.json({ success: false }, { status: 403 });
  }

  const { adminId, adminPassword, siteLang, timezone } = await req.json();

  // 검증 — frontend 검증과 동일 정책 (server-side 재검증).
  if (!adminId || typeof adminId !== 'string' || !adminId.trim()) {
    return NextResponse.json({ success: false, error: '관리자 ID를 입력해 주세요.' }, { status: 400 });
  }
  // 8자 이상 + 4 categories 중 3 이상 — 컴플라이언스·NIST 절충 패턴
  if (!adminPassword || typeof adminPassword !== 'string' || adminPassword.length < 8) {
    return NextResponse.json(
      { success: false, error: '비밀번호는 8자 이상이어야 합니다.' },
      { status: 400 },
    );
  }
  let categories = 0;
  if (/[A-Z]/.test(adminPassword)) categories++;
  if (/[a-z]/.test(adminPassword)) categories++;
  if (/\d/.test(adminPassword)) categories++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(adminPassword)) categories++;
  if (categories < 3) {
    return NextResponse.json(
      { success: false, error: '비밀번호는 대문자·소문자·숫자·특수문자 중 3종류 이상을 포함해야 합니다.' },
      { status: 400 },
    );
  }
  if (adminPassword.toLowerCase() === adminId.trim().toLowerCase()) {
    return NextResponse.json({ success: false, error: '비밀번호는 ID와 동일할 수 없습니다.' }, { status: 400 });
  }
  if (!siteLang || (siteLang !== 'ko' && siteLang !== 'en')) {
    return NextResponse.json({ success: false, error: '언어는 ko 또는 en 이어야 합니다.' }, { status: 400 });
  }
  if (!timezone || typeof timezone !== 'string') {
    return NextResponse.json({ success: false, error: '시간대를 선택해 주세요.' }, { status: 400 });
  }

  // 1) 관리자 자격증명 저장
  await core.setAdminCredentials(adminId.trim(), adminPassword);

  // 2) 시간대 저장
  await core.setTimezone(timezone);

  // 3) 사용 언어 저장 — 두 vault key 동시 저장:
  //    - system:ui-lang — 어드민 UI 언어 (i18n 인프라 미박힘, 향후 도입 시 자동 활용)
  //    - cms.siteLang — 사이트 공개 언어 (HTML lang 속성 + SEO)
  //    초기엔 같은 값. 어드민 = ko / 사이트 = en 같이 분리하려면 어드민 설정 / CMS 모달에서 별도 변경.
  await core.setGeminiKey('system:ui-lang', siteLang);
  const cms = await core.getCmsSettings();
  const patched = { ...cms, siteLang };
  await core.setModuleSettings('cms', patched);

  // 4) 자동 로그인 — setAdminCredentials 직후 동일 자격증명으로 로그인 → 세션 토큰 발급
  const result = await core.login(adminId.trim(), adminPassword, 'setup');
  if (!result || typeof result !== 'object' || !('token' in result) || !result.token) {
    // 직후 호출이라 거의 무조건 성공이지만 안전망 (Vault write 실패 등)
    return NextResponse.json({ success: true, autoLogin: false });
  }
  const session = result as { token: string };

  const res = NextResponse.json({ success: true, autoLogin: true });
  res.cookies.set({
    name: 'firebat_token',
    value: session.token,
    httpOnly: true,
    secure: isHttpsRequest(req),
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
