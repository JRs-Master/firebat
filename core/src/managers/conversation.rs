//! ConversationManager — 어드민 채팅 대화 DB 저장 / 조회 / cli_session resume +
//! 메시지 단위 임베딩 동기 + cosine search_history.
//!
//! 옛 TS ConversationManager (`core/managers/conversation-manager.ts`) Rust 1:1 port.
//! Phase B-18 Step 1.5 — sync_embeddings + search_history 저장.
//! IEmbedderPort 설정되어 있을 때만 활성 (with_embedder 빌더 미설정 시 stub — embedding 없이 CRUD 만).

use std::sync::Arc;

use sha1::{Digest, Sha1};

use crate::ports::{
    ConversationEmbeddingRow, ConversationMessage, ConversationRecord, ConversationSummary,
    IDatabasePort, IEmbedderPort, ILogPort, InfraResult,
};

const CONTENT_PREVIEW_MAX: usize = 500;
/// search_history 의 같은 conv 부스트 스코어 — 옛 TS 와 동일 (현재 활성 대화 우선).
const SAME_CONV_BOOST: f32 = 0.2;

/// Canonical Message ⟷ conversation_messages row bijection (shared by admin·hub·frontend).
/// Columns = id/role/content (metadata) + created_at (sort index). data_json = remaining rich fields
/// (badges at top, blocks under `data`) + createdAt kept (exact round-trip → no-op preservation on unchanged
/// save). Zero id/role/content duplication. One convention = identical on every surface.
pub const MESSAGE_COLUMN_KEYS: &[&str] = &["id", "role", "content"];

/// Message Value → (id, role, content, created_at[for sort], data_json). data_json = message ∖ {id,role,content}.
pub fn split_message(msg: &serde_json::Value) -> (String, String, String, i64, String) {
    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    // The storage word for the answering side is 'assistant'. The admin UI's internal state
    // still says 'system' for that bubble (its first naming), and this boundary translates so
    // no caller has to — rows written as 'system' made the assistant invisible to recall
    // extraction and role-filtered search (repaired 2026-08-08, one-shot UPDATE in database.rs).
    let role = match msg.get("role").and_then(|v| v.as_str()).unwrap_or_default() {
        "system" => "assistant".to_string(),
        r => r.to_string(),
    };
    let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let created_at = msg.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut rich = msg.clone();
    if let Some(o) = rich.as_object_mut() {
        for k in MESSAGE_COLUMN_KEYS {
            o.remove(*k);
        }
    }
    let data_json = serde_json::to_string(&rich).unwrap_or_else(|_| "{}".to_string());
    (id, role, content, created_at, data_json)
}

/// (id, role, content columns, data_json) → Message Value = parse(data_json) ∪ {id, role, content}.
/// Rich fields like createdAt live in data_json → restored exactly.
pub fn join_message(id: &str, role: &str, content: &str, data_json: &str) -> serde_json::Value {
    let mut msg = serde_json::from_str::<serde_json::Value>(data_json)
        .ok()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(o) = msg.as_object_mut() {
        o.insert("id".to_string(), serde_json::json!(id));
        o.insert("role".to_string(), serde_json::json!(role));
        o.insert("content".to_string(), serde_json::json!(content));
    }
    msg
}

/// Default conversation title (matches the conversations.title column DEFAULT).
pub const DEFAULT_CONV_TITLE: &str = "새 대화";

/// Derive a conversation title from a message's content (first 28 chars, ellipsis if longer).
/// Single owner-agnostic logic shared by admin save + hub append → the backend is the title authority
/// for both (no admin-frontend / hub-backend split). char-based slice — byte slicing panics mid-Korean.
pub fn derive_conv_title(content: &str) -> String {
    let trimmed = content.trim();
    let mut title: String = trimmed.chars().take(28).collect();
    if trimmed.chars().count() > 28 {
        title.push('…');
    }
    title
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchMatch {
    #[serde(rename = "convId")]
    pub conv_id: String,
    #[serde(rename = "convTitle", skip_serializing_if = "Option::is_none")]
    pub conv_title: Option<String>,
    #[serde(rename = "msgIdx")]
    pub msg_idx: i64,
    pub role: String,
    #[serde(rename = "contentPreview")]
    pub content_preview: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub score: f32,
    /// includeBlocks=true 시 AI 메시지의 원본 blocks (component / Image 메타 보존).
    /// AI 가 과거 차트·표 데이터를 재조회 없이 재활용할 때 사용.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<serde_json::Value>,
}

/// One message inside a read window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWindowMessage {
    pub msg_idx: i64,
    pub role: String,
    pub text: String,
    /// `includeBlocks=true` 시 그 메시지의 원본 render blocks. `text` 는 데이터 계열을
    /// `[stock_chart data 63행]` 로 접으므로, 접힌 값이 필요하면 이 칸이 준다 —
    /// 재조회가 아니라 되읽기(같은 시점의 같은 값).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<serde_json::Value>,
}

