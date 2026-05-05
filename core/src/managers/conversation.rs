//! ConversationManager — 어드민 채팅 대화 DB 저장 / 조회 / cli_session resume +
//! 메시지 단위 임베딩 동기 + cosine search_history.
//!
//! 옛 TS ConversationManager (`core/managers/conversation-manager.ts`) Rust 1:1 port.
//! Phase B-18 Step 1.5 — sync_embeddings + search_history 박음.
//! IEmbedderPort 박혀있을 때만 활성 (with_embedder 빌더 미박음 시 stub — embedding 없이 CRUD 만).

use std::sync::Arc;

use sha1::{Digest, Sha1};

use crate::ports::{
    ConversationEmbeddingRow, ConversationRecord, ConversationSummary, IDatabasePort,
    IEmbedderPort, ILogPort, InfraResult,
};

const CONTENT_PREVIEW_MAX: usize = 500;
/// search_history 의 같은 conv 부스트 스코어 — 옛 TS 와 동일 (현재 활성 대화 우선).
const SAME_CONV_BOOST: f32 = 0.2;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    /// IEmbedderPort 옵션 — 박혀있으면 임베딩 sync + 검색 활성. 없으면 stub.
    embedder: Option<Arc<dyn IEmbedderPort>>,
    log: Option<Arc<dyn ILogPort>>,
}

impl ConversationManager {
    pub fn new(db: Arc<dyn IDatabasePort>) -> Self {
        Self {
            db,
            embedder: None,
            log: None,
        }
    }

    /// Embedder 주입 — 박히면 메시지 sync + cosine 검색 활성. 옛 TS 의 IEmbedderPort 의존성 위치.
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

