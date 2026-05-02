import { IDatabasePort, PageListItem, PageSpec } from '../../core/ports';
import { InfraResult } from '../../core/types';
import Database from 'better-sqlite3';
import { DB_PATH } from '../config';
import { unwrapJson } from '../../core/utils/json-normalize';
import { runMigrations } from './migrations/runner';

/**
 * 범용 DB 포트의 1차 구현체 (로컬 SQLite)
 * 몽고디비 등 NoSQL로 향후 변경 시, 이 파일만 갈아끼우면 Core가 즉시 동작합니다.
 */
export class SqliteDatabaseAdapter implements IDatabasePort {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  /** 필수 테이블 자동 생성 */
  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        slug       TEXT PRIMARY KEY,
        spec       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'published',
        project    TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 기존 DB 마이그레이션 — 컬럼 없으면 추가
    const migrations = [
      'ALTER TABLE pages ADD COLUMN project TEXT',
      "ALTER TABLE pages ADD COLUMN visibility TEXT DEFAULT 'public'",
      'ALTER TABLE pages ADD COLUMN password TEXT',
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* 이미 존재하면 무시 */ }
    }
    // 대화 저장 테이블 (admin 계정의 채팅 히스토리 — 다기기 동기화용)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL DEFAULT 'admin',
        title      TEXT NOT NULL DEFAULT '새 대화',
        messages   TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated ON conversations(owner, updated_at DESC)'); } catch {}
    // CLI 모드 세션 resume 용 컬럼 (마이그레이션: 존재하지 않을 때만 추가)
    try { this.db.exec(`ALTER TABLE conversations ADD COLUMN cli_session_id TEXT`); } catch { /* 이미 존재하면 무시 */ }
    try { this.db.exec(`ALTER TABLE conversations ADD COLUMN cli_model TEXT`); } catch { /* 이미 존재하면 무시 */ }
    // Plan 실행 / 3-stage 공동설계 진행 상태 — multi-turn 지속용 JSON
    // { planId, currentStage?, selections?, type? } 등 구조. null 이면 진행 중 plan 없음.
    try { this.db.exec(`ALTER TABLE conversations ADD COLUMN active_plan_state TEXT`); } catch { /* 이미 존재 */ }

    // 대화 삭제 tombstone — 한 기기에서 삭제 후 다른 기기의 stale POST 가 되살리는 레이스 방지.
    //  - DELETE 시 tombstone 기록 + conversations row 삭제
    //  - POST 시 tombstone 있으면 409 반환 → 클라이언트는 로컬에서도 제거
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deleted_conversations (
        id         TEXT NOT NULL,
        owner      TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (id, owner)
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_deleted_conversations_owner ON deleted_conversations(owner, deleted_at DESC)'); } catch {}

    // 공유 대화 (shared conversations) — ChatGPT·Claude 의 공유 기능과 동일.
    //  - type='turn': 단일 Q+A pair 공유 (MessageBubble 복사 옆 버튼)
    //  - type='full': 전체 대화 공유 (Sidebar ⋯ 메뉴)
    //  - messages 는 공유 시점 snapshot — 원본 대화가 바뀌거나 삭제돼도 불변
    //  - expires_at 경과 후 자동 삭제 (cron 1시간마다)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_conversations (
        slug           TEXT PRIMARY KEY,
        type           TEXT NOT NULL DEFAULT 'full',
        title          TEXT NOT NULL DEFAULT '공유된 대화',
        messages       TEXT NOT NULL,
        owner          TEXT,
        source_conv_id TEXT,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_shared_expires ON shared_conversations(expires_at)'); } catch {}
    // dedup_key 컬럼 (마이그레이션) — 같은 키 + 유효 share 존재 시 재사용
    try { this.db.exec('ALTER TABLE shared_conversations ADD COLUMN dedup_key TEXT'); } catch { /* 이미 존재 */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_shared_dedup ON shared_conversations(dedup_key, expires_at)'); } catch {}

    // 메시지 단위 벡터 임베딩 (search_history 도구용 — 과거 대화 검색)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_embeddings (
        conv_id         TEXT NOT NULL,
        owner           TEXT NOT NULL,
        msg_idx         INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        content_preview TEXT NOT NULL,
        embedding       BLOB NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (conv_id, msg_idx)
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_embeddings_owner ON conversation_embeddings(owner, created_at DESC)'); } catch {}

    // 도구·컴포넌트 라우팅 캐시 (self-learning router)
    //  - 유저 쿼리 임베딩을 저장해두고, 유사 쿼리 재유입 시 캐시된 라우팅 재사용
    //  - Flash Lite 호출 빈도 감소 → 시간 지날수록 LLM 비용 체감
    //  - success/failure 카운트로 잘못된 라우팅 자동 폐기
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_cache (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,       -- 'tools' | 'components'
        query_text      TEXT NOT NULL,
        query_embedding BLOB NOT NULL,
        result_json     TEXT NOT NULL,       -- { tools: [...] } 또는 { components: [...] }
        success_count   INTEGER NOT NULL DEFAULT 0,
        failure_count   INTEGER NOT NULL DEFAULT 0,
        use_count       INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        last_used_at    INTEGER NOT NULL
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_routing_cache_kind ON routing_cache(kind, last_used_at DESC)'); } catch {}

    // 페이지 URL 리디렉트 — slug 변경 시 구 URL 로 들어오는 요청을 신 URL 로 자동 이동
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS page_redirects (
        from_slug   TEXT PRIMARY KEY,
        to_slug     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);

    // 미디어 사용처 인덱스 — 페이지 PageSpec 안의 image src 에서 추출한 (media_slug, page_slug) 매핑.
    // PageManager.save 시 자동 upsert, delete 시 page_slug 기준 일괄 삭제.
    // 갤러리 삭제 confirm 차등화 + 사용처 표시에 활용.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_usage (
        media_slug  TEXT NOT NULL,
        page_slug   TEXT NOT NULL,
        used_at     INTEGER NOT NULL,
        PRIMARY KEY (media_slug, page_slug)
      );
      CREATE INDEX IF NOT EXISTS idx_media_usage_page ON media_usage(page_slug);
      CREATE INDEX IF NOT EXISTS idx_media_usage_media ON media_usage(media_slug);
    `);

    // ── 마이그레이션 runner ──
    // 위 baseline 스키마는 implicit v1. v2+ 변경은 migrations/NNN-name.sql 추가로 자동 적용.
    // 자세한 안내: infra/database/migrations/README.md
    runMigrations(this.db);
  }

  async query(sql: string, params?: unknown[]): Promise<InfraResult<Record<string, unknown>[]>> {
    try {
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
      const stmt = this.db.prepare(sql);

      if (isSelect) {
        const rows = params ? stmt.all(...params) : stmt.all();
        return { success: true, data: rows as Record<string, unknown>[] };
      } else {
        const info = params ? stmt.run(...params) : stmt.run();
        return { success: true, data: [info as unknown as Record<string, unknown>] };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ── PageSpec CRUD ────────────────────────────────────────────────────────

  async listPages(): Promise<InfraResult<PageListItem[]>> {
    try {
      const rows = this.db.prepare(
        `SELECT slug, status, spec, visibility, updated_at as updatedAt FROM pages ORDER BY updated_at DESC`
      ).all() as Array<{ slug: string; status: string; spec: string; visibility: string | null; updatedAt: string }>;
      const toVisibility = (v: string | null): 'public' | 'password' | 'private' => {
        if (v === 'password' || v === 'private') return v;
        return 'public';
      };
      const list: PageListItem[] = rows.map(r => {
        try {
          const parsed = JSON.parse(r.spec);
          return { slug: r.slug, status: r.status, title: parsed.head?.title ?? r.slug, project: parsed.project ?? undefined, visibility: toVisibility(r.visibility), updatedAt: r.updatedAt };
        } catch {
          return { slug: r.slug, status: r.status, title: r.slug, project: undefined, visibility: toVisibility(r.visibility), updatedAt: r.updatedAt };
        }
      });
      return { success: true, data: list };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getPage(slug: string): Promise<InfraResult<PageSpec>> {
    try {
      const row = this.db.prepare(`SELECT spec, visibility, password, created_at as createdAt, updated_at as updatedAt FROM pages WHERE slug = ?`).get(slug) as { spec: string; visibility: string; password: string | null; createdAt: string; updatedAt: string } | undefined;
      if (!row) return { success: false, error: `Page not found: ${slug}` };
      // 과거 double-encoded 저장된 손상 데이터도 자동 복구 — unwrapJson 이 깊이 3까지 재파싱
      const parsed = unwrapJson<Record<string, unknown>>(row.spec);
      parsed._visibility = row.visibility ?? 'public';
      parsed._hasPassword = !!row.password;
      parsed._createdAt = row.createdAt ?? null;
      parsed._updatedAt = row.updatedAt ?? null;
      return { success: true, data: parsed as unknown as PageSpec };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async savePage(slug: string, spec: string): Promise<InfraResult<void>> {
    try {
      const parsed = JSON.parse(spec);
      const status = parsed.status ?? 'published';
      const project = parsed.project ?? null;
      this.db.prepare(`
        INSERT INTO pages (slug, spec, status, project, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(slug) DO UPDATE SET
          spec = excluded.spec,
          status = excluded.status,
          project = excluded.project,
          updated_at = CURRENT_TIMESTAMP
      `).run(slug, spec, status, project);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 페이지 visibility 설정 */
  async setPageVisibility(slug: string, visibility: 'public' | 'password' | 'private', password?: string): Promise<InfraResult<void>> {
    try {
      const row = this.db.prepare(`SELECT slug FROM pages WHERE slug = ?`).get(slug);
      if (!row) return { success: false, error: `Page not found: ${slug}` };
      this.db.prepare(`UPDATE pages SET visibility = ?, password = ? WHERE slug = ?`)
        .run(visibility, visibility === 'password' ? (password ?? null) : null, slug);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 페이지 비밀번호 검증 */
  async verifyPagePassword(slug: string, password: string): Promise<InfraResult<boolean>> {
    try {
      const row = this.db.prepare(`SELECT password FROM pages WHERE slug = ?`).get(slug) as { password: string | null } | undefined;
      if (!row) return { success: false, error: `Page not found: ${slug}` };
      return { success: true, data: row.password === password };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async deletePage(slug: string): Promise<InfraResult<void>> {
    try {
      const info = this.db.prepare(`DELETE FROM pages WHERE slug = ?`).run(slug);
      if (info.changes === 0) return { success: false, error: `Page not found: ${slug}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 특정 프로젝트에 속한 페이지 slug 목록 */
  async listPagesByProject(project: string): Promise<InfraResult<string[]>> {
    try {
      const rows = this.db.prepare(
        `SELECT slug FROM pages WHERE project = ?`
      ).all(project) as { slug: string }[];
      return { success: true, data: rows.map(r => r.slug) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 특정 프로젝트의 모든 페이지 삭제 */
  // ── Shared conversations (공유 대화) ────────────────────────────────────
  /** 공유 생성 — 8자리 hex slug 자동 할당 (충돌 시 재시도).
   *  dedupKey 제공 시 같은 키 + 유효한 share 존재하면 기존 slug/expiresAt 반환 (24h TTL 갱신 X). */
  async createShare(input: { type: 'turn' | 'full'; title: string; messages: unknown[]; owner?: string; sourceConvId?: string; ttlMs: number; dedupKey?: string }): Promise<InfraResult<{ slug: string; expiresAt: number; reused?: boolean }>> {
    try {
      const now = Date.now();
      const expiresAt = now + input.ttlMs;
      // dedupKey 있고 유효한 share 존재 → 재사용
      if (input.dedupKey) {
        const existing = this.db.prepare(
          `SELECT slug, expires_at as expiresAt FROM shared_conversations
           WHERE dedup_key = ? AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        ).get(input.dedupKey, now) as { slug: string; expiresAt: number } | undefined;
        if (existing) {
          return { success: true, data: { slug: existing.slug, expiresAt: existing.expiresAt, reused: true } };
        }
      }
      const messagesJson = JSON.stringify(input.messages);
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug = Math.random().toString(36).slice(2, 10);
        try {
          this.db.prepare(
            `INSERT INTO shared_conversations (slug, type, title, messages, owner, source_conv_id, created_at, expires_at, dedup_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(slug, input.type, input.title, messagesJson, input.owner ?? null, input.sourceConvId ?? null, now, expiresAt, input.dedupKey ?? null);
          return { success: true, data: { slug, expiresAt } };
        } catch (err: any) {
          if (err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') continue; // slug 충돌 → 재시도
          return { success: false, error: err.message };
        }
      }
      return { success: false, error: 'slug 충돌 5회 — 재시도 포기' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 공유 조회 — 만료 시 null 반환 (404 처리용). */
  async getShare(slug: string): Promise<InfraResult<{ slug: string; type: 'turn' | 'full'; title: string; messages: unknown[]; createdAt: number; expiresAt: number } | null>> {
    try {
      const row = this.db.prepare(
        `SELECT slug, type, title, messages, created_at as createdAt, expires_at as expiresAt
         FROM shared_conversations WHERE slug = ?`,
      ).get(slug) as { slug: string; type: string; title: string; messages: string; createdAt: number; expiresAt: number } | undefined;
      if (!row) return { success: true, data: null };
      if (row.expiresAt < Date.now()) return { success: true, data: null }; // 만료
      let messages: unknown[] = [];
      try { messages = JSON.parse(row.messages); } catch {}
      return { success: true, data: { slug: row.slug, type: row.type as 'turn' | 'full', title: row.title, messages, createdAt: row.createdAt, expiresAt: row.expiresAt } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 만료된 공유 정리 — 1시간마다 cron 에서 호출. */
  async cleanupExpiredShares(): Promise<InfraResult<{ deleted: number }>> {
    try {
      const res = this.db.prepare(`DELETE FROM shared_conversations WHERE expires_at < ?`).run(Date.now());
      return { success: true, data: { deleted: res.changes } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async deletePagesByProject(project: string): Promise<InfraResult<string[]>> {
    try {
      const slugs = this.db.prepare(`SELECT slug FROM pages WHERE project = ?`).all(project) as { slug: string }[];
      if (slugs.length > 0) {
        this.db.prepare(`DELETE FROM pages WHERE project = ?`).run(project);
      }
      return { success: true, data: slugs.map(r => r.slug) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
