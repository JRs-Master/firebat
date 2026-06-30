//! gRPC HubService impl — HubManager wrapping.
//!
//! Hub Phase 1 (2026-05-17). 매 RPC unique Request / Response (Phase B-typed).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use std::pin::Pin;
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};

use crate::managers::ai::{AiManager, AiStreamEvent};
use crate::managers::hub::{HubManager, CreateInstanceInput, UpdateInstanceInput};
use crate::ports::HubInstance;
use crate::proto::{
    hub_stream_event_pb::Event as HubStreamEventOneof, AiChunkEventPb, AiErrorEventPb,
    AiResultEventPb, AiStepEventPb, HubSendMessageStreamRequest, HubStreamEventPb,
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
    HubRotateApiTokenRequest, HubRotateApiTokenResponse, HubSaveMessageRequest,
    HubSaveMessageResponse, HubSendMessageRequest,
    HubSendMessageResponse, HubUpdateConversationTitleRequest,
    HubUpdateConversationTitleResponse, HubUpdateInstanceRequest, HubUpdateInstanceResponse,
};

pub struct HubServiceImpl {
    manager: Arc<HubManager>,
    ai: Arc<AiManager>,
    /// MediaManager (옵션) — hub 대화 영구삭제 시 conv-scoped 첨부 미디어 cascade. 미설정 시 skip.
    media: Option<Arc<crate::managers::media::MediaManager>>,
}

impl HubServiceImpl {
    pub fn new(manager: Arc<HubManager>, ai: Arc<AiManager>) -> Self {
        Self {
            manager,
            ai,
            media: None,
        }
    }

    /// MediaManager 설정 — hub 대화 영구삭제 시 첨부 cascade 활성.
    pub fn with_media(mut self, media: Arc<crate::managers::media::MediaManager>) -> Self {
        self.media = Some(media);
        self
    }

