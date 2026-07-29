/**
 * 페이지↔모듈 바인딩 — TS 측 공유 게이트 + when=request SSR resolver.
 *
 * 게이트는 Rust `core/src/utils/page_binding.rs::binding_gate` 의 미러(단일 정책):
 *   1. 모듈 config 에 `pageBinding: {alias?, action}` 선언(opt-in 폐쇄 집합) — 미선언 = 거부
 *   2. 요청 액션 = 선언 액션만 (블록이 action 을 생략하면 선언 액션 사용)
 *   3. requiresApproval 액션(실주문 등) = 페이지 표면 전면 거부
 *
 * request-resolve 는 **신규 공개 endpoint 가 아니라 발행 페이지 SSR(RSC) 내부**에서만 돈다 —
 * 공격 표면 불증가. 익명 GET 플러드 방어 = TTL 캐시(방문자 수 무관 바인딩당 TTL 에 1회 실행)
 * + single-flight(스탬피드 방지). 실패 = 저장된 `_baked` 폴백(stale-but-alive).
 */

import { getModuleConfig } from './api-gen/module';
import { resolveBinding } from './api-gen/page';

type Json = Record<string, unknown>;

/** 모듈 config 캐시 — 요청마다 gRPC GetConfig 왕복 방지 (5분). */
const configCache = new Map<string, { cfg: Json | null; t: number }>();
const CONFIG_TTL_MS = 5 * 60_000;

async function moduleConfig(name: string): Promise<Json | null> {
  const now = Date.now();
  if (configCache.size > 500) configCache.clear();
  const hit = configCache.get(name);
  if (hit && now - hit.t < CONFIG_TTL_MS) return hit.cfg;
  const res = await getModuleConfig({ name }).catch(() => null);
  const cfg = res?.ok && res.data && typeof res.data === 'object' ? (res.data as Json) : null;
  configCache.set(name, { cfg, t: now });
  return cfg;
}

/** Rust binding_gate 미러 — 통과 시 실행할 액션명 반환, 거부 시 null. */
export async function pageBindingGate(moduleName: string, requestedAction: string): Promise<string | null> {
  const cfg = await moduleConfig(moduleName);
  if (!cfg) return null;
  const pb = cfg.pageBinding as Json | undefined;
  const declared = typeof pb?.action === 'string' ? (pb.action as string).trim() : '';
  if (!declared) return null; // pageBinding 미선언 = opt-in 아님
  const action = requestedAction.trim() || declared;
  // 추가 선언 액션(pageBinding.actions) 도 허용 — Rust binding_gate `allows()` 미러.
  const extra = pb?.actions as Json | undefined;
  const allowed = action === declared || !!(extra && typeof extra === 'object' && action in extra);
  if (!allowed) return null;
  const ra = cfg.requiresApproval;
  if (ra === true || (Array.isArray(ra) && ra.includes(action))) return null;
  return action;
}

/** page-form 공용 — requiresApproval 거부 판정 (form 은 pageBinding 미요구라 별도 노출). */
export async function moduleActionDenied(moduleName: string, action: string): Promise<boolean> {
  const cfg = await moduleConfig(moduleName);
  if (!cfg) return false; // config 없음 = run 쪽 미존재 에러에 위임
  const ra = cfg.requiresApproval;
  return ra === true || (Array.isArray(ra) && action !== '' && ra.includes(action));
}

// ── when=request SSR resolver ────────────────────────────────────────────────

/** 결과 캐시 — 키 = slug+블록경로+args 해시. TTL = 블록 cacheTtl(초, clamp 60~3600, 기본 300). */
const resultCache = new Map<string, { blocks: unknown[]; t: number; ttlMs: number }>();
/** single-flight — 같은 키 동시 요청은 한 실행을 공유 (익명 트래픽 스탬피드 방지). */
const inflight = new Map<string, Promise<unknown[] | null>>();

function cacheKey(slug: string, path: string, module: string, action: string, args: unknown): string {
  return `${slug}|${path}|${module}|${action}|${JSON.stringify(args ?? {})}`;
}

function clampTtlMs(raw: unknown): number {
  const sec = typeof raw === 'number' && Number.isFinite(raw) ? raw : 300;
  return Math.min(3600, Math.max(60, Math.floor(sec))) * 1000;
}

/**
 * 실행 = Rust 단일 소스 (`PageService.ResolveBinding` → `page_binding::resolve_binding`,
 * publish-bake 와 같은 함수). 옛 TS 재구현은 봉투 방언(params wrap)·config args 병합·선언형
 * blocks 템플릿 렌더를 전부 빠뜨려 kiwoom 류에서 방문-resolve 가 원리적으로 실패했다 — 실행
 * 의미론은 두 곳에 두지 않는다. TS 몫 = 게이트 선필터 + TTL 캐시 + single-flight 뿐.
 */
