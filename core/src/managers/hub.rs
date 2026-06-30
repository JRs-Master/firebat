//! HubManager — Hub Phase 1 (2026-05-17) 의 비즈니스 로직.
//!
//! system service `hub` 의 instance / conversation / message 영역 CRUD wrapper.
//! 외부 워드프레스 사이트 영역 연결용. admin chat 과 별개 (테이블 분리).
//!
//! 책임:
//! - Instance CRUD + slug 검증 (영숫자 / 하이픈 only) + api_token 자동 생성
//! - Conversation ensure (instance, session_id 기준 동일성 유지)
//! - Message append + list
//! - api_token / allowed_domains 영역 검증 헬퍼 (외부 endpoint 영역 사용)

use std::sync::Arc;

use crate::managers::ai::{AiManager, AiResponse};
use crate::ports::{
    AiRequestOpts, ChatMessage, HubContext, HubConversation, HubInstance,
    HubMessage, IHubPort, InfraResult, LlmCallOpts,
};

/// slug 검증 — URL safe (Unicode alnum + 한글 + 하이픈 + 언더스코어). 빈 문자열 금지.
/// 길이 = byte 기준 64 (한글 1자 = UTF-8 3 byte).
pub fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() {
        return Err("slug 가 비어있습니다.".to_string());
    }
    if slug.len() > 64 {
        return Err("slug 는 64 byte 이하여야 합니다 (한글 1자 = 3 byte).".to_string());
    }
    if !slug.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(
            "slug 는 영숫자 / 한글 / 하이픈 / 언더스코어만 허용됩니다. 공백 / 슬래시 / 기호 금지."
                .to_string(),
        );
    }
    Ok(())
}

/// 32 byte hex api_token 생성. UUID v4 두 개 합친 영역 (128 bit × 2 = 256 bit entropy).
pub fn generate_api_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

/// 새 instance 생성 시 input. id / api_token / created_at / updated_at 은 매니저가 자동.
#[derive(Debug, Clone)]
pub struct CreateInstanceInput {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub allowed_references: Vec<String>,
    pub allowed_sysmods: Vec<String>,
    pub model_id: Option<String>,
    pub enabled: bool,
    pub allowed_domains: Vec<String>,
    // 노출 형태 — None = default true (양쪽 노출 시작)
    pub expose_widget: Option<bool>,
    pub expose_page: Option<bool>,
    // instance kind — None = 'widget'(기본). 'tenant' = 풀 워크스페이스.
    pub kind: Option<String>,
}

/// 부분 update — 매 필드 Option (None = 변경 X). enabled / api_token 영역 별도 토글 메서드.
#[derive(Debug, Clone, Default)]
pub struct UpdateInstanceInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub allowed_references: Option<Vec<String>>,
    pub allowed_sysmods: Option<Vec<String>>,
    pub model_id: Option<String>,
    pub enabled: Option<bool>,
    pub allowed_domains: Option<Vec<String>>,
    pub expose_widget: Option<bool>,
    pub expose_page: Option<bool>,
    pub kind: Option<String>,
}

pub struct HubManager {
    port: Arc<dyn IHubPort>,
    /// PageManager (옵션) — hub instance 삭제 시 hub-scoped page (project='hub:<instance_id>')
    /// cascade 처리. 미설정 시 cascade skip.
    page: Option<Arc<crate::managers::page::PageManager>>,
    /// Conversation persistence = the single ConversationManager (owner="hub:<inst>:<sid>"), same logic as admin.
    /// When unset (tests) falls back to IHubPort (memory.db). HubManager itself only does instances + send orchestration.
    conv: Option<Arc<crate::managers::conversation::ConversationManager>>,
}

impl HubManager {
    pub fn new(port: Arc<dyn IHubPort>) -> Self {
        Self { port, page: None, conv: None }
    }

    /// Set PageManager — cascades hub-scoped pages (project='hub:<id>') when a hub instance is deleted.
    pub fn with_page(mut self, page: Arc<crate::managers::page::PageManager>) -> Self {
        self.page = Some(page);
        self
    }

