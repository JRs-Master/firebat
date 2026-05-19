import { ConsoleLayoutInner } from '../admin/layout-client';

/**
 * Hub page mode 의 layout — admin/ConsoleLayoutInner reuse + hubMode prop.
 * 헤더 logout 버튼 자동 hide (anonymous 방문자).
 */
export default function HubLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleLayoutInner hubMode>{children}</ConsoleLayoutInner>;
}
