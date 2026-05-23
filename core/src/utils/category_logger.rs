//! CategoryLogger — ILogPort 를 감싸 매니저별 category 를 자동 주입하는 wrapper.
//!
//! 매니저 코드는 `self.log.info(msg)` 를 그대로 호출하고, main.rs 에서 매니저 생성 시점에
//! 이 wrapper 로 감싸기만 하면 category 가 붙는다. info/warn/error/debug 호출은 inner 의
//! `log_with(category, level, msg)` 로 라우팅되어, TracingLogAdapter 가 category 를 tracing
//! field 로 기록 → LogBufferLayer 가 sqlite target 컬럼에 저장 → admin 로그 탭 prefix 필터가
//! 매니저 단위로 동작.

use std::sync::Arc;

use crate::ports::ILogPort;

/// 특정 category 를 자동으로 붙여 inner logger 로 위임하는 wrapper.
pub struct CategoryLogger {
    inner: Arc<dyn ILogPort>,
    category: String,
}

impl CategoryLogger {
    pub fn new(inner: Arc<dyn ILogPort>, category: &str) -> Self {
        Self {
            inner,
            category: category.to_string(),
        }
    }
}

impl ILogPort for CategoryLogger {
    fn info(&self, msg: &str) {
        self.inner.log_with(&self.category, "info", msg);
    }
    fn warn(&self, msg: &str) {
        self.inner.log_with(&self.category, "warn", msg);
    }
    fn error(&self, msg: &str) {
        self.inner.log_with(&self.category, "error", msg);
    }
    fn debug(&self, msg: &str) {
        self.inner.log_with(&self.category, "debug", msg);
    }
    /// 호출 측이 직접 category 를 명시하면 그대로 존중 (wrapper category 무시).
    fn log_with(&self, category: &str, level: &str, msg: &str) {
        self.inner.log_with(category, level, msg);
    }
}
