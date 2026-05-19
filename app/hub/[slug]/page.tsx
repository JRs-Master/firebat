import { notFound } from 'next/navigation';
import { getInstanceBySlug } from '../../../lib/api-gen/hub';
import { HubChatClient } from './HubChatClient';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Ctx): Promise<Metadata> {
  const { slug } = await params;
  const res = await getInstanceBySlug({ slug });
  if (!res.ok || !res.data?.instance || !res.data.instance.enabled || !res.data.instance.exposePage) {
    return { title: 'Not Found' };
  }
  const instance = res.data.instance;
  return {
    title: instance.name,
    description: instance.description || `${instance.name} 챗봇`,
    robots: 'noindex, nofollow',
  };
}

/**
 * Hub page mode — anonymous 방문자가 `/hub/<slug>` 접근 시 admin chat UI reuse + hubContext 박음.
 *
 * 흐름:
 *   1. server-side: hub instance 조회 + enabled + exposePage 가드
 *   2. client component (HubChatClient) 에 instance 박은 후 admin/ConsolePage reuse
 *   3. useChat 가 hubContext 박혀있으면 /api/hub/<slug>/chat SSE 분기 + sessionId / apiToken 헤더 박음
 */
export default async function HubPage({ params }: Ctx) {
  const { slug } = await params;
  const res = await getInstanceBySlug({ slug });
  if (!res.ok || !res.data?.instance) notFound();
  const instance = res.data.instance;
  if (!instance.enabled || !instance.exposePage) notFound();

  return (
    <HubChatClient
      slug={instance.slug}
      apiToken={instance.apiToken}
      instanceName={instance.name}
      instanceDescription={instance.description}
      modelId={instance.modelId || undefined}
    />
  );
}
