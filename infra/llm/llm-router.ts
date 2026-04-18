/**
 * Self-Learning LLM Router
 *
 * 도구·컴포넌트 라우팅을 Flash Lite 로 수행하되,
 * 결과를 벡터 임베딩 캐시(routing_cache 테이블)에 저장해 재사용.
 *
 * 흐름:
 *   1. 유저 쿼리 임베딩 → routing_cache 에서 유사 엔트리 검색
 *   2. top1 유사도 >= CACHE_HIT_THRESHOLD AND confidence >= CONFIDENCE_MIN → 캐시 재사용
 *   3. miss → Flash Lite 호출 → 결과 신규 저장
 *
 * 시간이 지나면서 유저 쿼리 패턴이 포화되어 Flash Lite 호출 빈도 급감.
 */
import type { ILlmPort, ToolDefinition } from '../../core/ports';
import type { IDatabasePort } from '../../core/ports';
import { embedQuery, cosine, float32ToBuffer, bufferToFloat32 } from './embedder';

export type RouteKind = 'tools' | 'components';

export interface RouteResult {
  names: string[];
  /** 캐시 hit 이면 해당 엔트리 ID (success/failure 업데이트용). miss 면 신규 생성된 ID. */
  cacheId: number;
  source: 'cache' | 'llm';
}

/** 유사 쿼리 간주 임계값 */
const CACHE_HIT_THRESHOLD = 0.92;
/** 신뢰도 최소 (success / (success+failure)) */
const CONFIDENCE_MIN = 0.7;
/** 최소 사용 횟수가 너무 적으면 confidence 판정 대신 일단 사용 */
const MIN_USE_BEFORE_CONFIDENCE_CHECK = 3;
/** 연속 실패 이 값 이상이면 캐시 무시 */
const MAX_FAILURE_STREAK = 3;

/** Flash Lite 라우터 — tools/components 공통 */
export class LlmRouter {
  constructor(
    private readonly db: IDatabasePort,
    private readonly llm: ILlmPort,
    private readonly routerModel: string,
  ) {}

  /**
   * 쿼리 임베딩으로 유사 캐시 엔트리 검색.
   * top1 유사도·confidence·failure 조건 통과 시 캐시 반환, 아니면 null.
   */
  private async lookupCache(kind: RouteKind, queryVec: Float32Array): Promise<{ id: number; names: string[]; score: number } | null> {
    const res = await this.db.query(
      `SELECT id, result_json, success_count, failure_count, use_count, query_embedding
       FROM routing_cache WHERE kind = ? ORDER BY last_used_at DESC`,
      [kind],
    );
    if (!res.success || !res.data || res.data.length === 0) return null;

    let bestId = -1;
    let bestScore = -1;
    let bestResult: string | null = null;
    let bestSuccess = 0;
    let bestFailure = 0;
    let bestUseCount = 0;

    for (const row of res.data as Array<{ id: number; result_json: string; success_count: number; failure_count: number; use_count: number; query_embedding: Buffer }>) {
      try {
        const v = bufferToFloat32(row.query_embedding);
        const score = cosine(queryVec, v);
        if (score > bestScore) {
          bestScore = score;
          bestId = row.id;
          bestResult = row.result_json;
          bestSuccess = row.success_count;
          bestFailure = row.failure_count;
          bestUseCount = row.use_count;
        }
      } catch { /* 손상 엔트리 스킵 */ }
    }

    if (bestScore < CACHE_HIT_THRESHOLD) return null;
    if (bestFailure >= MAX_FAILURE_STREAK && bestFailure > bestSuccess) return null;

    // 사용 횟수 충분하면 confidence 체크, 아니면 첫 몇 번은 신뢰
    if (bestUseCount >= MIN_USE_BEFORE_CONFIDENCE_CHECK) {
      const confidence = bestSuccess / Math.max(1, bestSuccess + bestFailure);
      if (confidence < CONFIDENCE_MIN) return null;
    }

    try {
      const parsed = JSON.parse(bestResult || '{}') as { names?: string[] };
      if (!Array.isArray(parsed.names)) return null;
      return { id: bestId, names: parsed.names, score: bestScore };
    } catch {
      return null;
    }
  }

