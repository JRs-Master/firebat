import { NextResponse } from 'next/server';
import { getSystemModules, listUserModules } from '../../../../lib/api-gen/module';
import { withAuth } from '../../../../lib/with-api-error';

/** GET /api/fs/system-modules — 설정 화면이 그리는 모듈 목록.
 *
 * 시스템과 사용자 모듈을 **한 목록**으로 돌려준다. 사용자 모듈은 발견되고 실행되고 승인 게이트까지
 * 걸리는데 이 목록에만 없어서, 올린 사람이 자기 모듈을 끄지도 못했다 — 배관은 전부 scope 를 안 가리고
 * (`setModuleEnabled` 는 이름만 받고, config 조회는 system → services → user 순으로 찾는다) 이 한
 * 줄만 시스템 스캔이었다. 사용자 모듈의 존재 이유가 "코어 배포 없이 능력을 만든다"인데, 만든 것을
 * 끄려면 서버에 들어가야 했다.
 *
 * 한쪽이 실패해도 나머지는 돌려준다: 사용자 스캔이 없다고 시스템 목록까지 비면, 화면은 모듈이
 * 사라진 것처럼 보인다.
 */
export const GET = withAuth(async () => {
  const [sys, user] = await Promise.all([getSystemModules(), listUserModules()]);
  if (!sys.ok && !user.ok) {
    return NextResponse.json({ success: false, error: sys.message }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    modules: [...(sys.ok ? sys.data ?? [] : []), ...(user.ok ? user.data ?? [] : [])],
  });
});
