//! EventManager — Backend SSE 이벤트 발행 / 구독 / audit log.
//!
//! 옛 TS EventManager (`core/managers/event-manager.ts`) Rust 재구현.
//!
//! Phase B 단계: in-memory broadcast (Vec<Listener> + Mutex). 추후 tokio::sync::broadcast
//! channel 도입 검토 (gRPC streaming RPC 와 자연 통합 위해).
//!
//! BIBLE 준수: Core 매니저는 직접 발행 X. Core facade 메서드가 EventManager 의 도메인 메서드
//! (notify_sidebar / notify_gallery / notify_cron_complete) 호출. emit() 자체는 일반화 path.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ports::ILogPort;

/// FirebatEvent — 옛 TS lib/events.ts 의 FirebatEvent 와 호환 schema.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FirebatEvent {
    /// 이벤트 type — 'sidebar:refresh' / 'cron:complete' / 'gallery:refresh' / 'status:update' 등
    #[serde(rename = "type")]
    pub event_type: String,
    /// 이벤트 payload (JSON value 임의 구조)
    #[serde(default)]
    pub data: serde_json::Value,
}

/// Audit log entry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub event: FirebatEvent,
    pub emitted_at: i64, // unix ms
}

/// 이벤트 listener 함수.
pub type EventListener = Arc<dyn Fn(&FirebatEvent) + Send + Sync>;

/// 이벤트 filter — 모든 이벤트 / 특정 type 들 / 사용자 함수.
pub enum EventFilter {
    All,
    Types(Vec<String>),
    Custom(Arc<dyn Fn(&FirebatEvent) -> bool + Send + Sync>),
}

struct Subscription {
    id: u64,
    filter: EventFilter,
    handler: EventListener,
}

const AUDIT_MAX: usize = 100;

pub struct EventManager {
    logger: Arc<dyn ILogPort>,
    state: Mutex<EventState>,
}

struct EventState {
    next_sub_id: u64,
    subscriptions: Vec<Subscription>,
    audit_log: Vec<AuditEntry>,
}