    /// 대화 저장 — 옛 TS save 1:1 port.
    ///
    /// 흐름:
    /// 1. Tombstone 검사 — 다른 기기에서 삭제된 대화면 reject
    /// 2. **기존 messages 와 union merge** (옛 TS unionMergeMessages 1:1) — 모바일·PC 동시 쓰기 시
    ///    incoming 으로 단순 덮어쓰면 다른 기기 메시지 유실. id 기준 합집합 + timestamp 정렬.
    /// 3. JSON 직렬화 + DB 저장
    /// 4. 임베딩 sync (embedder 박혀있을 때만, fire-and-forget)
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
            return Err(format!("대화 {}는 삭제됨 (tombstone)", id));
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
                    None => return Err("messages 가 array 가 아닙니다".to_string()),
                };
                let merged = crate::utils::message_merge::union_merge_messages(
                    &existing_arr,
                    &incoming_arr,
                );
                serde_json::Value::Array(merged)
            }
            None => messages.clone(),
        };

        let messages_json = serde_json::to_string(&merged_messages)
            .map_err(|e| format!("messages 직렬화 실패: {e}"))?;
        if !self.db.save_conversation(owner, id, title, &messages_json, created_at) {
            return Err(format!("대화 저장 실패: {}", id));
        }

        // 임베딩 sync — embedder 박혀있고 messages 가 array 일 때만.
        // 옛 TS 는 fire-and-forget (`.catch(()=>{})`) — Rust 도 await 후 실패 무시 (스킵).
        if self.embedder.is_some() {
            if let Some(arr) = merged_messages.as_array() {
                if let Err(e) = self.sync_embeddings(owner, id, arr).await {
                    if let Some(log) = &self.log {
                        log.debug(&format!(
                            "[ConversationManager] sync_embeddings 실패 ({id}): {e} — 저장 자체는 성공"
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
            return Err(format!("대화 {}는 삭제됨 (tombstone)", id));
        }
        let messages_json = serde_json::to_string(messages)
            .map_err(|e| format!("messages 직렬화 실패: {e}"))?;
        if self.db.save_conversation(owner, id, title, &messages_json, created_at) {
            Ok(())
        } else {
            Err(format!("대화 저장 실패: {}", id))
        }
    }

    pub fn delete(&self, owner: &str, id: &str) -> InfraResult<()> {
        if self.db.delete_conversation(owner, id) {
            Ok(())
        } else {
            Err(format!("대화 삭제 실패: {}", id))
        }
    }

    pub fn is_deleted(&self, owner: &str, id: &str) -> bool {
        self.db.is_conversation_deleted(owner, id)
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

    /// 메시지 배열 ↔ 기존 임베딩 비교 → 변경·신규만 재임베딩, 사라진 인덱스는 일괄 삭제.
    /// 옛 TS `syncEmbeddings` 1:1 port. embedder 미박음 시 즉시 반환.
    async fn sync_embeddings(
        &self,
        owner: &str,
        conv_id: &str,
        messages: &[serde_json::Value],
    ) -> Result<(), String> {
        let Some(embedder) = self.embedder.as_ref() else {
            return Ok(());
        };

        // 기존 임베딩 (msg_idx → content_hash) 로드
        let existing_rows = self.db.list_conversation_embeddings(owner, conv_id);
        let existing: std::collections::HashMap<i64, String> = existing_rows
            .into_iter()
            .map(|m| (m.msg_idx, m.content_hash))
            .collect();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let mut keep_idx: std::collections::HashSet<i64> = std::collections::HashSet::new();

        for (i, msg) in messages.iter().enumerate() {
            let i_idx = i as i64;
            let Some(parsed) = message_to_text(msg) else {
                continue;
            };
            keep_idx.insert(i_idx);
            let hash = sha1_hex(&format!("{}:{}", embedder.version(), parsed.text));

            // 기존 hash 와 같으면 변경 없음 → skip
            if existing.get(&i_idx) == Some(&hash) {
                continue;
            }

            // 임베딩 생성 (실패 시 해당 메시지 스킵 — 옛 TS try/catch 와 동등)
            match embedder.embed_passage(&parsed.text).await {
                Ok(vec) => {
                    let preview = take_chars(&parsed.text, CONTENT_PREVIEW_MAX);
                    let blob = embedder.vec_to_bytes(&vec);
                    let row = ConversationEmbeddingRow {
                        conv_id: conv_id.to_string(),
                        conv_title: None, // upsert 시 미사용
                        owner: owner.to_string(),
                        msg_idx: i_idx,
                        role: parsed.role,
                        content_hash: hash,
                        content_preview: preview,
                        embedding: blob,
                        created_at: now,
                    };
                    let _ = self.db.upsert_conversation_embedding(&row);
                }
                Err(e) => {
                    if let Some(log) = &self.log {
                        log.debug(&format!(
                            "[ConversationManager] 임베딩 실패 (msg {}): {e}",
                            i_idx
                        ));
                    }
                }
            }
        }

        // 사라진 msg_idx 일괄 삭제 (한 쿼리 — 옛 TS 와 동등)
        let to_delete: Vec<i64> = existing
            .keys()
            .copied()
            .filter(|idx| !keep_idx.contains(idx))
            .collect();
        if !to_delete.is_empty() {
            self.db
                .delete_conversation_embeddings_by_idx(owner, conv_id, &to_delete);
        }
        Ok(())
    }

    /// 과거 대화 검색 — query 임베딩 ↔ 저장된 메시지 임베딩 cosine.
    /// 옛 TS `searchHistory` 1:1 port. embedder 미박음 시 빈 결과.
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

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let cutoff = now - within_days * 86_400_000;

        let rows = self.db.query_conversation_embeddings_since(owner, cutoff);
        if rows.is_empty() {
            return Ok(vec![]);
        }

        let q_vec = embedder
            .embed_query(query)
            .await
            .map_err(|e| format!("임베딩 실패: {e}"))?;

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
                        if let Some(blocks) = msg.get("data").and_then(|d| d.get("blocks")) {
                            if blocks.is_array() {
                                filtered[fi].blocks = Some(blocks.clone());
                            }
                        }
                    }
                }
            }
        }

        Ok(filtered)
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

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

    // 1. content 최우선
    if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
        if !content.trim().is_empty() {
            return Some(ParsedMessage {
                role,
                text: content.to_string(),
            });
        }
    }

    // 2. blocks 의 text / Image 메타 추출 — 일반 로직 (모든 Image 동등 처리, AI 생성/업로드 무관)
    let mut parts: Vec<String> = Vec::new();
    if let Some(blocks) = obj
        .get("data")
        .and_then(|d| d.get("blocks"))
        .and_then(|b| b.as_array())
    {
        for b in blocks {
            let Some(bo) = b.as_object() else { continue };
            let block_type = bo.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(t) = bo.get("text").and_then(|v| v.as_str()) {
                        if !t.trim().is_empty() {
                            parts.push(t.to_string());
                        }
                    }
                }
                "Image" => {
                    // 일반 로직: alt / prompt / filenameHint 합쳐 [이미지] prefix
                    let mut img_parts: Vec<String> = Vec::new();
                    for k in ["alt", "prompt", "filenameHint"] {
                        if let Some(v) = bo.get(k).and_then(|v| v.as_str()) {
                            let trimmed = v.trim();
                            if !trimmed.is_empty() {
                                img_parts.push(trimmed.to_string());
                            }
                        }
                    }
                    if !img_parts.is_empty() {
                        parts.push(format!("[이미지] {}", img_parts.join(" ")));
                    }
                }
                _ => {}
            }
        }
    }
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

