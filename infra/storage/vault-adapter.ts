import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class VaultAdapter {
  private db: Database.Database;
  private logger: { error(msg: string): void } | null = null;

  /** ILogPort 주입 — boot 시 log 어댑터 생성 후 호출 */
  setLogger(log: { error(msg: string): void }): void {
    this.logger = log;
  }

  private logError(msg: string, e: unknown): void {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (this.logger) {
      this.logger.error(`${msg}: ${errMsg}`);
    }
  }

  constructor() {
    const dbPath = path.resolve(process.cwd(), 'data', 'vault.db');
    
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  getSecret(key: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT value FROM secrets WHERE key = ?');
      const result = stmt.get(key) as { value: string } | undefined;
      return result ? result.value : null;
    } catch (e) {
      this.logError('[Vault] Error getting secret', e);
      return null;
    }
  }

  setSecret(key: string, value: string): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO secrets (key, value) 
        VALUES (?, ?) 
        ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
      `);
      stmt.run(key, value.trim());
      return true;
    } catch (e) {
      this.logError('[Vault] Error setting secret', e);
      return false;
    }
  }

  deleteSecret(key: string): boolean {
    try {
      const stmt = this.db.prepare('DELETE FROM secrets WHERE key = ?');
      stmt.run(key);
      return true;
    } catch (e) {
      this.logError('[Vault] Error deleting secret', e);
      return false;
    }
  }

  /** 저장된 모든 시크릿 키 이름 목록 반환 (값은 노출하지 않음) */
  listKeys(): string[] {
    try {
      const stmt = this.db.prepare('SELECT key FROM secrets ORDER BY key');
      return (stmt.all() as Array<{ key: string }>).map(row => row.key);
    } catch (e) {
      this.logError('[Vault] Error listing keys', e);
      return [];
    }
  }

  /** 특정 접두사로 시작하는 시크릿 키 목록 반환 */
  listKeysByPrefix(prefix: string): string[] {
    try {
      const stmt = this.db.prepare('SELECT key FROM secrets WHERE key LIKE ? ORDER BY key');
      return (stmt.all(`${prefix}%`) as Array<{ key: string }>).map(row => row.key);
    } catch (e) {
      this.logError('[Vault] Error listing keys by prefix', e);
      return [];
    }
  }
}

// 전역 공간에 할당하여 Next.js Hot-Reload 시 다중 커넥션으로 인한 SQLite 잠금(Lock) 및 프리징 방지
const globalForVault = globalThis as unknown as {
  vault: VaultAdapter | undefined
};

export const vault = globalForVault.vault ?? new VaultAdapter();

if (process.env.NODE_ENV !== 'production') {
  globalForVault.vault = vault;
}
