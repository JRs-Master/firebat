//! gRPC TelegramService impl — Bot API wrapper.
//!
//! Phase B-17.5b minimum:
//! - SetupWebhook / RemoveWebhook / GetWebhookStatus — Telegram Bot API setWebhook 호출
//! - IsOwner — Vault `system:telegram:owner-id` chat_id whitelist 매칭
//! - ProcessMessage — webhook payload 파싱 (Phase B-17+ AiManager 연동 후 활성)
//!
//! 매 RPC unique Request / Response — buf STANDARD 정공.
//! 옛 공유 타입 (StringRequest / BoolRequest / RawJsonPb / Empty) 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::AiManager;
use crate::managers::module::ModuleManager;
use crate::ports::{INetworkPort, IVaultPort, NetworkRequest};
use crate::proto::{
    telegram_service_server::TelegramService, TelegramGetWebhookSecretRequest,
    TelegramGetWebhookSecretResponse, TelegramGetWebhookStatusRequest,
    TelegramGetWebhookStatusResponse, TelegramIsOwnerRequest, TelegramIsOwnerResponse,
    TelegramProcessMessageRequest, TelegramProcessMessageResponse, TelegramRemoveWebhookRequest,
    TelegramRemoveWebhookResponse, TelegramSetupWebhookRequest, TelegramSetupWebhookResponse,
};

pub struct TelegramServiceImpl {
    vault: Arc<dyn IVaultPort>,
    /// HTTP — Telegram Bot API 호출 (옛 reqwest 직접 의존 → INetworkPort 위임, 2026-05-06 audit A5).
    network: Arc<dyn INetworkPort>,
    /// AiManager (옵션) — 설정되어 있으면 process_message webhook → AI → reply 활성.
    ai: Option<Arc<AiManager>>,
    /// ModuleManager (옵션) — sysmod_telegram 으로 reply 발송. ai 와 같이 설정되어야 의미 있음.
    module: Option<Arc<ModuleManager>>,
}

impl TelegramServiceImpl {
    pub fn new(vault: Arc<dyn IVaultPort>, network: Arc<dyn INetworkPort>) -> Self {
        Self {
            vault,
            network,
            ai: None,
            module: None,
        }
    }

    /// AiManager + ModuleManager 설정한 채로 부팅 — process_message 활성.
    pub fn with_ai_and_module(mut self, ai: Arc<AiManager>, module: Arc<ModuleManager>) -> Self {
        self.ai = Some(ai);
        self.module = Some(module);
        self
    }

    fn bot_token(&self) -> Option<String> {
        self.vault
            .get_secret("user:TELEGRAM_BOT_TOKEN")
            .filter(|v| !v.is_empty())
    }

    fn webhook_secret(&self) -> String {
        self.vault
            .get_secret("system:telegram:webhook-secret")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                // 신규 발급 — 32자 random hex
                let mut bytes = [0u8; 16];
                use rand::RngCore;
                rand::thread_rng().fill_bytes(&mut bytes);
                let secret: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
                self.vault
                    .set_secret("system:telegram:webhook-secret", &secret);
                secret
            })
    }
}