async function runBinding(moduleName: string, action: string, args: unknown): Promise<unknown[] | null> {
  const argsJson = args && typeof args === 'object' ? JSON.stringify(args) : '';
  const res = await resolveBinding({ module: moduleName, action, argsJson }).catch(() => null);
  if (!res?.ok || !res.data?.success || !res.data.blocksJson) return null;
  try {
    const blocks = JSON.parse(res.data.blocksJson);
    if (!Array.isArray(blocks) || blocks.length === 0) return null;
    return blocks;
  } catch {
    return null;
  }
}

/**
 * body 트리의 `when:"request"` module 블록을 SSR 시점에 resolve — `_baked` 를 최신 결과로 교체.
 * 게이트 거부·실행 실패 = 저장된 `_baked` 그대로(폴백). body 를 in-place 변형 후 반환.
 * 호출 전제: 페이지 visibility 게이트(public 판정)를 이미 통과한 RSC 흐름 안.
 */
export async function resolveRequestBindings(body: unknown, slug: string): Promise<void> {
  const tasks: Promise<void>[] = [];
  walk(body, '0', tasks, slug);
  if (tasks.length > 0) await Promise.all(tasks);
}

/** 라이브 컴포넌트 type — seed 바인딩 fresh-on-visit resolve 대상. */
const LIVE_SEED_TYPES = new Set(['live_stock_chart', 'livestockchart', 'live_chart', 'livechart']);

