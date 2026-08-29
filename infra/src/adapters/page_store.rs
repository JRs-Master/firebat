//! PageStoreAdapter — one SQLite file per published page, at `data/pages/<slug>/store.db`.
//!
//! A page app has no storage of its own: it runs on an opaque origin so the browser refuses it
//! `localStorage`, and opening that origin would hand the app the ability to act as the signed-in
//! admin (measured 2026-08-29 — a sandboxed frame's own requests carry no cookies, which is the
//! property being kept). So the framework holds the data and the app asks for it, the same shape as
//! a module asking for a secret.
//!
//! **One file per page, not one shared table** (2026-08-29 decision). Deleting a page is deleting a
//! file; backup is a folder copy; a page's size is visible on its own; two busy apps never wait on
//! each other's lock. It is what modules already do with their stores under `data/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use firebat_core::ports::IPageStorePort;
use rusqlite::{params, Connection};

pub struct PageStoreAdapter {
    root: PathBuf,
    /// Open handles, one per page. Pages are few and a handle is small, so they are kept rather
    /// than reopened per call — an app polls its own state far more often than pages are created.
    conns: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

/// A slug is a URL path and may nest (`carom`, `docs/manual`). It becomes a directory path, so
/// every segment has to be a plain name — this is the guard, not a convention.
fn safe_relative(slug: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    let mut segments = 0;
    for seg in slug.split('/') {
        let seg = seg.trim();
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        if !seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return None;
        }
        out.push(seg);
        segments += 1;
    }
    (segments > 0).then_some(out)
}

