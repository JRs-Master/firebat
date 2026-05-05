//! ConsoleLogAdapter — ILogPort 의 stderr 구현체.
//!
//! Phase B 단계: 단순 stderr eprintln! 출력. tracing crate 도입은 Phase B 후속에서
//! (구조화 로그 / span / 파일 출력 / JSONL 등 박을 때).
//!
//! 옛 TS ConsoleLogAdapter (`infra/log/index.ts`) Rust 재구현 — 4 레벨 + timestamp prefix.

use firebat_core::ports::ILogPort;

pub struct ConsoleLogAdapter {
    /// 디버그 레벨 출력 여부 — env FIREBAT_LOG_DEBUG=1 시 활성. 기본 OFF (스팸 회피).
    debug_enabled: bool,
}

impl ConsoleLogAdapter {
    pub fn new() -> Self {
        let debug_enabled = std::env::var("FIREBAT_LOG_DEBUG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        Self { debug_enabled }
    }

    fn timestamp() -> String {
        // 단순 unix epoch ms — chrono 도입 전 stub. 추후 ISO 8601 로 교체.
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        format!("{ms}")
    }
}

impl Default for ConsoleLogAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ILogPort for ConsoleLogAdapter {
    fn info(&self, msg: &str) {
        eprintln!("[{}] [INFO] {}", Self::timestamp(), msg);
    }

    fn warn(&self, msg: &str) {
        eprintln!("[{}] [WARN] {}", Self::timestamp(), msg);
    }

    fn error(&self, msg: &str) {
        eprintln!("[{}] [ERROR] {}", Self::timestamp(), msg);
    }

    fn debug(&self, msg: &str) {
        if self.debug_enabled {
            eprintln!("[{}] [DEBUG] {}", Self::timestamp(), msg);
        }
    }
}