    /// hub visitor 격리 — instance_id/session_id 지정 시 conv 의 그것과 모두 일치할 때만 통과.
    /// 둘 중 하나라도 빈 값/부재면 무검사(옛 호환). 불일치·conv 부재 = 권한 거부.
    /// 프론트(sessions route) ensureConvOwnership 가드 대신 core 단일 강제.
    async fn ensure_conv_owner(
        &self,
        conv_id: &str,
        instance_id: &Option<String>,
        session_id: &Option<String>,
    ) -> Result<(), TonicStatus> {
        let (Some(inst), Some(sess)) = (
            instance_id.as_deref().filter(|s| !s.is_empty()),
            session_id.as_deref().filter(|s| !s.is_empty()),
        ) else {
            return Ok(());
        };
        match self.manager.get_conversation(conv_id).await {
            Ok(Some(c)) if c.instance_id.as_str() == inst && c.session_id.as_str() == sess => Ok(()),
            Ok(_) => Err(TonicStatus::permission_denied(
                "이 대화에 접근할 권한이 없습니다.",
            )),
            Err(e) => Err(TonicStatus::internal(e)),
        }
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
        kind: i.kind,
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
            kind: args.kind,
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
            kind: args.kind,
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
        let args = req.into_inner();
        self.ensure_conv_owner(&args.id, &args.instance_id, &args.session_id)
            .await?;
        let id = args.id;
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
        let args = req.into_inner();
        self.ensure_conv_owner(&args.id, &args.instance_id, &args.session_id)
            .await?;
        self.manager
            .delete_conversation(&args.id)
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
        let args = req.into_inner();
        self.ensure_conv_owner(&args.id, &args.instance_id, &args.session_id)
            .await?;
        self.manager
            .restore_conversation(&args.id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubRestoreConversationResponse {}))
    }

    async fn permanent_delete_conversation(
        &self,
        req: Request<HubPermanentDeleteConversationRequest>,
    ) -> Result<Response<HubPermanentDeleteConversationResponse>, TonicStatus> {
        let args = req.into_inner();
        self.ensure_conv_owner(&args.id, &args.instance_id, &args.session_id)
            .await?;
        self.manager
            .permanent_delete_conversation(&args.id)
            .await
            .map_err(TonicStatus::internal)?;
        // cascade: hub 대화의 conv-scoped 첨부 미디어(TTS 오디오 등) 삭제 — best-effort.
        if let Some(media) = &self.media {
            if let Err(e) = media.delete_conv_attachments(&args.id).await {
                tracing::warn!(target: "media", "hub conv 첨부 cascade 삭제 실패 (conv={}): {e}", args.id);
            }
        }
        Ok(Response::new(HubPermanentDeleteConversationResponse {}))
    }

    async fn update_conversation_title(
        &self,
        req: Request<HubUpdateConversationTitleRequest>,
    ) -> Result<Response<HubUpdateConversationTitleResponse>, TonicStatus> {
        let args = req.into_inner();
        self.ensure_conv_owner(&args.id, &args.instance_id, &args.session_id)
            .await?;
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
            .append_user_message(&args.conversation_id, &args.content, None)
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
            .append_system_message(&args.conversation_id, content, data_json, None)
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
        let args = req.into_inner();
        self.ensure_conv_owner(&args.conversation_id, &args.instance_id, &args.session_id)
            .await?;
        let conversation_id = args.conversation_id;
        let messages = self
            .manager
            .list_messages(&conversation_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(HubListMessagesResponse {
            messages: messages.into_iter().map(message_to_pb).collect(),
        }))
    }

    async fn save_message(
        &self,
        req: Request<HubSaveMessageRequest>,
    ) -> Result<Response<HubSaveMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        // owner-scoped — instance/session 필수 + conv 소유 검증(cross-tenant 쓰기 차단).
        if args.instance_id.is_empty() || args.session_id.is_empty() {
            return Err(TonicStatus::invalid_argument(
                "instance_id/session_id 가 필요합니다.",
            ));
        }
        self.ensure_conv_owner(
            &args.conversation_id,
            &Some(args.instance_id.clone()),
            &Some(args.session_id.clone()),
        )
        .await?;
        let msg: serde_json::Value = serde_json::from_str(&args.message_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("message_json 파싱 실패: {e}")))?;
        let owner = format!("hub:{}:{}", args.instance_id, args.session_id);
        self.manager
            .persist_message(&owner, &args.conversation_id, &msg);
        Ok(Response::new(HubSaveMessageResponse {}))
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

        // 3. user/AI 메시지 영속화는 process_with_tools 단일 경로(send_message 내부)가 처리 — 여기서 따로 append 안 함.

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
                None, // ai_msg_id — unary HubSendMessage 는 클라 id 미동봉(uuid fallback)
                None, // user_msg_id — unary (uuid fallback)
                None, // unary — 스트리밍 emit 없음
            )
            .await
            .map_err(TonicStatus::internal)?;

        // 5. Serialize with the canonical `data` object — same single-source shape as admin chat.
        let raw_json = response.to_result_json();

        Ok(Response::new(HubSendMessageResponse {
            conversation_id,
            raw_json,
        }))
    }

    type SendMessageStreamStream =
        Pin<Box<dyn Stream<Item = Result<HubStreamEventPb, TonicStatus>> + Send + 'static>>;

    /// streaming 변형 — admin chat (AiService.StreamRequestActionWithTools) 과 동일한 이벤트 스트림.
    /// 인증 + 대화 ensure + user 메시지 영속화는 동기로 먼저, 그 다음 AI 호출(emit)을 spawn 해
    /// chunk/step/result 를 server-stream. hub plan mode 가 admin 과 같은 경로를 타 실행 카드 누락 차단.
    async fn send_message_stream(
        &self,
        req: Request<HubSendMessageStreamRequest>,
    ) -> Result<Response<Self::SendMessageStreamStream>, TonicStatus> {
        let args = req.into_inner();
        if args.user_message.trim().is_empty() {
            return Err(TonicStatus::invalid_argument("user_message 가 비어있습니다."));
        }
        if args.session_id.trim().is_empty() {
            return Err(TonicStatus::invalid_argument("session_id 가 비어있습니다."));
        }

        // 1. 인증 (origin/token/self-host — 익명 visitor 신뢰 불가, 반드시 server-side).
        let origin = if args.origin.is_empty() { None } else { Some(args.origin.as_str()) };
        let self_host = if args.self_host.is_empty() { None } else { Some(args.self_host.as_str()) };
        let instance = self
            .manager
            .authenticate(&args.slug, &args.api_token, origin, self_host)
            .await
            .map_err(TonicStatus::permission_denied)?;

        // 2. 대화 ensure. (영속은 process_with_tools 단일 경로가 처리 — append_user_message 제거.)
        let conversation_id = self
            .manager
            .ensure_conversation(&instance.id, &args.session_id)
            .await
            .map_err(TonicStatus::internal)?;
        // 클라이언트 발급 메시지 id — 프론트 로컬 메시지와 conversation rows 정렬(admin systemId 패턴). 빈 string = uuid fallback.
        // 영속 단일 경로(process_with_tools)에 ai_opts 로 주입돼 user/system 을 이 id 로 저장.
        let user_msg_id = if args.user_msg_id.is_empty() { None } else { Some(args.user_msg_id.clone()) };
        let ai_msg_id = if args.ai_msg_id.is_empty() { None } else { Some(args.ai_msg_id.clone()) };

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

        // 4. mpsc — AiManager 가 emit. capacity 256 (admin streaming 과 동일).
        let (event_tx, event_rx) = tokio::sync::mpsc::channel::<AiStreamEvent>(256);
        let (final_tx, mut final_rx) =
            tokio::sync::mpsc::channel::<Result<crate::managers::ai::AiResponse, String>>(1);

        let manager = self.manager.clone();
        let ai = self.ai.clone();
        let user_message = args.user_message.clone();
        tokio::spawn(async move {
            let res = manager
                .send_message(
                    ai,
                    &instance,
                    &conversation_id,
                    &user_message,
                    plan_mode,
                    plan_execute_id,
                    plan_revise_id,
                    ai_msg_id,
                    user_msg_id,
                    Some(event_tx),
                )
                .await;
            let _ = final_tx.send(res).await;
        });

        // 5. event stream → AiStreamEventPb (admin stream_request_action_with_tools 와 동일 매핑).
        let event_stream = ReceiverStream::new(event_rx).map(|evt| match evt {
            AiStreamEvent::Chunk { event_type, content } => Ok(HubStreamEventPb {
                event: Some(HubStreamEventOneof::Chunk(AiChunkEventPb { event_type, content })),
            }),
            AiStreamEvent::Step { name, status, description, error_message } => Ok(HubStreamEventPb {
                event: Some(HubStreamEventOneof::Step(AiStepEventPb {
                    name,
                    status,
                    description,
                    error_message,
                })),
            }),
        });

        let final_stream = async_stream::stream! {
            let mut event_stream = event_stream;
            while let Some(item) = event_stream.next().await {
                yield item;
            }
            match final_rx.recv().await {
                Some(Ok(response)) => {
                    let raw_json = response.to_result_json();
                    yield Ok(HubStreamEventPb {
                        event: Some(HubStreamEventOneof::Result(AiResultEventPb { raw_json })),
                    });
                }
                Some(Err(e)) => {
                    yield Ok(HubStreamEventPb {
                        event: Some(HubStreamEventOneof::Error(AiErrorEventPb { error_message: e })),
                    });
                }
                None => {
                    yield Ok(HubStreamEventPb {
                        event: Some(HubStreamEventOneof::Error(AiErrorEventPb {
                            error_message: "hub AI streaming final 채널 닫힘".to_string(),
                        })),
                    });
                }
            }
        };

        let pinned: Self::SendMessageStreamStream = Box::pin(final_stream);
        Ok(Response::new(pinned))
    }
}
