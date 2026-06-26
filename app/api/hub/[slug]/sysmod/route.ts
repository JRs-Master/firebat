import { NextRequest, NextResponse } from 'next/server';
import { runModule } from '../../../../../lib/api-gen/module';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/sysmod — 익명 hub 방문자의 sysmod 호출 dispatcher.
 *
 * 인증 = X-Api-Token + X-Session-Id. 호출 sysmod = instance.allowed_sysmods 매칭 + 안전 list 매칭.
 * input.data._hubScope = instance.id 자동 강제 — sysmod 가 자기 hub 데이터 디렉토리 사용.
 *
 * Body: `{ module: 'notes' | 'calendar' | ..., action: string, ...data }`
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

// hub visitor 가 호출 가능한 sysmod whitelist — 외부 API 통합 (kakao / naver 등) 차단.
// 자체 host 데이터 sysmod 만 허용. 새 sysmod 추가 시 본 list 갱신 필요.
const HUB_ALLOWED_SYSMODS = new Set(['notes', 'calendar']);

async function authHub(
  req: NextRequest,
  slug: string,
): Promise<{ ok: true; instanceId: string; sessionId: string } | { ok: false; response: NextResponse }> {
  // sessionId 형식 검증(path 스코프 traversal 차단)은 resolvePrincipal 안에 통합됨.
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return { ok: false, response: principal };
  return { ok: true, instanceId: principal.hubInstance!.id, sessionId: principal.sessionId! };
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 }); }

  const moduleName = String(body.module ?? '');
  if (!moduleName) return NextResponse.json({ success: false, error: 'module 필수' }, { status: 400 });

  // 안전 list 매칭 — notes / calendar = 사이드바 패널 안 visitor 본인 데이터 sysmod (자체 host).
  // 외부 시스템 통합 sysmod (kakao / naver / kiwoom 등 admin 자격 필요) 는 본 list 부재로 차단.
  // instance.allowed_sysmods (AI 도구 호출 허용 list, admin 설정) 와는 별개 — sidebar panel 기본
  // 기능이라 allowed_sysmods 매칭 가드 적용 안 함. 옛 = allowed_sysmods 가드 때문에 visitor 사이드바
  // calendar/notes panel 이 403 (demo instance 의 allowed_sysmods 에 미포함 시).
  if (!HUB_ALLOWED_SYSMODS.has(moduleName)) {
    return NextResponse.json({ success: false, error: `hub 안 허용되지 않은 sysmod: ${moduleName}` }, { status: 403 });
  }

  // visitor 별 격리 — _hubScope = `<instance_id>:<session_id>` 자동 주입.
  // sysmod 가 resolveNotesDir / resolveCalDir 안에서 분리 (data/hub/<inst>/<sid>/notes/...).
  const moduleInput = {
    action: String(body.action ?? ''),
    ...body.data,
    _hubScope: `${auth.instanceId}:${auth.sessionId}`,
  };

  try {
    const res = await runModule({
      module: moduleName,
      data: JSON.stringify(moduleInput),
    } as any);
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    // runModule 응답 parse — output.data 영역 unwrap.
    const data = res.data as any;
    return NextResponse.json({ success: true, data: data?.data ?? data, raw: data });
  } catch (err) {
    logger.debug('hub-sysmod', 'op 실패', { module: moduleName, error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
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
