/**
 * CmsSidebar — widget catalog 기반 렌더 (Phase A.3 단순화).
 *
 * sidebar.widgets 배열 설정되어 있으면 CmsWidget 호출. 사용자가 어드민 widget builder 에서
 * add/remove/reorder/props/visibility 편집. 옛 토글(검색 · 최근 글 · 카테고리 · 태그 · 구독 · HTML)과
 * composeLayout 자동 derive 는 없어졌다 — 같은 일은 각 위젯(2026-11-23 설정 칸도 걷음).
 */
import type { SidebarConfig } from '../../lib/cms-layout';
import { CmsWidget } from './cms-widget-renderer';

export async function CmsSidebar({ sidebar }: { sidebar: SidebarConfig }) {
  const widgets = sidebar.widgets ?? [];
  if (widgets.length === 0) return null;
  return (
    <aside className="firebat-cms-sidebar">
      {widgets.map((slot, i) => (
        <CmsWidget key={i} slot={slot} area="sidebar" />
      ))}
    </aside>
  );
}
