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

export interface RecentRoutingContext {
  /** 직전 유저 쿼리 */
  previousQuery: string;
  /** 직전 라우팅된 도구/컴포넌트 이름 */
  previousNames: string[];
}

export type FeedbackSignal = 'positive' | 'negative' | 'neutral';

export interface RouteResult {
  names: string[];
  /** 캐시 hit 이면 해당 엔트리 ID (success/failure 업데이트용). miss 면 신규 생성된 ID. */
  cacheId: number;
  source: 'cache' | 'llm';
  /** recentContext 주어졌을 때, 이전 라우팅에 대한 유저 피드백 판정 결과 */
  previousFeedback?: FeedbackSignal;
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

  /**
   * 도구 라우팅 — 유저 쿼리로 관련 도구 이름 배열 반환.
   * recentContext 주어지면 같은 호출에서 이전 라우팅에 대한 유저 피드백도 판정.
   */
  async routeTools(
    query: string,
    availableTools: ToolDefinition[],
    alwaysInclude: string[] = [],
    recentContext?: RecentRoutingContext,
  ): Promise<RouteResult> {
    if (!query.trim()) return { names: alwaysInclude, cacheId: -1, source: 'cache' };
    const qVec = await embedQuery(query);

    // 1. 캐시 조회 — 단, recentContext 있으면 피드백 판정 위해 LLM 경로 강제
    //    (캐시 hit 이어도 이전 라우팅 평가는 필요)
    if (!recentContext) {
      const cached = await this.lookupCache('tools', qVec);
      if (cached) {
        await this.touchCache(cached.id);
        const merged = Array.from(new Set([...alwaysInclude, ...cached.names]));
        return { names: merged, cacheId: cached.id, source: 'cache' };
      }
    }

    // 2. Flash Lite 호출 (피드백 포함 여부는 recentContext 존재 여부로 분기)
    const catalog = availableTools.map(t => `- ${t.name}: ${(t.description || '').slice(0, 100)}`).join('\n');

    const systemPrompt = recentContext
      ? `당신은 Firebat 의 도구 라우터 + 유저 피드백 판정기입니다.
두 가지 작업을 한 번에 수행:
1) 현재 유저 쿼리에 관련된 도구 이름 선별
2) 직전 라우팅에 대한 유저의 만족도 판정 (positive/negative/neutral)
   - "아니 그게 아니라/틀렸/엉뚱" 등 명확한 불만 → negative
   - "좋아/완벽/맞아/고마워" 등 명확한 만족 → positive
   - 애매·중립·단순 이어짐 → neutral

응답은 순수 JSON 만 (마크다운·설명 금지):
{ "tools": ["name1", "name2"], "previous_feedback": "neutral" }`
      : `당신은 Firebat 의 도구 라우터입니다. 유저 쿼리를 보고 관련 도구 이름만 JSON 배열로 반환하세요.
다른 설명·마크다운·코드블록 금지. 오직 JSON 배열만.

예시 응답: ["sysmod_kiwoom", "render_alert"]`;

    const userPrompt = recentContext
      ? `사용 가능한 도구:
${catalog}

[이전 턴]
유저 쿼리: "${recentContext.previousQuery}"
라우팅된 도구: ${JSON.stringify(recentContext.previousNames)}

[현재 턴]
유저 쿼리: "${query}"

응답 JSON:`
      : `사용 가능한 도구:
${catalog}

유저 쿼리: "${query}"

이 쿼리에 관련된 도구 이름 JSON 배열:`;

    const res = await this.llm.askText(userPrompt, systemPrompt, { model: this.routerModel });
    if (!res.success) {
      return { names: alwaysInclude, cacheId: -1, source: 'llm' };
    }

    const validNames = availableTools.map(t => t.name);
    const parsed = parseRouteResponse(res.data || '', validNames, !!recentContext);
    if (parsed.names.length === 0) {
      return { names: alwaysInclude, cacheId: -1, source: 'llm', previousFeedback: parsed.feedback };
    }

    const id = await this.saveCache('tools', query, qVec, parsed.names);
    const merged = Array.from(new Set([...alwaysInclude, ...parsed.names]));
    return { names: merged, cacheId: id, source: 'llm', previousFeedback: parsed.feedback };
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
    const parsed = parseRouteResponse(res.data || '', validNames, false);
    if (parsed.names.length === 0) return { names: [], cacheId: -1, source: 'llm' };

    const id = await this.saveCache('components', query, qVec, parsed.names);
    return { names: parsed.names, cacheId: id, source: 'llm' };
  }
}

/** LLM 응답 파싱: 배열 형태 또는 {tools, previous_feedback} 오브젝트 형태 모두 지원 */
function parseRouteResponse(text: string, validNames: string[], expectFeedback: boolean): { names: string[]; feedback?: FeedbackSignal } {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch {
    // JSON 블록 일부만 추출해 재시도
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const candidate = expectFeedback && objMatch ? objMatch[0] : (arrMatch ? arrMatch[0] : null);
    if (!candidate) return { names: [] };
    try { parsed = JSON.parse(candidate); } catch { return { names: [] }; }
  }

  let namesRaw: unknown;
  let feedback: FeedbackSignal | undefined;

  if (Array.isArray(parsed)) {
    namesRaw = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    namesRaw = obj.tools ?? obj.names ?? obj.components;
    const fb = obj.previous_feedback;
    if (fb === 'positive' || fb === 'negative' || fb === 'neutral') feedback = fb;
  }

  if (!Array.isArray(namesRaw)) return { names: [], feedback };
  const validSet = new Set(validNames);
  const names = (namesRaw as unknown[])
    .filter((x): x is string => typeof x === 'string')
    .filter(n => validSet.has(n));
  return { names, feedback };
}
