import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { createClient } from '@connectrpc/connect';
import { AiService } from '../../../../lib/proto-gen/firebat_pb';
import { transport } from '../../../../lib/api-gen/_transport';

export const dynamic = 'force-dynamic';

/**
 * 진행 중인 채팅 턴 취소 — **중지 버튼 전용**.
 *
 * 왜 별도 엔드포인트인가: 스트림 라우트의 `abortSignal` 은 탭 닫기·네트워크 끊김과 중지 버튼을
 * 구분하지 못한다. 끊김일 때 턴을 죽이면 백그라운드 재개(탭을 닫아도 답이 저장되는 것)가 깨지고,
 * 반대로 살려 두면 중지가 안 먹는다 — 실측(2026-07-29): 오타로 중지한 뒤 다시 보냈더니 두 턴이
 * 동시에 돌아 CLI 두 개가 기동하고 답이 2개 저장됐다. 그래서 중지는 **명시적 신호**로 보낸다.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  let turnId = '';
  try {
    turnId = String(((await req.json()) as { turnId?: string })?.turnId ?? '');
  } catch {
    /* 본문 없음 = 취소할 대상 없음 */
  }
  if (!turnId) {
    return Response.json({ cancelled: false, reason: 'turnId 가 없습니다.' }, { status: 400 });
  }
  try {
    const res = await createClient(AiService, transport).cancelTurn({ turnId });
    // cancelled=false = 그 턴이 이미 끝났다는 뜻(경합). 오류가 아니라 정상 응답이다.
    return Response.json({ cancelled: res.cancelled });
  } catch (err) {
    return Response.json(
      { cancelled: false, reason: (err as Error)?.message ?? '취소 요청에 실패했습니다.' },
      { status: 500 },
    );
  }
}