/// A contiguous slice of one session, as returned to the caller of `read_messages`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWindow {
    pub conv_id: String,
    pub title: String,
    /// Message count of the whole session, so the caller knows how much is outside this window.
    pub total: i64,
    pub from: i64,
    pub messages: Vec<ConversationWindowMessage>,
    /// Set when the character cap ended the window early — resume here. Absent = the window covers
    /// everything that was asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_from: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchHistoryOpts {
    pub current_conv_id: Option<String>,
    pub limit: Option<usize>,
    pub within_days: Option<i64>,
    pub min_score: Option<f32>,
    pub include_blocks: bool,
}

pub struct ConversationManager {
    db: Arc<dyn IDatabasePort>,
    /// IEmbedderPort 옵션 — 설정되어 있으면 임베딩 sync + 검색 활성. 없으면 stub.
    embedder: Option<Arc<dyn IEmbedderPort>>,
    log: Option<Arc<dyn ILogPort>>,
    /// The sysmod result cache, so a conversation takes its working set with it when it is
    /// permanently deleted. A chat's cached rows are reachable for as long as the conversation is,
    /// which is why they are owned rather than timed — see `utils::cache_owner`.
    ///
    /// ⚠️ Wired to the explicit delete only. The 30-day retention sweep hard-deletes rows without
    /// naming them, so entries owned by a conversation it removes are left to the runaway cap.
    cache: Option<Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>>,
}

impl ConversationManager {
    pub fn new(db: Arc<dyn IDatabasePort>) -> Self {
        Self {
            db,
            embedder: None,
            log: None,
            cache: None,
        }
    }

