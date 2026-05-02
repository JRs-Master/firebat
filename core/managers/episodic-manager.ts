/**
 * Episodic Manager — 메모리 시스템 4-tier 의 Episodic tier (Phase 2).
 *
 * 시간순 사건 추적 — 자동매매 실행 / 페이지 발행 / cron trigger / 도구 호출 / 사용자 액션 등.
 * Entity tier (영속 추적 대상) 와 m2m link — 하나의 event 가 N entity 에 영향.
 *
 * 자동 훅 — 일반화된 saveEvent API 를 다른 매니저 (PageManager.save / Schedule fire /
 * Media generate / ToolManager dispatch 등) 가 호출. 도메인별 hook enumerate X.
 *
 * 인프라: IEpisodicPort
 * SSE 발행: 하지 않음 (Core 파사드에서 처리)
 */
import type {
  IEpisodicPort,
  EventRecord,
  EventSearchOpts,
} from '../ports';
import type { InfraResult } from '../types';

export class EpisodicManager {
  constructor(private readonly episodicPort: IEpisodicPort) {}

  /** Event 저장 — title+description 임베딩 자동. entityIds 박으면 m2m link 자동.
   *  dedupThreshold (0~1) 박으면 같은 type + 7일 이내 기존 event 와 cosine 비교 → skip 가능. */
  async saveEvent(input: {
    type: string;
    title: string;
    description?: string;
    who?: string;
    context?: Record<string, unknown>;
    occurredAt?: number;
    entityIds?: number[];
    sourceConvId?: string;
    ttlDays?: number;
    dedupThreshold?: number;
  }): Promise<InfraResult<{ id: number; skipped?: boolean; similarity?: number }>> {
    return this.episodicPort.saveEvent(input);
  }

  /** Event 단건 수정. entityIds 박으면 link 전체 교체. */
  async updateEvent(id: number, patch: {
    type?: string;
    title?: string;
    description?: string;
    who?: string;
    context?: Record<string, unknown>;
    occurredAt?: number;
    entityIds?: number[];
    ttlDays?: number;
  }): Promise<InfraResult<void>> {
    return this.episodicPort.updateEvent(id, patch);
  }

  async deleteEvent(id: number): Promise<InfraResult<void>> {
    return this.episodicPort.removeEvent(id);
  }

  async getEvent(id: number): Promise<InfraResult<EventRecord | null>> {
    return this.episodicPort.getEvent(id);
  }

  /** 검색 — semantic + 다중 필터 (type/who/시간범위/entityId). */
  async searchEvents(opts: EventSearchOpts): Promise<InfraResult<EventRecord[]>> {
    return this.episodicPort.searchEvents(opts);
  }

  /** 최근 events — type/who 필터 옵션. occurredAt DESC. */
  async listRecentEvents(opts?: { type?: string; who?: string; limit?: number; offset?: number }): Promise<InfraResult<EventRecord[]>> {
    return this.episodicPort.listRecentEvents(opts);
  }

  /** Entity 의 event 목록 — searchEvents(entityId) 의 편의 wrapper. */
  async listEventsByEntity(entityId: number, opts?: { limit?: number; offset?: number }): Promise<InfraResult<EventRecord[]>> {
    return this.episodicPort.searchEvents({ entityId, limit: opts?.limit, offset: opts?.offset });
  }

  async linkEntity(eventId: number, entityId: number): Promise<InfraResult<void>> {
    return this.episodicPort.linkEventEntity(eventId, entityId);
  }

  async unlinkEntity(eventId: number, entityId: number): Promise<InfraResult<void>> {
    return this.episodicPort.unlinkEventEntity(eventId, entityId);
  }

  async cleanupExpired(): Promise<InfraResult<{ deleted: number }>> {
    return this.episodicPort.cleanupExpiredEvents();
  }
}
