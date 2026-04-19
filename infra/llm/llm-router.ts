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
  /** 현재 쿼리가 이전 턴 맥락을 필요로 하는지 — LLM 판정 (지시어/연속성 감지) */
  needsPreviousContext?: boolean;
}

/** 유사 쿼리 간주 임계값 */
const CACHE_HIT_THRESHOLD = 0.92;
/** 신뢰도 최소 (success / (success+failure)) */
const CONFIDENCE_MIN = 0.7;
/** 최소 사용 횟수가 너무 적으면 confidence 판정 대신 일단 사용 */
const MIN_USE_BEFORE_CONFIDENCE_CHECK = 3;
/** 연속 실패 이 값 이상이면 캐시 무시 */
const MAX_FAILURE_STREAK = 3;

// ── JSON 스키마 (grammar-level 강제) ───────────────────────────────────────
// Gemini responseSchema 제약: enum 은 반드시 string 배열, integer+enum 금지.
// 아래 스키마는 어댑터가 별도 변환 없이도 통과하도록 작성됨.

/** routeTools 기본 응답 (recentContext 없을 때): 이름 배열 하나 */
const ROUTE_TOOLS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tools: { type: 'array', items: { type: 'string' } },
  },
  required: ['tools'],
};

/** routeTools 확장 응답 (recentContext 있을 때): 이름 + 피드백 + 맥락 플래그 */
const ROUTE_TOOLS_WITH_FEEDBACK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tools: { type: 'array', items: { type: 'string' } },
    previous_feedback: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    needs_previous_context: { type: 'boolean' },
  },
  required: ['tools', 'previous_feedback', 'needs_previous_context'],
};

/** routeComponents 응답: 컴포넌트 이름 배열 */
const ROUTE_COMPONENTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    components: { type: 'array', items: { type: 'string' } },
  },
  required: ['components'],
};

/** generateSearchQuery 응답: 리라이트된 히스토리 검색 쿼리 + 맥락 필요 여부 */
const GENERATE_SEARCH_QUERY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    needs_previous_context: { type: 'boolean' },
  },
  required: ['query', 'needs_previous_context'],
};

