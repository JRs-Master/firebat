import { IDatabasePort } from '../../core/ports';
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
  }

  async query(queryPayload: any, options?: any): Promise<InfraResult<any>> {
    try {
      if (typeof queryPayload !== 'string') {
         return { success: false, error: '[Adapter Mismatch] SqliteDatabaseAdapter currently requires raw SQL strings, not JSON payload objects.' };
      }
      
      const isSelect = queryPayload.trim().toUpperCase().startsWith('SELECT');
      const stmt = this.db.prepare(queryPayload);
      
      if (isSelect) {
        const rows = options ? stmt.all(options) : stmt.all();
        return { success: true, data: rows };
      } else {
        const info = options ? stmt.run(options) : stmt.run();
        return { success: true, data: info };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ── PageSpec CRUD ────────────────────────────────────────────────────────

  async listPages(): Promise<InfraResult<any[]>> {
    try {
      const rows = this.db.prepare(
        `SELECT slug, status, spec, visibility, updated_at as updatedAt FROM pages ORDER BY updated_at DESC`
      ).all() as any[];
      const list = rows.map(r => {
        try {
          const parsed = JSON.parse(r.spec);
          return { slug: r.slug, status: r.status, title: parsed.head?.title ?? r.slug, project: parsed.project ?? null, visibility: r.visibility ?? 'public', updatedAt: r.updatedAt };
        } catch {
          return { slug: r.slug, status: r.status, title: r.slug, project: null, visibility: r.visibility ?? 'public', updatedAt: r.updatedAt };
        }
      });
      return { success: true, data: list };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getPage(slug: string): Promise<InfraResult<any>> {
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
