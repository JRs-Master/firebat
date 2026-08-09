//! gRPC AiService impl — AiManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! 2026-05-15: 옛 공유 타입 (Empty / BoolRequest / StringRequest / RawJsonPb / AiTextResultPb)
//! → RPC 별 unique Request/Response 분리 (buf STANDARD lint RPC_REQUEST_RESPONSE_UNIQUE).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::{AiManager, AiStreamEvent};
use crate::ports::{LlmCallOpts, ToolDefinition};
use crate::proto::{
    ai_service_server::AiService, ai_stream_event_pb::Event as AiStreamEventOneof,
    AiCancelTurnRequest, AiCancelTurnResponse, AiChunkEventPb, AiCodeAssistRequest, AiCodeAssistResponse, AiConsumePendingRequest,
    AiConsumePendingResponse, AiCreatePendingRequest, AiCreatePendingResponse,
    AiErrorEventPb, AiGetPendingRequest, AiGetPendingResponse, AiIsSubAgentEnabledRequest,
    AiListPendingRequest, AiListPendingResponse,
    AiIsSubAgentEnabledResponse, AiProcessRequest, AiProcessResponse, AiRejectPendingRequest,
    AiRejectPendingResponse, AiRequestActionWithToolsRequest, AiRequestActionWithToolsResponse,
    AiResolveCallTargetRequest, AiResolveCallTargetResponse, AiResultEventPb,
    AiRunAgentJobRequest, AiRunAgentJobResponse, AiSetSubAgentEnabledRequest,
    AiSetSubAgentEnabledResponse, AiSpawnSubAgentRequest, AiSpawnSubAgentResponse,
    AiStepEventPb, AiStorePlanRequest, AiStorePlanResponse, AiStreamEventPb, AiTurnStatusRequest,
    AiTurnStatusResponse,
    AiStreamRequestActionWithToolsRequest,
};
use std::pin::Pin;
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};

pub struct AiServiceImpl {
    manager: Arc<AiManager>,
}

