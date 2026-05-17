//! ChatbotManager — Chatbot Phase 1 (2026-05-17) 의 비즈니스 로직.
//!
//! system service `chatbot` 의 instance / conversation / message 영역 CRUD wrapper.
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
    AiRequestOpts, ChatMessage, ChatbotContext, ChatbotConversation, ChatbotInstance,
    ChatbotMessage, IChatbotPort, InfraResult, LlmCallOpts,
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
}

pub struct ChatbotManager {
    port: Arc<dyn IChatbotPort>,
}

impl ChatbotManager {
    pub fn new(port: Arc<dyn IChatbotPort>) -> Self {
        Self { port }
    }

    fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    // ─── Instance CRUD ────────────────────────────────────────────────────

    /// 새 chatbot instance 생성. slug 검증 + api_token 자동 + slug 중복 확인.
    pub async fn create_instance(&self, input: CreateInstanceInput) -> InfraResult<String> {
        validate_slug(&input.slug)?;
        if self
            .port
            .get_instance_by_slug(&input.slug)
            .await?
            .is_some()
        {
            return Err(format!("slug \"{}\" 가 이미 존재합니다.", input.slug));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let ts = Self::now_ms();
        let instance = ChatbotInstance {
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
        };
        self.port.create_instance(&instance).await?;
        Ok(id)
    }

    pub async fn list_instances(&self) -> InfraResult<Vec<ChatbotInstance>> {
        self.port.list_instances().await
    }

    pub async fn get_instance(&self, id: &str) -> InfraResult<Option<ChatbotInstance>> {
        self.port.get_instance(id).await
    }

    pub async fn get_instance_by_slug(
        &self,
        slug: &str,
    ) -> InfraResult<Option<ChatbotInstance>> {
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
        current.updated_at = Self::now_ms();
        self.port.update_instance(&current).await
    }

    pub async fn delete_instance(&self, id: &str) -> InfraResult<()> {
        self.port.delete_instance(id).await
    }

    /// api_token 재발급 (옛 token 무효, 매 워드프레스 위젯 영역 다시 박아야 함).
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

    /// (slug, api_token, origin) → 인증 + 활성 검증. Ok(instance) 또는 Err(reason).
    /// 외부 endpoint 영역 호출 시 매번 박힘.
    pub async fn authenticate(
        &self,
        slug: &str,
        api_token: &str,
        origin: Option<&str>,
    ) -> InfraResult<ChatbotInstance> {
        let instance = self
            .port
            .get_instance_by_slug(slug)
            .await?
            .ok_or_else(|| "chatbot 가 없습니다.".to_string())?;
        if !instance.enabled {
            return Err("비활성된 chatbot 입니다.".to_string());
        }
        // 상수 시간 비교 — timing-attack 방어. simple eq 영역 length-leak 있지만 충분.
        if !constant_time_eq(instance.api_token.as_bytes(), api_token.as_bytes()) {
            return Err("api_token 이 잘못됐습니다.".to_string());
        }
        // origin 검사 — allowed_domains 빈 배열 = 모든 origin 허용 (개발 영역). 명시되면 일치 origin 만.
        if !instance.allowed_domains.is_empty() {
            let origin_str = origin.unwrap_or("");
            if !instance.allowed_domains.iter().any(|d| d == origin_str) {
                return Err(format!(
                    "허용되지 않은 origin: {origin_str}",
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
        self.port.ensure_conversation(instance_id, session_id).await
    }

    pub async fn list_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<ChatbotConversation>> {
        self.port.list_conversations(instance_id, session_id).await
    }

    pub async fn get_conversation(&self, id: &str) -> InfraResult<Option<ChatbotConversation>> {
        self.port.get_conversation(id).await
    }

    pub async fn delete_conversation(&self, id: &str) -> InfraResult<()> {
        self.port.delete_conversation(id).await
    }

    pub async fn update_conversation_title(&self, id: &str, title: &str) -> InfraResult<()> {
        self.port.update_conversation_title(id, title).await
    }

    // ─── Message ──────────────────────────────────────────────────────────

    pub async fn append_user_message(
        &self,
        conversation_id: &str,
        content: &str,
    ) -> InfraResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let msg = ChatbotMessage {
            id: id.clone(),
            conversation_id: conversation_id.to_string(),
            role: "user".to_string(),
            content: Some(content.to_string()),
            data_json: None,
            created_at: Self::now_ms(),
        };
        self.port.append_message(&msg).await?;
        Ok(id)
    }

    /// system (AI) 메시지 append — content + data_json (blocks / tool_results 영역).
    pub async fn append_system_message(
        &self,
        conversation_id: &str,
        content: Option<String>,
        data_json: Option<String>,
    ) -> InfraResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let msg = ChatbotMessage {
            id: id.clone(),
            conversation_id: conversation_id.to_string(),
            role: "system".to_string(),
            content,
            data_json,
            created_at: Self::now_ms(),
        };
        self.port.append_message(&msg).await?;
        Ok(id)
    }

    pub async fn list_messages(
        &self,
        conversation_id: &str,
    ) -> InfraResult<Vec<ChatbotMessage>> {
        self.port.list_messages(conversation_id).await
    }

    /// 외부 chatbot endpoint 가 호출하는 통합 entry — 가드 + history 영역 적용 + AiManager 호출 +
    /// AI 응답 영역 chatbot_messages 영속화.
    ///
    /// 흐름:
    ///   1. instance 영역 allowed_sysmods / allowed_references 영역 ChatbotContext 빌드
    ///   2. 옛 user 메시지 영역 이전 메시지 영역 recent N 영역 ChatMessage 영역 빌드 (history prepend 용)
    ///   3. AiRequestOpts + LlmCallOpts 영역 빌드 + AiManager.process_with_tools_opts 호출
    ///   4. AI 응답 영역 chatbot_messages 영역 append_system_message 영역 영속화
    ///   5. AiResponse 영역 반환 (route layer 가 SSE 영역 wrap)
    pub async fn send_message(
        &self,
        ai: Arc<AiManager>,
        instance: &ChatbotInstance,
        conversation_id: &str,
        user_message: &str,
    ) -> InfraResult<AiResponse> {
        const HISTORY_RECENT_LIMIT: usize = 10;

        // 옛 user 메시지 영역 모두 영역 listMessages (현재 user 메시지 영역 옛 영역 append_user_message
        // 영역 박혀있는 영역 = caller 영역 책임). recent N 영역 빌드.
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

        let chatbot_ctx = ChatbotContext {
            instance_id: instance.id.clone(),
            allowed_sysmods: instance.allowed_sysmods.clone(),
            allowed_references: instance.allowed_references.clone(),
            history,
        };

        let system_prompt = instance
            .system_prompt
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(String::from);
        let model_id = instance
            .model_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(String::from);

        let llm_opts = LlmCallOpts {
            owner: Some(format!("chatbot:{}", instance.id)),
            conversation_id: Some(conversation_id.to_string()),
            system_prompt,
            model: model_id.clone(),
            ..Default::default()
        };

        let ai_opts = AiRequestOpts {
            owner: Some(format!("chatbot:{}", instance.id)),
            conversation_id: Some(conversation_id.to_string()),
            model: model_id,
            chatbot_context: Some(chatbot_ctx),
            ..Default::default()
        };

        let response = ai
            .process_with_tools_opts(user_message, &[], &llm_opts, &ai_opts)
            .await?;

        // AI 응답 영역 chatbot_messages 영속화. data_json 영역 blocks + tool_results + suggestions 영역.
        let data_payload = serde_json::json!({
            "executedActions": response.executed_actions,
            "toolResults": response.tool_results,
            "blocks": response.blocks,
            "suggestions": response.suggestions,
            "libraryHits": response.library_hits,
        });
        let _ = self
            .append_system_message(
                conversation_id,
                Some(response.reply.clone()),
                Some(data_payload.to_string()),
            )
            .await;

        Ok(response)
    }
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
