//! SqliteVaultAdapter — IVaultPort 의 rusqlite 구현체.
//!
//! 옛 TS VaultAdapter (`infra/storage/vault-adapter.ts`) Rust 재구현.
//! SQLite key-value 저장. 다중 thread 안전 — Mutex 로 connection wrapping.
//!
//! Hardcoding audit (Phase B 룰):
//!  - 옛 TS 의 try/catch return false 패턴 그대로 — 일반 robustness (errors silent → InfraResult)
//!  - 옛 SQL 그대로 (CREATE TABLE / INSERT ON CONFLICT / DELETE / SELECT) — 표준 SQLite 패턴
//!  - magic number 0건

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::ports::IVaultPort;

pub struct SqliteVaultAdapter {
    conn: Mutex<Connection>,
}

impl SqliteVaultAdapter {
    /// 새 어댑터 — DB 파일 경로 (보통 `data/vault.db`). 디렉토리 자동 생성.
    pub fn new(db_path: impl AsRef<Path>) -> Result<Self, String> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Vault DB 디렉토리 생성 실패: {e}"))?;
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("Vault DB open 실패: {e}"))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS secrets (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .map_err(|e| format!("Vault 테이블 생성 실패: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// In-memory DB — 테스트용.
    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Vault in-memory DB open 실패: {e}"))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS secrets (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .map_err(|e| format!("Vault 테이블 생성 실패: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

impl IVaultPort for SqliteVaultAdapter {
    fn get_secret(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        let mut stmt = conn
            .prepare("SELECT value FROM secrets WHERE key = ?1")
            .ok()?;
        stmt.query_row(params![key], |row| row.get::<_, String>(0))
            .ok()
    }

    fn set_secret(&self, key: &str, value: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = CURRENT_TIMESTAMP",
            params![key, value.trim()],
        )
        .is_ok()
    }

    fn delete_secret(&self, key: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.execute("DELETE FROM secrets WHERE key = ?1", params![key])
            .is_ok()
    }

    fn list_keys(&self) -> Vec<String> {
        let Ok(conn) = self.conn.lock() else {
            return vec![];
        };
        let Ok(mut stmt) = conn.prepare("SELECT key FROM secrets ORDER BY key") else {
            return vec![];
        };
        let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
            return vec![];
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    fn list_keys_by_prefix(&self, prefix: &str) -> Vec<String> {
        let Ok(conn) = self.conn.lock() else {
            return vec![];
        };
        let Ok(mut stmt) =
            conn.prepare("SELECT key FROM secrets WHERE key LIKE ?1 ORDER BY key")
        else {
            return vec![];
        };
        let pattern = format!("{}%", prefix);
        let Ok(rows) = stmt.query_map(params![pattern], |row| row.get::<_, String>(0)) else {
            return vec![];
        };
        rows.filter_map(|r| r.ok()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_get_then_delete_roundtrip() {
        let vault = SqliteVaultAdapter::new_in_memory().unwrap();

        // empty
        assert_eq!(vault.get_secret("k1"), None);

        // set
        assert!(vault.set_secret("k1", "v1"));
        assert_eq!(vault.get_secret("k1"), Some("v1".to_string()));

        // overwrite
        assert!(vault.set_secret("k1", "v1-updated"));
        assert_eq!(vault.get_secret("k1"), Some("v1-updated".to_string()));

        // delete
        assert!(vault.delete_secret("k1"));
        assert_eq!(vault.get_secret("k1"), None);
    }

    #[test]
    fn list_keys_and_prefix() {
        let vault = SqliteVaultAdapter::new_in_memory().unwrap();
        vault.set_secret("user:foo", "1");
        vault.set_secret("user:bar", "2");
        vault.set_secret("system:vertex", "3");

        let all = vault.list_keys();
        assert_eq!(all.len(), 3);
        assert!(all.contains(&"system:vertex".to_string()));

        let user_keys = vault.list_keys_by_prefix("user:");
        assert_eq!(user_keys.len(), 2);
        assert!(user_keys.iter().all(|k| k.starts_with("user:")));
    }

    #[test]
    fn whitespace_trimmed_on_set() {
        let vault = SqliteVaultAdapter::new_in_memory().unwrap();
        vault.set_secret("k", "  value with surrounding ws  ");
        assert_eq!(vault.get_secret("k"), Some("value with surrounding ws".to_string()));
    }
}