  /** 캐시 hit 사용 시 use_count·last_used_at 갱신 */
  private async touchCache(id: number): Promise<void> {
    await this.db.query(
      `UPDATE routing_cache SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
      [Date.now(), id],
    );
  }

  /** 신규 엔트리 저장. 반환 ID. */
  private async saveCache(kind: RouteKind, queryText: string, queryVec: Float32Array, names: string[]): Promise<number> {
    const now = Date.now();
    const blob = float32ToBuffer(queryVec);
    const resultJson = JSON.stringify({ names });
    const res = await this.db.query(
      `INSERT INTO routing_cache (kind, query_text, query_embedding, result_json, success_count, failure_count, use_count, created_at, last_used_at)
       VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?)`,
      [kind, queryText.slice(0, 500), blob, resultJson, now, now],
    );
    const id = (res.data?.[0] as { lastInsertRowid?: number })?.lastInsertRowid ?? -1;
    return typeof id === 'bigint' ? Number(id) : id;
  }

  /** 성공 신호 반영 */
  async recordSuccess(cacheId: number): Promise<void> {
    if (cacheId < 0) return;
    await this.db.query(`UPDATE routing_cache SET success_count = success_count + 1 WHERE id = ?`, [cacheId]);
  }

  /** 실패 신호 반영 (기본 1점, 유저 재시도 등 강한 신호는 2점) */
  async recordFailure(cacheId: number, weight: number = 1): Promise<void> {
    if (cacheId < 0) return;
    await this.db.query(`UPDATE routing_cache SET failure_count = failure_count + ? WHERE id = ?`, [weight, cacheId]);
  }

  /** 도구 라우팅 — 유저 쿼리로 관련 도구 이름 배열 반환 */
  async routeTools(query: string, availableTools: ToolDefinition[], alwaysInclude: string[] = []): Promise<RouteResult> {
    if (!query.trim()) return { names: alwaysInclude, cacheId: -1, source: 'cache' };
    const qVec = await embedQuery(query);

    // 1. 캐시 조회
    const cached = await this.lookupCache('tools', qVec);
    if (cached) {
      await this.touchCache(cached.id);
      const merged = Array.from(new Set([...alwaysInclude, ...cached.names]));
      return { names: merged, cacheId: cached.id, source: 'cache' };
    }

    // 2. Flash Lite 호출
    const catalog = availableTools.map(t => `- ${t.name}: ${(t.description || '').slice(0, 100)}`).join('\n');
    const systemPrompt = `당신은 Firebat 의 도구 라우터입니다. 유저 쿼리를 보고 관련 도구 이름만 JSON 배열로 반환하세요.
다른 설명·마크다운·코드블록 금지. 오직 JSON 배열만.

예시 응답: ["sysmod_kiwoom", "render_alert"]`;
    const userPrompt = `사용 가능한 도구:
${catalog}

유저 쿼리: "${query}"

이 쿼리에 관련된 도구 이름 JSON 배열:`;

    const res = await this.llm.askText(userPrompt, systemPrompt, { model: this.routerModel });
    if (!res.success) {
      // LLM 실패 → 빈 결과 + ALWAYS_INCLUDE
      return { names: alwaysInclude, cacheId: -1, source: 'llm' };
    }

    const names = parseNamesJson(res.data || '', availableTools.map(t => t.name));
    if (names.length === 0) return { names: alwaysInclude, cacheId: -1, source: 'llm' };

    const id = await this.saveCache('tools', query, qVec, names);
    const merged = Array.from(new Set([...alwaysInclude, ...names]));
    return { names: merged, cacheId: id, source: 'llm' };
  }

  /** 컴포넌트 라우팅 — 유저 쿼리로 관련 컴포넌트 이름 배열 반환 */
  async routeComponents(query: string, catalog: Array<{ name: string; description: string }>): Promise<RouteResult> {
    if (!query.trim()) return { names: [], cacheId: -1, source: 'cache' };
    const qVec = await embedQuery(query);

    const cached = await this.lookupCache('components', qVec);
    if (cached) {
      await this.touchCache(cached.id);
      return { names: cached.names, cacheId: cached.id, source: 'cache' };
    }

    const catalogText = catalog.map(c => `- ${c.name}: ${c.description.slice(0, 80)}`).join('\n');
    const systemPrompt = `당신은 UI 컴포넌트 라우터입니다. 유저 쿼리·의도에 맞는 컴포넌트 이름만 JSON 배열로 반환하세요.
다른 설명·마크다운·코드블록 금지.

예시: ["stock_chart", "table"]`;
    const userPrompt = `사용 가능한 컴포넌트:
${catalogText}

유저 쿼리: "${query}"

관련 컴포넌트 이름 JSON 배열:`;

    const res = await this.llm.askText(userPrompt, systemPrompt, { model: this.routerModel });
    if (!res.success) return { names: [], cacheId: -1, source: 'llm' };

    const validNames = catalog.map(c => c.name);
    const names = parseNamesJson(res.data || '', validNames);
    if (names.length === 0) return { names: [], cacheId: -1, source: 'llm' };

    const id = await this.saveCache('components', query, qVec, names);
    return { names, cacheId: id, source: 'llm' };
  }
}

/** LLM 응답에서 JSON 배열 추출. 유효하지 않은 이름 필터. */
function parseNamesJson(text: string, validNames: string[]): string[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  let arr: unknown;
  try { arr = JSON.parse(cleaned); } catch {
    // 대괄호 영역만 추출해 재시도
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { arr = JSON.parse(m[0]); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const validSet = new Set(validNames);
  return arr
    .filter((x): x is string => typeof x === 'string')
    .filter(n => validSet.has(n));
}
