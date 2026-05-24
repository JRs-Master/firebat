'use client';

import { ConsolePage, type HubContext } from '../../admin/page';

/**
 * Hub page mode client wrapper — admin ConsolePage reuse + hubContext 전달.
 * server component (page.tsx) 에서 instance 조회 후 본 컴포넌트에 props 로 전달.
 */
export function HubChatClient(props: HubContext) {
  return <ConsolePage hubContext={props} />;
}
