import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { createClient } from '@connectrpc/connect';
import { AiService } from '../../../../lib/proto-gen/firebat_pb';
import { transport } from '../../../../lib/api-gen/_transport';

export const dynamic = 'force-dynamic';

/**
 * "내 턴 아직 돌고 있나?" — 스트림을 잃은 클라이언트가 추측하는 대신 묻는 자리.
 *
 * 답은 서버 것이다: 턴은 듣는 사람이 있든 없든 detached 태스크가 DB 에 쓴다. 그래서 연결이
 * 끊겨도 토큰을 재생할 필요가 없고, 필요한 건 이 한 가지 판정뿐이다 — **아직 오는 중인가,
 * 이미 저장됐는가.** 이게 없어서 지금까지는 워치독이 늦게 터지길 기다렸다가 `TIMEOUT` 이라는
 * (턴은 멀쩡히 도는데) 거짓 문구를 띄우고 5초 폴링을 10분 돌렸다.
 *
 * `running:false` 인데 DB 에도 답이 없으면 그건 프로세스가 턴 중간에 재시작된 것 = 진짜 유실.
 * 그 경우는 폴링할 게 아니라 유실이라고 말해야 한다.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const turnId = req.nextUrl.searchParams.get('turnId') ?? '';
  if (!turnId) {
    return Response.json({ running: false, reason: 'turnId 가 없습니다.' }, { status: 400 });
  }
  try {
    const res = await createClient(AiService, transport).turnStatus({ turnId });
    return Response.json({ running: res.running });
  } catch (err) {
    // 서버에 못 물었다 = 모른다. 안 돈다고 단정하면 클라이언트가 살아 있는 턴을 유실로 표시한다.
    return Response.json(
      { running: null, reason: (err as Error)?.message ?? '상태를 확인하지 못했습니다.' },
      { status: 503 },
    );
  }
}
