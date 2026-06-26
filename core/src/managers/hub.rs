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
    /// Phase 1 통합 — 대화를 app.db owner 기반 단일 store(conversations/conversation_messages)에도
    /// dual-write. owner = "hub:<instance>:<session>". 미설정 시 dual-write skip(옛 동작).
    db: Option<Arc<dyn crate::ports::IDatabasePort>>,
}

impl HubManager {
    pub fn new(port: Arc<dyn IHubPort>) -> Self {
        Self { port, page: None, db: None }
    }

    /// PageManager 설정 — hub instance 삭제 시 hub-scoped page (project='hub:<id>') cascade 처리.
    pub fn with_page(mut self, page: Arc<crate::managers::page::PageManager>) -> Self {
        self.page = Some(page);
        self
    }

    /// Phase 1 통합 store(app.db) dual-write 활성 — 대화 row + 메시지 rows 를 owner 기반 단일 store 에도 기록.
    pub fn with_db(mut self, db: Arc<dyn crate::ports::IDatabasePort>) -> Self {
        self.db = Some(db);
        self
    }

    fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// Phase 1 — app.db 통합 store 에 hub 대화 row 를 owner-keyed 로 멱등 생성(있으면 no-op).
    /// owner = "hub:<instance>:<session>". 제목은 placeholder — 실제 제목 동기화는 read 슬라이스/백필.
    fn mirror_hub_conv_row(&self, instance_id: &str, session_id: &str, conv_id: &str) {
        if let Some(db) = &self.db {
            let owner = format!("hub:{instance_id}:{session_id}");
            db.ensure_conversation_row(&owner, conv_id, "새 대화", Self::now_ms());
        }
    }