fn to_raw(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl TelegramService for TelegramServiceImpl {
    async fn setup_webhook(
        &self,
        req: Request<TelegramSetupWebhookRequest>,
    ) -> Result<Response<TelegramSetupWebhookResponse>, TonicStatus> {
        let webhook_url = req.into_inner().webhook_url;
        let token = self
            .bot_token()
            .ok_or_else(|| {
                TonicStatus::failed_precondition(crate::i18n::t(
                    "core.error.telegram.bot_token_missing",
                    None,
                    &[],
                ))
            })?;
        let secret = self.webhook_secret();

        let endpoint = format!("https://api.telegram.org/bot{}/setWebhook", token);
        let resp = self
            .network
            .fetch(NetworkRequest {
                url: endpoint,
                method: "POST".to_string(),
                headers: None,
                body: Some(serde_json::json!({
                    "url": webhook_url,
                    "secret_token": secret,
                    "drop_pending_updates": true,
                })),
                timeout_ms: 30_000,
            })
            .await
            .map_err(|e| TonicStatus::internal(format!("Telegram setWebhook: {e}")))?;
        Ok(Response::new(TelegramSetupWebhookResponse {
            raw_json: to_raw(&resp.body),
        }))
    }

    async fn remove_webhook(
        &self,
        _req: Request<TelegramRemoveWebhookRequest>,
    ) -> Result<Response<TelegramRemoveWebhookResponse>, TonicStatus> {
        let token = self
            .bot_token()
            .ok_or_else(|| {
                TonicStatus::failed_precondition(crate::i18n::t(
                    "core.error.telegram.bot_token_missing",
                    None,
                    &[],
                ))
            })?;
        let endpoint = format!("https://api.telegram.org/bot{}/deleteWebhook", token);
        let resp = self
            .network
            .fetch(NetworkRequest {
                url: endpoint,
                method: "POST".to_string(),
                headers: None,
                body: None,
                timeout_ms: 30_000,
            })
            .await
            .map_err(|e| TonicStatus::internal(format!("Telegram deleteWebhook: {e}")))?;
        Ok(Response::new(TelegramRemoveWebhookResponse {
            raw_json: to_raw(&resp.body),
        }))
    }

    async fn get_webhook_status(
        &self,
        _req: Request<TelegramGetWebhookStatusRequest>,
    ) -> Result<Response<TelegramGetWebhookStatusResponse>, TonicStatus> {
        let token = self
            .bot_token()
            .ok_or_else(|| {
                TonicStatus::failed_precondition(crate::i18n::t(
                    "core.error.telegram.bot_token_missing",
                    None,
                    &[],
                ))
            })?;
        let endpoint = format!("https://api.telegram.org/bot{}/getWebhookInfo", token);
        let resp = self
            .network
            .fetch(NetworkRequest {
                url: endpoint,
                method: "GET".to_string(),
                headers: None,
                body: None,
                timeout_ms: 30_000,
            })
            .await
            .map_err(|e| TonicStatus::internal(format!("Telegram getWebhookInfo: {e}")))?;
        Ok(Response::new(TelegramGetWebhookStatusResponse {
            raw_json: to_raw(&resp.body),
        }))
    }

    async fn is_owner(
        &self,
        req: Request<TelegramIsOwnerRequest>,
    ) -> Result<Response<TelegramIsOwnerResponse>, TonicStatus> {
        let chat_id = req.into_inner().chat_id;
        let owner = self
            .vault
            .get_secret("system:telegram:owner-id")
            .unwrap_or_default();
        Ok(Response::new(TelegramIsOwnerResponse {
            is_owner: !owner.is_empty() && owner == chat_id,
        }))
    }

    async fn get_webhook_secret(
        &self,
        _req: Request<TelegramGetWebhookSecretRequest>,
    ) -> Result<Response<TelegramGetWebhookSecretResponse>, TonicStatus> {
        let secret = self.webhook_secret();
        Ok(Response::new(TelegramGetWebhookSecretResponse {
            raw_json: to_raw(&serde_json::json!({"secret": secret})),
        }))
    }

    async fn process_message(
        &self,
        req: Request<TelegramProcessMessageRequest>,
    ) -> Result<Response<TelegramProcessMessageResponse>, TonicStatus> {
        let args = req.into_inner();
        let chat_id_str = args.chat_id;

        let (Some(ai), Some(module)) = (&self.ai, &self.module) else {
            return Ok(Response::new(TelegramProcessMessageResponse {
                raw_json: to_raw(&serde_json::json!({
                    "success": false,
                    "error": crate::i18n::t("core.error.telegram.ai_manager_unset", None, &[])
                })),
            }));
        };

        // 1. AI 호출 (history 없음, stateless — 옛 TS 1:1)
        let llm_opts = crate::ports::LlmCallOpts::default();
        let ai_opts = crate::ports::AiRequestOpts::default();
        let ai_res = ai
            .process_with_tools_opts(&args.text, &[], &llm_opts, &ai_opts)
            .await;
        let response = match ai_res {
            Ok(r) => r,
            Err(e) => {
                return Ok(Response::new(TelegramProcessMessageResponse {
                    raw_json: to_raw(&serde_json::json!({
                        "success": false,
                        "error": crate::i18n::t(
                            "core.error.telegram.ai_reply_failed",
                            None,
                            &[("detail", &e.to_string())],
                        )
                    })),
                }));
            }
        };
        let reply = response.reply.trim().to_string();
        if reply.is_empty() {
            return Ok(Response::new(TelegramProcessMessageResponse {
                raw_json: to_raw(&serde_json::json!({
                    "success": false,
                    "error": crate::i18n::t("core.error.telegram.ai_reply_empty", None, &[])
                })),
            }));
        }

        // 2. sysmod_telegram send-message 로 응답 (chatId 명시) — 옛 TS 1:1.
        // 4000자 cap (텔레그램 4096 한도 + 여유 96).
        let trimmed_reply: String = reply.chars().take(4000).collect();
        let send_input = serde_json::json!({
            "action": "send-message",
            "chatId": chat_id_str,
            "text": trimmed_reply,
        });
        let send_res = module
            .execute(
                "system/modules/telegram/index.mjs",
                &send_input,
                &crate::ports::SandboxExecuteOpts::default(),
            )
            .await;
        match send_res {
            Ok(_) => Ok(Response::new(TelegramProcessMessageResponse {
                raw_json: to_raw(&serde_json::json!({
                    "success": true,
                    "reply": reply,
                })),
            })),
            Err(e) => Ok(Response::new(TelegramProcessMessageResponse {
                raw_json: to_raw(&serde_json::json!({
                    "success": false,
                    "error": crate::i18n::t(
                        "core.error.telegram.send_failed",
                        None,
                        &[("detail", &e.to_string())],
                    )
                })),
            })),
        }
    }
}
