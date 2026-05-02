/**
 * Entity Manager — 메모리 시스템 4-tier 의 Entity tier (Phase 1).
 *
 * 종목·인물·프로젝트·이벤트 단위 entity 추적 + linked facts (timeline).
 * 단기 대화 (ConversationManager) 와 별도 — 대화 끝나도 보존되는 정제된 사실.
 *
 * 인프라: IEntityPort
 * SSE 발행: 하지 않음 (Core 파사드에서 처리)
 */
import type {
  IEntityPort,
  EntityRecord,
  EntityFactRecord,
  EntitySearchOpts,
  FactSearchOpts,
} from '../ports';
import type { InfraResult } from '../types';

export class EntityManager {
  constructor(private readonly entityPort: IEntityPort) {}

  // ── Entity CRUD ──────────────────────────────────────────────────────────

  /** Entity 저장 — name+type 으로 upsert. aliases / metadata / 임베딩 자동. */
  async saveEntity(input: {
    name: string;
    type: string;
    aliases?: string[];
    metadata?: Record<string, unknown>;
    sourceConvId?: string;
  }): Promise<InfraResult<{ id: number; created: boolean }>> {
    return this.entityPort.saveEntity(input);
  }

  /** Entity 단건 수정 */
  async updateEntity(id: number, patch: {
    name?: string;
    type?: string;
    aliases?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<InfraResult<void>> {
    return this.entityPort.updateEntity(id, patch);
  }

  /** Entity 삭제 (cascade — linked facts 도 자동 정리) */
  async deleteEntity(id: number): Promise<InfraResult<void>> {
    return this.entityPort.removeEntity(id);
  }

  /** Entity 단건 조회 — factCount 자동 채움 */
  async getEntity(id: number): Promise<InfraResult<EntityRecord | null>> {
    return this.entityPort.getEntity(id);
  }

  /** 이름으로 Entity 조회 — canonical name + alias 매칭. AI 가 entity 이미 있는지 확인 시 사용. */
  async findEntityByName(name: string): Promise<InfraResult<EntityRecord | null>> {
    return this.entityPort.findEntityByName(name);
  }

  /** Entity 검색 — semantic (임베딩) + filter. */
  async searchEntities(opts: EntitySearchOpts): Promise<InfraResult<EntityRecord[]>> {
    return this.entityPort.searchEntities(opts);
  }

  // ── Fact CRUD ────────────────────────────────────────────────────────────

  /** Fact 저장 — entityId 에 link. 임베딩 자동 생성.
   *  dedupThreshold (0~1) 박으면 같은 entity 의 기존 fact 와 cosine 비교 → skip 가능. */
  async saveFact(input: {
    entityId: number;
    content: string;
    factType?: string;
    occurredAt?: number;
    tags?: string[];
    sourceConvId?: string;
    ttlDays?: number;
    dedupThreshold?: number;
  }): Promise<InfraResult<{ id: number; skipped?: boolean; similarity?: number }>> {
    return this.entityPort.saveFact(input);
  }

  /** Fact 단건 수정 */
  async updateFact(id: number, patch: {
    content?: string;
    factType?: string;
    occurredAt?: number;
    tags?: string[];
    ttlDays?: number;
  }): Promise<InfraResult<void>> {
    return this.entityPort.updateFact(id, patch);
  }

  /** Fact 삭제 */
  async deleteFact(id: number): Promise<InfraResult<void>> {
    return this.entityPort.removeFact(id);
  }

  /** Fact 단건 조회 */
  async getFact(id: number): Promise<InfraResult<EntityFactRecord | null>> {
    return this.entityPort.getFact(id);
  }

  /** Entity 의 fact timeline (시간순). */
  async getEntityTimeline(entityId: number, opts?: {
    limit?: number;
    offset?: number;
    orderBy?: 'occurredAt' | 'createdAt';
  }): Promise<InfraResult<EntityFactRecord[]>> {
    return this.entityPort.listFactsByEntity(entityId, opts);
  }

  /** Fact 검색 — semantic + entity/type/tag/시간 범위 필터. */
  async searchFacts(opts: FactSearchOpts): Promise<InfraResult<EntityFactRecord[]>> {
    return this.entityPort.searchFacts(opts);
  }

  // ── 통합 retrieve (Phase 5 RetrievalEngine 의 base) ────────────────────────

  /** 자연어 query 에 매칭되는 entity + 그 entity 의 최근 facts.
   *  AI 가 사용자 발화 → "이 query 에 어떤 entity 가 관련 있나?" 묻고 timeline 자동 prepend 시 활용.
   *
   *  반환: { entity, recentFacts[] }[] — top N entity 와 각 timeline (limit per entity).
   *  Phase 5 에서 자동 prepend 패턴으로 발전 (현재 명시 도구 호출).
   */
  async retrieveContext(query: string, opts?: {
    entityLimit?: number;
    factsPerEntity?: number;
  }): Promise<Array<{ entity: EntityRecord; recentFacts: EntityFactRecord[] }>> {
    if (!query.trim()) return [];
    const entityLimit = Math.max(1, Math.min(20, opts?.entityLimit ?? 5));
    const factsPerEntity = Math.max(1, Math.min(50, opts?.factsPerEntity ?? 5));
    const entitiesRes = await this.searchEntities({ query, limit: entityLimit });
    if (!entitiesRes.success || !entitiesRes.data) return [];
    const out: Array<{ entity: EntityRecord; recentFacts: EntityFactRecord[] }> = [];
    for (const entity of entitiesRes.data) {
      const factsRes = await this.getEntityTimeline(entity.id, { limit: factsPerEntity, orderBy: 'occurredAt' });
      out.push({
        entity,
        recentFacts: factsRes.success && factsRes.data ? factsRes.data : [],
      });
    }
    return out;
  }

  /** 만료 fact 정리 — cron 호출용 */
  async cleanupExpired(): Promise<InfraResult<{ deleted: number }>> {
    return this.entityPort.cleanupExpiredFacts();
  }
}