/** rerankHistory 응답: 후보 중 top-K 인덱스 배열 */
const RERANK_HISTORY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    top_indices: { type: 'array', items: { type: 'integer' } },
  },
  required: ['top_indices'],
};

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
      ? `당신은 Firebat 의 도구 라우터 + 맥락 판정기입니다.
세 가지 작업을 한 번에 수행:
1) 현재 유저 쿼리에 관련된 도구 이름 선별
2) 직전 라우팅에 대한 유저의 만족도 (positive/negative/neutral)
   - "아니 그게 아니라/틀렸/엉뚱" → negative
   - "좋아/완벽/맞아/고마워" → positive
   - 애매·중립·단순 이어짐 → neutral
3) 현재 쿼리가 직전 턴 맥락을 참조해야 하는지 (needs_previous_context)
   - true: "이거/그거/저거/아까/다시/이어서/계속/또/더/말고" 등 지시어·연속 표현이 있어
           이전 턴을 참조해야 의미 파악 가능
   - false: 새 주제 / 독립된 질문 (이전 턴은 참조 불필요)
   - 판단 기준: 이전 턴을 안 보면 현재 쿼리를 이해 못 하는 경우만 true

응답은 순수 JSON 만 (마크다운·설명 금지):
{ "tools": ["name1"], "previous_feedback": "neutral", "needs_previous_context": false }`
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

    // JSON 스키마 강제 — recentContext 유무로 분기 (필드 개수 다름)
    const schema = recentContext ? ROUTE_TOOLS_WITH_FEEDBACK_SCHEMA : ROUTE_TOOLS_SCHEMA;
    const res = await this.llm.askText(userPrompt, systemPrompt, {
      model: this.routerModel,
      jsonMode: true,
      jsonSchema: schema,
    });
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
    return { names: merged, cacheId: id, source: 'llm', previousFeedback: parsed.feedback, needsPreviousContext: parsed.needsPreviousContext };
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

    const res = await this.llm.askText(userPrompt, systemPrompt, {
      model: this.routerModel,
      jsonMode: true,
      jsonSchema: ROUTE_COMPONENTS_SCHEMA,
    });
    if (!res.success) return { names: [], cacheId: -1, source: 'llm' };

    const validNames = catalog.map(c => c.name);
    const parsed = parseRouteResponse(res.data || '', validNames, false);
    if (parsed.names.length === 0) return { names: [], cacheId: -1, source: 'llm' };

    const id = await this.saveCache('components', query, qVec, parsed.names);
    return { names: parsed.names, cacheId: id, source: 'llm' };
  }

  /**
   * (C) 히스토리 벡터 검색용 쿼리 리라이트.
   *
   * - 대명사·지시어("이거/저거/아까")가 포함된 애매한 쿼리를 이전 턴 맥락으로 해소
   * - 벡터 검색 recall 향상이 목적 (의미는 보존, 임베딩 적합성 개선)
   * - prevQuery 없거나 router 비활성 시 원본 그대로 반환
   */
  async generateSearchQuery(rawQuery: string, prevQuery?: string): Promise<{ query: string; needsPreviousContext: boolean }> {
    if (!rawQuery.trim()) return { query: rawQuery, needsPreviousContext: false };

    const systemPrompt = `당신은 히스토리 벡터 검색 쿼리 리라이터입니다.
유저가 현재 던진 쿼리를 과거 대화 검색용으로 재작성하세요.

원칙:
- 대명사·지시어("이거/저거/아까/다시")가 있으면 직전 유저 쿼리로 풀어서 구체화
- 독립 신규 주제면 원본 그대로 (추측 금지)
- needs_previous_context: 직전 턴 참조가 의미 파악에 필요하면 true

응답은 순수 JSON:
{ "query": "...", "needs_previous_context": true/false }`;

    const userPrompt = prevQuery
      ? `직전 유저 쿼리: "${prevQuery}"
현재 유저 쿼리: "${rawQuery}"

검색용으로 재작성:`
      : `현재 유저 쿼리: "${rawQuery}"

검색용으로 재작성:`;

    const res = await this.llm.askText(userPrompt, systemPrompt, {
      model: this.routerModel,
      jsonMode: true,
      jsonSchema: GENERATE_SEARCH_QUERY_SCHEMA,
    });
    if (!res.success) return { query: rawQuery, needsPreviousContext: false };

    try {
      const parsed = JSON.parse(res.data || '{}') as { query?: string; needs_previous_context?: boolean };
      const q = typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : rawQuery;
      const ctx = typeof parsed.needs_previous_context === 'boolean' ? parsed.needs_previous_context : false;
      return { query: q, needsPreviousContext: ctx };
    } catch {
      return { query: rawQuery, needsPreviousContext: false };
    }
  }

  /**
   * (D) 히스토리 검색 결과 재랭킹.
   *
   * - 벡터 top-N 후보 중 **현재 쿼리와 의미적으로 맞는 것** 을 top-K 로 선별
   * - 벡터 유사도만으로는 잡기 어려운 주제 경계(예: "삼성전자" ↔ "삼성바이오") 분리
   * - 실패 시 원본 순서 유지하며 앞 K 개 반환
   */
  async rerankHistory<T extends { preview: string }>(query: string, candidates: T[], topK: number = 5): Promise<T[]> {
    if (candidates.length === 0) return [];
    if (candidates.length <= topK) return candidates;

    const systemPrompt = `당신은 대화 히스토리 재랭커입니다.
유저가 찾는 과거 대화 후보들 중 **현재 쿼리와 의미적으로 가장 관련 깊은 것** 을 상위 ${topK} 개 인덱스로 반환하세요.

판단 기준:
- 주제·엔티티 일치 (예: "삼성전자" 쿼리엔 삼성바이오 답변은 제외)
- 최근성보다 의미 관련성 우선
- 애매하면 제외

응답은 순수 JSON:
{ "top_indices": [0, 3, 5, ...] }  // 후보 배열 인덱스, 관련도 내림차순, 최대 ${topK} 개`;

    const listText = candidates.map((c, i) => `[${i}] ${c.preview.slice(0, 150)}`).join('\n');
    const userPrompt = `현재 쿼리: "${query}"

후보:
${listText}

상위 ${topK} 인덱스:`;

    const res = await this.llm.askText(userPrompt, systemPrompt, {
      model: this.routerModel,
      jsonMode: true,
      jsonSchema: RERANK_HISTORY_SCHEMA,
    });
    if (!res.success) return candidates.slice(0, topK);

    try {
      const parsed = JSON.parse(res.data || '{}') as { top_indices?: unknown[] };
      if (!Array.isArray(parsed.top_indices)) return candidates.slice(0, topK);
      const picked: T[] = [];
      const seen = new Set<number>();
      for (const raw of parsed.top_indices) {
        const idx = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length || seen.has(idx)) continue;
        seen.add(idx);
        picked.push(candidates[idx]);
        if (picked.length >= topK) break;
      }
      return picked.length > 0 ? picked : candidates.slice(0, topK);
    } catch {
      return candidates.slice(0, topK);
    }
  }
}

/** LLM 응답 파싱: 배열 형태 또는 {tools, previous_feedback} 오브젝트 형태 모두 지원 */
function parseRouteResponse(text: string, validNames: string[], expectFeedback: boolean): { names: string[]; feedback?: FeedbackSignal; needsPreviousContext?: boolean } {
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
  let needsPreviousContext: boolean | undefined;

  if (Array.isArray(parsed)) {
    namesRaw = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    namesRaw = obj.tools ?? obj.names ?? obj.components;
    const fb = obj.previous_feedback;
    if (fb === 'positive' || fb === 'negative' || fb === 'neutral') feedback = fb;
    if (typeof obj.needs_previous_context === 'boolean') needsPreviousContext = obj.needs_previous_context;
  }

  if (!Array.isArray(namesRaw)) return { names: [], feedback, needsPreviousContext };
  const validSet = new Set(validNames);
  const names = (namesRaw as unknown[])
    .filter((x): x is string => typeof x === 'string')
    .filter(n => validSet.has(n));
  return { names, feedback, needsPreviousContext };
}
