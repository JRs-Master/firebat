//! gRPC ChatbotService impl — ChatbotManager wrapping.
//!
//! Chatbot Phase 1 (2026-05-17). 매 RPC unique Request / Response (Phase B-typed).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::AiManager;
use crate::managers::chatbot::{ChatbotManager, CreateInstanceInput, UpdateInstanceInput};
use crate::ports::ChatbotInstance;
use crate::proto::{
    chatbot_service_server::ChatbotService, ChatbotAppendSystemMessageRequest,
    ChatbotAppendSystemMessageResponse, ChatbotAppendUserMessageRequest,
    ChatbotAppendUserMessageResponse, ChatbotAuthenticateRequest, ChatbotAuthenticateResponse,
    ChatbotConversationPb, ChatbotCreateInstanceRequest, ChatbotCreateInstanceResponse,
    ChatbotDeleteConversationRequest, ChatbotDeleteConversationResponse,
    ChatbotDeleteInstanceRequest, ChatbotDeleteInstanceResponse, ChatbotEnsureConversationRequest,
    ChatbotEnsureConversationResponse, ChatbotGetConversationRequest,
    ChatbotGetConversationResponse, ChatbotGetInstanceBySlugRequest,
    ChatbotGetInstanceBySlugResponse, ChatbotGetInstanceRequest, ChatbotGetInstanceResponse,
    ChatbotInstancePb, ChatbotListConversationsRequest, ChatbotListConversationsResponse,
    ChatbotListInstancesRequest, ChatbotListInstancesResponse, ChatbotListMessagesRequest,
    ChatbotListMessagesResponse, ChatbotMessagePb, ChatbotRotateApiTokenRequest,
    ChatbotRotateApiTokenResponse, ChatbotSendMessageRequest, ChatbotSendMessageResponse,
    ChatbotUpdateConversationTitleRequest, ChatbotUpdateConversationTitleResponse,
    ChatbotUpdateInstanceRequest, ChatbotUpdateInstanceResponse,
};

pub struct ChatbotServiceImpl {
    manager: Arc<ChatbotManager>,
    ai: Arc<AiManager>,
}

impl ChatbotServiceImpl {
    pub fn new(manager: Arc<ChatbotManager>, ai: Arc<AiManager>) -> Self {
        Self { manager, ai }
    }
}

// ─── 변환 헬퍼 ────────────────────────────────────────────────────────────

fn instance_to_pb(i: ChatbotInstance) -> ChatbotInstancePb {
    ChatbotInstancePb {
        id: i.id,
        slug: i.slug,
        name: i.name,
        description: i.description.unwrap_or_default(),
        system_prompt: i.system_prompt.unwrap_or_default(),
        allowed_references: i.allowed_references,
        allowed_sysmods: i.allowed_sysmods,
        model_id: i.model_id.unwrap_or_default(),
        enabled: i.enabled,
        api_token: i.api_token,
        allowed_domains: i.allowed_domains,
        created_at: i.created_at,
        updated_at: i.updated_at,
    }
}

fn conversation_to_pb(c: crate::ports::ChatbotConversation) -> ChatbotConversationPb {
    ChatbotConversationPb {
        id: c.id,
        instance_id: c.instance_id,
        session_id: c.session_id,
        title: c.title.unwrap_or_default(),
        created_at: c.created_at,
        updated_at: c.updated_at,
    }
}

fn message_to_pb(m: crate::ports::ChatbotMessage) -> ChatbotMessagePb {
    ChatbotMessagePb {
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content.unwrap_or_default(),
        data_json: m.data_json.unwrap_or_default(),
        created_at: m.created_at,
    }
}

#[tonic::async_trait]
impl ChatbotService for ChatbotServiceImpl {
    // ─── Instance CRUD ────────────────────────────────────────────────────

