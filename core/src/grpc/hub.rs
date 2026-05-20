//! gRPC HubService impl — HubManager wrapping.
//!
//! Hub Phase 1 (2026-05-17). 매 RPC unique Request / Response (Phase B-typed).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::AiManager;
use crate::managers::hub::{HubManager, CreateInstanceInput, UpdateInstanceInput};
use crate::ports::HubInstance;
use crate::proto::{
    hub_service_server::HubService, HubAppendSystemMessageRequest,
    HubAppendSystemMessageResponse, HubAppendUserMessageRequest,
    HubAppendUserMessageResponse, HubAuthenticateRequest, HubAuthenticateResponse,
    HubConversationPb, HubCreateInstanceRequest, HubCreateInstanceResponse,
    HubDeleteConversationRequest, HubDeleteConversationResponse,
    HubCreateConversationRequest, HubCreateConversationResponse,
    HubDeleteInstanceRequest, HubDeleteInstanceResponse, HubEnsureConversationRequest,
    HubEnsureConversationResponse, HubGetConversationRequest,
    HubGetConversationResponse, HubGetInstanceBySlugRequest,
    HubGetInstanceBySlugResponse, HubGetInstanceRequest, HubGetInstanceResponse,
    HubInstancePb, HubListConversationsRequest, HubListConversationsResponse,
    HubListDeletedConversationsRequest, HubListDeletedConversationsResponse,
    HubListInstancesRequest, HubListInstancesResponse, HubListMessagesRequest,
    HubListMessagesResponse, HubMessagePb,
    HubPermanentDeleteConversationRequest, HubPermanentDeleteConversationResponse,
    HubRestoreConversationRequest, HubRestoreConversationResponse,
    HubRotateApiTokenRequest, HubRotateApiTokenResponse, HubSendMessageRequest,
    HubSendMessageResponse, HubUpdateConversationTitleRequest,
    HubUpdateConversationTitleResponse, HubUpdateInstanceRequest, HubUpdateInstanceResponse,
};

pub struct HubServiceImpl {
    manager: Arc<HubManager>,
    ai: Arc<AiManager>,
}

impl HubServiceImpl {
    pub fn new(manager: Arc<HubManager>, ai: Arc<AiManager>) -> Self {
        Self { manager, ai }
    }
}

// ─── 변환 헬퍼 ────────────────────────────────────────────────────────────

fn instance_to_pb(i: HubInstance) -> HubInstancePb {
    HubInstancePb {
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
        expose_widget: i.expose_widget,
        expose_page: i.expose_page,
    }
}

fn conversation_to_pb(c: crate::ports::HubConversation) -> HubConversationPb {
    HubConversationPb {
        id: c.id,
        instance_id: c.instance_id,
        session_id: c.session_id,
        title: c.title.unwrap_or_default(),
        created_at: c.created_at,
        updated_at: c.updated_at,
    }
}

fn message_to_pb(m: crate::ports::HubMessage) -> HubMessagePb {
    HubMessagePb {
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content.unwrap_or_default(),
        data_json: m.data_json.unwrap_or_default(),
        created_at: m.created_at,
    }
}

#[tonic::async_trait]
impl HubService for HubServiceImpl {
    // ─── Instance CRUD ────────────────────────────────────────────────────

