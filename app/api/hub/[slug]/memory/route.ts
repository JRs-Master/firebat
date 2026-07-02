import { NextRequest, NextResponse } from 'next/server';
import { listFiles, saveFile, deleteFile, readFile } from '../../../../../lib/api-gen/memory';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/memory — hub 테넌트의 data/memory (운영 규칙) CRUD dispatcher.
 *
 * 인증 = X-Api-Token + X-Session-Id → owner `hub:<inst>:<sid>` 자동 강제. Rust MemoryService 가
 * owner 로 격리(memory_file 매니저 owner-scoped). ops: list / save / delete / read.
 * admin 의 `/api/memory` 와 같은 백엔드, owner 만 다름(owner-injection 통합).
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;
  const owner = principal.owner;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'list': {
        const res = await listFiles({ owner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        const items = typeof res.data === 'string' ? JSON.parse(res.data) : (res.data ?? []);
        return NextResponse.json({ success: true, items });
      }
      case 'read': {
        if (!body.name) return jsonResponse(400, { error: 'name 필수' });
        const res = await readFile({ name: String(body.name), owner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        const entry = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        return NextResponse.json({ success: true, entry });
      }
      case 'save': {
        if (!body.name || typeof body.content !== 'string') return jsonResponse(400, { error: 'name + content 필수' });
        const res = await saveFile({
          name: String(body.name),
          content: String(body.content),
          category: typeof body.category === 'string' ? body.category : 'user',
          description: typeof body.description === 'string' ? body.description : '',
          owner,
        } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'delete': {
        if (!body.name) return jsonResponse(400, { error: 'name 필수' });
        const res = await deleteFile({ name: String(body.name), owner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-memory', 'op 실패', { op, error: err });
    return jsonResponse(500, { error: (err as Error)?.message ?? '서버 오류' });
  }
}

function jsonResponse(status: number, body: unknown) {
  return NextResponse.json(body, { status });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}