    /// Cache handle — a permanently deleted conversation takes its cached tool results with it.
    pub fn with_cache(
        mut self,
        cache: Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>,
    ) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Embedder 주입 — 주입되면 메시지 sync + cosine 검색 활성. 옛 TS 의 IEmbedderPort 의존성 위치.
    pub fn with_embedder(mut self, embedder: Arc<dyn IEmbedderPort>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    pub fn with_log(mut self, log: Arc<dyn ILogPort>) -> Self {
        self.log = Some(log);
        self
    }

    pub fn list(&self, owner: &str) -> Vec<ConversationSummary> {
        self.db.list_conversations(owner)
    }

    pub fn get(&self, owner: &str, id: &str) -> Option<ConversationRecord> {
        self.db.get_conversation(owner, id)
    }

    /// Reads a window of one session's messages as flat text.
    ///
    /// `search_history` matches a SINGLE message, so a hit on a long exchange returns a fragment
    /// ("아니야") with nothing around it and there was no way to widen — a 20-question game could not
    /// be reconstructed at all. This is that missing step: the search hands back `convId` + `msgIdx`,
    /// this reads the neighbourhood.
    ///
    /// `to` is exclusive. Output is capped by `max_chars`; when the cap cuts the window short the
    /// result reports the index to resume from instead of silently truncating.
    pub fn read_messages(
        &self,
        owner: &str,
        id: &str,
        from: usize,
        to: Option<usize>,
        max_chars: usize,
        include_blocks: bool,
    ) -> Option<ConversationWindow> {
        let record = self.db.get_conversation(owner, id)?;
        let messages = record.messages.as_array().cloned().unwrap_or_default();
        let total = messages.len();
        let end = to.unwrap_or(total).min(total);
        let start = from.min(end);

        let mut out: Vec<ConversationWindowMessage> = Vec::new();
        let mut used = 0usize;
        let mut next_from: Option<usize> = None;
        for (offset, msg) in messages[start..end].iter().enumerate() {
            let idx = start + offset;
            let Some(parsed) = message_to_text(msg) else {
                continue;
            };
            let blocks = if include_blocks { message_blocks(msg) } else { None };
            // Blocks count toward the cap too — otherwise `maxChars` would bound the prose while a
            // window quietly returned megabytes of rows, and `nextFrom` would stop meaning anything.
            let len = parsed.text.chars().count()
                + blocks
                    .as_ref()
                    .map(|b| b.to_string().chars().count())
                    .unwrap_or(0);
            if used + len > max_chars && !out.is_empty() {
                next_from = Some(idx);
                break;
            }
            used += len;
            out.push(ConversationWindowMessage {
                msg_idx: idx as i64,
                role: parsed.role,
                text: parsed.text,
                blocks,
            });
        }

        Some(ConversationWindow {
            conv_id: record.id,
            title: record.title,
            total: total as i64,
            from: start as i64,
            messages: out,
            next_from: next_from.map(|n| n as i64),
        })
    }

    /// Consolidation watermark reads/writes (see IDatabasePort docs).
    pub fn list_needing_consolidation(&self, owner: &str, cutoff_ms: i64, limit: usize) -> Vec<String> {
        self.db
            .list_conversations_needing_consolidation(owner, cutoff_ms, limit)
    }

    pub fn mark_consolidated(&self, id: &str, ts: i64) -> bool {
        self.db.set_conversation_consolidated_at(id, ts)
    }

    /// 대화 저장 — 옛 TS save 1:1 port.
    ///
    /// 흐름:
    /// 1. Tombstone 검사 — 다른 기기에서 삭제된 대화면 reject
    /// 2. **기존 messages 와 union merge** (옛 TS unionMergeMessages 1:1) — 모바일·PC 동시 쓰기 시
    ///    incoming 으로 단순 덮어쓰면 다른 기기 메시지 유실. id 기준 합집합 + timestamp 정렬.
    /// 3. JSON 직렬화 + DB 저장
    /// 4. 임베딩 sync (embedder 설정되어 있을 때만, fire-and-forget)
    pub async fn save(
        &self,
        owner: &str,
        id: &str,
        title: &str,
        messages: &serde_json::Value,
        created_at: Option<i64>,
    ) -> InfraResult<()> {
        // Tombstone 검사 — 다른 기기에서 삭제된 대화면 reject (옛 TS 와 동일)
        if self.db.is_conversation_deleted(owner, id) {
            return Err(crate::i18n::t(
                "core.error.conversation.tombstoned",
                None,
                &[("id", id)],
            ));
        }

        // 기존 messages 읽어 union merge — 옛 TS save:127-145 1:1.
        // 모바일·PC 동시 쓰기 race 보호. 미존재 / 파싱 실패 시 incoming 그대로.
        let merged_messages: serde_json::Value = match self.db.get_conversation(owner, id) {
            Some(existing_record) => {
                let existing_arr: Vec<serde_json::Value> = existing_record
                    .messages
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let incoming_arr: Vec<serde_json::Value> = match messages.as_array() {
                    Some(arr) => arr.clone(),
                    None => {
                        return Err(crate::i18n::t(
                            "core.error.conversation.messages_not_array",
                            None,
                            &[],
                        ))
                    }
                };
                let merged = crate::utils::message_merge::union_merge_messages(
                    &existing_arr,
                    &incoming_arr,
                );
                serde_json::Value::Array(merged)
            }
            None => messages.clone(),
        };

        let messages_json = serde_json::to_string(&merged_messages).map_err(|e| {
            crate::i18n::t(
                "core.error.conversation.messages_serialize_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
        if !self.db.save_conversation(owner, id, title, &messages_json, created_at) {
            return Err(crate::i18n::t(
                "core.error.conversation.save_failed",
                None,
                &[("id", id)],
            ));
        }

        // 임베딩 sync — embedder 설정되어 있고 messages 가 array 일 때만.
        // 옛 TS 는 fire-and-forget (`.catch(()=>{})`) — Rust 도 await 후 실패 무시 (스킵).
        if self.embedder.is_some() {
            if let Some(arr) = merged_messages.as_array() {
                if let Err(e) = self.sync_embeddings(owner, id, arr).await {
                    if let Some(log) = &self.log {
                        log.debug(&format!(
                            "[ConversationManager] sync_embeddings failed ({id}): {e} — save itself succeeded"
                        ));
                    }
                }
            }
        }

        Ok(())
    }

    /// 동기 save — 임베딩 sync 없이 빠른 CRUD. 옛 호환·테스트용.
    pub fn save_sync(
        &self,
        owner: &str,
        id: &str,
        title: &str,
        messages: &serde_json::Value,
        created_at: Option<i64>,
    ) -> InfraResult<()> {
        if self.db.is_conversation_deleted(owner, id) {
            return Err(crate::i18n::t(
                "core.error.conversation.tombstoned",
                None,
                &[("id", id)],
            ));
        }
        let messages_json = serde_json::to_string(messages).map_err(|e| {
            crate::i18n::t(
                "core.error.conversation.messages_serialize_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
        if self.db.save_conversation(owner, id, title, &messages_json, created_at) {
            Ok(())
        } else {
            Err(crate::i18n::t(
                "core.error.conversation.save_failed",
                None,
                &[("id", id)],
            ))
        }
    }

    /// 삭제 — soft delete. conversations.deleted_at 설정 + tombstone 기록.
    /// 30일 후 cleanup_old_deleted 가 cascade hard delete (row + 임베딩).
    /// 사용자가 휴지통에서 복원하면 restore() 가 deleted_at 을 NULL 로 설정.
    pub fn delete(&self, owner: &str, id: &str) -> InfraResult<()> {
        if self.db.delete_conversation(owner, id) {
            Ok(())
        } else {
            Err(crate::i18n::t(
                "core.error.conversation.delete_failed",
                None,
                &[("id", id)],
            ))
        }
    }

    pub fn is_deleted(&self, owner: &str, id: &str) -> bool {
        self.db.is_conversation_deleted(owner, id)
    }

    /// 휴지통 목록 — soft-deleted conversations (deleted_at IS NOT NULL).
    /// 최신 삭제 순.
    pub fn list_deleted(&self, owner: &str) -> Vec<ConversationSummary> {
        self.db.list_deleted_conversations(owner)
    }

    /// 휴지통에서 복원 — deleted_at NULL 설정 + tombstone 제거.
    /// 다기기 동기화 정상화 (tombstone 으로 막혔던 대화 부활 차단 해제).
    pub fn restore(&self, owner: &str, id: &str) -> InfraResult<()> {
        if self.db.restore_conversation(owner, id) {
            Ok(())
        } else {
            Err(crate::i18n::t(
                "core.error.conversation.restore_failed",
                None,
                &[("id", id)],
            ))
        }
    }

    /// 영구 삭제 — hard delete. row + 임베딩 cascade. tombstone 은 그대로 유지.
    /// 휴지통에서 명시 클릭 또는 30일 retention cron 이 호출.
    pub fn permanent_delete(&self, owner: &str, id: &str) -> InfraResult<()> {
        if self.db.permanent_delete_conversation(owner, id) {
            // The conversation's cached tool results are owned by it, so this is what ends them —
            // no clock does. See `utils::cache_owner`.
            if let Some(cache) = &self.cache {
                cache.drop_owner(&crate::utils::cache_owner::conversation(id));
            }
            Ok(())
        } else {
            Err(crate::i18n::t(
                "core.error.conversation.permanent_delete_failed",
                None,
                &[("id", id)],
            ))
        }
    }

    /// 30일 retention cleanup — `retention_ms` (예: 30 * 24 * 3600 * 1000) 보다
    /// 오래된 휴지통 대화 일괄 hard delete. internal 30d cron 이 6h 마다 호출.
    /// 응답: 삭제된 conversation 개수.
    pub fn cleanup_old_deleted(&self, retention_ms: i64) -> i64 {
        let cutoff = crate::utils::time::now_ms() - retention_ms;
        self.db.cleanup_old_deleted_conversations(cutoff)
    }

    // ─── owner-keyed persistence primitives — shared by admin·hub (hub delegates here, no separate manager) ───
    // Conversation persistence lives in ConversationManager alone. admin=owner:"admin" / hub=owner:"hub:<inst>:<sid>".

    /// Reuse the owner's most recent active conversation, or create one. list = updated_at DESC → first() = latest.
    pub fn ensure(&self, owner: &str) -> String {
        if let Some(s) = self.db.list_conversations(owner).into_iter().next() {
            return s.id;
        }
        self.create(owner)
    }

    /// Always create a new conversation (owner). title="" → first-message auto-title fills it.
    pub fn create(&self, owner: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.db
            .ensure_conversation_row(owner, &id, "", crate::utils::time::now_ms());
        id
    }

    /// Append a single message (owner-keyed) — chat-turn persistence primitive. Creates the conv row if absent.
    /// canonical split_message: columns=metadata, data_json=rich. Same shape as admin save. Upsert on id (idempotent).
    pub fn append(&self, owner: &str, conv_id: &str, msg: &serde_json::Value) {
        let (id, role, content, created, data_json) = split_message(msg);
        let created = if created == 0 {
            crate::utils::time::now_ms()
        } else {
            created
        };
        let id = if id.is_empty() {
            format!("{conv_id}-{created}")
        } else {
            id
        };
        self.db.ensure_conversation_row(owner, conv_id, "", created);
        // Backend-derive the conversation title from the first user message — single authority for admin & hub.
        // Set only while the title is still empty/default so later turns keep it.
        if role == "user" && !content.trim().is_empty() {
            let cur = self
                .db
                .get_conversation_meta_by_id(conv_id)
                .map(|(_, s)| s.title)
                .unwrap_or_default();
            let cur = cur.trim();
            if cur.is_empty() || cur == DEFAULT_CONV_TITLE {
                self.db.update_conversation_title(conv_id, &derive_conv_title(&content));
            }
        }
        self.db.append_conversation_message(&ConversationMessage {
            id,
            conversation_id: conv_id.to_string(),
            role,
            content,
            data_json,
            created_at: created,
        });

        // Trigger embedding sync for search_history. The canonical single-message append is now the only
        // chat-persist path (save() is off the chat path), so embeddings must be generated here — otherwise
        // new conversations never get indexed and become unsearchable. Fire-and-forget background task keeps
        // this hot path non-blocking (same pattern as auth login). The task reloads the full committed
        // message array so msg_idx = position, matching get_conversation / search_history ordering.
        if let Some(embedder) = &self.embedder {
            let db = self.db.clone();
            let embedder = embedder.clone();
            let log = self.log.clone();
            let owner = owner.to_string();
            let conv_id = conv_id.to_string();
            tokio::spawn(async move {
                if let Some(rec) = db.get_conversation(&owner, &conv_id) {
                    if let Some(arr) = rec.messages.as_array() {
                        if let Err(e) =
                            sync_conversation_embeddings(&db, &embedder, &log, &owner, &conv_id, arr)
                                .await
                        {
                            if let Some(l) = &log {
                                l.debug(&format!(
                                    "[ConversationManager] append embedding sync failed ({conv_id}): {e}"
                                ));
                            }
                        }
                    }
                }
            });
        }
    }

    /// Update title (by id) — shared by rename and auto-title.
    pub fn update_title(&self, id: &str, title: &str) -> bool {
        self.db.update_conversation_title(id, title)
    }

    /// Conversation meta (owner + summary) by id — includes soft-deleted. Used to derive/reconstruct hub owner.
    pub fn meta_by_id(&self, id: &str) -> Option<(String, ConversationSummary)> {
        self.db.get_conversation_meta_by_id(id)
    }

    /// Message rows by conv_id (conv_id is unique → owner-independent). Shared by hub list_messages.
    pub fn message_rows(&self, conv_id: &str) -> Vec<ConversationMessage> {
        self.db.list_conversation_messages(conv_id)
    }

    /// 임베딩 row 메타 목록 — test 또는 진단용. 옛 inline test 가 `mgr.db.list_conversation_embeddings`
    /// 직접 access 하던 패턴을 도메인 메서드로 노출 (Phase B-post audit E4).
    pub fn list_embeddings(
        &self,
        owner: &str,
        conv_id: &str,
    ) -> Vec<crate::ports::ConversationEmbeddingMeta> {
        self.db.list_conversation_embeddings(owner, conv_id)
    }

    /// CLI 모드 session resume — 같은 모델일 때만 재사용. 모델 바뀌면 자동 무효.
    pub fn get_cli_session(&self, conversation_id: &str, current_model: &str) -> Option<String> {
        self.db.get_cli_session(conversation_id, current_model)
    }

    pub fn set_cli_session(&self, conversation_id: &str, session_id: &str, model: &str) -> bool {
        self.db.set_cli_session(conversation_id, session_id, model)
    }

    pub fn get_active_plan_state(&self, conversation_id: &str) -> Option<serde_json::Value> {
        let raw = self.db.get_active_plan_state(conversation_id)?;
        serde_json::from_str(&raw).ok()
    }

    pub fn set_active_plan_state(
        &self,
        conversation_id: &str,
        state: Option<&serde_json::Value>,
    ) -> bool {
        let json = match state {
            Some(v) => match serde_json::to_string(v) {
                Ok(s) => Some(s),
                Err(_) => return false,
            },
            None => None,
        };
        self.db.set_active_plan_state(conversation_id, json.as_deref())
    }

    // ── 임베딩 sync + search_history (Phase B-18 Step 1.5) ────────────────────

    /// Thin wrapper — delegates to the standalone `sync_conversation_embeddings` so both `save()` and the
    /// background task spawned by `append()` share one implementation.
    async fn sync_embeddings(
        &self,
        owner: &str,
        conv_id: &str,
        messages: &[serde_json::Value],
    ) -> Result<(), String> {
        let Some(embedder) = self.embedder.as_ref() else {
            return Ok(());
        };
        sync_conversation_embeddings(&self.db, embedder, &self.log, owner, conv_id, messages).await
    }

    /// 과거 대화 검색 — query 임베딩 ↔ 저장된 메시지 임베딩 cosine.
    /// 옛 TS `searchHistory` 1:1 port. embedder 미설정 시 빈 결과.
    pub async fn search_history(
        &self,
        owner: &str,
        query: &str,
        opts: SearchHistoryOpts,
    ) -> InfraResult<Vec<HistorySearchMatch>> {
        let Some(embedder) = self.embedder.as_ref() else {
            return Ok(vec![]);
        };
        let query = query.trim();
        if query.is_empty() {
            return Ok(vec![]);
        }

        let limit = opts.limit.unwrap_or(5).max(1);
        let within_days = opts.within_days.unwrap_or(60).max(0);
        let min_score = opts.min_score.unwrap_or(0.25);

        let now = crate::utils::time::now_ms();
        let cutoff = now - within_days * 86_400_000;

        let rows = self.db.query_conversation_embeddings_since(owner, cutoff);
        if rows.is_empty() {
            return Ok(vec![]);
        }

        let q_vec = embedder.embed_query(query).await.map_err(|e| {
            crate::i18n::t(
                "core.error.conversation.embedding_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;

        let mut scored: Vec<HistorySearchMatch> = rows
            .into_iter()
            .map(|r| {
                let vec = embedder.bytes_to_vec(&r.embedding);
                let mut score = embedder.cosine(&q_vec, &vec);
                if let Some(curr) = &opts.current_conv_id {
                    if &r.conv_id == curr {
                        score += SAME_CONV_BOOST;
                    }
                }
                HistorySearchMatch {
                    conv_id: r.conv_id,
                    conv_title: r.conv_title,
                    msg_idx: r.msg_idx,
                    role: r.role,
                    content_preview: r.content_preview,
                    created_at: r.created_at,
                    score,
                    blocks: None,
                }
            })
            .collect();

        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        let mut filtered: Vec<HistorySearchMatch> = scored
            .into_iter()
            .filter(|m| m.score >= min_score)
            .take(limit)
            .collect();

        // include_blocks: conv 단위 묶어 한 번에 messages 로드 → 매칭 msg_idx 의 blocks 추출.
        if opts.include_blocks && !filtered.is_empty() {
            let mut by_conv: std::collections::HashMap<String, Vec<usize>> =
                std::collections::HashMap::new();
            for (i, m) in filtered.iter().enumerate() {
                by_conv.entry(m.conv_id.clone()).or_default().push(i);
            }
            for (conv_id, indices) in by_conv {
                let Some(record) = self.db.get_conversation(owner, &conv_id) else {
                    continue;
                };
                let Some(msgs) = record.messages.as_array() else {
                    continue;
                };
                for fi in indices {
                    let msg_idx = filtered[fi].msg_idx as usize;
                    if let Some(msg) = msgs.get(msg_idx) {
                        filtered[fi].blocks = message_blocks(msg);
                    }
                }
            }
        }

        Ok(filtered)
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// The render blocks a stored message carries, from whichever channel holds them: `data.blocks`
/// (render-tool path) or the `firebat-render` fences in `content` (the primary path). Reading only
/// `data.blocks` recovered nothing for a fence-rendered answer, which is how `includeBlocks` came
/// back empty for exactly the messages worth reopening. One helper so `search_history` and
/// `read_conversation` hand back the same thing.
fn message_blocks(msg: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(blocks) = msg.get("data").and_then(|d| d.get("blocks")) {
        if blocks.as_array().is_some_and(|a| !a.is_empty()) {
            return Some(blocks.clone());
        }
    }
    msg.get("content")
        .and_then(|v| v.as_str())
        .and_then(crate::managers::ai::render_exec::fence_blocks)
}

/// Embedding sync core — standalone (no `&self`) so the background task in `append()` can run it from
/// cloned Arcs. Compares the message array against stored embeddings, re-embeds new/changed messages
/// (idempotent via content_hash), and deletes embeddings for indices no longer present. `msg_idx` =
/// position in `messages`, matching the ordering that `get_conversation` and `search_history` use.
async fn sync_conversation_embeddings(
    db: &Arc<dyn IDatabasePort>,
    embedder: &Arc<dyn IEmbedderPort>,
    log: &Option<Arc<dyn ILogPort>>,
    owner: &str,
    conv_id: &str,
    messages: &[serde_json::Value],
) -> Result<(), String> {
    // Load existing embeddings (msg_idx -> content_hash).
    let existing_rows = db.list_conversation_embeddings(owner, conv_id);
    let existing: std::collections::HashMap<i64, String> = existing_rows
        .into_iter()
        .map(|m| (m.msg_idx, m.content_hash))
        .collect();

    let now = crate::utils::time::now_ms();

    let mut keep_idx: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut embedded_count = 0usize;

    for (i, msg) in messages.iter().enumerate() {
        let i_idx = i as i64;
        let Some(parsed) = message_to_text(msg) else {
            continue;
        };
        keep_idx.insert(i_idx);
        let hash = sha1_hex(&format!("{}:{}", embedder.version(), parsed.text));

        // Unchanged hash → skip re-embedding.
        if existing.get(&i_idx) == Some(&hash) {
            continue;
        }

        // Embed (skip this message on failure).
        match embedder.embed_passage(&parsed.text).await {
            Ok(vec) => {
                let preview = take_chars(&parsed.text, CONTENT_PREVIEW_MAX);
                let blob = embedder.vec_to_bytes(&vec);
                let row = ConversationEmbeddingRow {
                    conv_id: conv_id.to_string(),
                    conv_title: None, // unused on upsert
                    owner: owner.to_string(),
                    msg_idx: i_idx,
                    role: parsed.role,
                    content_hash: hash,
                    content_preview: preview,
                    embedding: blob,
                    created_at: now,
                };
                let _ = db.upsert_conversation_embedding(&row);
                embedded_count += 1;
            }
            Err(e) => {
                if let Some(log) = log {
                    log.debug(&format!(
                        "[ConversationManager] embedding failed (msg {}): {e}",
                        i_idx
                    ));
                }
            }
        }
    }

    if embedded_count > 0 {
        if let Some(log) = log {
            log.info(&format!(
                "conversation embeddings updated — {} new/changed (conv={})",
                embedded_count, conv_id
            ));
        }
    }

    // Delete embeddings for indices that no longer exist (single query).
    let to_delete: Vec<i64> = existing
        .keys()
        .copied()
        .filter(|idx| !keep_idx.contains(idx))
        .collect();
    if !to_delete.is_empty() {
        db.delete_conversation_embeddings_by_idx(owner, conv_id, &to_delete);
    }
    Ok(())
}

#[derive(Debug)]
struct ParsedMessage {
    role: String,
    text: String,
}

/// 메시지 객체 → 검색 가능한 텍스트 (role + text). 옛 TS `messageToText` 1:1 port.
/// content (최우선) > blocks 의 text/Image 메타 > [이미지 첨부] 폴백. role unknown 무시.
fn message_to_text(msg: &serde_json::Value) -> Option<ParsedMessage> {
    let obj = msg.as_object()?;
    let role = obj
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    if role == "unknown" {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();

    // 1. content (X: render fence 가 content 에 상주) → 텍스트 값만 추출(임베딩이 raw JSON 안 먹게).
    if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
        let t = crate::managers::ai::render_exec::fence_to_plaintext(content);
        if !t.trim().is_empty() {
            parts.push(t);
        }
    }

    // 2. data.blocks — block(render 도구) 경로 render 도 메모리·회상에 잡히게 content 와 병합.
    //    fence 가 주 경로지만 html/code/math/diagram 등은 block 으로 남아, 옛 content-first early-return
    //    이 그 리치 콘텐츠를 메모리에서 빠뜨리던 구멍을 일반 직렬화로 메운다(기억상실 보완).
    if let Some(blocks) = obj
        .get("data")
        .and_then(|d| d.get("blocks"))
        .and_then(|b| b.as_array())
    {
        for b in blocks {
            if let Some(t) = block_to_text(b) {
                if !t.trim().is_empty() {
                    parts.push(t);
                }
            }
        }
    }

    // The CLI path writes the SAME answer into both channels — `content` as plaintext and a `text`
    // block as markdown — so joining them blindly embedded every reply twice. That halved the
    // usable window of the passage encoder for long messages and made the stored preview read like
    // a stutter. Drop a part whose text is already carried by an earlier one.
    let mut deduped: Vec<String> = Vec::with_capacity(parts.len());
    for part in parts {
        let key = normalize_for_dedup(&part);
        if key.is_empty() {
            continue;
        }
        if deduped
            .iter()
            .any(|kept| normalize_for_dedup(kept).contains(&key))
        {
            continue;
        }
        deduped.push(part);
    }
    let parts = deduped;

    if !parts.is_empty() {
        return Some(ParsedMessage {
            role,
            text: parts.join("\n"),
        });
    }

    // 3. user 메시지가 이미지 첨부만 (content 없음) — 검색 가능한 마커
    if role == "user" && obj.get("image").is_some() {
        return Some(ParsedMessage {
            role,
            text: "[이미지 첨부]".to_string(),
        });
    }

    None
}

/// 단일 render 블록 → 메모리/회상용 텍스트. 타입별 하드코딩 없이 일반 추출:
/// text=본문 / Image=마커+메타 / 큰 raw 아티팩트(html/code/math/diagram/mermaid)=마커만(원본
/// 마크업·코드·수식은 임베딩 노이즈) / 그 외 리치 컴포넌트(sentence/table/quiz 등)=props 의 prose
/// string 값을 일반 수집.
fn block_to_text(b: &serde_json::Value) -> Option<String> {
    let bo = b.as_object()?;
    let block_type = bo.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match block_type {
        "text" => bo
            .get("text")
            .and_then(|v| v.as_str())
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.to_string()),
        "Image" | "image" => {
            let mut img_parts: Vec<String> = Vec::new();
            for k in ["alt", "prompt", "filenameHint"] {
                if let Some(v) = bo.get(k).and_then(|v| v.as_str()) {
                    let trimmed = v.trim();
                    if !trimmed.is_empty() {
                        img_parts.push(trimmed.to_string());
                    }
                }
            }
            if img_parts.is_empty() {
                Some("[이미지]".to_string())
            } else {
                Some(format!("[이미지] {}", img_parts.join(" ")))
            }
        }
        // 큰 raw 아티팩트 — 원본은 임베딩 노이즈라 마커만(회상은 보통 주변 산문으로 충분).
        "html" | "code" | "math" | "diagram" | "mermaid" => Some(format!("[{block_type}]")),
        // 리치 컴포넌트 — props 의 prose string 값 일반 수집(타입별 하드코딩 0).
        _ => {
            let mut acc: Vec<String> = Vec::new();
            collect_prose(b, &mut acc);
            if acc.is_empty() {
                None
            } else {
                Some(acc.join(" "))
            }
        }
    }
}

/// 객체/배열을 재귀하며 prose string 값만 수집. 구조·비텍스트 키(type/name/url/색 등)는 제외.
fn collect_prose(v: &serde_json::Value, acc: &mut Vec<String>) {
    const SKIP_KEYS: &[&str] = &[
        "type", "name", "url", "src", "href", "color", "icon", "id", "slug", "variant", "lang",
        "language",
    ];
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() {
                acc.push(t.to_string());
            }
        }
        serde_json::Value::Array(a) => {
            for x in a {
                collect_prose(x, acc);
            }
        }
        serde_json::Value::Object(m) => {
            for (k, x) in m {
                if SKIP_KEYS.contains(&k.as_str()) {
                    continue;
                }
                collect_prose(x, acc);
            }
        }
        _ => {}
    }
}

/// Shapes `search_history` output so the result itself names the next move.
///
/// The standing prompt already said "stop rewording, widen instead" and it did not take: measured
/// 2026-07-31, a turn that had already found one session ran three more reworded searches before
/// reaching for the session list. A pointer carried by the RESULT lands where the decision is made,
/// which is the same reason validation errors here name the tool to call next.
///
/// Also groups the hits by session, because that is the unit the next call takes — the model had to
/// derive it from a flat list of message hits every time.
pub fn describe_history_matches(matches: Vec<HistorySearchMatch>) -> serde_json::Value {
    let mut sessions: Vec<serde_json::Value> = Vec::new();
    for m in &matches {
        if let Some(existing) = sessions
            .iter_mut()
            .find(|s| s.get("convId").and_then(|v| v.as_str()) == Some(m.conv_id.as_str()))
        {
            let n = existing.get("hits").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
            if let Some(obj) = existing.as_object_mut() {
                obj.insert("hits".to_string(), serde_json::json!(n));
            }
            continue;
        }
        sessions.push(serde_json::json!({
            "convId": m.conv_id,
            "title": m.conv_title,
            "hits": 1,
        }));
    }
    // `sessions` is provenance for the hits above — never a listing. Spelling that out because the
    // grouping alone read as one: asked for "yesterday's conversations", a turn answered straight
    // from these rows instead of calling list_conversations, and the answer only looked right
    // because the top-K happened to cover the day (2026-07-31).
    let next_step = if matches.is_empty() {
        "No message matched by meaning. Rewording rarely helps here — a session made of short \
         replies cannot be matched semantically. Use list_conversations (narrow with since/until) \
         and read a session with read_conversation."
    } else {
        "Each match is ONE message, not a summary, and `sessions` only says which sessions these \
         particular hits came from — it is NOT a list of the caller's sessions and never answers \
         'which conversations happened in period X'; list_conversations(since, until) does. To see \
         what actually happened, call read_conversation with that convId around its msgIdx. If none \
         of these is the right session, use list_conversations rather than rewording."
    };
    serde_json::json!({
        "matches": matches,
        "sessions": sessions,
        "nextStep": next_step,
    })
}

/// Strips whitespace and markdown emphasis markers so the plaintext and markdown copies of the same
/// answer compare equal. Not a general normalizer — just enough to spot the duplicate channel.
fn normalize_for_dedup(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '*' | '_' | '`' | '#' | '~'))
        .collect()
}

/// `sha1(version:text)` → hex. Same as the old TS (a model swap invalidates the cache by itself).
fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    let out = hasher.finalize();
    hex::encode(out)
}

/// 텍스트 첫 N 문자 (UTF-8 char boundary 안전). 옛 TS `text.slice(0, max)` 1:1.
fn take_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// Tests 이관 — embedding sync tests (save_with_embedder / sync_embeddings_grow / delete_cascades) 는
// `infra/tests/conversation_manager_test.rs` (integration). private fn (`message_to_text` /
// `sha1_hex` / `take_chars`) 사용 unit test 만 inline 유지.
#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;

    #[test]
    fn message_to_text_extracts_content() {
        let msg = serde_json::json!({"role": "user", "content": "hello"});
        let p = message_to_text(&msg).unwrap();
        assert_eq!(p.role, "user");
        assert_eq!(p.text, "hello");
    }

    #[test]
    fn message_to_text_drops_the_markdown_copy_of_the_same_answer() {
        // The CLI path stores the answer twice — plaintext in `content`, markdown in a text block.
        let msg = serde_json::json!({
            "role": "assistant",
            "content": "좋아, 내가 맞혀볼게\n1번째 질문: 살아 있는 것이야?",
            "data": {"blocks": [
                {"type": "text", "text": "좋아, 내가 맞혀볼게\n**1번째 질문: 살아 있는 것이야?**"}
            ]}
        });
        let p = message_to_text(&msg).unwrap();
        assert_eq!(p.text, "좋아, 내가 맞혀볼게\n1번째 질문: 살아 있는 것이야?");
    }

    #[test]
    fn message_to_text_keeps_a_block_that_adds_content() {
        let msg = serde_json::json!({
            "role": "assistant",
            "content": "결과입니다",
            "data": {"blocks": [{"type": "text", "text": "추가 설명"}]}
        });
        let p = message_to_text(&msg).unwrap();
        assert!(p.text.contains("결과입니다"));
        assert!(p.text.contains("추가 설명"));
    }

    #[test]
    fn message_to_text_extracts_blocks_and_image() {
        let msg = serde_json::json!({
            "role": "assistant",
            "data": {
                "blocks": [
                    {"type": "text", "text": "결과:"},
                    {"type": "Image", "alt": "차트", "prompt": "monthly chart"}
                ]
            }
        });
        let p = message_to_text(&msg).unwrap();
        assert_eq!(p.role, "assistant");
        assert!(p.text.contains("결과:"));
        assert!(p.text.contains("[이미지]"));
        assert!(p.text.contains("차트"));
    }

    #[test]
    fn message_to_text_returns_none_for_unknown_role() {
        let msg = serde_json::json!({"content": "no role"});
        assert!(message_to_text(&msg).is_none());
    }

    #[test]
    fn sha1_hex_deterministic() {
        let a = sha1_hex("test:hello");
        let b = sha1_hex("test:hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 40);
        // version 바뀌면 다른 hash
        assert_ne!(sha1_hex("v1:hello"), sha1_hex("v2:hello"));
    }

    #[test]
    fn take_chars_respects_utf8_boundary() {
        // 한국어 문자 cutoff — bytes 단위로 자르면 panic, char 단위 cutoff 안전
        let s = "안녕하세요반갑습니다";
        let cut = take_chars(s, 5);
        assert_eq!(cut, "안녕하세요");
    }
}