function walk(node: unknown, path: string, tasks: Promise<void>[], slug: string) {
  if (Array.isArray(node)) {
    node.forEach((c, i) => walk(c, `${path}.${i}`, tasks, slug));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Json;
  const type = typeof rec.type === 'string' ? (rec.type as string).toLowerCase() : '';
  if (type === 'module') {
    const props = rec.props as Json | undefined;
    if (props && props.when === 'request' && typeof props.module === 'string') {
      tasks.push(resolveOne(props, path, slug));
    }
    return; // _baked 안쪽으로 하강 금지 (Rust walk 미러)
  }
  // 라이브 봉/라인 차트 — seed:{module,action,args} 선언 시 방문마다 최신 시드 재fetch(정기 페이지의
  // 생성시점 스냅샷 갭 해소). 라이브 틱은 그 위에서 이어짐. 게이트 = 일반 module 바인딩과 동일.
  if (LIVE_SEED_TYPES.has(type)) {
    const props = rec.props as Json | undefined;
    const seed = props?.seed as Json | undefined;
    if (props && seed && typeof seed.module === 'string') {
      tasks.push(resolveLiveSeed(props, seed, path, slug));
    }
    return;
  }
  for (const v of Object.values(rec)) walk(v, path, tasks, slug);
}

/** 라이브 시드 resolve — pageBinding 게이트로 모듈을 방문 시점 실행하고, 반환 블록에서 캔들 배열
 *  (첫 번째 `props.data` 배열)을 뽑아 라이브 블록의 `data`(시드)로 주입. 실패 = 기존 data 유지. */
async function resolveLiveSeed(props: Json, seed: Json, path: string, slug: string): Promise<void> {
  const moduleName = String(seed.module);
  const requested = typeof seed.action === 'string' ? (seed.action as string) : '';
  const action = await pageBindingGate(moduleName, requested);
  if (!action) return;
  const key = cacheKey(slug, `${path}#seed`, moduleName, action, seed.args);
  const ttlMs = clampTtlMs(props.cacheTtl);
  const now = Date.now();
  if (resultCache.size > 1000) resultCache.clear();
  const hit = resultCache.get(key);
  if (!hit || now - hit.t >= hit.ttlMs) {
    let p = inflight.get(key);
    if (!p) {
      p = runBinding(moduleName, action, seed.args).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const blocks = await p;
    if (blocks) resultCache.set(key, { blocks, t: now, ttlMs });
  }
  const cached = resultCache.get(key);
  const rows = cached ? firstDataArray(cached.blocks) : null;
  if (rows && rows.length > 0) props.data = rows;
  if (rows && rows.length > 0 && props.derive) await resolveDerived(props, rows, path, slug);
}

/** 시드 봉을 받아 **파생 분석**을 방문 시점에 재계산 — `derive:{module,action,args?}`.
 *
 *  왜 필요한가: `seed` 는 봉만 새로 가져오므로 그 봉으로 계산한 분석(엘리엇 파동·추세선 등)은
 *  페이지 생성 시점에 굳어 버린다. 실측 페이지가 정확히 그랬다 — 봉은 최신인데 파동 분석은
 *  몇 시간 전 텍스트였고("실시간인데 실시간이 아니다"), 차트엔 주석이 아예 없었다.
 *
 *  계약 = pageBinding 그대로 — 파생 모듈이 렌더 블록을 반환하고, 그 **첫 블록의 props**(data 제외)를
 *  라이브 차트 props 에 병합한다. 무엇을 그릴지는 모듈이 소유하고 프레임워크는 추측하지 않는다.
 *  봉은 선언한 인자 이름(기본 `bars`)으로 주입한다. 실패 = 조용히 주석 없이(차트는 살아 있음). */
async function resolveDerived(props: Json, rows: unknown[], path: string, slug: string): Promise<void> {
  const d = props.derive as Json | undefined;
  if (!d || typeof d.module !== 'string') return;
  const moduleName = String(d.module);
  const action = await pageBindingGate(moduleName, typeof d.action === 'string' ? (d.action as string) : '');
  if (!action) return;
  const barsArg = typeof d.barsArg === 'string' && d.barsArg ? (d.barsArg as string) : 'bars';
  const args = { ...((d.args as Record<string, unknown>) ?? {}), [barsArg]: rows };
  // 캐시 키에 봉 개수·마지막 봉을 섞는다 — 같은 시드면 재계산 0, 새 봉이 오면 자동 무효화.
  const lastRow = rows[rows.length - 1];
  const stamp = `${rows.length}:${typeof lastRow === 'object' && lastRow ? String((lastRow as Json).date ?? '') : ''}`;
  const key = cacheKey(slug, `${path}#derive:${stamp}`, moduleName, action, d.args);
  const ttlMs = clampTtlMs(props.cacheTtl);
  const now = Date.now();
  const hit = resultCache.get(key);
  if (!hit || now - hit.t >= hit.ttlMs) {
    let p = inflight.get(key);
    if (!p) {
      p = runBinding(moduleName, action, args).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const blocks = await p;
    if (blocks) resultCache.set(key, { blocks, t: now, ttlMs });
  }
  const first = resultCache.get(key)?.blocks?.[0];
  const derived = first && typeof first === 'object' ? ((first as Json).props as Json | undefined) : undefined;
  if (!derived) return;
  for (const [k, v] of Object.entries(derived)) {
    // 선언(seed/derive)은 덮지 않는다. `data` 는 **덮는다** — 파생 모듈이 봉을 돌려줬다면
    // "내가 분석한 구간이 이것" 이라는 뜻이고, 차트가 다른 구간을 보여 주면 표와 어긋난다.
    if (k === 'seed' || k === 'derive') continue;
    props[k] = v;
  }
  // 첫 블록 뒤에 더 있으면 **차트 아래에 그대로 얹는다** — 신호 모듈이 체결 표·지표 카드를
  // 함께 돌려주는 경우(모의투자). 프레임워크가 무엇을 그릴지 추측하지 않고 모듈이 준 블록을
  // 그 자리에 놓기만 한다. `_baked` 와 같은 프레임워크-전용 키라 모델이 저작하지 않는다.
  const rest = resultCache.get(key)?.blocks?.slice(1) ?? [];
  props._after = rest.length > 0 ? rest : undefined;
}

/** 렌더 블록 배열에서 첫 번째 `props.data` 배열(캔들 행) 추출. */
function firstDataArray(blocks: unknown[]): unknown[] | null {
  for (const b of blocks) {
    if (b && typeof b === 'object') {
      const d = (((b as Json).props as Json | undefined)?.data);
      if (Array.isArray(d) && d.length > 0) return d;
    }
  }
  return null;
}

async function resolveOne(props: Json, path: string, slug: string): Promise<void> {
  const moduleName = String(props.module);
  const requested = typeof props.action === 'string' ? (props.action as string) : '';
  const action = await pageBindingGate(moduleName, requested);
  if (!action) return; // 거부 = 저장된 _baked 폴백
  const key = cacheKey(slug, path, moduleName, action, props.args);
  const ttlMs = clampTtlMs(props.cacheTtl);
  const now = Date.now();
  if (resultCache.size > 1000) resultCache.clear();
  const hit = resultCache.get(key);
  if (hit && now - hit.t < hit.ttlMs) {
    props._baked = hit.blocks;
    props._bakedAt = hit.t;
    return;
  }
  let p = inflight.get(key);
  if (!p) {
    p = runBinding(moduleName, action, props.args).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const blocks = await p;
  if (blocks) {
    resultCache.set(key, { blocks, t: now, ttlMs });
    props._baked = blocks;
    props._bakedAt = now;
  }
  // blocks == null → 저장된 _baked 유지 (stale-but-alive)
}