/// `sha1(version:text)` → hex. 옛 TS 와 동일 (모델 교체 시 cache 자동 무효화).
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

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::database::SqliteDatabaseAdapter;
    use firebat_infra::adapters::embedder::StubEmbedderAdapter;

    fn make_manager() -> ConversationManager {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        ConversationManager::new(db)
    }

    fn make_manager_with_embedder() -> ConversationManager {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        ConversationManager::new(db).with_embedder(embedder)
    }

    #[test]
    fn save_get_list_delete_roundtrip_sync() {
        let mgr = make_manager();
        let messages = serde_json::json!([
            {"role": "user", "content": "안녕"},
            {"role": "assistant", "content": "반가워요"}
        ]);

        mgr.save_sync("admin", "c1", "테스트 대화", &messages, None).unwrap();
        let got = mgr.get("admin", "c1").unwrap();
        assert_eq!(got.title, "테스트 대화");
        assert_eq!(got.messages.as_array().unwrap().len(), 2);

        let list = mgr.list("admin");
        assert_eq!(list.len(), 1);

        mgr.delete("admin", "c1").unwrap();
        assert!(mgr.get("admin", "c1").is_none());
    }

    #[test]
    fn deleted_tombstone_rejects_save() {
        let mgr = make_manager();
        mgr.save_sync("admin", "c1", "v1", &serde_json::json!([]), None).unwrap();
        mgr.delete("admin", "c1").unwrap();
        assert!(mgr.is_deleted("admin", "c1"));
        let result = mgr.save_sync("admin", "c1", "v2", &serde_json::json!([]), None);
        assert!(result.is_err());
    }

    #[test]
    fn cli_session_model_match() {
        let mgr = make_manager();
        mgr.save_sync("admin", "c1", "test", &serde_json::json!([]), None).unwrap();
        assert!(mgr.set_cli_session("c1", "sess-abc", "claude-4"));
        assert_eq!(
            mgr.get_cli_session("c1", "claude-4"),
            Some("sess-abc".to_string())
        );
        assert!(mgr.get_cli_session("c1", "gpt-5").is_none());
    }

    #[test]
    fn active_plan_state_roundtrip() {
        let mgr = make_manager();
        mgr.save_sync("admin", "c1", "test", &serde_json::json!([]), None).unwrap();

        assert!(mgr.get_active_plan_state("c1").is_none());
        let state = serde_json::json!({"planId": "p1", "stage": 2});
        assert!(mgr.set_active_plan_state("c1", Some(&state)));
        let got = mgr.get_active_plan_state("c1").unwrap();
        assert_eq!(got["planId"], "p1");
        assert_eq!(got["stage"], 2);

        assert!(mgr.set_active_plan_state("c1", None));
        assert!(mgr.get_active_plan_state("c1").is_none());
    }

    // ── 임베딩 sync + search_history 테스트 (Phase B-18 Step 1.5) ──────────────

    #[tokio::test]
    async fn save_with_embedder_indexes_messages() {
        let mgr = make_manager_with_embedder();
        let messages = serde_json::json!([
            {"role": "user", "content": "삼성전자 75000원에 매수"},
            {"role": "assistant", "content": "주문 접수 완료"}
        ]);
        mgr.save("admin", "c1", "거래", &messages, None).await.unwrap();

        // 임베딩 row 2개 박혔는지 확인
        let metas = mgr.db.list_conversation_embeddings("admin", "c1");
        assert_eq!(metas.len(), 2);
    }

    #[tokio::test]
    async fn search_history_returns_match_for_indexed_message() {
        let mgr = make_manager_with_embedder();
        let messages = serde_json::json!([
            {"role": "user", "content": "삼성전자 매수 75000원"},
        ]);
        mgr.save("admin", "c1", "거래", &messages, None).await.unwrap();

        // 같은 텍스트로 검색 — stub embedder 는 결정론이라 cosine ~= 1.0 (query/passage prefix
        // 다르지만 같은 텍스트라 dot product 가 minScore 넘는 정도)
        let results = mgr
            .search_history(
                "admin",
                "삼성전자 매수 75000원",
                SearchHistoryOpts {
                    min_score: Some(-1.0), // stub 은 query/passage prefix 다름 — 낮은 minScore
                    limit: Some(5),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].conv_id, "c1");
        assert!(results[0].content_preview.contains("삼성전자"));
    }

    #[tokio::test]
    async fn search_history_empty_query_returns_empty() {
        let mgr = make_manager_with_embedder();
        let results = mgr
            .search_history("admin", "", SearchHistoryOpts::default())
            .await
            .unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn search_history_without_embedder_returns_empty() {
        let mgr = make_manager();
        let results = mgr
            .search_history("admin", "anything", SearchHistoryOpts::default())
            .await
            .unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn sync_embeddings_grow_with_union_merge() {
        // union_merge_messages 박힌 후 — 메시지는 절대 줄어들지 않고 union 으로 자라기만 함.
        // 모바일·PC 동시 쓰기 race 보호 (옛 TS 1:1).
        // 임베딩 cleanup 로직은 defensive 로 유지 (sync_embeddings 가 dropped idx 제거하는 코드는 그대로) —
        // 실 production 에선 trigger 안 됨 (union merge 가 보장). delete() 만 cleanup 책임.
        let mgr = make_manager_with_embedder();
        let messages = serde_json::json!([
            {"id": "u-1700000000000", "role": "user", "content": "msg 0"},
            {"id": "s-1700000000001", "role": "assistant", "content": "msg 1"},
            {"id": "u-1700000000002", "role": "user", "content": "msg 2"}
        ]);
        mgr.save("admin", "c1", "t", &messages, None).await.unwrap();
        assert_eq!(mgr.db.list_conversation_embeddings("admin", "c1").len(), 3);

        // 두 번째 save — 메시지 1개 추가 (모바일 쪽 새 메시지). union 으로 자람.
        let messages2 = serde_json::json!([
            {"id": "u-1700000000003", "role": "user", "content": "msg 3 from mobile"}
        ]);
        mgr.save("admin", "c1", "t", &messages2, None).await.unwrap();
        let metas = mgr.db.list_conversation_embeddings("admin", "c1");
        // 모든 메시지 보존 (union) → 4개 임베딩
        assert_eq!(metas.len(), 4);
    }

    #[tokio::test]
    async fn save_union_merges_with_existing_messages() {
        // 옛 TS unionMergeMessages 1:1 동작 — 모바일·PC 동시 쓰기 시 메시지 유실 방지.
        let mgr = make_manager();
        // PC 가 메시지 2개 저장
        let pc_messages = serde_json::json!([
            {"id": "u-1700000000000", "role": "user", "content": "PC user"},
            {"id": "s-1700000000001", "role": "assistant", "content": "PC reply"}
        ]);
        mgr.save("admin", "c-merge", "t", &pc_messages, None)
            .await
            .unwrap();

        // 모바일 이 자기 메시지만 + 새 메시지 추가해서 저장 (PC 두 번째 메시지 모름)
        let mobile_messages = serde_json::json!([
            {"id": "u-1700000000000", "role": "user", "content": "PC user"},
            {"id": "u-1700000000005", "role": "user", "content": "Mobile user"}
        ]);
        mgr.save("admin", "c-merge", "t", &mobile_messages, None)
            .await
            .unwrap();

        // 결과: 3개 메시지 (PC reply 보존됨)
        let record = mgr.get("admin", "c-merge").unwrap();
        let arr = record.messages.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        let contents: Vec<&str> = arr
            .iter()
            .map(|m| m.get("content").and_then(|v| v.as_str()).unwrap_or(""))
            .collect();
        // timestamp 순 정렬: PC user (000) → PC reply (001) → Mobile user (005)
        assert_eq!(contents, vec!["PC user", "PC reply", "Mobile user"]);
    }

    #[tokio::test]
    async fn delete_cascades_embeddings() {
        let mgr = make_manager_with_embedder();
        let messages = serde_json::json!([{"role": "user", "content": "test"}]);
        mgr.save("admin", "c1", "t", &messages, None).await.unwrap();
        assert_eq!(mgr.db.list_conversation_embeddings("admin", "c1").len(), 1);

        mgr.delete("admin", "c1").unwrap();
        assert_eq!(mgr.db.list_conversation_embeddings("admin", "c1").len(), 0);
    }

    #[test]
    fn message_to_text_extracts_content() {
        let msg = serde_json::json!({"role": "user", "content": "hello"});
        let p = message_to_text(&msg).unwrap();
        assert_eq!(p.role, "user");
        assert_eq!(p.text, "hello");
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
