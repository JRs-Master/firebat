/**
 * CmsSidebar — widget catalog 기반 렌더 (Phase A.3 단순화).
 *
 * sidebar.widgets 배열 박혀있으면 CmsWidget 호출. 사용자가 어드민 widget builder 에서
 * add/remove/reorder/props/visibility 편집. Legacy 6 toggle 은 composeLayout 이 자동
 * derive 해 widgets 배열 채워주므로 이 컴포넌트는 단일 path 유지.
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