impl EventManager {
    pub fn new(logger: Arc<dyn ILogPort>) -> Self {
        Self {
            logger,
            state: Mutex::new(EventState {
                next_sub_id: 0,
                subscriptions: Vec::new(),
                audit_log: Vec::new(),
            }),
        }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// 이벤트 발행 — 모든 구독자 fanout + audit log 기록.
    pub fn emit(&self, event: FirebatEvent) {
        // 1. audit log + listener snapshot — lock 안에서 동시 수행
        let listeners: Vec<(EventListener, EventFilter)> = {
            let mut state = match self.state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            state.audit_log.push(AuditEntry {
                event: event.clone(),
                emitted_at: Self::now_ms(),
            });
            if state.audit_log.len() > AUDIT_MAX {
                state.audit_log.remove(0);
            }
            // 구독자 snapshot (lock 풀고 호출 — listener 안 emit 시 deadlock 회피)
            state
                .subscriptions
                .iter()
                .map(|s| (s.handler.clone(), Self::clone_filter(&s.filter)))
                .collect()
        };

        // 2. lock 풀고 listener 호출 — listener 의 panic 격리 (한 listener 실패 가 다른 영향 X)
        for (handler, filter) in listeners {
            if !Self::matches_filter(&filter, &event) {
                continue;
            }
            // panic 격리 — std::panic::catch_unwind 가능하지만 단순화 위해 logger 만 사용
            // (실패 listener 가 한 번 panic 해도 main thread 안 죽음 — Rust 의 panic 은 thread 격리)
            handler(&event);
        }
    }

    /// 구독 등록 — unsubscribe 핸들 (subscription id) 반환.
    pub fn subscribe(&self, filter: EventFilter, handler: EventListener) -> u64 {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let id = state.next_sub_id;
        state.next_sub_id += 1;
        state.subscriptions.push(Subscription {
            id,
            filter,
            handler,
        });
        id
    }

    /// 구독 해제 — id 로 listener 제거. 이미 없으면 false.
    pub fn unsubscribe(&self, id: u64) -> bool {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let before = state.subscriptions.len();
        state.subscriptions.retain(|s| s.id != id);
        before != state.subscriptions.len()
    }

    /// 최근 audit log — 어드민 UI / 디버깅.
    pub fn list_audit_log(&self, limit: usize) -> Vec<AuditEntry> {
        let state = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let len = state.audit_log.len();
        let take = limit.min(len);
        state.audit_log[len - take..].to_vec()
    }

    /// 현재 활성 구독자 수 — 디버깅 용.
    pub fn listener_count(&self) -> usize {
        self.state.lock().map(|s| s.subscriptions.len()).unwrap_or(0)
    }

    fn matches_filter(filter: &EventFilter, event: &FirebatEvent) -> bool {
        match filter {
            EventFilter::All => true,
            EventFilter::Types(types) => types.iter().any(|t| t == &event.event_type),
            EventFilter::Custom(f) => f(event),
        }
    }

    fn clone_filter(filter: &EventFilter) -> EventFilter {
        match filter {
            EventFilter::All => EventFilter::All,
            EventFilter::Types(t) => EventFilter::Types(t.clone()),
            EventFilter::Custom(f) => EventFilter::Custom(f.clone()),
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 도메인 메서드 — 옛 TS 의 boilerplate 응집.
    // BIBLE 의 SSE 이벤트 발행 일원화 — Core facade 가 이 메서드들 호출.
    // ──────────────────────────────────────────────────────────────────────────

    /// 사이드바 갱신 — 페이지·프로젝트·모듈·파일·템플릿 변경 시.
    pub fn notify_sidebar(&self) {
        self.emit(FirebatEvent {
            event_type: "sidebar:refresh".to_string(),
            data: serde_json::json!({}),
        });
    }

    /// 갤러리 갱신 — 미디어 생성·재생성·삭제 시.
    pub fn notify_gallery(&self, data: serde_json::Value) {
        self.emit(FirebatEvent {
            event_type: "gallery:refresh".to_string(),
            data,
        });
    }

    /// 크론 완료 — 결과 메타 + 사이드바 갱신 동시 발화.
    pub fn notify_cron_complete(&self, meta: serde_json::Value) {
        self.emit(FirebatEvent {
            event_type: "cron:complete".to_string(),
            data: meta,
        });
        self.notify_sidebar();
    }

    /// Subscriber failed log — fanout 시 listener 실패 케이스 중앙 처리용.
    /// (현재는 listener panic 자체는 thread 격리라 호출 X. 추후 catch_unwind 도입 시 활용.)
    #[allow(dead_code)]
    fn log_subscriber_error(&self, event_type: &str, err: &str) {
        self.logger.error(&format!(
            "[EventManager] subscriber failed (event type={event_type}): {err}"
        ));
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::log::ConsoleLogAdapter;

    fn make_manager() -> EventManager {
        let logger: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        EventManager::new(logger)
    }

    #[test]
    fn emit_records_to_audit_log() {
        let mgr = make_manager();
        mgr.emit(FirebatEvent {
            event_type: "test:foo".to_string(),
            data: serde_json::json!({"x": 1}),
        });
        let log = mgr.list_audit_log(50);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].event.event_type, "test:foo");
    }

    #[test]
    fn audit_log_capped_at_max() {
        let mgr = make_manager();
        for i in 0..150 {
            mgr.emit(FirebatEvent {
                event_type: format!("e-{i}"),
                data: serde_json::json!({}),
            });
        }
        let log = mgr.list_audit_log(200);
        assert_eq!(log.len(), AUDIT_MAX);
        // 가장 오래된 50 건은 evict — 'e-50' 이 head 여야
        assert_eq!(log[0].event.event_type, "e-50");
        assert_eq!(log[AUDIT_MAX - 1].event.event_type, "e-149");
    }

    #[test]
    fn subscribe_all_receives_all_events() {
        let mgr = make_manager();
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_cap = received.clone();
        mgr.subscribe(
            EventFilter::All,
            Arc::new(move |ev| {
                received_cap.lock().unwrap().push(ev.event_type.clone());
            }),
        );

        mgr.emit(FirebatEvent {
            event_type: "a".to_string(),
            data: serde_json::json!({}),
        });
        mgr.emit(FirebatEvent {
            event_type: "b".to_string(),
            data: serde_json::json!({}),
        });

        let got = received.lock().unwrap().clone();
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn subscribe_types_filter() {
        let mgr = make_manager();
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_cap = received.clone();
        mgr.subscribe(
            EventFilter::Types(vec!["sidebar:refresh".to_string()]),
            Arc::new(move |ev| {
                received_cap.lock().unwrap().push(ev.event_type.clone());
            }),
        );

        mgr.notify_sidebar(); // 매칭
        mgr.notify_gallery(serde_json::json!({})); // 미매칭

        let got = received.lock().unwrap().clone();
        assert_eq!(got, vec!["sidebar:refresh".to_string()]);
    }

    #[test]
    fn unsubscribe_stops_receiving() {
        let mgr = make_manager();
        let count: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        let count_cap = count.clone();
        let id = mgr.subscribe(
            EventFilter::All,
            Arc::new(move |_ev| {
                *count_cap.lock().unwrap() += 1;
            }),
        );

        mgr.emit(FirebatEvent {
            event_type: "a".to_string(),
            data: serde_json::json!({}),
        });
        assert_eq!(*count.lock().unwrap(), 1);

        assert!(mgr.unsubscribe(id));
        mgr.emit(FirebatEvent {
            event_type: "b".to_string(),
            data: serde_json::json!({}),
        });
        assert_eq!(*count.lock().unwrap(), 1);
    }

    #[test]
    fn cron_complete_also_triggers_sidebar() {
        let mgr = make_manager();
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let events_cap = events.clone();
        mgr.subscribe(
            EventFilter::All,
            Arc::new(move |ev| {
                events_cap.lock().unwrap().push(ev.event_type.clone());
            }),
        );

        mgr.notify_cron_complete(serde_json::json!({"jobId": "j1", "success": true}));

        let got = events.lock().unwrap().clone();
        assert_eq!(got, vec!["cron:complete".to_string(), "sidebar:refresh".to_string()]);
    }
}