    async fn create_instance(
        &self,
        req: Request<HubCreateInstanceRequest>,
    ) -> Result<Response<HubCreateInstanceResponse>, TonicStatus> {
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
            expose_widget: args.expose_widget,
            expose_page: args.expose_page,
        };
        let id = self
            .manager
            .create_instance(input)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(HubCreateInstanceResponse { id }))
    }

    async fn list_instances(
        &self,
        _req: Request<HubListInstancesRequest>,
    ) -> Result<Response<HubListInstancesResponse>, TonicStatus> {
        let instances = self
            .manager
            .list_instances()
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubListInstancesResponse {
            instances: instances.into_iter().map(instance_to_pb).collect(),
        }))
    }

    async fn get_instance(
        &self,
        req: Request<HubGetInstanceRequest>,
    ) -> Result<Response<HubGetInstanceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let instance = self
            .manager
            .get_instance(&id)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found(format!("instance \"{id}\" 가 없습니다.")))?;
        Ok(Response::new(HubGetInstanceResponse {
            instance: Some(instance_to_pb(instance)),
        }))
    }

    async fn get_instance_by_slug(
        &self,
        req: Request<HubGetInstanceBySlugRequest>,
    ) -> Result<Response<HubGetInstanceBySlugResponse>, TonicStatus> {
        let slug = req.into_inner().slug;
        let instance = self
            .manager
            .get_instance_by_slug(&slug)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found(format!("slug \"{slug}\" 가 없습니다.")))?;
        Ok(Response::new(HubGetInstanceBySlugResponse {
            instance: Some(instance_to_pb(instance)),
        }))
    }

    async fn update_instance(
        &self,
        req: Request<HubUpdateInstanceRequest>,
    ) -> Result<Response<HubUpdateInstanceResponse>, TonicStatus> {
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
            expose_widget: args.expose_widget,
            expose_page: args.expose_page,
        };
        self.manager
            .update_instance(&args.id, patch)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(HubUpdateInstanceResponse {}))
    }

    async fn delete_instance(
        &self,
        req: Request<HubDeleteInstanceRequest>,
    ) -> Result<Response<HubDeleteInstanceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_instance(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubDeleteInstanceResponse {}))
    }

    async fn rotate_api_token(
        &self,
        req: Request<HubRotateApiTokenRequest>,
    ) -> Result<Response<HubRotateApiTokenResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let new_token = self
            .manager
            .rotate_api_token(&id)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(HubRotateApiTokenResponse { new_token }))
    }

    // ─── 외부 endpoint 검증 ───────────────────────────────────────────────

    async fn authenticate(
        &self,
        req: Request<HubAuthenticateRequest>,
    ) -> Result<Response<HubAuthenticateResponse>, TonicStatus> {
        let args = req.into_inner();
        let origin = if args.origin.is_empty() { None } else { Some(args.origin.as_str()) };
        let self_host = if args.self_host.is_empty() { None } else { Some(args.self_host.as_str()) };
        let instance = self
            .manager
            .authenticate(&args.slug, &args.api_token, origin, self_host)
            .await
            .map_err(TonicStatus::permission_denied)?;
        Ok(Response::new(HubAuthenticateResponse {
            instance: Some(instance_to_pb(instance)),
        }))
    }

    // ─── Conversation ────────────────────────────────────────────────────

    async fn ensure_conversation(
        &self,
        req: Request<HubEnsureConversationRequest>,
    ) -> Result<Response<HubEnsureConversationResponse>, TonicStatus> {
        let args = req.into_inner();
        let conversation_id = self
            .manager
            .ensure_conversation(&args.instance_id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubEnsureConversationResponse {
            conversation_id,
        }))
    }

    async fn create_conversation(
        &self,
        req: Request<HubCreateConversationRequest>,
    ) -> Result<Response<HubCreateConversationResponse>, TonicStatus> {
        let args = req.into_inner();
        let conversation_id = self
            .manager
            .create_conversation(&args.instance_id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubCreateConversationResponse {
            conversation_id,
        }))
    }

    async fn list_conversations(
        &self,
        req: Request<HubListConversationsRequest>,
    ) -> Result<Response<HubListConversationsResponse>, TonicStatus> {
        let args = req.into_inner();
        let conversations = self
            .manager
            .list_conversations(&args.instance_id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubListConversationsResponse {
            conversations: conversations.into_iter().map(conversation_to_pb).collect(),
        }))
    }

    async fn get_conversation(
        &self,
        req: Request<HubGetConversationRequest>,
    ) -> Result<Response<HubGetConversationResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let conversation = self
            .manager
            .get_conversation(&id)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found(format!("conversation \"{id}\" 가 없습니다.")))?;
        Ok(Response::new(HubGetConversationResponse {
            conversation: Some(conversation_to_pb(conversation)),
        }))
    }

    async fn delete_conversation(
        &self,
        req: Request<HubDeleteConversationRequest>,
    ) -> Result<Response<HubDeleteConversationResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_conversation(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubDeleteConversationResponse {}))
    }

    async fn list_deleted_conversations(
        &self,
        req: Request<HubListDeletedConversationsRequest>,
    ) -> Result<Response<HubListDeletedConversationsResponse>, TonicStatus> {
        let args = req.into_inner();
        let conversations = self
            .manager
            .list_deleted_conversations(&args.instance_id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubListDeletedConversationsResponse {
            conversations: conversations.into_iter().map(conversation_to_pb).collect(),
        }))
    }

    async fn restore_conversation(
        &self,
        req: Request<HubRestoreConversationRequest>,
    ) -> Result<Response<HubRestoreConversationResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .restore_conversation(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubRestoreConversationResponse {}))
    }

    async fn permanent_delete_conversation(
        &self,
        req: Request<HubPermanentDeleteConversationRequest>,
    ) -> Result<Response<HubPermanentDeleteConversationResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .permanent_delete_conversation(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubPermanentDeleteConversationResponse {}))
    }

    async fn update_conversation_title(
        &self,
        req: Request<HubUpdateConversationTitleRequest>,
    ) -> Result<Response<HubUpdateConversationTitleResponse>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .update_conversation_title(&args.id, &args.title)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubUpdateConversationTitleResponse {}))
    }

    // ─── Message ─────────────────────────────────────────────────────────

    async fn append_user_message(
        &self,
        req: Request<HubAppendUserMessageRequest>,
    ) -> Result<Response<HubAppendUserMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        let message_id = self
            .manager
            .append_user_message(&args.conversation_id, &args.content)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubAppendUserMessageResponse {
            message_id,
        }))
    }

    async fn append_system_message(
        &self,
        req: Request<HubAppendSystemMessageRequest>,
    ) -> Result<Response<HubAppendSystemMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        let content = if args.content.is_empty() { None } else { Some(args.content) };
        let data_json = if args.data_json.is_empty() { None } else { Some(args.data_json) };
        let message_id = self
            .manager
            .append_system_message(&args.conversation_id, content, data_json)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubAppendSystemMessageResponse {
            message_id,
        }))
    }

    async fn list_messages(
        &self,
        req: Request<HubListMessagesRequest>,
    ) -> Result<Response<HubListMessagesResponse>, TonicStatus> {
        let conversation_id = req.into_inner().conversation_id;
        let messages = self
            .manager
            .list_messages(&conversation_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubListMessagesResponse {
            messages: messages.into_iter().map(message_to_pb).collect(),
        }))
    }

    // ─── 외부 endpoint 통합 entry ───────────────────────────────────────────

    async fn send_message(
        &self,
        req: Request<HubSendMessageRequest>,
    ) -> Result<Response<HubSendMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        if args.user_message.trim().is_empty() {
            return Err(TonicStatus::invalid_argument("user_message 가 비어있습니다."));
        }
        if args.session_id.trim().is_empty() {
            return Err(TonicStatus::invalid_argument("session_id 가 비어있습니다."));
        }

        // 1. 인증
        let origin = if args.origin.is_empty() { None } else { Some(args.origin.as_str()) };
        let self_host = if args.self_host.is_empty() { None } else { Some(args.self_host.as_str()) };
        let instance = self
            .manager
            .authenticate(&args.slug, &args.api_token, origin, self_host)
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

        // 4. AI 호출 (가드 + history + 영속화 통합). visitor 의 plan_mode + plan_execute_id /
        // plan_revise_id 영역 전파.
        let plan_mode = match args.plan_mode.as_str() {
            "always" => crate::ports::PlanMode::Always,
            "auto" => crate::ports::PlanMode::Auto,
            _ => crate::ports::PlanMode::Off,
        };
        let plan_execute_id = if args.plan_execute_id.is_empty() {
            None
        } else {
            Some(args.plan_execute_id.clone())
        };
        let plan_revise_id = if args.plan_revise_id.is_empty() {
            None
        } else {
            Some(args.plan_revise_id.clone())
        };
        let response = self
            .manager
            .send_message(
                self.ai.clone(),
                &instance,
                &conversation_id,
                &args.user_message,
                plan_mode,
                plan_execute_id,
                plan_revise_id,
            )
            .await
            .map_err(TonicStatus::internal)?;

        // 5. raw_json 영역 직렬화 (admin chat 영역 동일 포맷)
        let raw_json = serde_json::to_string(&response).map_err(|e| {
            TonicStatus::internal(format!("AiResponse 직렬화 실패: {e}"))
        })?;

        Ok(Response::new(HubSendMessageResponse {
            conversation_id,
            raw_json,
        }))
    }
}
