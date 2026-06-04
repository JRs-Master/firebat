import { NextRequest, NextResponse } from 'next/server';
import { libraryOpDispatch } from '../../../../lib/handlers/library';
import { withAuth } from '../../../../lib/with-api-error';

/**
 * Library RPC dispatcher — POST /api/library/{op} (admin).
 *
 * `lib/api-gen/library` 가 `@connectrpc/connect-node` 를 transitively 가져와서 client component
 * (LibraryPanel 등) 가 직접 import 하면 Turbopack bundle 에 `node:http2` 포함 → 빌드 fail.
 * 그래서 client 는 본 dispatcher 를 통해 호출.
 *
 * op→RPC 매핑은 `lib/handlers/library.ts::libraryOpDispatch` 단일 소스 (hub 라우트와 공유).
 * admin 은 owner='admin' (또는 caller 지정). body = RPC args. 응답 = `{ success, data?, error? }`.
 */
interface Ctx { params: Promise<{ op: string }> }

export const POST = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const { op } = await params;
  const body = await req.json().catch(() => ({}));
  const owner = typeof body?.owner === 'string' && body.owner ? body.owner : 'admin';
  const result = await libraryOpDispatch(op, body, owner);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
});
