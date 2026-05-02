/**
 * SqliteEpisodicAdapter — Episodic Memory (Phase 2 of 4-tier memory).
 *
 * 시간순 사건 추적. Entity tier 와 같은 DB 위에서 작동, ON DELETE CASCADE 로 entity 삭제 시
 * link 자동 정리.
 *
 * Embedding flow: saveEvent 시 title + description 합쳐 IEmbedderPort.embedPassage 호출 →
 * BLOB 저장. searchEvents 가 query → embedQuery → 모든 row cosine compute (Phase 1 단순,
 * Phase 3 vector store 시 인덱스화).
 */
import type Database from 'better-sqlite3';
import type {
  IEpisodicPort,
  IEmbedderPort,
  ILogPort,
  EventRecord,
  EventSearchOpts,
} from '../../core/ports';
import type { InfraResult } from '../../core/types';

interface EventRow {
  id: number;
  type: string;
  title: string;
  description: string | null;
  who: string | null;
  context: string | null;
  embedding: Buffer | null;
  source_conv_id: string | null;
  occurred_at: number;
  expires_at: number | null;
  created_at: number;
}

function safeJsonObject(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

export class SqliteEpisodicAdapter implements IEpisodicPort {
  constructor(
    private readonly db: Database.Database,
    private readonly embedder: IEmbedderPort,
    private readonly log: ILogPort,
  ) {}

  private rowToEvent(row: EventRow, entityIds: number[] = []): EventRecord {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description ?? undefined,
      who: row.who ?? undefined,
      context: safeJsonObject(row.context),
      occurredAt: row.occurred_at,
      sourceConvId: row.source_conv_id ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
      entityIds,
    };
  }

  /** event_entities row 들에서 event_id → entity_id[] 맵핑 */
  private getEntityIdsForEvents(eventIds: number[]): Map<number, number[]> {
    const map = new Map<number, number[]>();
    if (eventIds.length === 0) return map;
    const placeholders = eventIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT event_id, entity_id FROM event_entities WHERE event_id IN (${placeholders})
    `).all(...eventIds) as Array<{ event_id: number; entity_id: number }>;
    for (const r of rows) {
      const arr = map.get(r.event_id) ?? [];
      arr.push(r.entity_id);
      map.set(r.event_id, arr);
    }
    return map;
  }

  async saveEvent(input: {
    type: string; title: string; description?: string; who?: string;
    context?: Record<string, unknown>; occurredAt?: number;
    entityIds?: number[]; sourceConvId?: string; ttlDays?: number; embedding?: Buffer;
    dedupThreshold?: number;
  }): Promise<InfraResult<{ id: number; skipped?: boolean; similarity?: number }>> {
    try {
      const type = input.type.trim();
      const title = input.title.trim();
      if (!type || !title) return { success: false, error: 'type 과 title 은 필수' };
      const now = Date.now();
      const occurredAt = input.occurredAt ?? now;
      const expiresAt = input.ttlDays && input.ttlDays > 0 ? now + input.ttlDays * 24 * 60 * 60 * 1000 : null;
      const description = input.description?.trim() || null;
      const who = input.who?.trim() || null;
      const context = input.context ? JSON.stringify(input.context) : null;

      // Embedding — input 우선, 없으면 자동
      let embedding: Buffer | null = input.embedding ?? null;
      if (!embedding) {
        try {
          const text = description ? `${title}\n${description}` : title;
          const arr = await this.embedder.embedPassage(text);
          embedding = this.embedder.float32ToBuffer(arr);
        } catch (err: any) {
          this.log.debug?.(`[Event] 임베딩 생성 실패: ${err?.message ?? err}`);
        }
      }

      // 중복 검출 — dedupThreshold 박혀있고 새 임베딩 있을 때만.
      // 같은 type 의 최근 기존 event (occurredAt 7일 이내) 와 cosine 비교 — 너무 멀면
      // 같은 사실의 진짜 발생일 수 있으니 7일 경계 안에서만 검출.
      if (input.dedupThreshold && input.dedupThreshold > 0 && embedding) {
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        const existing = this.db.prepare(`
          SELECT id, embedding FROM events
          WHERE type = ? AND embedding IS NOT NULL
            AND occurred_at >= ?
            AND (expires_at IS NULL OR expires_at > ?)
        `).all(type, sevenDaysAgo, now) as Array<{ id: number; embedding: Buffer }>;
        let bestId: number | null = null;
        let bestSimilarity = 0;
        const newEmb = this.embedder.bufferToFloat32(embedding);
        for (const row of existing) {
          const sim = this.embedder.cosine(newEmb, this.embedder.bufferToFloat32(row.embedding));
          if (sim > bestSimilarity) {
            bestSimilarity = sim;
            bestId = row.id;
          }
        }
        if (bestId !== null && bestSimilarity >= input.dedupThreshold) {
          this.log.debug?.(`[Event] 중복 검출 skip — type=${type} similarity=${bestSimilarity.toFixed(3)} existing_id=${bestId}`);
          // entityIds 박혀있으면 기존 event 에 link 추가 (m2m upsert)
          if (input.entityIds && input.entityIds.length > 0) {
            const link = this.db.prepare('INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?, ?)');
            for (const eid of input.entityIds) link.run(bestId, eid);
          }
          return { success: true, data: { id: bestId, skipped: true, similarity: bestSimilarity } };
        }
      }

      const insertEvent = this.db.prepare(`
        INSERT INTO events
          (type, title, description, who, context, embedding, source_conv_id, occurred_at, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const linkEntity = this.db.prepare(`
        INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?, ?)
      `);
      const txn = this.db.transaction(() => {
        const info = insertEvent.run(
          type, title, description, who, context, embedding,
          input.sourceConvId ?? null, occurredAt, expiresAt, now,
        );
        const id = info.lastInsertRowid as number;
        if (input.entityIds && input.entityIds.length > 0) {
          for (const eid of input.entityIds) {
            linkEntity.run(id, eid);
          }
        }
        return id;
      });
      const id = txn();
      return { success: true, data: { id } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async updateEvent(id: number, patch: {
    type?: string; title?: string; description?: string; who?: string;
    context?: Record<string, unknown>; occurredAt?: number;
    entityIds?: number[]; ttlDays?: number; embedding?: Buffer;
  }): Promise<InfraResult<void>> {
    try {
      const sets: string[] = [];
      const params: any[] = [];
      if (patch.type !== undefined) { sets.push('type = ?'); params.push(patch.type.trim()); }
      if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title.trim()); }
      if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description?.trim() || null); }
      if (patch.who !== undefined) { sets.push('who = ?'); params.push(patch.who?.trim() || null); }
      if (patch.context !== undefined) { sets.push('context = ?'); params.push(patch.context ? JSON.stringify(patch.context) : null); }
      if (patch.occurredAt !== undefined) { sets.push('occurred_at = ?'); params.push(patch.occurredAt); }
      if (patch.ttlDays !== undefined) {
        const expiresAt = patch.ttlDays > 0 ? Date.now() + patch.ttlDays * 24 * 60 * 60 * 1000 : null;
        sets.push('expires_at = ?'); params.push(expiresAt);
      }
      if (patch.embedding !== undefined) { sets.push('embedding = ?'); params.push(patch.embedding); }

      const txn = this.db.transaction(() => {
        if (sets.length > 0) {
          const info = this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
          if (info.changes === 0) throw new Error(`Event not found: ${id}`);
        }
        // entityIds 박혀있으면 link 전체 교체
        if (patch.entityIds !== undefined) {
          this.db.prepare('DELETE FROM event_entities WHERE event_id = ?').run(id);
          if (patch.entityIds.length > 0) {
            const link = this.db.prepare('INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?, ?)');
            for (const eid of patch.entityIds) link.run(id, eid);
          }
        }
      });
      txn();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async removeEvent(id: number): Promise<InfraResult<void>> {
    try {
      const info = this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
      if (info.changes === 0) return { success: false, error: `Event not found: ${id}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getEvent(id: number): Promise<InfraResult<EventRecord | null>> {
    try {
      const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
      if (!row) return { success: true, data: null };
      const map = this.getEntityIdsForEvents([id]);
      return { success: true, data: this.rowToEvent(row, map.get(id) ?? []) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async searchEvents(opts: EventSearchOpts): Promise<InfraResult<EventRecord[]>> {
    try {
      const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
      const offset = Math.max(0, opts.offset ?? 0);
      const conditions: string[] = ['(e.expires_at IS NULL OR e.expires_at > ?)'];
      const params: any[] = [Date.now()];
      if (opts.type) { conditions.push('e.type = ?'); params.push(opts.type); }
      if (opts.who) { conditions.push('e.who = ?'); params.push(opts.who); }
      if (opts.occurredAfter !== undefined) { conditions.push('e.occurred_at >= ?'); params.push(opts.occurredAfter); }
      if (opts.occurredBefore !== undefined) { conditions.push('e.occurred_at <= ?'); params.push(opts.occurredBefore); }

      // entityId filter — m2m JOIN
      const fromClause = opts.entityId !== undefined
        ? 'FROM events e INNER JOIN event_entities ee ON ee.event_id = e.id'
        : 'FROM events e';
      if (opts.entityId !== undefined) {
        conditions.push('ee.entity_id = ?');
        params.push(opts.entityId);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;

      const hasSemantic = !!(opts.query?.trim() || opts.queryEmbedding);

      const rows = this.db.prepare(`SELECT DISTINCT e.* ${fromClause} ${where}`).all(...params) as EventRow[];

      let result: EventRow[];
      if (hasSemantic) {
        let queryEmb: Float32Array;
        if (opts.queryEmbedding) {
          queryEmb = this.embedder.bufferToFloat32(opts.queryEmbedding);
        } else {
          queryEmb = await this.embedder.embedQuery(opts.query!);
        }
        const scored = rows
          .filter(r => r.embedding)
          .map(r => ({ row: r, score: this.embedder.cosine(queryEmb, this.embedder.bufferToFloat32(r.embedding!)) }))
          .sort((a, b) => b.score - a.score);
        result = scored.slice(offset, offset + limit).map(s => s.row);
      } else {
        // 시간 순 정렬 — occurredAt DESC
        rows.sort((a, b) => b.occurred_at - a.occurred_at);
        result = rows.slice(offset, offset + limit);
      }

      const eventIds = result.map(r => r.id);
      const entityMap = this.getEntityIdsForEvents(eventIds);
      return { success: true, data: result.map(r => this.rowToEvent(r, entityMap.get(r.id) ?? [])) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async listRecentEvents(opts?: { type?: string; who?: string; limit?: number; offset?: number }): Promise<InfraResult<EventRecord[]>> {
    try {
      const limit = Math.max(1, Math.min(500, opts?.limit ?? 50));
      const offset = Math.max(0, opts?.offset ?? 0);
      const conditions: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
      const params: any[] = [Date.now()];
      if (opts?.type) { conditions.push('type = ?'); params.push(opts.type); }
      if (opts?.who) { conditions.push('who = ?'); params.push(opts.who); }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const rows = this.db.prepare(`
        SELECT * FROM events ${where}
        ORDER BY occurred_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as EventRow[];
      const eventIds = rows.map(r => r.id);
      const entityMap = this.getEntityIdsForEvents(eventIds);
      return { success: true, data: rows.map(r => this.rowToEvent(r, entityMap.get(r.id) ?? [])) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async linkEventEntity(eventId: number, entityId: number): Promise<InfraResult<void>> {
    try {
      this.db.prepare('INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?, ?)').run(eventId, entityId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async unlinkEventEntity(eventId: number, entityId: number): Promise<InfraResult<void>> {
    try {
      this.db.prepare('DELETE FROM event_entities WHERE event_id = ? AND entity_id = ?').run(eventId, entityId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async cleanupExpiredEvents(): Promise<InfraResult<{ deleted: number }>> {
    try {
      const info = this.db.prepare('DELETE FROM events WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
      return { success: true, data: { deleted: info.changes as number } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
