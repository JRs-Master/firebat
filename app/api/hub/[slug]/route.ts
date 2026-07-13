import { NextRequest, NextResponse } from 'next/server';
import {
  createInstance,
  listInstances,
  getInstance,
  getInstanceBySlug,
  updateInstance,
  deleteInstance,
  rotateApiToken,
  authenticate,
  ensureConversation,
  listConversations,
  getConversation,
  deleteConversation,
  updateConversationTitle,
  appendUserMessage,
  appendSystemMessage,
  listMessages,
} from '../../../../lib/api-gen/hub';
import { withAuth } from '../../../../lib/with-api-error';
import { ApiError } from '../../../../lib/api-error';

/**
 * Hub RPC dispatcher — POST /api/hub/{op}.
 *
 * 경로 param 이름이 {slug} 인 사유: Next.js 가 같은 부모 폴더 안 sibling dynamic
 * 라우트끼리 param 이름 동일을 강제 (외부 chat endpoint 가 /api/hub/[slug]/chat).
 * 의미상으로는 op 이름 (create-instance / list-instances 등) 가 들어옴.
 *
 * client component (HubPanel / InstanceDetail) 가 호출. 옛 Library 패턴 동일
 * (lib/api-gen/hub 의 _transport 가 @connectrpc/connect-node 포함 → client
 * 직접 import 시 node:http2 bundle 영역 fail).
 *
 * 외부 endpoint (POST /api/hub/<slug>/chat) 는 sibling route — 단계 7 신설.
 * 본 dispatcher = admin UI 전용 (인증 필요).
 */
interface Ctx { params: Promise<{ slug: string }> }

export const POST = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const { slug } = await params;
  const body = await req.json().catch(() => ({}));

  const result = await dispatch(slug, body);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
});

async function dispatch(op: string, args: any): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  switch (op) {
    // Instance CRUD
    case 'create-instance':
      return createInstance({
        slug: String(args?.slug ?? ''),
        name: String(args?.name ?? ''),
        description: args?.description ?? '',
        systemPrompt: args?.systemPrompt ?? '',
        allowedReferences: Array.isArray(args?.allowedReferences) ? args.allowedReferences.map(String) : [],
        allowedSysmods: Array.isArray(args?.allowedSysmods) ? args.allowedSysmods.map(String) : [],
        modelId: args?.modelId ?? '',
        enabled: args?.enabled !== false,
        allowedDomains: Array.isArray(args?.allowedDomains) ? args.allowedDomains.map(String) : [],
        // 노출 모드 — undefined / null = backend default (둘 다 true)
        exposeWidget: typeof args?.exposeWidget === 'boolean' ? args.exposeWidget : undefined,
        exposePage: typeof args?.exposePage === 'boolean' ? args.exposePage : undefined,
        // instance kind — 'tenant'(풀 워크스페이스) | 'widget'(임베드 챗봇). 그 외 값 = backend default('widget')
        kind: args?.kind === 'tenant' || args?.kind === 'widget' ? args.kind : undefined,
      });
    case 'list-instances':
      return listInstances();
    case 'get-instance':
      return getInstance({ id: String(args?.id ?? '') });
    case 'get-instance-by-slug':
      return getInstanceBySlug({ slug: String(args?.slug ?? '') });
    case 'update-instance':
      return updateInstance({
        id: String(args?.id ?? ''),
        name: args?.name,
        description: args?.description,
        systemPrompt: args?.systemPrompt,
        allowedReferences: Array.isArray(args?.allowedReferences) ? args.allowedReferences.map(String) : [],
        replaceAllowedReferences: args?.replaceAllowedReferences === true,
        allowedSysmods: Array.isArray(args?.allowedSysmods) ? args.allowedSysmods.map(String) : [],
        replaceAllowedSysmods: args?.replaceAllowedSysmods === true,
        modelId: args?.modelId,
        enabled: args?.enabled,
        allowedDomains: Array.isArray(args?.allowedDomains) ? args.allowedDomains.map(String) : [],
        replaceAllowedDomains: args?.replaceAllowedDomains === true,
        exposeWidget: typeof args?.exposeWidget === 'boolean' ? args.exposeWidget : undefined,
        exposePage: typeof args?.exposePage === 'boolean' ? args.exposePage : undefined,
        kind: args?.kind === 'tenant' || args?.kind === 'widget' ? args.kind : undefined,
      });
    case 'delete-instance':
      return deleteInstance({ id: String(args?.id ?? '') });
    case 'rotate-api-token':
      return rotateApiToken({ id: String(args?.id ?? '') });

    // 외부 검증 (admin 영역에서도 인증 검증 호출 가능)
    case 'authenticate':
      return authenticate({
        slug: String(args?.slug ?? ''),
        apiToken: String(args?.apiToken ?? ''),
        origin: args?.origin ?? '',
      });

    // Conversation
    case 'ensure-conversation':
      return ensureConversation({
        instanceId: String(args?.instanceId ?? ''),
        sessionId: String(args?.sessionId ?? ''),
      });
    case 'list-conversations':
      return listConversations({
        instanceId: String(args?.instanceId ?? ''),
        sessionId: String(args?.sessionId ?? ''),
      });
    case 'get-conversation':
      return getConversation({ id: String(args?.id ?? '') });
    case 'delete-conversation':
      return deleteConversation({ id: String(args?.id ?? '') });
    case 'update-conversation-title':
      return updateConversationTitle({
        id: String(args?.id ?? ''),
        title: String(args?.title ?? ''),
      });

    // Message
    case 'append-user-message':
      return appendUserMessage({
        conversationId: String(args?.conversationId ?? ''),
        content: String(args?.content ?? ''),
      });
    case 'append-system-message':
      return appendSystemMessage({
        conversationId: String(args?.conversationId ?? ''),
        content: args?.content ?? '',
        dataJson: args?.dataJson ?? '',
      });
    case 'list-messages':
      return listMessages({ conversationId: String(args?.conversationId ?? '') });

    default:
      throw new ApiError(400, `지원되지 않는 op: ${op}`);
  }
}