impl AiServiceImpl {
    pub fn new(manager: Arc<AiManager>) -> Self {
        Self { manager }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// LlmCallOptsPb (string opts_json) → LlmCallOpts struct. None / empty 면 default.
fn parse_opts(opts: Option<crate::proto::LlmCallOptsPb>) -> LlmCallOpts {
    opts.and_then(|o| {
        if o.opts_json.is_empty() {
            None
        } else {
            serde_json::from_str(&o.opts_json).ok()
        }
    })
    .unwrap_or_default()
}

/// 같은 opts_json 안에 들어간 AiRequestOpts 필드 (planMode / planExecuteId / planReviseId / owner /
/// conversationId / hubContext 등) 추출. frontend 가 LlmCallOpts + AiRequestOpts 를 단일 JSON 으로
/// 보내기 때문에 양쪽 동시 parse 필요. unknown field 는 serde 가 자연 무시.
fn parse_ai_opts(opts: Option<&crate::proto::LlmCallOptsPb>) -> crate::ports::AiRequestOpts {
    opts.and_then(|o| {
        if o.opts_json.is_empty() {
            None
        } else {
            serde_json::from_str::<crate::ports::AiRequestOpts>(&o.opts_json).ok()
        }
    })
    .unwrap_or_default()
}

/// ToolDefinitionsPb (string tools_json) → Vec<ToolDefinition>. None / empty 면 빈 배열.
fn parse_tools(tools: Option<crate::proto::ToolDefinitionsPb>) -> Vec<ToolDefinition> {
    tools
        .and_then(|t| {
            if t.tools_json.is_empty() {
                None
            } else {
                serde_json::from_str(&t.tools_json).ok()
            }
        })
        .unwrap_or_default()
}

#[tonic::async_trait]
impl AiService for AiServiceImpl {
    async fn process(
        &self,
        req: Request<AiProcessRequest>,
    ) -> Result<Response<AiProcessResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts = parse_opts(args.opts);
        match self.manager.ask_text(&args.prompt, &opts).await {
            Ok(text) => Ok(Response::new(AiProcessResponse { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn request_action_with_tools(
        &self,
        req: Request<AiRequestActionWithToolsRequest>,
    ) -> Result<Response<AiRequestActionWithToolsResponse>, TonicStatus> {
        let args = req.into_inner();
        let mut ai_opts = parse_ai_opts(args.opts.as_ref());
        let opts = parse_opts(args.opts);
        let tools = parse_tools(args.tools);
        // LlmCallOpts.plan_mode → AiRequestOpts.plan_mode 동기화 (parse_ai_opts 가 못 잡은 경우 fallback).
        if matches!(ai_opts.plan_mode, crate::ports::PlanMode::Off) {
            ai_opts.plan_mode = opts.plan_mode;
        }
        match self
            .manager
            .process_with_tools_opts(&args.prompt, &tools, &opts, &ai_opts)
            .await
        {
            Ok(response) => Ok(Response::new(AiRequestActionWithToolsResponse {
                raw_json: response.to_result_json(),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    type StreamRequestActionWithToolsStream =
        Pin<Box<dyn Stream<Item = Result<AiStreamEventPb, TonicStatus>> + Send + 'static>>;

    /// 진짜 streaming RPC — 매 turn reasoning chunk / 도구 호출 step / 최종 result event 를
    /// server-stream 으로 보냄. AiManager.process_with_tools_opts_with_emit 안 mpsc 채널을 통해 →
    /// 본 fn 가 ReceiverStream 통해 tonic Stream 변환.
    async fn stream_request_action_with_tools(
        &self,
        req: Request<AiStreamRequestActionWithToolsRequest>,
    ) -> Result<Response<Self::StreamRequestActionWithToolsStream>, TonicStatus> {
        let args = req.into_inner();
        let mut ai_opts = parse_ai_opts(args.opts.as_ref());
        let opts = parse_opts(args.opts);
        let tools = parse_tools(args.tools);
        let prompt = args.prompt.clone();
        // LlmCallOpts.plan_mode → AiRequestOpts.plan_mode 동기화 (parse_ai_opts 가 못 잡은 경우 fallback).
        if matches!(ai_opts.plan_mode, crate::ports::PlanMode::Off) {
            ai_opts.plan_mode = opts.plan_mode;
        }

        // mpsc 채널 — AiManager 가 emit 호출. capacity = 256 (chunk buffer).
        let (event_tx, event_rx) = tokio::sync::mpsc::channel::<AiStreamEvent>(256);
        // 최종 result / error 영역 채널 — process_with_tools_opts_with_emit 의 InfraResult 받음.
        let (final_tx, mut final_rx) =
            tokio::sync::mpsc::channel::<Result<crate::managers::ai::AiResponse, String>>(1);

        let manager = self.manager.clone();
        // 턴 id — 프론트가 발급한 `aiMsgId`. 이게 있어야 사용자가 중지를 눌렀을 때 **이 턴**을
        // 지목해 끊을 수 있다(크론·에이전트 턴은 없으므로 취소 대상이 아니다).
        let turn_id = ai_opts.ai_msg_id.clone();
        // 등록 실패 = 같은 턴 id 가 이미 실행 중(중복 전송) → 두 번째는 돌리지 않는다.
        // 옛엔 그대로 돌아 같은 id 로 답을 덮어써서 사용자 눈앞에서 답이 바뀌었다(실측).
        let (cancel_rx, duplicate) = match turn_id.as_deref() {
            Some(id) => match manager.register_cancel(id) {
                Some(rx) => (Some(rx), false),
                None => (None, true),
            },
            None => (None, false),
        };
        tokio::spawn(async move {
            let opts_local = opts;
            let ai_opts_local = ai_opts;
            let run = manager.process_with_tools_opts_with_emit(
                &prompt,
                &tools,
                &opts_local,
                &ai_opts_local,
                Some(event_tx),
            );
            // 중지 = 턴 future 를 **drop** 한다. SSE 끊김과 달리 사용자가 명시적으로 누른 신호라,
            // drop 이 곧 CLI 자식 kill(kill_on_drop)이고 영속 단계에 도달하지 않아 유령 답도 안 남는다.
            if duplicate {
                let _ = final_tx
                    .send(Err("같은 요청이 이미 처리 중입니다 — 중복 실행을 막았습니다.".to_string()))
                    .await;
                return;
            }
            let res = match cancel_rx {
                Some(mut rx) => {
                    tokio::select! {
                        r = run => r,
                        _ = rx.changed() => {
                            Err("turn cancelled by user".to_string())
                        }
                    }
                }
                None => run.await,
            };
            if let Some(id) = &turn_id {
                manager.unregister_cancel(id);
            }
            let _ = final_tx.send(res).await;
        });

        // ReceiverStream 통해 매 event → AiStreamEventPb 매핑. 마지막에 final_rx 의 result/error 가 들어감.
        let event_stream = ReceiverStream::new(event_rx).map(|evt| match evt {
            AiStreamEvent::Chunk { event_type, content } => {
                Ok(AiStreamEventPb {
                    event: Some(AiStreamEventOneof::Chunk(AiChunkEventPb { event_type, content })),
                })
            }
            AiStreamEvent::Step { name, status, description, error_message } => {
                Ok(AiStreamEventPb {
                    event: Some(AiStreamEventOneof::Step(AiStepEventPb {
                        name,
                        status,
                        description,
                        error_message,
                    })),
                })
            }
        });

        // final_rx 를 stream 끝에 붙임. 옛 event_stream 종료 후 final result event 가 들어감.
        let final_stream = async_stream::stream! {
            // event channel 영역 닫힐 때까지 그대로 emit.
            let mut event_stream = event_stream;
            while let Some(item) = event_stream.next().await {
                yield item;
            }
            // 종료 후 final result / error event 발행.
            match final_rx.recv().await {
                Some(Ok(response)) => {
                    yield Ok(AiStreamEventPb {
                        event: Some(AiStreamEventOneof::Result(AiResultEventPb {
                            raw_json: response.to_result_json(),
                        })),
                    });
                }
                Some(Err(e)) => {
                    yield Ok(AiStreamEventPb {
                        event: Some(AiStreamEventOneof::Error(AiErrorEventPb {
                            error_message: e,
                        })),
                    });
                }
                None => {
                    // final channel closed without value — internal error.
                    yield Ok(AiStreamEventPb {
                        event: Some(AiStreamEventOneof::Error(AiErrorEventPb {
                            error_message: "AI streaming 영역 final result 채널 닫힘".to_string(),
                        })),
                    });
                }
            }
        };

        let pinned: Self::StreamRequestActionWithToolsStream = Box::pin(final_stream);
        Ok(Response::new(pinned))
    }

    async fn code_assist(
        &self,
        req: Request<AiCodeAssistRequest>,
    ) -> Result<Response<AiCodeAssistResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts = parse_opts(args.opts);
        match self.manager.ask_text(&args.prompt, &opts).await {
            Ok(text) => Ok(Response::new(AiCodeAssistResponse { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn run_agent_job(
        &self,
        req: Request<AiRunAgentJobRequest>,
    ) -> Result<Response<AiRunAgentJobResponse>, TonicStatus> {
        let args = req.into_inner();
        if args.agent_prompt.trim().is_empty() {
            return Ok(Response::new(AiRunAgentJobResponse {
                raw_json: to_raw_json(&serde_json::json!({
                    "success": false,
                    "error": crate::i18n::t("core.error.ai.agent_prompt_empty", None, &[])
                })),
            }));
        }
        let llm_opts = LlmCallOpts {
            model: args.model.clone(),
            ..Default::default()
        };
        let ai_opts = crate::ports::AiRequestOpts {
            owner: Some("admin".to_string()),
            cron_agent: Some(crate::ports::CronAgentOpts {
                job_id: args.job_id.clone(),
                title: args.title,
            }),
            model: args.model,
            ..Default::default()
        };
        // "Run now" from the panel runs with the JOB's identity, scoped to this execution —
        // the standing the schedule's approval gave it, and nothing beyond this future.
        match crate::utils::cron_context::scope(
            args.job_id.clone(),
            self.manager
                .process_with_tools_opts(&args.agent_prompt, &[], &llm_opts, &ai_opts),
        )
        .await
        {
            Ok(res) => Ok(Response::new(AiRunAgentJobResponse {
                raw_json: to_raw_json(&serde_json::json!({
                    "success": res.error.is_none(),
                    "reply": res.reply,
                    "executedActions": res.executed_actions,
                    "blocks": res.blocks,
                    "error": res.error,
                })),
            })),
            Err(e) => Ok(Response::new(AiRunAgentJobResponse {
                raw_json: to_raw_json(&serde_json::json!({
                    "success": false,
                    "error": e,
                })),
            })),
        }
    }

    async fn resolve_call_target(
        &self,
        req: Request<AiResolveCallTargetRequest>,
    ) -> Result<Response<AiResolveCallTargetResponse>, TonicStatus> {
        let identifier = req.into_inner().identifier;
        Ok(Response::new(AiResolveCallTargetResponse {
            raw_json: to_raw_json(&serde_json::json!({
                "identifier": identifier,
                "kind": serde_json::Value::Null,
                "note": crate::i18n::t("core.error.ai.tool_dispatcher_unready", None, &[])
            })),
        }))
    }

    async fn cancel_turn(
        &self,
        req: Request<AiCancelTurnRequest>,
    ) -> Result<Response<AiCancelTurnResponse>, TonicStatus> {
        let turn_id = req.into_inner().turn_id;
        let cancelled = !turn_id.is_empty() && self.manager.cancel_turn(&turn_id);
        Ok(Response::new(AiCancelTurnResponse { cancelled }))
    }

    async fn turn_status(
        &self,
        req: Request<AiTurnStatusRequest>,
    ) -> Result<Response<AiTurnStatusResponse>, TonicStatus> {
        let turn_id = req.into_inner().turn_id;
        let running = !turn_id.is_empty() && self.manager.is_turn_running(&turn_id);
        Ok(Response::new(AiTurnStatusResponse { running }))
    }

    async fn spawn_sub_agent(
        &self,
        req: Request<AiSpawnSubAgentRequest>,
    ) -> Result<Response<AiSpawnSubAgentResponse>, TonicStatus> {
        let args = req.into_inner();
        let llm_opts = LlmCallOpts {
            model: args.model,
            ..Default::default()
        };
        match self
            .manager
            .process_with_tools(&args.prompt, &[], &llm_opts)
            .await
        {
            Ok(res) => Ok(Response::new(AiSpawnSubAgentResponse {
                raw_json: to_raw_json(&res),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn is_sub_agent_enabled(
        &self,
        _req: Request<AiIsSubAgentEnabledRequest>,
    ) -> Result<Response<AiIsSubAgentEnabledResponse>, TonicStatus> {
        Ok(Response::new(AiIsSubAgentEnabledResponse {
            enabled: self.manager.is_sub_agent_enabled(),
        }))
    }

    async fn set_sub_agent_enabled(
        &self,
        req: Request<AiSetSubAgentEnabledRequest>,
    ) -> Result<Response<AiSetSubAgentEnabledResponse>, TonicStatus> {
        self.manager.set_sub_agent_enabled(req.into_inner().enabled);
        Ok(Response::new(AiSetSubAgentEnabledResponse {}))
    }

    // ── Pending tools (옛 TS lib/pending-tools.ts 통합) ────────────────────
    async fn create_pending(
        &self,
        req: Request<AiCreatePendingRequest>,
    ) -> Result<Response<AiCreatePendingResponse>, TonicStatus> {
        let args = req.into_inner();
        let raw_args: serde_json::Value = if args.args_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args.args_json).map_err(|e| {
                TonicStatus::invalid_argument(crate::i18n::t(
                    "core.error.ai.args_json_parse_failed",
                    None,
                    &[("detail", &e.to_string())],
                ))
            })?
        };
        let typed = crate::utils::pending_tools::PendingActionArgs::from_call(&args.name, &raw_args)
            .map_err(TonicStatus::invalid_argument)?;
        let plan_id = crate::utils::pending_tools::create_pending(typed, &args.summary);
        Ok(Response::new(AiCreatePendingResponse { plan_id }))
    }

    async fn get_pending(
        &self,
        req: Request<AiGetPendingRequest>,
    ) -> Result<Response<AiGetPendingResponse>, TonicStatus> {
        let plan_id = req.into_inner().plan_id;
        let result = crate::utils::pending_tools::get_pending(&plan_id);
        Ok(Response::new(AiGetPendingResponse {
            raw_json: to_raw_json(&result),
        }))
    }

    /// Cards still waiting, for the screen that lets a person find them. A card created outside a
    /// chat — an editor's MCP client, the CLI — was written to the store and then had nowhere to be
    /// seen, because the only handle on it was a `planId` that lived in the chat message.
    async fn list_pending(
        &self,
        req: Request<AiListPendingRequest>,
    ) -> Result<Response<AiListPendingResponse>, TonicStatus> {
        let scope = req.into_inner().hub_scope;
        let scope = if scope.trim().is_empty() { None } else { Some(scope) };
        let items = crate::utils::pending_tools::list_pending(scope.as_deref());
        Ok(Response::new(AiListPendingResponse {
            raw_json: to_raw_json(&items),
        }))
    }

    async fn consume_pending(
        &self,
        req: Request<AiConsumePendingRequest>,
    ) -> Result<Response<AiConsumePendingResponse>, TonicStatus> {
        let plan_id = req.into_inner().plan_id;
        let result = crate::utils::pending_tools::consume_pending(&plan_id);
        Ok(Response::new(AiConsumePendingResponse {
            raw_json: to_raw_json(&result),
        }))
    }

    async fn reject_pending(
        &self,
        req: Request<AiRejectPendingRequest>,
    ) -> Result<Response<AiRejectPendingResponse>, TonicStatus> {
        let plan_id = req.into_inner().plan_id;
        let had = crate::utils::pending_tools::reject_pending(&plan_id);
        Ok(Response::new(AiRejectPendingResponse { had }))
    }

    // ── Plan store (옛 TS lib/plan-store.ts 통합) ──────────────────────────
    async fn store_plan(
        &self,
        req: Request<AiStorePlanRequest>,
    ) -> Result<Response<AiStorePlanResponse>, TonicStatus> {
        let args = req.into_inner();
        let steps: Vec<crate::utils::plan_store::PlanStep> = args
            .steps
            .into_iter()
            .filter_map(|s| {
                if s.step_json.is_empty() {
                    None
                } else {
                    serde_json::from_str(&s.step_json).ok()
                }
            })
            .collect();
        let risks = if args.risks.is_empty() {
            None
        } else {
            Some(args.risks)
        };
        crate::utils::plan_store::store_plan(crate::utils::plan_store::PlanInsert {
            plan_id: args.plan_id,
            title: args.title,
            steps,
            estimated_time: args.estimated_time,
            risks,
        });
        Ok(Response::new(AiStorePlanResponse {}))
    }
}

// Tests 이관 — `infra/tests/svc_ai_test.rs` (integration test).
