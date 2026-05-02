/**
 * SqliteEntityAdapter — Entity + EntityFact CRUD + semantic search.
 *
 * Phase 1 of 4-tier memory system. Phase 3 에서 dedicated vector store (Qdrant 또는
 * SQLite cosine extension) 으로 swap 가능 — IEntityPort 인터페이스 그대로 유지.
 *
 * Embedding flow:
 *   - saveEntity / saveFact 가 IEmbedderPort.embedPassage 호출 → BLOB 저장
 *   - searchEntities / searchFacts 가 IEmbedderPort.embedQuery 호출 → 모든 row 와 cosine compute
 *   - Phase 1 단순 구현: 모든 row scan. Entity 1000+ 시점에 vector index 추가
 */
import type Database from 'better-sqlite3';
import type {
  IEntityPort,
  IEmbedderPort,
  ILogPort,
  EntityRecord,
  EntityFactRecord,
  EntitySearchOpts,
  FactSearchOpts,
} from '../../core/ports';
import type { InfraResult } from '../../core/types';

interface EntityRow {
  id: number;
  name: string;
  type: string;
  aliases: string;
  metadata: string | null;
  embedding: Buffer | null;
  source_conv_id: string | null;
  first_seen: number;
  last_updated: number;
  fact_count?: number;
}

