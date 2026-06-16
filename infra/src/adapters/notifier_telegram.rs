//! TelegramNotifierAdapter — INotifierPort 의 Telegram Bot API 구현체.
//!
//! 흐름:
//!   1. Vault `system:module:telegram:settings` JSON 의 `bruteForceAlert: bool` toggle 검사.
//!      false 또는 미설정 시 silent skip (사용자 명시 OFF 의도).
//!   2. Vault `user:TELEGRAM_BOT_TOKEN` + `user:TELEGRAM_CHAT_ID` 읽음 (sysmod_telegram 동일 키).
//!      미설정 시 silent skip — 운영자 등록 안 한 상태.
//!   3. Telegram Bot API `sendMessage` 호출.
//!      level → emoji prefix (Info=ℹ / Warn=⚠ / Critical=🚨).
//!
//! 실패 silent — login latency 차단 X. tracing 로 진단 가능.
//!
//! Hexagonal — Core 매니저는 INotifierPort trait 만 의존. Telegram 구현 디테일 격리.
//! 향후 Discord / Slack / Email adapter 추가 시 같은 trait 구현.

use async_trait::async_trait;
use std::sync::Arc;

use firebat_core::ports::{INotifierPort, IVaultPort, NotifyLevel};
use firebat_core::vault_keys::vk_module_settings;

const VK_TELEGRAM_BOT_TOKEN: &str = "user:TELEGRAM_BOT_TOKEN";
const VK_TELEGRAM_CHAT_ID: &str = "user:TELEGRAM_CHAT_ID";

pub struct TelegramNotifierAdapter {
    vault: Arc<dyn IVaultPort>,
    http: reqwest::Client,
}

impl TelegramNotifierAdapter {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            vault,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    /// 토글 검사 — settings JSON 의 `bruteForceAlert: true` 또는 `bruteForceAlert: "true"` 일 때만 발송.
    /// 미설정 / false / 다른 값 = silent skip.
    fn brute_force_alert_enabled(&self) -> bool {
        let raw = match self.vault.get_secret(&vk_module_settings("telegram")) {
            Some(s) if !s.is_empty() => s,
            _ => return false,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return false,
        };
        match parsed.get("bruteForceAlert") {
            Some(serde_json::Value::Bool(b)) => *b,
            Some(serde_json::Value::String(s)) => s == "true",
            _ => false,
        }
    }

    fn level_emoji(level: NotifyLevel) -> &'static str {
        match level {
            NotifyLevel::Info => "ℹ",
            NotifyLevel::Warn => "⚠",
            NotifyLevel::Critical => "🚨",
        }
    }
}

#[async_trait]
impl INotifierPort for TelegramNotifierAdapter {
    async fn notify(&self, level: NotifyLevel, title: &str, message: &str) {
        // 1. toggle 검사 — OFF 면 silent skip
        if !self.brute_force_alert_enabled() {
            return;
        }

        // 2. 토큰 / chat_id 검사 — 둘 중 하나 미설정 시 silent skip
        let token = match self.vault.get_secret(VK_TELEGRAM_BOT_TOKEN) {
            Some(t) if !t.is_empty() => t,
            _ => {
                tracing::debug!(
                    "TelegramNotifier: TELEGRAM_BOT_TOKEN 미설정 — 알림 skip"
                );
                return;
            }
        };
        let chat_id = match self.vault.get_secret(VK_TELEGRAM_CHAT_ID) {
            Some(id) if !id.is_empty() => id,
            _ => {
                tracing::debug!(
                    "TelegramNotifier: TELEGRAM_CHAT_ID 미설정 — 알림 skip"
                );
                return;
            }
        };

        // 3. Telegram Bot API 호출.
        //    parse_mode 미지정 = 평문 전송. 레거시 "Markdown" 은 동적 본문(attempt_key 등)에
        //    `_ * [` 백틱 같은 특수문자가 섞이면 `400 Bad Request: can't parse entities` 로 거부된다
        //    (sysmod_telegram 도 호출자가 명시할 때만 parse_mode 를 붙여 기본 평문 → 항상 성공).
        let emoji = Self::level_emoji(level);
        let text = format!("{emoji} {title}\n\n{message}");
        let url = format!("https://api.telegram.org/bot{token}/sendMessage");
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": true,
        });
        let result = self.http.post(&url).json(&body).send().await;
        match result {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!(level = ?level, "TelegramNotifier: 알림 발송 성공");
            }
            Ok(resp) => {
                tracing::warn!(
                    status = %resp.status(),
                    "TelegramNotifier: Telegram API non-2xx 응답 — 토큰 / chat_id 확인 필요"
                );
            }
            Err(e) => {
                tracing::warn!(error = %e, "TelegramNotifier: HTTP 요청 실패");
            }
        }
    }
}
