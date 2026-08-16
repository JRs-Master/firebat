import { NextResponse } from 'next/server';
import { listUserModules } from '../../../../lib/api-gen/module';
import { withAuth } from '../../../../lib/with-api-error';

/** GET /api/fs/user-modules — `user/` 아래 모듈만.
 *
 * 별도 라우트인 것이 요점이다. 사용자 모듈은 발견·실행·승인 게이트를 시스템 모듈과 똑같이 받지만
 * 목록에서는 갈라져야 한다: 설정 화면은 둘 다 그려야 끄고 켤 수 있고, hub 인스턴스의 allow 후보는
 * 시스템 것뿐이어야 한다. 한 라우트가 둘을 합쳐 주면 후자가 조용히 전자를 따라간다.
 */
export const GET = withAuth(async () => {
  const res = await listUserModules();
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, modules: res.data ?? [] });
});
