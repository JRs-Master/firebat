//! EventManager integration test — 옛 core inline tests 이관.
//!
//! `audit_log_capped_at_max` 는 private const `AUDIT_MAX` 사용으로 inline 유지.

use std::sync::{Arc, Mutex};

use firebat_core::managers::event::{EventFilter, EventManager, FirebatEvent};
use firebat_core::ports::ILogPort;
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
    assert_eq!(
        got,
        vec!["cron:complete".to_string(), "sidebar:refresh".to_string()]
    );
}
