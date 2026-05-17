import { NextRequest, NextResponse } from 'next/server';
import {
  createReference,
  listReferences,
  deleteReference,
  uploadSource,
  listSources,
  getSource,
  deleteSource,
  search,
} from '../../../../lib/api-gen/library';
import { withAuth } from '../../../../lib/with-api-error';
import { ApiError } from '../../../../lib/api-error';

/**
 * Library RPC dispatcher — POST /api/library/{op}.
 *
 * `lib/api-gen/library` 가 `@connectrpc/connect-node` 를 transitively 가져와서
 * client component (LibraryPanel 등) 가 직접 import 하면 Turbopack bundle 에
 * `node:http2` 가 박혀 빌드 fail. 그래서 client 는 본 dispatcher 를 통해 호출.
 *
 * 8 op:
 *  - list-references / create-reference / delete-reference
 *  - list-sources / get-source / delete-source
 *  - upload-text-source (textarea inline_text 전용; 파일 업로드는 /api/library/upload-and-extract)
 *  - search
 *
 * body = RPC args 그대로. 응답 = `{ success, data?, error? }`.
 */
interface Ctx { params: Promise<{ op: string }> }

export const POST = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const { op } = await params;
  const body = await req.json().catch(() => ({}));

  const result = await dispatch(op, body);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
});

async function dispatch(op: string, args: any): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  switch (op) {
    case 'list-references':
      return listReferences({ owner: args?.owner ?? 'admin' });
    case 'create-reference':
      return createReference({
        name: String(args?.name ?? ''),
        description: args?.description ?? '',
        owner: args?.owner ?? 'admin',
      });
    case 'delete-reference':
      return deleteReference({ id: String(args?.id ?? '') });
    case 'list-sources':
      return listSources({ referenceId: String(args?.referenceId ?? '') });
    case 'get-source':
      return getSource({ id: String(args?.id ?? '') });
    case 'delete-source':
      return deleteSource({ id: String(args?.id ?? '') });
    case 'upload-text-source':
      return uploadSource({
        referenceId: String(args?.referenceId ?? ''),
        name: String(args?.name ?? ''),
        sourceType: 'text',
        inlineText: String(args?.inlineText ?? ''),
      });
    case 'search':
      return search({
        owner: args?.owner ?? 'admin',
        query: String(args?.query ?? ''),
        referenceIds: Array.isArray(args?.referenceIds) ? args.referenceIds.map(String) : [],
        topK: typeof args?.topK === 'number' ? BigInt(args.topK) : BigInt(0),
      });
    default:
      throw new ApiError(400, `지원되지 않는 op: ${op}`);
  }
}
