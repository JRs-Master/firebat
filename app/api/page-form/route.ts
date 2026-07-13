import { NextRequest, NextResponse } from 'next/server';
import { get as getPageRpc } from '../../../lib/api-gen/page';
import { getVisibility as getProjectVisibility } from '../../../lib/api-gen/project';
import { runModule, getModuleConfig } from '../../../lib/api-gen/module';
import { parsePageRecord } from '../../../lib/util/page-pb-convert';

/**
 * POST /api/page-form — 발행(공개) 페이지 form 콜백 (익명 · page-scoped allowlist).
 *
 * 옛: form 컴포넌트가 admin 전용 /api/module/run 을 불러 공개 방문자는 무조건 401 —
 * 발행 앱의 form 이 장식이었음 (#9 보안 슬라이스 2). 이 route 가 익명 표면을 뚫되
 * 3중 게이트로 좁힌다:
 *   1. 페이지 실재 + 공개(public) — spec._visibility → 프로젝트 상속 (page.tsx 미러).
 *      password/private 페이지의 콜백은 잠금 (게이트 뒤 콘텐츠 = 보수적 거부).
 *   2. allowlist = 페이지 spec 자체 — body 의 form 블록이 선언한 bindModule 만 호출 가능.
 *      페이지 발행이 save_page 승인을 거치므로 "발행 승인 = 그 form 배선 승인" (별도 등록 0).
 *   3. requiresApproval 클래스(실주문 등) = 익명 표면 전면 거부 (config 선언 기반).
 * + IP당 rate limit (남용 방어). 실행은 admin 과 같은 gRPC RunModule(사람 표면 = 풀 데이터).
 */

export const dynamic = 'force-dynamic';

// IP당 분당 캡 — 단일 인스턴스 in-memory (restart 리셋 = 무해). Map 무한 성장은 상한에서 clear.
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = hits.get(ip);
  if (!h || now - h.t > RATE_WINDOW_MS) {
    hits.set(ip, { n: 1, t: now });
    return false;
  }
  h.n += 1;
  return h.n > RATE_MAX;
}

/** spec 트리에서 form 블록의 bindModule 수집 — 컨테이너(grid children / tabs items …)
 *  중첩 무관 generic 재귀 (블록 shape = {type, props} 만 가정). */
function collectFormModules(node: unknown, out: Set<string>) {
  if (Array.isArray(node)) {
    for (const c of node) collectFormModules(c, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
  const props = rec.props as Record<string, unknown> | undefined;
  if (type === 'form' && props && typeof props.bindModule === 'string') {
    out.add(props.bindModule);
  }
  for (const v of Object.values(rec)) collectFormModules(v, out);
}

export async function POST(req: NextRequest) {
  try {
    const { slug, module: moduleName, data } = await req.json();
    if (!slug || typeof slug !== 'string' || !moduleName || typeof moduleName !== 'string') {
      return NextResponse.json({ success: false, error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
    }
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (rateLimited(ip)) {
      return NextResponse.json({ success: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429 });
    }

    // 1) 페이지 실재 + 공개 여부 — 페이지 spec 이 곧 allowlist 소스.
    const pageRes = await getPageRpc({ slug });
    if (!pageRes.ok || !pageRes.data) {
      return NextResponse.json({ success: false, error: '페이지를 찾을 수 없습니다.' }, { status: 404 });
    }
    const spec = parsePageRecord(pageRes.data) as {
      _visibility?: string;
      project?: string;
      body?: unknown;
    };
    let visibility: string =
      spec._visibility === 'private' || spec._visibility === 'password' ? spec._visibility : 'public';
    if (visibility === 'public' && spec.project) {
      const pv = await getProjectVisibility({ project: spec.project });
      const projectVis = pv.ok ? (pv.data as string | undefined) : undefined;
      if (projectVis === 'private' || projectVis === 'password') visibility = projectVis;
    }
    if (visibility !== 'public') {
      return NextResponse.json({ success: false, error: '이 페이지에서는 사용할 수 없습니다.' }, { status: 403 });
    }

    // 2) allowlist — 페이지 body 의 form 블록이 선언한 모듈만.
    const allowed = new Set<string>();
    collectFormModules(spec.body, allowed);
    if (!allowed.has(moduleName)) {
      return NextResponse.json({ success: false, error: '이 페이지에 연결되지 않은 모듈입니다.' }, { status: 403 });
    }

    // 3) requiresApproval 선언 모듈(실주문 등) = 익명 표면 전면 거부.
    //    true = 전 액션 / [액션…] = 해당 액션 요청 시 거부 (config 선언형 게이트 미러).
    const cfgRes = await getModuleConfig({ name: moduleName });
    if (cfgRes.ok && cfgRes.data && typeof cfgRes.data === 'object') {
      const ra = (cfgRes.data as Record<string, unknown>).requiresApproval;
      const action = typeof (data as Record<string, unknown> | undefined)?.action === 'string'
        ? String((data as Record<string, unknown>).action)
        : '';
      const denied = ra === true || (Array.isArray(ra) && action !== '' && ra.includes(action));
      if (denied) {
        return NextResponse.json({ success: false, error: '이 모듈은 공개 페이지에서 실행할 수 없습니다.' }, { status: 403 });
      }
    }

    const res = await runModule({ module: moduleName, dataJson: JSON.stringify(data ?? {}) });
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    }
    const out = res.data;
    const parsedData = out.dataJson ? JSON.parse(out.dataJson) : undefined;
    return NextResponse.json(
      { success: out.success, data: parsedData, error: out.error },
      { status: out.success ? 200 : 400 },
    );
  } catch {
    return NextResponse.json({ success: false, error: '요청 처리에 실패했습니다.' }, { status: 500 });
  }
}
