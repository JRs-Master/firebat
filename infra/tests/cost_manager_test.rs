//! CostManager integration test — 옛 core 의 inline `#[cfg(test)] mod tests` 이관.
//!
//! Phase B-4 cutover 후 dev-dep cyclic (core ← infra ← core) 회피 위해 integration test 로
//! 이동. core crate 가 `pub` 노출하는 메서드만 호출 가능 — private fn 사용 test 는 inline 유지.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::cost::{CostBudget, CostManager, CostStatsFilter};
use firebat_core::ports::{IDatabasePort, IVaultPort};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_manager() -> (CostManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (CostManager::new(db, vault), dir)
}

#[test]
fn record_and_stats() {
    let (mgr, _dir) = make_manager();
    mgr.record("gpt-5.5", 1000, 500, 0, 0.05, Some("chat"));
    mgr.record("claude-4", 2000, 800, 100, 0.10, Some("chat"));
    mgr.record("gemini-3", 1500, 600, 0, 0.03, Some("agent"));

    let all = mgr.get_stats(&CostStatsFilter::default());
    assert_eq!(all.call_count, 3);
    assert!((all.total_cost_usd - 0.18).abs() < 0.001);
    assert_eq!(all.total_input_tokens, 4500);

    let chat_only = mgr.get_stats(&CostStatsFilter {
        purpose: Some("chat".to_string()),
        ..Default::default()
    });
    assert_eq!(chat_only.call_count, 2);
}

#[test]
fn budget_roundtrip_and_check() {
    let (mgr, _dir) = make_manager();
    let budget = CostBudget {
        daily_usd: 1.0,
        monthly_usd: 30.0,
        daily_calls: 100,
        monthly_calls: 1000,
        alert_at_percent: 80,
    };
    assert!(mgr.set_budget(&budget));
    let got = mgr.get_budget();
    assert_eq!(got.daily_usd, 1.0);

    // 한도 안
    mgr.record("m", 100, 100, 0, 0.10, None);
    let check = mgr.check_budget();
    assert!(check.within_budget);
    assert!(check.reason.is_none());

    // 한도 초과 — daily USD
    mgr.record("m", 100, 100, 0, 1.0, None);
    let check = mgr.check_budget();
    assert!(!check.within_budget);
    assert!(check.reason.is_some());
    assert!(check.reason.unwrap().contains("일일 비용"));
}

#[test]
fn current_spend_calendar_month() {
    let (mgr, _dir) = make_manager();
    mgr.record("m", 100, 100, 0, 0.5, None);
    mgr.record("m", 100, 100, 0, 0.3, None);
    let spend = mgr.get_current_spend();
    assert!((spend.daily_usd - 0.8).abs() < 0.001);
    assert!((spend.monthly_usd - 0.8).abs() < 0.001);
    assert_eq!(spend.daily_calls, 2);
    assert_eq!(spend.monthly_calls, 2);
    assert_eq!(spend.today.len(), 10); // YYYY-MM-DD
    assert_eq!(spend.month.len(), 7); // YYYY-MM
    assert!(spend.today.starts_with(&spend.month));
}

#[test]
fn alerts_4_kinds_at_percent() {
    let (mgr, _dir) = make_manager();
    let budget = CostBudget {
        daily_usd: 1.0,
        monthly_usd: 10.0,
        daily_calls: 10,
        monthly_calls: 100,
        alert_at_percent: 80,
    };
    mgr.set_budget(&budget);

    mgr.record("m", 100, 100, 0, 0.85, None);
    for _ in 0..7 {
        mgr.record("m", 100, 100, 0, 0.0, None);
    }
    let check = mgr.check_budget();
    assert!(check.within_budget);
    let has_daily_usd = check.alerts.iter().any(|a| a.contains("일일 USD"));
    let has_daily_calls = check.alerts.iter().any(|a| a.contains("일일 호출"));
    assert!(has_daily_usd, "alerts: {:?}", check.alerts);
    assert!(has_daily_calls, "alerts: {:?}", check.alerts);
}

#[test]
fn unlimited_budget_returns_within() {
    let (mgr, _dir) = make_manager();
    mgr.record("m", 100, 100, 0, 1000.0, None);
    let check = mgr.check_budget();
    assert!(check.within_budget);
    assert!(check.reason.is_none());
    assert!(check.alerts.is_empty());
}