    /// Phase 1 — hub 메시지를 app.db 통합 store(conversation_messages) 에도 dual-write.
    fn mirror_hub_message(&self, msg: &HubMessage) {
        if let Some(db) = &self.db {
            db.append_conversation_message(&crate::ports::ConversationMessage {
                id: msg.id.clone(),
                conversation_id: msg.conversation_id.clone(),
                role: msg.role.clone(),
                content: msg.content.clone().unwrap_or_default(),
                data_json: msg.data_json.clone().unwrap_or_default(),
                created_at: msg.created_at,
            });
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
        let conv_id = self.port.ensure_conversation(instance_id, session_id).await?;
        self.mirror_hub_conv_row(instance_id, session_id, &conv_id);
        Ok(conv_id)
    }

    /// 항상 새 conversation 생성 — multi-conv 모드에서 사이드바 "새 대화" 누를 때 호출.
    pub async fn create_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String> {
        let conv_id = self.port.create_conversation(instance_id, session_id).await?;
        self.mirror_hub_conv_row(instance_id, session_id, &conv_id);
        Ok(conv_id)
    }

    pub async fn list_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>> {
        self.port.list_conversations(instance_id, session_id).await
    }

    /// 휴지통 목록 — (instance_id, session_id) scope. deleted_at IS NOT NULL.
    pub async fn list_deleted_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>> {
        self.port
            .list_deleted_conversations(instance_id, session_id)
            .await
    }

    pub async fn get_conversation(&self, id: &str) -> InfraResult<Option<HubConversation>> {
        self.port.get_conversation(id).await
    }

    /// soft delete — 휴지통으로 이동. deleted_at 갱신.
    pub async fn delete_conversation(&self, id: &str) -> InfraResult<()> {
        self.port.delete_conversation(id).await
    }

    /// 휴지통에서 복원 — deleted_at NULL.
    pub async fn restore_conversation(&self, id: &str) -> InfraResult<()> {
        self.port.restore_conversation(id).await
    }

    /// 영구 삭제 — hard delete. messages cascade.
    pub async fn permanent_delete_conversation(&self, id: &str) -> InfraResult<()> {
        self.port.permanent_delete_conversation(id).await
    }

    /// 30일 retention cleanup — internal cron 이 호출.
    pub async fn cleanup_old_deleted_conversations(&self, retention_ms: i64) -> InfraResult<i64> {
        let cutoff = crate::utils::time::now_ms() - retention_ms;
        self.port.cleanup_old_deleted_conversations(cutoff).await
    }

    pub async fn update_conversation_title(&self, id: &str, title: &str) -> InfraResult<()> {
        self.port.update_conversation_title(id, title).await
    }

    // ─── Message ──────────────────────────────────────────────────────────

    pub async fn append_user_message(
        &self,
        conversation_id: &str,
        content: &str,
        id: Option<String>,
    ) -> InfraResult<String> {
        // 클라이언트 발급 id 우선(프론트 로컬 메시지와 hub_messages 정렬 — admin systemId 패턴), 없으면 uuid fallback.
        let id = id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let msg = HubMessage {
            id: id.clone(),
            conversation_id: conversation_id.to_string(),
            role: "user".to_string(),
            content: Some(content.to_string()),
            data_json: None,
            created_at: Self::now_ms(),
        };
        self.port.append_message(&msg).await?;
        self.mirror_hub_message(&msg);
        Ok(id)
    }

    /// system (AI) 메시지 append — content + data_json (blocks / tool_results 영역).
    pub async fn append_system_message(
        &self,
        conversation_id: &str,
        content: Option<String>,
        data_json: Option<String>,
        id: Option<String>,
    ) -> InfraResult<String> {
        // 클라이언트 발급 id 우선(프론트 systemId 정렬), 없으면 uuid fallback. background-resume reconcile 매칭용.
        let id = id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let msg = HubMessage {
            id: id.clone(),
            conversation_id: conversation_id.to_string(),
            role: "system".to_string(),
            content,
            data_json,
            created_at: Self::now_ms(),
        };
        self.port.append_message(&msg).await?;
        self.mirror_hub_message(&msg);
        Ok(id)
    }

    pub async fn list_messages(
        &self,
        conversation_id: &str,
    ) -> InfraResult<Vec<HubMessage>> {
        self.port.list_messages(conversation_id).await
    }

    /// 외부 hub endpoint 가 호출하는 통합 entry — 가드 + history 영역 적용 + AiManager 호출 +
    /// AI 응답 영역 hub_messages 영속화.
    ///
    /// 흐름:
    ///   1. instance 영역 allowed_sysmods / allowed_references 영역 HubContext 빌드
    ///   2. 옛 user 메시지 영역 이전 메시지 영역 recent N 영역 ChatMessage 영역 빌드 (history prepend 용)
    ///   3. AiRequestOpts + LlmCallOpts 영역 빌드 + AiManager.process_with_tools_opts 호출
    ///   4. AI 응답 영역 hub_messages 영역 append_system_message 영역 영속화
    ///   5. AiResponse 영역 반환 (route layer 가 SSE 영역 wrap)
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
        emit: Option<tokio::sync::mpsc::Sender<crate::managers::ai::AiStreamEvent>>,
    ) -> InfraResult<AiResponse> {
        const HISTORY_RECENT_LIMIT: usize = 10;

        // 옛 user 메시지를 모두 listMessages (현재 user 메시지는 caller 가 append_user_message 로
        // 이미 기록한 상태 = caller 책임). recent N 으로 빌드.
        let all_messages = self.port.list_messages(conversation_id).await?;
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

        // 진단 — "같은 세션 연속 대화인데 이전 맥락을 못 본다" 증상 추적. conversation_id /
        // 전체 메시지 수 / history 로 prepend 되는 수를 기록. 다음 재현에서 total=1(현재 메시지뿐)
        // 이면 ensure_conversation 이 새/다른 conv 를 줬다는 뜻, total>1 인데 history=0 이면 필터 문제.
        tracing::info!(
            category = "hub",
            "hub send_message — conv={} 전체메시지={} history={}",
            conversation_id,
            all_messages.len(),
            history.len()
        );

        // session_id — conversation 조회로 visitor 별 자료 격리 owner 에 들어감.
        // hub:<instance_id>:<session_id> 형태 owner 가 매 도구 호출 시 ai.rs 안 자동 주입.
        let conv = self.port.get_conversation(conversation_id).await?;
        let session_id = conv.as_ref().map(|c| c.session_id.clone()).unwrap_or_default();

        // Set the conversation title from the first user message — same behaviour as the admin
        // chat path (existingTitle || derived). hub previously never persisted a title, so
        // hub_conversations.title stayed NULL and the visitor's chat list showed every entry as
        // "새 대화" (admin sets it in the TS route; the hub Rust path was missing it = drift).
        // Set only when empty so it stays put on later turns. char-based slice — byte slicing
        // panics on a Korean char boundary.
        let title_empty = conv
            .as_ref()
            .map(|c| c.title.as_deref().unwrap_or("").trim().is_empty())
            .unwrap_or(true);
        if title_empty {
            let trimmed = user_message.trim();
            if !trimmed.is_empty() {
                let mut title: String = trimmed.chars().take(28).collect();
                if trimmed.chars().count() > 28 {
                    title.push('…');
                }
                let _ = self.port.update_conversation_title(conversation_id, &title).await;
            }
        }
        // owner = hub:<instance>:<session> (세션 단위 격리) — tool 주입(ai.rs)·library route 와 통일.
        // 옛 hub:<instance> (세션 없음) 은 per-tool 주입과 어긋나던 drift 였음.
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
            ..Default::default()
        };

        // streaming variant — emit 가 Some 이면 admin chat 과 동일하게 chunk/step 이벤트가 채널로 흐름.
        // None 이면 옛 unary 동작 (SendMessage RPC). 영속화는 어느 쪽이든 호출 후 동일.
        let response = ai
            .process_with_tools_opts_with_emit(user_message, &[], &llm_opts, &ai_opts, emit)
            .await?;

        // Persist the AI response into hub_messages using the canonical message-data builder
        // (AiResponse::message_data_json) — the same single source the admin path now consumes,
        // so a new field can never be dropped on one side again (the buildSession/libraryHits
        // drift root). Includes blocks/suggestions/pendingActions/buildSession so cards survive reload.
        let data_payload = response.message_data_json();
        let _ = self
            .append_system_message(
                conversation_id,
                Some(response.reply.clone()),
                Some(data_payload.to_string()),
                ai_msg_id,
            )
            .await;

        Ok(response)
    }
}

/// origin (scheme + host[:port]) 가 host (호스트 only) 와 같은 사이트인지 판정.
/// page mode / admin demo 가 자기 서버에서 위젯 호출할 때 자동 허용용.
/// 예: origin="https://firebat.co.kr", host="firebat.co.kr" → true.
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
