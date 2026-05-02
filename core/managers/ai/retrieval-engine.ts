/**
 * RetrievalEngine — 메모리 시스템 4-tier 통합 검색 (Phase 5).
 *
 * 사용자 query → 병렬 검색 (history + entities + events + entity_facts) → 통합
 * contextSummary 반환. AiManager 가 시스템 프롬프트에 <MEMORY_CONTEXT> 섹션 prepend.
 *
 * vs HistoryResolver:
 *   - HistoryResolver: search_history 만 (대화 raw, spread 판정)
 *   - RetrievalEngine: 4-tier 통합 (history + 메모리 시스템). HistoryResolver 결과
 *     포함 후 entity/event/fact 추가.
 *
 * Token budget — limits 박혀 있으면 그 대로, 미박힘 시 default. 빈 결과 자동 skip.
 *
 * 일반 로직: 도메인 (자동매매·블로그 etc) 무관 — 4 source 검색 후 통합. 도구별 enum X.
 */
import type { FirebatCore } from '../../index';
import type { EntityRecord, EntityFactRecord, EventRecord } from '../../ports';

export interface RetrievalLimits {
  /** search_history 매치 (default 5) — 대화 raw */
  history?: number;
  /** entity 검색 결과 (default 3) — 추적 대상 */
  entities?: number;
  /** entity_facts 검색 결과 (default 5) — 정제된 사실 */
  facts?: number;
  /** events 검색 결과 (default 5) — 시간순 사건 */
  events?: number;
  /** 매 entity 의 timeline 추가 fact 수 (default 3) */
  factsPerEntity?: number;
}

export interface RetrievalResult {
  /** 통합 컨텍스트 — system prompt prepend 용. 빈 문자열이면 모든 source 0. */
  contextSummary: string;
  /** 디버그 — 각 source 의 매칭 수 */
  stats: {
    history: number;
    entities: number;
    facts: number;
    events: number;
  };
}

export class RetrievalEngine {
  constructor(private readonly core: FirebatCore) {}

  async retrieve(opts: {
    query: string;
    owner?: string;
    currentConvId?: string;
    limits?: RetrievalLimits;
  }): Promise<RetrievalResult> {
    const empty: RetrievalResult = {
      contextSummary: '',
      stats: { history: 0, entities: 0, facts: 0, events: 0 },
    };
    const query = opts.query?.trim();
    if (!query) return empty;

    const lim: Required<RetrievalLimits> = {
      history: opts.limits?.history ?? 5,
      entities: opts.limits?.entities ?? 3,
      facts: opts.limits?.facts ?? 5,
      events: opts.limits?.events ?? 5,
      factsPerEntity: opts.limits?.factsPerEntity ?? 3,
    };

    // 4 source 병렬 검색
    const [historyRes, entitiesRes, factsRes, eventsRes] = await Promise.all([
      lim.history > 0 && opts.owner
        ? this.core.searchConversationHistory(opts.owner, query, {
            currentConvId: opts.currentConvId,
            limit: lim.history,
            minScore: 0.5,
          }).catch(() => null)
        : Promise.resolve(null),
      lim.entities > 0
        ? this.core.searchEntities({ query, limit: lim.entities }).catch(() => null)
        : Promise.resolve(null),
      lim.facts > 0
        ? this.core.searchEntityFacts({ query, limit: lim.facts }).catch(() => null)
        : Promise.resolve(null),
      lim.events > 0
        ? this.core.searchEvents({ query, limit: lim.events }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const sections: string[] = [];
    const stats = { history: 0, entities: 0, facts: 0, events: 0 };

    // 1) Conversation history
    if (historyRes?.success && historyRes.data && historyRes.data.length > 0) {
      const matches = historyRes.data.slice(0, lim.history);
      stats.history = matches.length;
      sections.push(
        `[관련 과거 대화 (${matches.length}건)]\n` +
        matches.map(m => {
          const role = m.role === 'user' ? '사용자' : 'AI';
          const preview = (m.contentPreview || '').slice(0, 200);
          return `- [${role}]: ${preview}`;
        }).join('\n')
      );
    }

    // 2) Entities — 매 entity 마다 최근 timeline 도 추가 (factsPerEntity)
    if (entitiesRes?.success && entitiesRes.data && entitiesRes.data.length > 0) {
      const ents = entitiesRes.data;
      stats.entities = ents.length;
      const entitySections: string[] = [];
      for (const e of ents) {
        let line = `- ${e.name} (${e.type})`;
        if (e.aliases && e.aliases.length > 0) line += ` [별칭: ${e.aliases.slice(0, 3).join(', ')}]`;
        if (typeof e.factCount === 'number' && e.factCount > 0) line += ` · ${e.factCount}개 사실`;
        // Timeline — 짧게
        if (lim.factsPerEntity > 0) {
          const tlRes = await this.core.getEntityTimeline(e.id, { limit: lim.factsPerEntity, orderBy: 'occurredAt' });
          if (tlRes.success && tlRes.data && tlRes.data.length > 0) {
            line += '\n' + tlRes.data.map((f: EntityFactRecord) => {
              const dateStr = f.occurredAt ? new Date(f.occurredAt).toISOString().slice(0, 10) : '';
              const typeLabel = f.factType ? `[${f.factType}] ` : '';
              return `    ${dateStr ? dateStr + ' ' : ''}${typeLabel}${f.content.slice(0, 150)}`;
            }).join('\n');
          }
        }
        entitySections.push(line);
      }
      sections.push(`[관련 엔티티 (${ents.length}건)]\n` + entitySections.join('\n'));
    }

    // 3) Facts — entity 무관 횡단 검색 결과
    if (factsRes?.success && factsRes.data && factsRes.data.length > 0) {
      const facts = factsRes.data.slice(0, lim.facts);
      stats.facts = facts.length;
      sections.push(
        `[관련 사실 (${facts.length}건)]\n` +
        facts.map((f: EntityFactRecord) => {
          const dateStr = f.occurredAt ? new Date(f.occurredAt).toISOString().slice(0, 10) : '';
          const typeLabel = f.factType ? `[${f.factType}] ` : '';
          return `- ${dateStr ? dateStr + ' ' : ''}${typeLabel}${f.content.slice(0, 200)}`;
        }).join('\n')
      );
    }

    // 4) Events — 시간순 사건
    if (eventsRes?.success && eventsRes.data && eventsRes.data.length > 0) {
      const evs = eventsRes.data.slice(0, lim.events);
      stats.events = evs.length;
      sections.push(
        `[관련 사건 (${evs.length}건)]\n` +
        evs.map((e: EventRecord) => {
          const dateStr = new Date(e.occurredAt).toISOString().slice(0, 16).replace('T', ' ');
          const whoLabel = e.who ? ` (${e.who})` : '';
          const desc = e.description ? ` — ${e.description.slice(0, 100)}` : '';
          return `- ${dateStr} [${e.type}]${whoLabel} ${e.title}${desc}`;
        }).join('\n')
      );
    }

    if (sections.length === 0) {
      return { contextSummary: '', stats };
    }

    const contextSummary = `<MEMORY_CONTEXT>\n` + sections.join('\n\n') + `\n</MEMORY_CONTEXT>`;
    return { contextSummary, stats };
  }
}
