import { NextResponse } from 'next/server';
import { getSystemModules } from '../../../../lib/api-gen/module';
import { withAuth } from '../../../../lib/with-api-error';

/** GET /api/fs/system-modules — `system/` 아래 모듈만.
 *
 * 사용자 모듈은 여기 오지 않는다. 이 목록의 소비자 중 하나가 hub 인스턴스의 allow 후보이고,
 * `user/` 는 그 인스턴스를 쓰는 사람이 자기 용도로 올린 것이지 남에게 줄 대상이 아니다. 공용으로
 * 쓸 것이면 `system/` 으로 내는 것이 그 구분의 뜻이다. 설정 목록은 `/api/fs/user-modules` 를 함께
 * 부른다 — 합치는 판단은 그 화면의 것이고, 이름이 `system-modules` 인 곳의 것이 아니다.
 */
export const GET = withAuth(async () => {
  const res = await getSystemModules();
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, modules: res.data ?? [] });
});
