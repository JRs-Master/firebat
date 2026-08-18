import { NextResponse } from 'next/server';
import { withAuth } from '../../../../../lib/with-api-error';
import { listSystem, listUser, getConfig } from '../../../../../lib/api-gen/module';

/** GET /api/settings/modules/page-exports — 어떤 모듈이 "페이지 → 문서 내보내기"를 제공하는가.
 *
 *  손목록이 아니라 선언 파생: 켜진 모듈의 config `pageExport` = [{action, label}] 를 모아
 *  돌려준다. 새 내보내기 모듈은 선언 한 줄로 사이드바 메뉴에 나타난다 — 프론트 수정 0
 *  ("모듈은 선언하고 프레임워크가 준다"). */
export const GET = withAuth(async () => {
  const [sys, usr] = await Promise.all([listSystem(), listUser()]);
  const mods = [...(sys.ok ? sys.data : []), ...(usr.ok ? usr.data : [])]
    .filter((m) => (m as { enabled?: boolean }).enabled);
  const exports: { module: string; action: string; label: string }[] = [];
  await Promise.all(mods.map(async (m) => {
    const cfg = await getConfig({ name: m.name });
    if (!cfg.ok || !cfg.data || typeof cfg.data !== 'object') return;
    const decl = (cfg.data as { pageExport?: unknown }).pageExport;
    if (!Array.isArray(decl)) return;
    for (const row of decl) {
      if (row && typeof row === 'object'
          && typeof (row as { action?: unknown }).action === 'string'
          && typeof (row as { label?: unknown }).label === 'string') {
        exports.push({
          module: m.name,
          action: (row as { action: string }).action,
          label: (row as { label: string }).label,
        });
      }
    }
  }));
  return NextResponse.json({ success: true, exports });
});
