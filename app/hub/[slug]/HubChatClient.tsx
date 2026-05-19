'use client';

import { ConsolePage, type HubContext } from '../../admin/page';

/**
 * Hub page mode client wrapper — admin ConsolePage reuse + hubContext 박음.
 * server component (page.tsx) 에서 instance 조회 후 본 컴포넌트에 props 박음.
 */
export function HubChatClient(props: HubContext) {
  return <ConsolePage hubContext={props} />;
}
