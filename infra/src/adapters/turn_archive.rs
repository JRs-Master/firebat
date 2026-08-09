//! Turn archive — every turn's full input and output, kept for readback.
//!
//! Why a store instead of the journal: the journal's `USER_AI_TRAINING` reconstruction is already
//! trimmed to the context window ("older round result removed"), journald caps line length and
//! rotates (2.2 GB on this host at the time of writing), and the log tab's ring holds only the
//! most recent 20,000 entries. Every readback this week ended with "what did the model actually
//! see?" and an inference. This answers it exactly.
//!
//! Development instrument, so: its own file (never mixed into app.db, which is user data), a row
//! cap that prunes oldest-first, and every write best-effort — an archive failure must never
//! affect a turn.

use std::sync::Mutex;

use firebat_core::ports::{ITurnArchivePort, TurnArchiveRecord};
use rusqlite::Connection;

/// Turns kept. A turn is a few tens of KB (the system prompt dominates), so this is ~100 MB at
/// the ceiling — bounded, and far more history than a readback ever needs.
const MAX_TURNS: i64 = 2_000;

pub struct TurnArchiveAdapter {
    conn: Mutex<Connection>,
}

impl TurnArchiveAdapter {
    pub fn new(path: &std::path::Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path).map_err(|e| format!("turn archive open: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=3000;
             CREATE TABLE IF NOT EXISTS turns (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 created_at INTEGER NOT NULL,
                 conversation_id TEXT NOT NULL,
                 message_id TEXT NOT NULL,
                 owner TEXT NOT NULL,
                 model TEXT NOT NULL,
                 thinking_level TEXT NOT NULL,
                 user_prompt TEXT NOT NULL,
                 system_prompt TEXT NOT NULL,
                 history_json TEXT NOT NULL,
                 tools_json TEXT NOT NULL,
                 rounds_json TEXT NOT NULL,
                 final_reasoning TEXT NOT NULL,
                 reply TEXT NOT NULL,
                 system_prompt_chars INTEGER NOT NULL,
                 history_turns INTEGER NOT NULL,
                 tool_count INTEGER NOT NULL,
                 round_count INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS turns_conv ON turns(conversation_id, created_at);
             CREATE INDEX IF NOT EXISTS turns_time ON turns(created_at);",
        )
        .map_err(|e| format!("turn archive schema: {e}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}

impl ITurnArchivePort for TurnArchiveAdapter {
    fn save_turn(&self, r: &TurnArchiveRecord) {
        let guard = match self.conn.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let history_json = serde_json::to_string(&r.history).unwrap_or_else(|_| "[]".into());
        let tools_json = serde_json::to_string(&r.tools).unwrap_or_else(|_| "[]".into());
        let rounds_json = serde_json::to_string(&r.rounds).unwrap_or_else(|_| "[]".into());
        let res = guard.execute(
            "INSERT INTO turns (created_at, conversation_id, message_id, owner, model,
                 thinking_level, user_prompt, system_prompt, history_json, tools_json,
                 rounds_json, final_reasoning, reply, system_prompt_chars, history_turns,
                 tool_count, round_count)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            rusqlite::params![
                r.created_at,
                r.conversation_id,
                r.message_id,
                r.owner,
                r.model,
                r.thinking_level,
                r.user_prompt,
                r.system_prompt,
                history_json,
                tools_json,
                rounds_json,
                r.final_reasoning,
                r.reply,
                r.system_prompt.chars().count() as i64,
                r.history.len() as i64,
                r.tools.len() as i64,
                r.rounds.len() as i64,
            ],
        );
        if let Err(e) = res {
            tracing::warn!(target: "turn_archive", "turn not archived: {e}");
            return;
        }
        // Oldest-first prune, cheap because `id` is the insertion order.
        let _ = guard.execute(
            "DELETE FROM turns WHERE id <= (SELECT MAX(id) - ?1 FROM turns)",
            rusqlite::params![MAX_TURNS],
        );
    }
}