    /// Delegate conversation persistence to ConversationManager (same owner-keyed manager as admin) — one logic.
    pub fn with_conversation(
        mut self,
        conv: Arc<crate::managers::conversation::ConversationManager>,
    ) -> Self {
        self.conv = Some(conv);
        self
    }

    fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// "hub:<instance>:<session>" → (instance, session); None if malformed. Reverse-parse the unified-store owner.
    fn parse_hub_owner(owner: &str) -> Option<(String, String)> {
        let rest = owner.strip_prefix("hub:")?;
        let (inst, sid) = rest.split_once(':')?;
        if inst.is_empty() || sid.is_empty() {
            return None;
        }
        Some((inst.to_string(), sid.to_string()))
    }

    /// Write a hub message (Message Value) through ConversationManager (single conversation store) — canonical split.
    /// owner = "hub:<inst>:<sid>" assigned at conv creation. Exactly the same storage shape as admin save.
    fn write_message(&self, conv_id: &str, msg: &serde_json::Value) {
        if let Some(conv) = &self.conv {
            if let Some((owner, _)) = conv.meta_by_id(conv_id) {
                conv.append(&owner, conv_id, msg);
            }
        }
    }

    // ─── Instance CRUD ────────────────────────────────────────────────────

    /// 새 hub instance 생성. slug 검증 + api_token 자동 + slug 중복 확인 (hub + page + reserved).
    pub async fn create_instance(&self, input: CreateInstanceInput) -> InfraResult<String> {
        validate_slug(&input.slug)?;
        // 시스템 예약 영역 (api / admin / user / hub / system / login / share / feed.xml 등) 차단.
        crate::utils::slug_validator::check_reserved(&input.slug)?;
        // hub 영역 중복 검사
        if self
            .port
            .get_instance_by_slug(&input.slug)
            .await?
            .is_some()
        {
            return Err(format!("slug \"{}\" 가 이미 hub 로 등록되어 있습니다.", input.slug));
        }
        // page 중복 검사 — 같은 slug 가 page 와 hub 양쪽에 동시에 등록되는 것을 차단.
        // root /<slug> URL 에서 page 가 우선 매칭되어 hub 가 숨겨지던 silent fail 회피.
        if let Some(page) = &self.page {
            if page.get(&input.slug).is_some() {
                return Err(format!(
                    "slug \"{}\" 가 이미 page 로 등록되어 있습니다.",
                    input.slug
                ));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let ts = Self::now_ms();
        let instance = HubInstance {
            id: id.clone(),
            slug: input.slug,
            name: input.name,
            description: input.description,
            system_prompt: input.system_prompt,
            allowed_references: input.allowed_references,
            allowed_sysmods: input.allowed_sysmods,
            model_id: input.model_id,
            enabled: input.enabled,
            api_token: generate_api_token(),
            allowed_domains: input.allowed_domains,
            created_at: ts,
            updated_at: ts,
            // 노출 형태 default — 둘 다 true (새 instance 양쪽 노출 시작)
            expose_widget: input.expose_widget.unwrap_or(true),
            expose_page: input.expose_page.unwrap_or(true),
            // 기본 'widget' — admin 이 명시 'tenant' 로 승격해야 풀 워크스페이스.
            kind: input.kind.unwrap_or_else(|| "widget".to_string()),
        };
        self.port.create_instance(&instance).await?;
        Ok(id)
    }

    pub async fn list_instances(&self) -> InfraResult<Vec<HubInstance>> {
        self.port.list_instances().await
    }

    pub async fn get_instance(&self, id: &str) -> InfraResult<Option<HubInstance>> {
        self.port.get_instance(id).await
    }

    pub async fn get_instance_by_slug(
        &self,
        slug: &str,
    ) -> InfraResult<Option<HubInstance>> {
        self.port.get_instance_by_slug(slug).await
    }

    /// 부분 update — None 필드 영역 옛 값 유지.
    pub async fn update_instance(
        &self,
        id: &str,
        patch: UpdateInstanceInput,
    ) -> InfraResult<()> {
        let mut current = self
            .port
            .get_instance(id)
            .await?
            .ok_or_else(|| format!("instance \"{id}\" 가 없습니다."))?;
        if let Some(v) = patch.name {
            current.name = v;
        }
        if let Some(v) = patch.description {
            current.description = Some(v);
        }
        if let Some(v) = patch.system_prompt {
            current.system_prompt = Some(v);
        }
        if let Some(v) = patch.allowed_references {
            current.allowed_references = v;
        }
        if let Some(v) = patch.allowed_sysmods {
            current.allowed_sysmods = v;
        }
        if let Some(v) = patch.model_id {
            current.model_id = Some(v);
        }
        if let Some(v) = patch.enabled {
            current.enabled = v;
        }
        if let Some(v) = patch.allowed_domains {
            current.allowed_domains = v;
        }
        if let Some(v) = patch.expose_widget {
            current.expose_widget = v;
        }
        if let Some(v) = patch.expose_page {
            current.expose_page = v;
        }
        if let Some(v) = patch.kind {
            current.kind = v;
        }
        current.updated_at = Self::now_ms();
        self.port.update_instance(&current).await
    }

    pub async fn delete_instance(&self, id: &str) -> InfraResult<()> {
        // hub-scoped page cascade — project = 'hub:<id>' 인 모든 page 같이 삭제.
        // PageManager 설정되어 있을 때만 동작 (옛 호환 — 미설정 시 skip).
        if let Some(page) = &self.page {
            let project_key = format!("hub:{}", id);
            let pages = page.list();
            for p in pages {
                if p.project.as_deref() == Some(project_key.as_str()) {
                    let _ = page.delete(&p.slug, Some(project_key.as_str()));
                }
            }
        }
        // hub_instances + conversations + messages cascade (adapter 가 처리)
        self.port.delete_instance(id).await
    }

    /// api_token 재발급 (옛 token 무효, 매 워드프레스 위젯에 다시 등록해야 함).
    pub async fn rotate_api_token(&self, id: &str) -> InfraResult<String> {
        let mut current = self
            .port
            .get_instance(id)
            .await?
            .ok_or_else(|| format!("instance \"{id}\" 가 없습니다."))?;
        let new_token = generate_api_token();
        current.api_token = new_token.clone();
        current.updated_at = Self::now_ms();
        self.port.update_instance(&current).await?;
        Ok(new_token)
    }

    // ─── 외부 endpoint 영역 검증 헬퍼 ──────────────────────────────────────

    /// Sentinel — origin 검증 fail (외부 무단 임베드) 시 반환. Frontend route 가 이 prefix
    /// 검출하면 광고 메시지 SSE 응답 (단순 403 reject 하지 않음 — Firebat 광고 효과 활용).
    pub const UNAUTHORIZED_ORIGIN_PREFIX: &'static str = "UNAUTHORIZED_ORIGIN:";

    /// (slug, api_token, origin, self_host) → 인증 + 활성 + origin 검증.
    /// origin == self_host = 자동 허용 (page 풀스크린 / admin demo).
    /// 외부 origin = allowed_domains 매칭만. 미매칭 = UNAUTHORIZED_ORIGIN: sentinel Err.
    pub async fn authenticate(
        &self,
        slug: &str,
        api_token: &str,
        origin: Option<&str>,
        self_host: Option<&str>,
    ) -> InfraResult<HubInstance> {
        let instance = self
            .port
            .get_instance_by_slug(slug)
            .await?
            .ok_or_else(|| "hub 가 없습니다.".to_string())?;
        if !instance.enabled {
            return Err("비활성된 hub 입니다.".to_string());
        }
        // 상수 시간 비교 — timing-attack 방어.
        if !constant_time_eq(instance.api_token.as_bytes(), api_token.as_bytes()) {
            return Err("api_token 이 잘못됐습니다.".to_string());
        }
        // origin 검사:
        // 1. origin 빈 영역 (curl / native app / direct fetch) = 통과 (browser CORS 없음)
        // 2. origin = self_host (우리 사이트 page mode / admin demo) = 자동 허용
        // 3. origin = allowed_domains 매칭 = OK
        // 4. 외부 origin + allowed_domains 미매칭 = UNAUTHORIZED_ORIGIN: sentinel
        if let Some(origin_str) = origin.filter(|s| !s.is_empty()) {
            let host_match = self_host
                .map(|h| origin_matches_host(origin_str, h))
                .unwrap_or(false);
            let in_allowlist = instance.allowed_domains.iter().any(|d| d == origin_str);
            if !host_match && !in_allowlist {
                return Err(format!(
                    "{}{}",
                    Self::UNAUTHORIZED_ORIGIN_PREFIX,
                    origin_str
                ));
            }
        }
        Ok(instance)
    }

    // ─── Conversation ─────────────────────────────────────────────────────

    pub async fn ensure_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String> {
        if let Some(conv) = &self.conv {
            let owner = format!("hub:{instance_id}:{session_id}");
            return Ok(conv.ensure(&owner));
        }
        self.port.ensure_conversation(instance_id, session_id).await
    }

    /// Always create a new conversation — invoked when the sidebar "New chat" is clicked in multi-conv mode.
    pub async fn create_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String> {
        if let Some(conv) = &self.conv {
            let owner = format!("hub:{instance_id}:{session_id}");
            return Ok(conv.create(&owner));
        }
        self.port.create_conversation(instance_id, session_id).await
    }

    /// app.db ConversationSummary (owner-keyed) → HubConversation. instance/session come from the call args
    /// so no owner parsing needed. app.db always fills title (minimal placeholder) → Some.
    fn summary_to_hub_conv(
        s: crate::ports::ConversationSummary,
        instance_id: &str,
        session_id: &str,
    ) -> HubConversation {
        HubConversation {
            id: s.id,
            instance_id: instance_id.to_string(),
            session_id: session_id.to_string(),
            title: Some(s.title),
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }

    pub async fn list_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>> {
        if let Some(conv) = &self.conv {
            let owner = format!("hub:{instance_id}:{session_id}");
            return Ok(conv
                .list(&owner)
                .into_iter()
                .map(|s| Self::summary_to_hub_conv(s, instance_id, session_id))
                .collect());
        }
        self.port.list_conversations(instance_id, session_id).await
    }

    /// Trash list — (instance_id, session_id) scope, deleted_at IS NOT NULL.
    pub async fn list_deleted_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>> {
        if let Some(conv) = &self.conv {
            let owner = format!("hub:{instance_id}:{session_id}");
            return Ok(conv
                .list_deleted(&owner)
                .into_iter()
                .map(|s| Self::summary_to_hub_conv(s, instance_id, session_id))
                .collect());
        }
        self.port
            .list_deleted_conversations(instance_id, session_id)
            .await
    }

    pub async fn get_conversation(&self, id: &str) -> InfraResult<Option<HubConversation>> {
        // Reverse-parse owner ("hub:inst:sid") → reconstruct HubConversation.
        // Returns soft-deleted too (meta_by_id does not filter deleted) → restore·ensure_owner work.
        if let Some(conv) = &self.conv {
            return Ok(conv.meta_by_id(id).and_then(|(owner, s)| {
                Self::parse_hub_owner(&owner)
                    .map(|(inst, sid)| Self::summary_to_hub_conv(s, &inst, &sid))
            }));
        }
        self.port.get_conversation(id).await
    }

    /// Derive owner — "hub:<instance>:<session>". Call *before* a mutation (before a permanent-delete drops the row).
    async fn hub_owner_of(&self, id: &str) -> Option<String> {
        if let Some(conv) = &self.conv {
            return conv.meta_by_id(id).map(|(owner, _)| owner);
        }
        self.port
            .get_conversation(id)
            .await
            .ok()
            .flatten()
            .map(|c| format!("hub:{}:{}", c.instance_id, c.session_id))
    }

    /// Soft delete — move to trash.
    pub async fn delete_conversation(&self, id: &str) -> InfraResult<()> {
        if let Some(conv) = &self.conv {
            if let Some(owner) = self.hub_owner_of(id).await {
                let _ = conv.delete(&owner, id);
            }
            return Ok(());
        }
        self.port.delete_conversation(id).await
    }

    /// Restore from trash — deleted_at NULL.
    pub async fn restore_conversation(&self, id: &str) -> InfraResult<()> {
        if let Some(conv) = &self.conv {
            if let Some(owner) = self.hub_owner_of(id).await {
                let _ = conv.restore(&owner, id);
            }
            return Ok(());
        }
        self.port.restore_conversation(id).await
    }

    /// Permanent delete — hard delete, cascades conversation_messages.
    pub async fn permanent_delete_conversation(&self, id: &str) -> InfraResult<()> {
        if let Some(conv) = &self.conv {
            if let Some(owner) = self.hub_owner_of(id).await {
                let _ = conv.permanent_delete(&owner, id);
            }
            return Ok(());
        }
        self.port.permanent_delete_conversation(id).await
    }

    /// 30일 retention cleanup — internal cron 이 호출.
    pub async fn cleanup_old_deleted_conversations(&self, retention_ms: i64) -> InfraResult<i64> {
        if let Some(conv) = &self.conv {
            return Ok(conv.cleanup_old_deleted(retention_ms));
        }
        let cutoff = crate::utils::time::now_ms() - retention_ms;
        self.port.cleanup_old_deleted_conversations(cutoff).await
    }

    pub async fn update_conversation_title(&self, id: &str, title: &str) -> InfraResult<()> {
        // Shared by rename and first-message auto-title.
        if let Some(conv) = &self.conv {
            conv.update_title(id, title);
            return Ok(());
        }
        self.port.update_conversation_title(id, title).await
    }

    // ─── Message ──────────────────────────────────────────────────────────

    pub async fn append_user_message(
        &self,
        conversation_id: &str,
        content: &str,
        id: Option<String>,
    ) -> InfraResult<String> {
        // Prefer the client-issued id (frontend local-message ordering — admin systemId pattern); uuid fallback.
        let id = id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // canonical Message Value — split_message separates columns/data_json. user has no rich fields → data_json={}.
        let msg = serde_json::json!({
            "id": id, "role": "user", "content": content, "createdAt": Self::now_ms(),
        });
        self.write_message(conversation_id, &msg);
        Ok(id)
    }

    /// Append a system (AI) message — content + canonical data payload (message_data_json).
    pub async fn append_system_message(
        &self,
        conversation_id: &str,
        content: Option<String>,
        data_json: Option<String>,
        id: Option<String>,
    ) -> InfraResult<String> {
        // Prefer the client-issued id (frontend systemId ordering); uuid fallback. For background-resume reconcile matching.
        let id = id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // canonical Message Value — same as admin systemMsg: badges (executedActions etc.) at top + data: payload.
        // split_message separates columns (id/role/content/createdAt) → data_json = {badges, data: payload}.
        let payload: serde_json::Value = data_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let mut msg = serde_json::json!({
            "id": id, "role": "system", "content": content.clone().unwrap_or_default(), "createdAt": Self::now_ms(),
        });
        if let Some(o) = msg.as_object_mut() {
            for k in ["executedActions", "toolResults", "suggestions", "pendingActions", "libraryHits"] {
                if let Some(v) = payload.get(k) {
                    o.insert(k.to_string(), v.clone());
                }
            }
            o.insert("data".to_string(), payload);
        }
        self.write_message(conversation_id, &msg);
        Ok(id)
    }

    /// Re-save an existing message (client-state persistence) — canonical append of the full Message Value
    /// (ON CONFLICT id UPDATE, created_at preserved). Persists approve/reject status etc. so it survives
    /// reconcile (no card resurrection). owner is verified by grpc.
    pub fn persist_message(&self, owner: &str, conv_id: &str, msg: &serde_json::Value) {
        if let Some(conv) = &self.conv {
            conv.append(owner, conv_id, msg);
        }
    }

    pub async fn list_messages(
        &self,
        conversation_id: &str,
    ) -> InfraResult<Vec<HubMessage>> {
        // rows(conv_id) → HubMessage mapping (presentation).
        if let Some(conv) = &self.conv {
            return Ok(conv
                .message_rows(conversation_id)
                .into_iter()
                .map(|m| HubMessage {
                    id: m.id,
                    conversation_id: m.conversation_id,
                    role: m.role,
                    content: if m.content.is_empty() { None } else { Some(m.content) },
                    data_json: if m.data_json.is_empty() { None } else { Some(m.data_json) },
                    created_at: m.created_at,
                })
                .collect());
        }
        self.port.list_messages(conversation_id).await
    }

    /// Unified entry called by the external hub endpoint — applies guards + history + invokes AiManager +
    /// persists the AI response.
    ///
    /// Flow:
    ///   1. Build HubContext from the instance's allowed_sysmods / allowed_references
    ///   2. Build recent-N ChatMessage history (for prepend) from prior messages
    ///   3. Build AiRequestOpts + LlmCallOpts + call AiManager.process_with_tools_opts
    ///   4. Persist the AI response via append_system_message
    ///   5. Return AiResponse (the route layer wraps it as SSE)
    pub async fn send_message(
        &self,
        ai: Arc<AiManager>,
        instance: &HubInstance,
        conversation_id: &str,
        user_message: &str,
        plan_mode: crate::ports::PlanMode,
        plan_execute_id: Option<String>,
        plan_revise_id: Option<String>,
        ai_msg_id: Option<String>,
        user_msg_id: Option<String>,
        emit: Option<tokio::sync::mpsc::Sender<crate::managers::ai::AiStreamEvent>>,
    ) -> InfraResult<AiResponse> {
        const HISTORY_RECENT_LIMIT: usize = 10;

        // List prior messages (the current user message is already persisted by the caller via
        // append_user_message). Build from the recent N. Single store = app.db (self.list_messages).
        let all_messages = self.list_messages(conversation_id).await?;
        let start = all_messages.len().saturating_sub(HISTORY_RECENT_LIMIT);
        let recent = &all_messages[start..];
        let history: Vec<ChatMessage> = recent
            .iter()
            .filter_map(|m| {
                let content = m.content.clone().unwrap_or_default();
                if content.trim().is_empty() {
                    return None;
                }
                Some(ChatMessage {
                    role: match m.role.as_str() {
                        "system" => "assistant".to_string(),
                        other => other.to_string(),
                    },
                    content: serde_json::Value::String(content),
                    image: None,
                    image_mime_type: None,
                })
            })
            .collect();

        // Diagnostic — track the "same session loses earlier context" symptom. Logs conversation_id /
        // total message count / prepended history count. On a repro: total=1 (only the current message)
        // means ensure_conversation handed back a new/different conv; total>1 with history=0 means a filter issue.
        tracing::info!(
            category = "hub",
            "hub send_message — conv={} 전체메시지={} history={}",
            conversation_id,
            all_messages.len(),
            history.len()
        );

        // session_id — fetched from the conversation; feeds the per-visitor isolation owner.
        // owner "hub:<instance_id>:<session_id>" is auto-injected per tool call inside ai.rs.
        // Single store = app.db (self.get_conversation, owner reverse-parsed).
        let conv = self.get_conversation(conversation_id).await?;
        let session_id = conv.as_ref().map(|c| c.session_id.clone()).unwrap_or_default();

        // Title is derived by the shared backend logic (ConversationManager.append → derive_conv_title) when the
        // caller appends the first user message — same authority as admin. No hub-specific auto-title here.
        // owner = hub:<instance>:<session> (per-session isolation) — unified with tool injection (ai.rs) and library route.
        // The old hub:<instance> (no session) drifted from per-tool injection.
        let owner = format!("hub:{}:{}", instance.id, session_id);

        // instance 커스텀 프롬프트는 기본 시스템 프롬프트(에이전트·plan·render 규칙)를 replace 하지 않고
        // hub_context 로 넘긴다 → AiManager 가 base 에 추가 합성 (admin 과 동일 base + plan_instruction 보장).
        let instance_directive = instance
            .system_prompt
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(String::from);
        let hub_ctx = HubContext {
            instance_id: instance.id.clone(),
            session_id,
            allowed_sysmods: instance.allowed_sysmods.clone(),
            allowed_references: instance.allowed_references.clone(),
            history,
            instance_directive,
        };

        let model_id = instance
            .model_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(String::from);

        // system_prompt 는 의도적으로 None — AiManager 가 prompt_builder 로 기본 프롬프트(+plan+history)를 빌드하고
        // hub_context.instance_directive 를 거기에 추가한다. 옛 system_prompt=instance 방식은 그 블록을 통째로 skip 했음.
        let llm_opts = LlmCallOpts {
            owner: Some(owner.clone()),
            conversation_id: Some(conversation_id.to_string()),
            model: model_id.clone(),
            plan_mode,
            ..Default::default()
        };

        let ai_opts = AiRequestOpts {
            owner: Some(owner),
            conversation_id: Some(conversation_id.to_string()),
            model: model_id,
            hub_context: Some(hub_ctx),
            plan_mode,
            plan_execute_id,
            plan_revise_id,
            // Persist is now the single shared path (process_with_tools) — inject the client-issued ids so it
            // writes user/system with the same ids (reconcile matches). Replaces the old append_*_message here.
            user_msg_id,
            ai_msg_id,
            ..Default::default()
        };

        // streaming variant — emit 가 Some 이면 admin chat 과 동일하게 chunk/step 이벤트가 채널로 흐름.
        // None 이면 옛 unary 동작 (SendMessage RPC). 영속화는 어느 쪽이든 호출 후 동일.
        // Persist (user + system) happens inside process_with_tools_opts_with_emit — the single shared path
        // for admin & hub (owner/ids injected via ai_opts above). No hub-specific append here anymore: that
        // was the divergence (hub=Rust here / admin=TS route). Now both persist server-side in one place.
        let response = ai
            .process_with_tools_opts_with_emit(user_message, &[], &llm_opts, &ai_opts, emit)
            .await?;

        Ok(response)
    }
}

/// origin (scheme + host[:port]) 가 host (호스트 only) 와 같은 사이트인지 판정.
/// page mode / admin demo 가 자기 서버에서 위젯 호출할 때 자동 허용용.
/// 예: origin="https://example.com", host="example.com" → true.
fn origin_matches_host(origin: &str, host: &str) -> bool {
    if origin == host {
        return true;
    }
    let origin_host = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin);
    origin_host == host
}

/// 상수 시간 byte 비교 — timing-attack 방어. 길이 일치 확인은 별도 (길이 자체 leak 영역
/// 영역 충분 안전 — api_token 영역 고정 길이).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_slug_accept_normal() {
        assert!(validate_slug("lawassistant").is_ok());
        assert!(validate_slug("my-bot_v2").is_ok());
        assert!(validate_slug("a").is_ok());
    }

    #[test]
    fn validate_slug_reject_empty_or_invalid() {
        assert!(validate_slug("").is_err());
        assert!(validate_slug("내챗봇").is_err()); // 한글 X
        assert!(validate_slug("bot/test").is_err()); // 슬래시 X
        assert!(validate_slug("bot test").is_err()); // 공백 X
    }

    #[test]
    fn validate_slug_reject_too_long() {
        let long = "a".repeat(65);
        assert!(validate_slug(&long).is_err());
    }

    #[test]
    fn generate_api_token_returns_64_hex() {
        let token = generate_api_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        // 매번 다른 token
        assert_ne!(token, generate_api_token());
    }

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }
}