interface FactRow {
  id: number;
  entity_id: number;
  content: string;
  fact_type: string | null;
  occurred_at: number | null;
  tags: string;
  embedding: Buffer | null;
  source_conv_id: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function safeJsonObject(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function rowToEntity(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    aliases: safeJsonArray(row.aliases),
    metadata: safeJsonObject(row.metadata),
    sourceConvId: row.source_conv_id ?? undefined,
    firstSeen: row.first_seen,
    lastUpdated: row.last_updated,
    factCount: row.fact_count,
  };
}

function rowToFact(row: FactRow): EntityFactRecord {
  return {
    id: row.id,
    entityId: row.entity_id,
    content: row.content,
    factType: row.fact_type ?? undefined,
    occurredAt: row.occurred_at ?? undefined,
    tags: safeJsonArray(row.tags),
    sourceConvId: row.source_conv_id ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteEntityAdapter implements IEntityPort {
  constructor(
    private readonly db: Database.Database,
    private readonly embedder: IEmbedderPort,
    private readonly log: ILogPort,
  ) {}

  // ── Entity CRUD ──────────────────────────────────────────────────────────

  async saveEntity(input: { name: string; type: string; aliases?: string[]; metadata?: Record<string, unknown>; sourceConvId?: string; embedding?: Buffer }): Promise<InfraResult<{ id: number; created: boolean }>> {
    try {
      const name = input.name.trim();
      const type = input.type.trim();
      if (!name || !type) return { success: false, error: 'name 과 type 은 필수' };
      const aliases = (input.aliases ?? []).map(s => s.trim()).filter(Boolean);
      const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
      const now = Date.now();
      // Embedding — input 우선, 없으면 자동 생성 (name + aliases 합쳐서)
      let embedding: Buffer | null = input.embedding ?? null;
      if (!embedding) {
        try {
          const text = [name, ...aliases].join(' ');
          const arr = await this.embedder.embedPassage(text);
          embedding = this.embedder.float32ToBuffer(arr);
        } catch (err: any) {
          this.log.debug?.(`[Entity] 임베딩 생성 실패: ${err?.message ?? err}`);
        }
      }

      // Upsert by (name, type)
      const existing = this.db.prepare('SELECT id FROM entities WHERE name = ? AND type = ?').get(name, type) as { id: number } | undefined;
      if (existing) {
        // 업데이트 — aliases / metadata / embedding 모두 갱신, last_updated 만 새로
        this.db.prepare(`
          UPDATE entities SET
            aliases = ?, metadata = ?, embedding = ?, last_updated = ?
          WHERE id = ?
        `).run(JSON.stringify(aliases), metadata, embedding, now, existing.id);
        return { success: true, data: { id: existing.id, created: false } };
      }

      const info = this.db.prepare(`
        INSERT INTO entities (name, type, aliases, metadata, embedding, source_conv_id, first_seen, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, type, JSON.stringify(aliases), metadata, embedding, input.sourceConvId ?? null, now, now);
      return { success: true, data: { id: info.lastInsertRowid as number, created: true } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async updateEntity(id: number, patch: { name?: string; type?: string; aliases?: string[]; metadata?: Record<string, unknown>; embedding?: Buffer }): Promise<InfraResult<void>> {
    try {
      const sets: string[] = [];
      const params: any[] = [];
      if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name.trim()); }
      if (patch.type !== undefined) { sets.push('type = ?'); params.push(patch.type.trim()); }
      if (patch.aliases !== undefined) {
        sets.push('aliases = ?');
        params.push(JSON.stringify(patch.aliases.filter(Boolean)));
      }
      if (patch.metadata !== undefined) {
        sets.push('metadata = ?');
        params.push(patch.metadata ? JSON.stringify(patch.metadata) : null);
      }
      if (patch.embedding !== undefined) {
        sets.push('embedding = ?');
        params.push(patch.embedding);
      }
      if (sets.length === 0) return { success: true };
      sets.push('last_updated = ?');
      params.push(Date.now());
      params.push(id);
      const info = this.db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (info.changes === 0) return { success: false, error: `Entity not found: ${id}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async removeEntity(id: number): Promise<InfraResult<void>> {
    try {
      // ON DELETE CASCADE 가 entity_facts 도 자동 정리.
      const info = this.db.prepare('DELETE FROM entities WHERE id = ?').run(id);
      if (info.changes === 0) return { success: false, error: `Entity not found: ${id}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getEntity(id: number): Promise<InfraResult<EntityRecord | null>> {
    try {
      const row = this.db.prepare(`
        SELECT e.*, COUNT(f.id) AS fact_count
        FROM entities e
        LEFT JOIN entity_facts f ON f.entity_id = e.id
        WHERE e.id = ?
        GROUP BY e.id
      `).get(id) as EntityRow | undefined;
      if (!row) return { success: true, data: null };
      return { success: true, data: rowToEntity(row) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async findEntityByName(name: string): Promise<InfraResult<EntityRecord | null>> {
    try {
      const trimmed = name.trim();
      if (!trimmed) return { success: true, data: null };
      // 1. canonical name 매칭
      const direct = this.db.prepare(`
        SELECT e.*, COUNT(f.id) AS fact_count
        FROM entities e
        LEFT JOIN entity_facts f ON f.entity_id = e.id
        WHERE LOWER(e.name) = LOWER(?)
        GROUP BY e.id
        ORDER BY e.last_updated DESC
        LIMIT 1
      `).get(trimmed) as EntityRow | undefined;
      if (direct) return { success: true, data: rowToEntity(direct) };
      // 2. alias 매칭 — JSON 안에서 case-insensitive 검색 (정확 일치)
      const allRows = this.db.prepare(`
        SELECT e.*, COUNT(f.id) AS fact_count
        FROM entities e
        LEFT JOIN entity_facts f ON f.entity_id = e.id
        GROUP BY e.id
      `).all() as EntityRow[];
      const lowered = trimmed.toLowerCase();
      for (const row of allRows) {
        const aliases = safeJsonArray(row.aliases);
        if (aliases.some(a => a.toLowerCase() === lowered)) {
          return { success: true, data: rowToEntity(row) };
        }
      }
      return { success: true, data: null };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async searchEntities(opts: EntitySearchOpts): Promise<InfraResult<EntityRecord[]>> {
    try {
      const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
      const offset = Math.max(0, opts.offset ?? 0);
      // 1. 후보 가져오기 — type / nameLike 필터 SQL 적용
      const conditions: string[] = [];
      const params: any[] = [];
      if (opts.type) { conditions.push('e.type = ?'); params.push(opts.type); }
      if (opts.nameLike) {
        const escaped = opts.nameLike.replace(/[\\%_]/g, m => `\\${m}`);
        conditions.push("LOWER(e.name) LIKE LOWER(?) ESCAPE '\\'");
        params.push(`%${escaped}%`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderBy = (() => {
        switch (opts.orderBy) {
          case 'firstSeen': return 'e.first_seen DESC';
          case 'factCount': return 'fact_count DESC';
          case 'name': return 'e.name ASC';
          case 'lastUpdated':
          default: return 'e.last_updated DESC';
        }
      })();

      // Semantic search 인 경우 — 임베딩 매칭 후 정렬, 그 외 SQL 정렬 그대로
      const hasSemanticQuery = !!(opts.query?.trim() || opts.queryEmbedding);
      if (hasSemanticQuery) {
        // 후보 모두 가져온 뒤 cosine 정렬
        const rows = this.db.prepare(`
          SELECT e.*, COUNT(f.id) AS fact_count
          FROM entities e
          LEFT JOIN entity_facts f ON f.entity_id = e.id
          ${where}
          GROUP BY e.id
        `).all(...params) as EntityRow[];
        let queryEmb: Float32Array;
        if (opts.queryEmbedding) {
          queryEmb = this.embedder.bufferToFloat32(opts.queryEmbedding);
        } else {
          queryEmb = await this.embedder.embedQuery(opts.query!);
        }
        const scored = rows
          .filter(r => r.embedding)
          .map(r => ({
            row: r,
            score: this.embedder.cosine(queryEmb, this.embedder.bufferToFloat32(r.embedding!)),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(offset, offset + limit);
        return { success: true, data: scored.map(s => rowToEntity(s.row)) };
      }

      const rows = this.db.prepare(`
        SELECT e.*, COUNT(f.id) AS fact_count
        FROM entities e
        LEFT JOIN entity_facts f ON f.entity_id = e.id
        ${where}
        GROUP BY e.id
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as EntityRow[];
      return { success: true, data: rows.map(rowToEntity) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ── Fact CRUD ────────────────────────────────────────────────────────────

  async saveFact(input: { entityId: number; content: string; factType?: string; occurredAt?: number; tags?: string[]; sourceConvId?: string; ttlDays?: number; embedding?: Buffer; dedupThreshold?: number }): Promise<InfraResult<{ id: number; skipped?: boolean; similarity?: number }>> {
    try {
      const content = input.content.trim();
      if (!content) return { success: false, error: 'content 필수' };
      // Entity 존재 확인
      const entityExists = this.db.prepare('SELECT id FROM entities WHERE id = ?').get(input.entityId);
      if (!entityExists) return { success: false, error: `Entity not found: ${input.entityId}` };

      const now = Date.now();
      const expiresAt = input.ttlDays && input.ttlDays > 0 ? now + input.ttlDays * 24 * 60 * 60 * 1000 : null;
      const tags = (input.tags ?? []).filter(Boolean);

      // Embedding — 입력 우선, 없으면 자동
      let embedding: Buffer | null = input.embedding ?? null;
      if (!embedding) {
        try {
          const arr = await this.embedder.embedPassage(content);
          embedding = this.embedder.float32ToBuffer(arr);
        } catch (err: any) {
          this.log.debug?.(`[Fact] 임베딩 생성 실패: ${err?.message ?? err}`);
        }
      }

      // 중복 검출 — dedupThreshold 박혀있고 새 임베딩 있을 때만.
      // 같은 entity 의 기존 fact 들 중 cosine ≥ threshold 면 skip + 기존 id 반환.
      if (input.dedupThreshold && input.dedupThreshold > 0 && embedding) {
        const existingFacts = this.db.prepare(`
          SELECT id, embedding FROM entity_facts
          WHERE entity_id = ? AND embedding IS NOT NULL
            AND (expires_at IS NULL OR expires_at > ?)
        `).all(input.entityId, now) as Array<{ id: number; embedding: Buffer }>;
        let bestId: number | null = null;
        let bestSimilarity = 0;
        const newEmb = this.embedder.bufferToFloat32(embedding);
        for (const row of existingFacts) {
          const sim = this.embedder.cosine(newEmb, this.embedder.bufferToFloat32(row.embedding));
          if (sim > bestSimilarity) {
            bestSimilarity = sim;
            bestId = row.id;
          }
        }
        if (bestId !== null && bestSimilarity >= input.dedupThreshold) {
          this.log.debug?.(`[Fact] 중복 검출 skip — entity=${input.entityId} similarity=${bestSimilarity.toFixed(3)} existing_id=${bestId}`);
          return { success: true, data: { id: bestId, skipped: true, similarity: bestSimilarity } };
        }
      }

      const info = this.db.prepare(`
        INSERT INTO entity_facts
          (entity_id, content, fact_type, occurred_at, tags, embedding, source_conv_id, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.entityId,
        content,
        input.factType ?? null,
        input.occurredAt ?? null,
        JSON.stringify(tags),
        embedding,
        input.sourceConvId ?? null,
        expiresAt,
        now,
        now,
      );

      // Entity 의 last_updated 갱신
      this.db.prepare('UPDATE entities SET last_updated = ? WHERE id = ?').run(now, input.entityId);

      return { success: true, data: { id: info.lastInsertRowid as number } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async updateFact(id: number, patch: { content?: string; factType?: string; occurredAt?: number; tags?: string[]; ttlDays?: number; embedding?: Buffer }): Promise<InfraResult<void>> {
    try {
      const sets: string[] = [];
      const params: any[] = [];
      if (patch.content !== undefined) { sets.push('content = ?'); params.push(patch.content.trim()); }
      if (patch.factType !== undefined) { sets.push('fact_type = ?'); params.push(patch.factType || null); }
      if (patch.occurredAt !== undefined) { sets.push('occurred_at = ?'); params.push(patch.occurredAt || null); }
      if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(patch.tags.filter(Boolean))); }
      if (patch.ttlDays !== undefined) {
        const expiresAt = patch.ttlDays > 0 ? Date.now() + patch.ttlDays * 24 * 60 * 60 * 1000 : null;
        sets.push('expires_at = ?');
        params.push(expiresAt);
      }
      if (patch.embedding !== undefined) { sets.push('embedding = ?'); params.push(patch.embedding); }
      if (sets.length === 0) return { success: true };
      sets.push('updated_at = ?');
      params.push(Date.now());
      params.push(id);
      const info = this.db.prepare(`UPDATE entity_facts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (info.changes === 0) return { success: false, error: `Fact not found: ${id}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async removeFact(id: number): Promise<InfraResult<void>> {
    try {
      const info = this.db.prepare('DELETE FROM entity_facts WHERE id = ?').run(id);
      if (info.changes === 0) return { success: false, error: `Fact not found: ${id}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getFact(id: number): Promise<InfraResult<EntityFactRecord | null>> {
    try {
      const row = this.db.prepare('SELECT * FROM entity_facts WHERE id = ?').get(id) as FactRow | undefined;
      if (!row) return { success: true, data: null };
      return { success: true, data: rowToFact(row) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async listFactsByEntity(entityId: number, opts?: { limit?: number; offset?: number; orderBy?: 'occurredAt' | 'createdAt' }): Promise<InfraResult<EntityFactRecord[]>> {
    try {
      const limit = Math.max(1, Math.min(500, opts?.limit ?? 100));
      const offset = Math.max(0, opts?.offset ?? 0);
      const orderCol = opts?.orderBy === 'occurredAt' ? 'occurred_at' : 'created_at';
      const rows = this.db.prepare(`
        SELECT * FROM entity_facts
        WHERE entity_id = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY ${orderCol} DESC NULLS LAST
        LIMIT ? OFFSET ?
      `).all(entityId, Date.now(), limit, offset) as FactRow[];
      return { success: true, data: rows.map(rowToFact) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async searchFacts(opts: FactSearchOpts): Promise<InfraResult<EntityFactRecord[]>> {
    try {
      const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
      const offset = Math.max(0, opts.offset ?? 0);
      const conditions: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
      const params: any[] = [Date.now()];
      if (opts.entityId !== undefined) { conditions.push('entity_id = ?'); params.push(opts.entityId); }
      if (opts.factType) { conditions.push('fact_type = ?'); params.push(opts.factType); }
      if (opts.occurredAfter !== undefined) { conditions.push('occurred_at >= ?'); params.push(opts.occurredAfter); }
      if (opts.occurredBefore !== undefined) { conditions.push('occurred_at <= ?'); params.push(opts.occurredBefore); }
      const where = `WHERE ${conditions.join(' AND ')}`;

      const hasSemanticQuery = !!(opts.query?.trim() || opts.queryEmbedding);
      const allRows = this.db.prepare(`SELECT * FROM entity_facts ${where}`).all(...params) as FactRow[];

      // Tag filter (JSON 안 ANY 매칭) — JS 측 처리
      let filtered = allRows;
      if (opts.tags && opts.tags.length > 0) {
        const wantTags = opts.tags.map(t => t.toLowerCase());
        filtered = allRows.filter(r => {
          const rowTags = safeJsonArray(r.tags).map(t => t.toLowerCase());
          return wantTags.some(wt => rowTags.includes(wt));
        });
      }

      if (hasSemanticQuery) {
        let queryEmb: Float32Array;
        if (opts.queryEmbedding) {
          queryEmb = this.embedder.bufferToFloat32(opts.queryEmbedding);
        } else {
          queryEmb = await this.embedder.embedQuery(opts.query!);
        }
        const scored = filtered
          .filter(r => r.embedding)
          .map(r => ({
            row: r,
            score: this.embedder.cosine(queryEmb, this.embedder.bufferToFloat32(r.embedding!)),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(offset, offset + limit);
        return { success: true, data: scored.map(s => rowToFact(s.row)) };
      }

      // 정렬 — 최근 occurredAt → createdAt
      filtered.sort((a, b) => {
        const aTime = a.occurred_at ?? a.created_at;
        const bTime = b.occurred_at ?? b.created_at;
        return bTime - aTime;
      });
      return { success: true, data: filtered.slice(offset, offset + limit).map(rowToFact) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async cleanupExpiredFacts(): Promise<InfraResult<{ deleted: number }>> {
    try {
      const info = this.db.prepare('DELETE FROM entity_facts WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
      return { success: true, data: { deleted: info.changes as number } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
