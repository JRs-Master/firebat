import { IDatabasePort, PageListItem, PageSpec } from '../../core/ports';
import { InfraResult } from '../../core/types';
import Database from 'better-sqlite3';
import { DB_PATH } from '../config';

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
      const row = this.db.prepare(`SELECT spec, visibility, password FROM pages WHERE slug = ?`).get(slug) as { spec: string; visibility: string; password: string | null } | undefined;
      if (!row) return { success: false, error: `Page not found: ${slug}` };
      const parsed = JSON.parse(row.spec);
      parsed._visibility = row.visibility ?? 'public';
      parsed._hasPassword = !!row.password;
      return { success: true, data: parsed };
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
