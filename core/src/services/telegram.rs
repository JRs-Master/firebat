//! gRPC TelegramService impl — Bot API wrapper.
//!
//! Phase B-17.5b minimum:
//! - SetupWebhook / RemoveWebhook / GetWebhookStatus — Telegram Bot API setWebhook 호출
//! - IsOwner — Vault `system:telegram:owner-id` chat_id whitelist 매칭
//! - ProcessMessage — webhook payload 파싱 (Phase B-17+ AiManager 연동 후 활성)

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::utils::http_client::http_client;
use crate::managers::ai::AiManager;
use crate::managers::module::ModuleManager;
use crate::ports::IVaultPort;
use crate::proto::{
    telegram_service_server::TelegramService, BoolRequest, Empty, JsonArgs, JsonValue,
    StringRequest,
};

pub struct TelegramServiceImpl {
    vault: Arc<dyn IVaultPort>,
    /// AiManager (옵션) — 박혀있으면 process_message webhook → AI → reply 활성.
    ai: Option<Arc<AiManager>>,
    /// ModuleManager (옵션) — sysmod_telegram 으로 reply 발송. ai 와 같이 박혀야 의미 있음.
    module: Option<Arc<ModuleManager>>,
}

impl TelegramServiceImpl {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            vault,
            ai: None,
            module: None,
        }
    }

    /// AiManager + ModuleManager 박은 채로 부팅 — process_message 활성.
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

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl TelegramService for TelegramServiceImpl {
    async fn setup_webhook(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let webhook_url = req.into_inner().value;
        let token = self
            .bot_token()
            .ok_or_else(|| TonicStatus::failed_precondition("TELEGRAM_BOT_TOKEN 미설정"))?;
        let secret = self.webhook_secret();

        let endpoint = format!("https://api.telegram.org/bot{}/setWebhook", token);
        let response = http_client()
            .post(&endpoint)
            .json(&serde_json::json!({
                "url": webhook_url,
                "secret_token": secret,
                "drop_pending_updates": true,
            }))
            .send()
            .await
            .map_err(|e| TonicStatus::internal(format!("Telegram setWebhook: {e}")))?;
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TonicStatus::internal(format!("body parse: {e}")))?;
        json_response(&body)
    }

    async fn remove_webhook(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let token = self
            .bot_token()
            .ok_or_else(|| TonicStatus::failed_precondition("TELEGRAM_BOT_TOKEN 미설정"))?;
        let endpoint = format!("https://api.telegram.org/bot{}/deleteWebhook", token);
        let response = http_client()
            .post(&endpoint)
            .send()
            .await
            .map_err(|e| TonicStatus::internal(format!("Telegram deleteWebhook: {e}")))?;
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TonicStatus::internal(format!("body parse: {e}")))?;
        json_response(&body)
    }

    async fn get_webhook_status(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let token = self
            .bot_token()
            .ok_or_else(|| TonicStatus::failed_precondition("TELEGRAM_BOT_TOKEN 미설정"))?;
        let endpoint = format!("https://api.telegram.org/bot{}/getWebhookInfo", token);
        let response = http_client()
            .get(&endpoint)
            .send()
            .await
            .map_err(|e| TonicStatus::internal(format!("Telegram getWebhookInfo: {e}")))?;
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TonicStatus::internal(format!("body parse: {e}")))?;
        json_response(&body)
    }

    async fn is_owner(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let chat_id = req.into_inner().value;
        let owner = self
            .vault
            .get_secret("system:telegram:owner-id")
            .unwrap_or_default();
        Ok(Response::new(BoolRequest {
            value: !owner.is_empty() && owner == chat_id,
        }))
    }

    async fn get_webhook_secret(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let secret = self.webhook_secret();
        json_response(&serde_json::json!({"secret": secret}))
    }

    async fn process_message(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS Core.processTelegramMessage 1:1 — webhook 메시지 → AI 응답 → reply 전송.
        // AiManager + ModuleManager 박혀있을 때만 작동.
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            text: String,
            #[serde(rename = "chatId")]
            chat_id: serde_json::Value, // string 또는 number
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("process_message args: {e}")))?;
        let chat_id_str = match &args.chat_id {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => {
                return Err(TonicStatus::invalid_argument(
                    "chatId 는 string 또는 number 여야 함",
                ));
            }
        };

        let (Some(ai), Some(module)) = (&self.ai, &self.module) else {
            return json_response(&serde_json::json!({
                "success": false,
                "error": "AiManager + ModuleManager 미박음 — with_ai_and_module 후 활성"
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
                return json_response(&serde_json::json!({
                    "success": false,
                    "error": format!("AI 응답 실패: {e}")
                }));
            }
        };
        let reply = response.reply.trim().to_string();
        if reply.is_empty() {
            return json_response(&serde_json::json!({
                "success": false,
                "error": "AI 응답 비어있음"
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
            Ok(_) => json_response(&serde_json::json!({
                "success": true,
                "reply": reply,
            })),
            Err(e) => json_response(&serde_json::json!({
                "success": false,
                "error": format!("응답 전송 실패: {e}")
            })),
        }
    }
}
