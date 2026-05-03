//! gRPC TelegramService impl — Bot API wrapper.
//!
//! Phase B-17.5b minimum:
//! - SetupWebhook / RemoveWebhook / GetWebhookStatus — Telegram Bot API setWebhook 호출
//! - IsOwner — Vault `system:telegram:owner-id` chat_id whitelist 매칭
//! - ProcessMessage — webhook payload 파싱 (Phase B-17+ AiManager 연동 후 활성)

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::llm::formats::common::http_client;
use crate::ports::IVaultPort;
use crate::proto::{
    telegram_service_server::TelegramService, BoolRequest, Empty, JsonArgs, JsonValue,
    StringRequest,
};

pub struct TelegramServiceImpl {
    vault: Arc<dyn IVaultPort>,
}

impl TelegramServiceImpl {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self { vault }
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
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-17+ — AiManager 와 연동해서 webhook 메시지 → AI 응답 → reply 전송.
        // 현재는 stub.
        json_response(&serde_json::json!({
            "_phase": "B-17+ stub — AiManager 연동 후 활성"
        }))
    }
}
