import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { listPending } from '../../../../lib/api-gen/ai';

/**
 * GET /api/plan/pending — cards still waiting for approval.
 *
 * A card could only ever be acted on by whoever held its `planId`, and the only place a `planId`
 * appeared was the chat message that produced it. A card created from anywhere else — an editor's
 * MCP client, the CLI, a script — was stored correctly and then had no surface: nothing listed it,
 * so nothing could approve it, while the caller was told the call had succeeded.
 *
 * Admin only, and the RPC returns only unscoped cards for an empty scope, so a hub visitor's card
 * cannot appear here.
 */
export const GET = withAuth(async (_req: NextRequest) => {
  const res = await listPending({ hubScope: '' });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 502 });
  return NextResponse.json({ success: true, data: res.data ?? [] });
});
