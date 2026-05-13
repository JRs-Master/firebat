import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

/** GET /api/vault/secrets — 사용자 시크릿 키 목록 (값은 마스킹) + 유저 모듈 필요 시크릿 */
export const GET = withAuth(async () => {
  const core = getCore();
  const names = await core.listUserSecrets();
  const secrets = await Promise.all(names.map(async (name: string) => {
    const value = await core.getUserSecret(name);
    return {
      name,
      hasValue: !!value,
      maskedValue: value
        ? (value.length > 10 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '***')
        : '',
    };
  }));
  // 유저 모듈 config.json에서 필요한 시크릿 자동 수집
  const moduleSecrets = await core.listUserModuleSecrets();
  return NextResponse.json({ success: true, secrets, moduleSecrets });
});

/** POST /api/vault/secrets — 사용자 시크릿 저장 { name, value } */
export const POST = withAuth(async (req: NextRequest) => {
  const { name, value } = await req.json();
  if (!name || typeof name !== 'string') {
    return NextResponse.json({ success: false, error: 'name 필수' }, { status: 400 });
  }
  if (!value || typeof value !== 'string') {
    return NextResponse.json({ success: false, error: 'value 필수' }, { status: 400 });
  }
  // 키 이름 검증: 영문, 숫자, 하이픈, 언더스코어만
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return NextResponse.json({ success: false, error: '키 이름은 영문, 숫자, -, _ 만 가능합니다.' }, { status: 400 });
  }
  const saved = await getCore().setUserSecret(name, value);
  return saved
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: '저장 실패' }, { status: 500 });
});

/** DELETE /api/vault/secrets?name=xxx — 사용자 시크릿 삭제 */
export const DELETE = withAuth(async (req: NextRequest) => {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: 'name 필요' }, { status: 400 });

  const deleted = await getCore().deleteUserSecret(name);
  return deleted
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: '삭제 실패' }, { status: 500 });
});