impl PageStoreAdapter {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            conns: Mutex::new(HashMap::new()),
        }
    }

    fn dir_of(&self, slug: &str) -> Option<PathBuf> {
        safe_relative(slug).map(|rel| self.root.join(rel))
    }

    /// The page's connection, opening (and creating) the file on first use. `None` = unusable slug
    /// or a store that could not be opened; callers treat that as "no data", never as a panic.
    fn conn(&self, slug: &str) -> Option<Arc<Mutex<Connection>>> {
        let mut map = self.conns.lock().ok()?;
        if let Some(c) = map.get(slug) {
            return Some(c.clone());
        }
        let dir = self.dir_of(slug)?;
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(target: "page_store", slug, error = %e, "page store dir");
            return None;
        }
        let path = dir.join("store.db");
        let conn = match Connection::open(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "page_store", slug, error = %e, "page store open");
                return None;
            }
        };
        // WAL + NORMAL: an app writes on interaction, so a lost final write on an OS crash costs a
        // click, while FULL would fsync on every keystroke-driven save.
        if let Err(e) = conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS kv (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        ) {
            tracing::warn!(target: "page_store", slug, error = %e, "page store schema");
            return None;
        }
        let arc = Arc::new(Mutex::new(conn));
        map.insert(slug.to_string(), arc.clone());
        Some(arc)
    }

    fn stored_bytes(conn: &Connection) -> u64 {
        conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) FROM kv",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        .max(0) as u64
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl IPageStorePort for PageStoreAdapter {
    fn get(&self, slug: &str, key: &str) -> Option<String> {
        let arc = self.conn(slug)?;
        let conn = arc.lock().ok()?;
        conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    }

    fn set(&self, slug: &str, key: &str, value: &str, max_bytes: u64) -> Result<(), String> {
        if key.trim().is_empty() {
            return Err("storage key must not be empty".to_string());
        }
        let arc = self
            .conn(slug)
            .ok_or_else(|| format!("no store for page '{slug}'"))?;
        let conn = arc.lock().map_err(|_| "page store lock".to_string())?;
        // Budget check counts the replacement, not the addition — overwriting a big value with a
        // small one must never be refused for the space the old one took.
        let existing: u64 = conn
            .query_row(
                "SELECT LENGTH(key) + LENGTH(value) FROM kv WHERE key = ?1",
                params![key],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            .max(0) as u64;
        let after = Self::stored_bytes(&conn)
            .saturating_sub(existing)
            .saturating_add((key.len() + value.len()) as u64);
        if after > max_bytes {
            return Err(format!(
                "page storage full: this write would use {after} bytes of the {max_bytes} this page \
                 is allowed. Delete keys you no longer need, or store less per key."
            ));
        }
        conn.execute(
            "INSERT INTO kv(key, value, updated_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_ms()],
        )
        .map_err(|e| format!("page store write: {e}"))?;
        Ok(())
    }

    fn delete(&self, slug: &str, key: &str) -> Result<(), String> {
        let Some(arc) = self.conn(slug) else {
            return Ok(()); // nothing stored is already deleted
        };
        let conn = arc.lock().map_err(|_| "page store lock".to_string())?;
        conn.execute("DELETE FROM kv WHERE key = ?1", params![key])
            .map_err(|e| format!("page store delete: {e}"))?;
        Ok(())
    }

    fn entries(&self, slug: &str) -> Vec<(String, String)> {
        let Some(arc) = self.conn(slug) else {
            return Vec::new();
        };
        let Ok(conn) = arc.lock() else {
            return Vec::new();
        };
        let Ok(mut stmt) = conn.prepare("SELECT key, value FROM kv ORDER BY key") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn bytes(&self, slug: &str) -> u64 {
        let Some(arc) = self.conn(slug) else {
            return 0;
        };
        let Ok(conn) = arc.lock() else { return 0 };
        Self::stored_bytes(&conn)
    }

    fn drop_page(&self, slug: &str) -> Result<(), String> {
        // Close first: a live handle keeps the file (and its -wal/-shm) alive on Windows.
        if let Ok(mut map) = self.conns.lock() {
            map.remove(slug);
        }
        let Some(dir) = self.dir_of(slug) else {
            return Ok(());
        };
        if Path::new(&dir).exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("page store remove ({}): {e}", dir.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (PageStoreAdapter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        (PageStoreAdapter::new(dir.path().to_path_buf()), dir)
    }

    #[test]
    fn a_page_keeps_what_it_stored() {
        let (s, _d) = store();
        s.set("carom", "records", "[1,2,3]", 1024).unwrap();
        assert_eq!(s.get("carom", "records").as_deref(), Some("[1,2,3]"));
        assert_eq!(s.entries("carom"), vec![("records".into(), "[1,2,3]".into())]);
    }

    #[test]
    fn each_page_gets_its_own_file() {
        let (s, d) = store();
        s.set("carom", "k", "a", 1024).unwrap();
        s.set("chess", "k", "b", 1024).unwrap();
        assert_eq!(s.get("carom", "k").as_deref(), Some("a"));
        assert_eq!(s.get("chess", "k").as_deref(), Some("b"));
        assert!(d.path().join("carom/store.db").exists());
        assert!(d.path().join("chess/store.db").exists());
    }

    #[test]
    fn deleting_a_page_deletes_its_store() {
        let (s, d) = store();
        s.set("carom", "k", "a", 1024).unwrap();
        s.drop_page("carom").unwrap();
        assert!(!d.path().join("carom").exists());
        assert_eq!(s.get("carom", "k"), None);
    }

    #[test]
    fn the_budget_counts_the_replacement_not_the_addition() {
        // Overwriting a large value with a small one must not be refused for the space the old one
        // occupied — otherwise a page fills up and can never be cleaned from inside the app.
        let (s, _d) = store();
        let big = "x".repeat(200);
        s.set("carom", "k", &big, 256).unwrap();
        s.set("carom", "k", "small", 256).expect("shrinking a value must be allowed");
        assert_eq!(s.get("carom", "k").as_deref(), Some("small"));
    }

    #[test]
    fn a_full_page_says_so() {
        let (s, _d) = store();
        let err = s.set("carom", "k", &"x".repeat(500), 100).unwrap_err();
        assert!(err.contains("page storage full"), "{err}");
        // …and nothing was written.
        assert_eq!(s.get("carom", "k"), None);
    }

    #[test]
    fn a_slug_can_nest_but_cannot_climb() {
        let (s, d) = store();
        s.set("docs/manual", "k", "v", 1024).unwrap();
        assert!(d.path().join("docs/manual/store.db").exists());
        // Traversal is refused at the guard, not by the filesystem.
        assert!(s.set("../escape", "k", "v", 1024).is_err());
        assert!(s.set("a/../../b", "k", "v", 1024).is_err());
        assert!(s.get("../escape", "k").is_none());
    }
}