    async fn create_instance(
        &self,
        req: Request<ChatbotCreateInstanceRequest>,
    ) -> Result<Response<ChatbotCreateInstanceResponse>, TonicStatus> {
        let args = req.into_inner();
        let input = CreateInstanceInput {
            slug: args.slug,
            name: args.name,
            description: if args.description.is_empty() { None } else { Some(args.description) },
            system_prompt: if args.system_prompt.is_empty() { None } else { Some(args.system_prompt) },
            allowed_references: args.allowed_references,
            allowed_sysmods: args.allowed_sysmods,
            model_id: if args.model_id.is_empty() { None } else { Some(args.model_id) },
            enabled: args.enabled,
            allowed_domains: args.allowed_domains,
        };
        let id = self
            .manager
            .create_instance(input)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(ChatbotCreateInstanceResponse { id }))
    }

    async fn list_instances(
        &self,
        _req: Request<ChatbotListInstancesRequest>,
    ) -> Result<Response<ChatbotListInstancesResponse>, TonicStatus> {
        let instances = self
            .manager
            .list_instances()
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotListInstancesResponse {
            instances: instances.into_iter().map(instance_to_pb).collect(),
        }))
    }

    async fn get_instance(
        &self,
        req: Request<ChatbotGetInstanceRequest>,
    ) -> Result<Response<ChatbotGetInstanceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let instance = self
            .manager
            .get_instance(&id)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found(format!("instance \"{id}\" 가 없습니다.")))?;
        Ok(Response::new(ChatbotGetInstanceResponse {
            instance: Some(instance_to_pb(instance)),
        }))
    }

    async fn get_instance_by_slug(
        &self,
        req: Request<ChatbotGetInstanceBySlugRequest>,
    ) -> Result<Response<ChatbotGetInstanceBySlugResponse>, TonicStatus> {
        let slug = req.into_inner().slug;
        let instance = self
            .manager
            .get_instance_by_slug(&slug)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found(format!("slug \"{slug}\" 가 없습니다.")))?;
        Ok(Response::new(ChatbotGetInstanceBySlugResponse {
            instance: Some(instance_to_pb(instance)),
        }))
    }

    async fn update_instance(
        &self,
        req: Request<ChatbotUpdateInstanceRequest>,
    ) -> Result<Response<ChatbotUpdateInstanceResponse>, TonicStatus> {
        let args = req.into_inner();
        let patch = UpdateInstanceInput {
            name: args.name,
            description: args.description,
            system_prompt: args.system_prompt,
            allowed_references: if args.replace_allowed_references {
                Some(args.allowed_references)
            } else {
                None
            },
            allowed_sysmods: if args.replace_allowed_sysmods {
                Some(args.allowed_sysmods)
            } else {
                None
            },
            model_id: args.model_id,
            enabled: args.enabled,
            allowed_domains: if args.replace_allowed_domains {
                Some(args.allowed_domains)
            } else {
                None
            },
        };
        self.manager
            .update_instance(&args.id, patch)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(ChatbotUpdateInstanceResponse {}))
    }

    async fn delete_instance(
        &self,
        req: Request<ChatbotDeleteInstanceRequest>,
    ) -> Result<Response<ChatbotDeleteInstanceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_instance(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotDeleteInstanceResponse {}))
    }

    async fn rotate_api_token(
        &self,
        req: Request<ChatbotRotateApiTokenRequest>,
    ) -> Result<Response<ChatbotRotateApiTokenResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let new_token = self
            .manager
            .rotate_api_token(&id)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(ChatbotRotateApiTokenResponse { new_token }))
    }

    // ─── 외부 endpoint 검증 ───────────────────────────────────────────────

    async fn authenticate(
        &self,
        req: Request<ChatbotAuthenticateRequest>,
    ) -> Result<Response<ChatbotAuthenticateResponse>, TonicStatus> {
        let args = req.into_inner();
        let origin = if args.origin.is_empty() { None } else { Some(args.origin.as_str()) };
        let instance = self
            .manager
            .authenticate(&args.slug, &args.api_token, origin)
            .await
            .map_err(TonicStatus::permission_denied)?;
        Ok(Response::new(ChatbotAuthenticateResponse {
            instance: Some(instance_to_pb(instance)),
        }))
    }

    // ─── Conversation ────────────────────────────────────────────────────

    async fn ensure_conversation(
        &self,
        req: Request<ChatbotEnsureConversationRequest>,
    ) -> Result<Response<ChatbotEnsureConversationResponse>, TonicStatus> {
        let args = req.into_inner();
        let conversation_id = self
            .manager
            .ensure_conversation(&args.instance_id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotEnsureConversationResponse {
            conversation_id,
        }))
    }

    async fn list_conversations(
        &self,
        req: Request<ChatbotListConversationsRequest>,
    ) -> Result<Response<ChatbotListConversationsResponse>, TonicStatus> {
        let args = req.into_inner();
        let conversations = self
            .manager
            .list_conversations(&args.instance_id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotListConversationsResponse {
            conversations: conversations.into_iter().map(conversation_to_pb).collect(),
        }))
    }

    async fn get_conversation(
        &self,
        req: Request<ChatbotGetConversationRequest>,
    ) -> Result<Response<ChatbotGetConversationResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let conversation = self
            .manager
            .get_conversation(&id)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found(format!("conversation \"{id}\" 가 없습니다.")))?;
        Ok(Response::new(ChatbotGetConversationResponse {
            conversation: Some(conversation_to_pb(conversation)),
        }))
    }

    async fn delete_conversation(
        &self,
        req: Request<ChatbotDeleteConversationRequest>,
    ) -> Result<Response<ChatbotDeleteConversationResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_conversation(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotDeleteConversationResponse {}))
    }

    async fn update_conversation_title(
        &self,
        req: Request<ChatbotUpdateConversationTitleRequest>,
    ) -> Result<Response<ChatbotUpdateConversationTitleResponse>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .update_conversation_title(&args.id, &args.title)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotUpdateConversationTitleResponse {}))
    }

    // ─── Message ─────────────────────────────────────────────────────────

    async fn append_user_message(
        &self,
        req: Request<ChatbotAppendUserMessageRequest>,
    ) -> Result<Response<ChatbotAppendUserMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        let message_id = self
            .manager
            .append_user_message(&args.conversation_id, &args.content)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotAppendUserMessageResponse {
            message_id,
        }))
    }

    async fn append_system_message(
        &self,
        req: Request<ChatbotAppendSystemMessageRequest>,
    ) -> Result<Response<ChatbotAppendSystemMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        let content = if args.content.is_empty() { None } else { Some(args.content) };
        let data_json = if args.data_json.is_empty() { None } else { Some(args.data_json) };
        let message_id = self
            .manager
            .append_system_message(&args.conversation_id, content, data_json)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotAppendSystemMessageResponse {
            message_id,
        }))
    }

    async fn list_messages(
        &self,
        req: Request<ChatbotListMessagesRequest>,
    ) -> Result<Response<ChatbotListMessagesResponse>, TonicStatus> {
        let conversation_id = req.into_inner().conversation_id;
        let messages = self
            .manager
            .list_messages(&conversation_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ChatbotListMessagesResponse {
            messages: messages.into_iter().map(message_to_pb).collect(),
        }))
    }

    // ─── 외부 endpoint 통합 entry ───────────────────────────────────────────

    async fn send_message(
        &self,
        req: Request<ChatbotSendMessageRequest>,
    ) -> Result<Response<ChatbotSendMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        if args.user_message.trim().is_empty() {
            return Err(TonicStatus::invalid_argument("user_message 가 비어있습니다."));
        }
        if args.session_id.trim().is_empty() {
            return Err(TonicStatus::invalid_argument("session_id 가 비어있습니다."));
        }

        // 1. 인증
        let origin = if args.origin.is_empty() { None } else { Some(args.origin.as_str()) };
        let instance = self
            .manager
            .authenticate(&args.slug, &args.api_token, origin)
            .await
            .map_err(TonicStatus::permission_denied)?;

        // 2. 대화 ensure
        let conversation_id = self
            .manager
            .ensure_conversation(&instance.id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;

        // 3. user 메시지 영속화 (선반영 — AI 실패해도 흐름 보존)
        let _ = self
            .manager
            .append_user_message(&conversation_id, &args.user_message)
            .await;

        // 4. AI 호출 (가드 + history + 영속화 통합)
        let response = self
            .manager
            .send_message(
                self.ai.clone(),
                &instance,
                &conversation_id,
                &args.user_message,
            )
            .await
            .map_err(TonicStatus::internal)?;

        // 5. raw_json 영역 직렬화 (admin chat 영역 동일 포맷)
        let raw_json = serde_json::to_string(&response).map_err(|e| {
            TonicStatus::internal(format!("AiResponse 직렬화 실패: {e}"))
        })?;

        Ok(Response::new(ChatbotSendMessageResponse {
            conversation_id,
            raw_json,
        }))
    }
}
