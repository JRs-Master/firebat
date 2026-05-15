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
import { isAdminSetup, validatePasswordPolicy, setAdminCredentials, login } from '../../../../lib/api-gen/auth';
import { setTimezone } from '../../../../lib/api-gen/settings';
import { setSystem as setSystemSecret } from '../../../../lib/api-gen/secret';
import { getCmsSettings, setModuleSettings } from '../../../../lib/api-gen/module';
import { SESSION_MAX_AGE_SECONDS, SESSION_COOKIE_NAME } from '../../../../lib/config';
import { isHttpsRequest } from '../../../../lib/cookie-helpers';
import { VK_SYSTEM_UI_LANG } from '../../../../lib/proto-gen/vault-keys';

export async function GET(_req: NextRequest) {
  const res = await isAdminSetup();
  if (!res.ok) {
    return NextResponse.json({ isAdminSetup: false });
  }
  return NextResponse.json({ isAdminSetup: Boolean(res.data) });
}

export async function POST(req: NextRequest) {
  // 이미 설정됨 = 재실행 거부 (변경은 어드민 설정 모달 경유).
  const setupRes = await isAdminSetup();
  if (setupRes.ok && setupRes.data === true) {
    return NextResponse.json({ success: false }, { status: 403 });
  }

  const { adminId, adminPassword, siteLang, timezone } = await req.json();

  // ID 검증 — 빈 문자열 차단
  if (!adminId || typeof adminId !== 'string' || !adminId.trim()) {
    return NextResponse.json({ success: false, error: '관리자 ID를 입력해 주세요.' }, { status: 400 });
  }
  if (!adminPassword || typeof adminPassword !== 'string') {
    return NextResponse.json({ success: false, error: '비밀번호를 입력해 주세요.' }, { status: 400 });
  }
  // 비번 정책 검증 — Rust validatePasswordPolicy single source (8자 + 3 카테고리 + ID 동일 금지).
  const policy = await validatePasswordPolicy({ password: adminPassword, id: adminId.trim() });
  if (!policy.ok) {
    return NextResponse.json(
      { success: false, error: policy.message || '비밀번호 정책 위반' },
      { status: 400 },
    );
  }
  if (!siteLang || (siteLang !== 'ko' && siteLang !== 'en')) {
    return NextResponse.json({ success: false, error: '언어는 ko 또는 en 이어야 합니다.' }, { status: 400 });
  }
  if (!timezone || typeof timezone !== 'string') {
    return NextResponse.json({ success: false, error: '시간대를 선택해 주세요.' }, { status: 400 });
  }

  // 1) 관리자 자격증명 저장
  const credRes = await setAdminCredentials({ id: adminId.trim(), password: adminPassword });
  if (!credRes.ok) {
    return NextResponse.json({ success: false, error: credRes.message }, { status: 500 });
  }

  // 2) 시간대 저장
  const tzRes = await setTimezone({ timezone: timezone });
  if (!tzRes.ok) {
    return NextResponse.json({ success: false, error: tzRes.message }, { status: 500 });
  }

  // 3) 사용 언어 저장 — 두 vault key 동시 저장:
  //    - system:ui-lang — 어드민 UI 언어 (i18n 인프라 미설정, 향후 도입 시 자동 활용)
  //    - cms.siteLang — 사이트 공개 언어 (HTML lang 속성 + SEO)
  //    초기엔 같은 값. 어드민 = ko / 사이트 = en 같이 분리하려면 어드민 설정 / CMS 모달에서 별도 변경.
  const uiLangRes = await setSystemSecret({ key: VK_SYSTEM_UI_LANG, value: siteLang });
  if (!uiLangRes.ok) {
    return NextResponse.json({ success: false, error: uiLangRes.message }, { status: 500 });
  }
  const cmsRes = await getCmsSettings();
  if (!cmsRes.ok) {
    return NextResponse.json({ success: false, error: cmsRes.message }, { status: 500 });
  }
  const cms = cmsRes.data as Record<string, unknown>;
  const patched = { ...cms, siteLang };
  const moduleRes = await setModuleSettings({ name: 'cms', settingsJson: JSON.stringify(patched) });
  if (!moduleRes.ok) {
    return NextResponse.json({ success: false, error: moduleRes.message }, { status: 500 });
  }

  // 4) 자동 로그인 — setAdminCredentials 직후 동일 자격증명으로 로그인 → 세션 토큰 발급
  const loginRes = await login({ id: adminId.trim(), password: adminPassword, attemptKey: 'setup' });
  if (!loginRes.ok) {
    return NextResponse.json({ success: true, autoLogin: false });
  }
  const lr = loginRes.data;
  if (!lr.ok || !lr.session || !lr.session.token) {
    // 직후 호출이라 거의 무조건 성공이지만 안전망 (Vault write 실패 등)
    return NextResponse.json({ success: true, autoLogin: false });
  }
  const session = lr.session;

  const res = NextResponse.json({ success: true, autoLogin: true });
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.token,
    httpOnly: true,
    secure: isHttpsRequest(req),
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
