//! CostManager — LLM 비용 누적 + budget 관리.
//!
//! 옛 TS CostManager (`core/managers/cost-manager.ts`) Rust 1:1 port.
//! Phase B 단계: SQLite 위에 llm_costs 테이블 + budget Vault 저장.
//! 옛 60초 dirty flush 패턴은 의도적 단순화 — 매 record 즉시 INSERT (rusqlite 가 매우 빠름).
//!
//! 일반 로직 fix (2026-05-04 audit):
//!   - 사용자 timezone 기반 dateKey (Vault `system:timezone`, default `Asia/Seoul`)
//!   - 캘린더 월 (`YYYY-MM-01 ~ YYYY-MM-31`) — 옛 TS 1:1
//!   - alert_at_percent 4종 (daily USD + daily calls + monthly USD + monthly calls)
//!   - getCurrentSpend / checkBudget 외부 노출 (옛 TS 시그니처 1:1)

use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ports::{IDatabasePort, IVaultPort, LlmCostStatsFilter, LlmCostStatsSummary};

const VK_COST_BUDGET: &str = "system:cost:budget";
const VK_TIMEZONE: &str = "system:timezone";
const DEFAULT_TZ: &str = "Asia/Seoul";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostBudget {
    #[serde(rename = "dailyUsd", default)]
    pub daily_usd: f64,
    #[serde(rename = "monthlyUsd", default)]
    pub monthly_usd: f64,
    #[serde(rename = "dailyCalls", default)]
    pub daily_calls: i64,
    #[serde(rename = "monthlyCalls", default)]
    pub monthly_calls: i64,
    #[serde(rename = "alertAtPercent", default)]
    pub alert_at_percent: i64, // 0~100, 0 = 알림 비활성
}

// 옛 manager-local 타입 → port 타입으로 통합 (DB-agnostic motto + 같은 모양 중복 제거).
pub type CostStatsFilter = LlmCostStatsFilter;
pub type CostStatsSummary = LlmCostStatsSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetCheckResult {
    /// 한도 안 (true) — 호출 허용. false 면 LLM 호출 거부.
    pub within_budget: bool,
    /// `allowed=false` 시 한국어 reason (옛 TS `checkBudget.reason` 1:1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub daily_used_usd: f64,
    pub monthly_used_usd: f64,
    pub daily_calls: i64,
    pub monthly_calls: i64,
    pub daily_limit_usd: f64,
    pub monthly_limit_usd: f64,
    pub daily_limit_calls: i64,
    pub monthly_limit_calls: i64,
    /// 사전 알림 (`alertAtPercent` 도달 시) 4종 — 한도 초과 reason 과 별도.
    pub alerts: Vec<String>,
}

/// 옛 TS `getCurrentSpend()` 1:1 — 일/월 누적.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CurrentSpend {
    pub daily_usd: f64,
    pub monthly_usd: f64,
    pub daily_calls: i64,
    pub monthly_calls: i64,
    /// 사용자 timezone 기준 `YYYY-MM-DD`
    pub today: String,
    /// 사용자 timezone 기준 `YYYY-MM`
    pub month: String,
}

pub struct CostManager {
    db: Arc<dyn IDatabasePort>,
    vault: Arc<dyn IVaultPort>,
}

impl CostManager {
    pub fn new(db: Arc<dyn IDatabasePort>, vault: Arc<dyn IVaultPort>) -> Self {
        Self { db, vault }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// 사용자 timezone resolve — Vault `system:timezone` 우선, 없으면 `Asia/Seoul` 폴백.
    /// 잘못된 IANA 문자열도 폴백 (옛 TS 와 동일 — 일반 로직).
    fn user_tz(&self) -> Tz {
        let tz_str = self
            .vault
            .get_secret(VK_TIMEZONE)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_TZ.to_string());
        tz_str.parse::<Tz>().unwrap_or(Tz::Asia__Seoul)
    }

    /// 사용자 timezone 기준 오늘 (`YYYY-MM-DD`) + 자정 epoch ms (당일 시작) +
    /// 다음날 자정 epoch ms (당일 끝, exclusive).
    fn today_range(&self, tz: Tz) -> (String, i64, i64) {
        let now_local = tz.from_utc_datetime(&Utc::now().naive_utc());
        let today_str = now_local.format("%Y-%m-%d").to_string();
        let day_start_local = tz
            .from_local_datetime(&now_local.date_naive().and_hms_opt(0, 0, 0).unwrap())
            .single()
            .unwrap_or(now_local);
        let day_end_local = day_start_local + Duration::days(1);
        (
            today_str,
            day_start_local.timestamp_millis(),
            day_end_local.timestamp_millis(),
        )
    }

    /// 사용자 timezone 기준 이번 달 (`YYYY-MM`) + 1일 자정 epoch ms +
    /// 다음달 1일 자정 epoch ms (exclusive). 옛 TS 의 `YYYY-MM-01 ~ YYYY-MM-31` 캘린더 월 1:1.
    fn month_range(&self, tz: Tz) -> (String, i64, i64) {
        let now_local = tz.from_utc_datetime(&Utc::now().naive_utc());
        let month_str = now_local.format("%Y-%m").to_string();
        let year = now_local.year();
        let month = now_local.month();
        let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
        let next_first = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1).unwrap()
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1).unwrap()
        };
        let month_start_local = tz
            .from_local_datetime(&first.and_hms_opt(0, 0, 0).unwrap())
            .single()
            .unwrap_or(now_local);
        let month_end_local = tz
            .from_local_datetime(&next_first.and_hms_opt(0, 0, 0).unwrap())
            .single()
            .unwrap_or(now_local);
        (
            month_str,
            month_start_local.timestamp_millis(),
            month_end_local.timestamp_millis(),
        )
    }

    /// 비용 record 1건 추가.
    pub fn record(
        &self,
        model: &str,
        input_tokens: i64,
        output_tokens: i64,
        cached_tokens: i64,
        cost_usd: f64,
        purpose: Option<&str>,
    ) -> bool {
        let now = Self::now_ms();
        self.db.record_llm_cost(
            now,
            model,
            input_tokens,
            output_tokens,
            cached_tokens,
            cost_usd,
            purpose,
        )
    }

    /// 통계 조회 (filter 적용).
    pub fn get_stats(&self, filter: &CostStatsFilter) -> CostStatsSummary {
        self.db.query_llm_cost_stats(filter)
    }

    pub fn get_budget(&self) -> CostBudget {
        let Some(raw) = self.vault.get_secret(VK_COST_BUDGET) else {
            return CostBudget::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn set_budget(&self, budget: &CostBudget) -> bool {
        let Ok(json) = serde_json::to_string(budget) else {
            return false;
        };
        self.vault.set_secret(VK_COST_BUDGET, &json)
    }

    /// 오늘·이달 누적 비용 + 호출 수 — 옛 TS `getCurrentSpend()` 1:1.
    /// 사용자 timezone 기준 dateKey + 캘린더 월 (`YYYY-MM-01 ~ YYYY-MM-31`).
    /// CLI 모드는 cost 0 이지만 calls 카운트.
    pub fn get_current_spend(&self) -> CurrentSpend {
        let tz = self.user_tz();
        let (today, day_start, day_end) = self.today_range(tz);
        let (month, month_start, month_end) = self.month_range(tz);

        let daily = self.get_stats(&CostStatsFilter {
            since: Some(day_start),
            until: Some(day_end - 1),
            ..Default::default()
        });
        let monthly = self.get_stats(&CostStatsFilter {
            since: Some(month_start),
            until: Some(month_end - 1),
            ..Default::default()
        });

        CurrentSpend {
            daily_usd: daily.total_cost_usd,
            monthly_usd: monthly.total_cost_usd,
            daily_calls: daily.call_count,
            monthly_calls: monthly.call_count,
            today,
            month,
        }
    }

    /// 한도 체크 — LLM 호출 직전. `within_budget=false` 면 호출 거부.
    /// USD/calls 한도 중 하나라도 초과 시 차단. 옛 TS `checkBudget()` 1:1.
    /// `alert_at_percent` 도달 시 사전 알림 4종 (daily USD + daily calls + monthly USD + monthly calls).
    pub fn check_budget(&self) -> BudgetCheckResult {
        let budget = self.get_budget();
        let spend = self.get_current_spend();

        let base = BudgetCheckResult {
            within_budget: true,
            reason: None,
            daily_used_usd: spend.daily_usd,
            monthly_used_usd: spend.monthly_usd,
            daily_calls: spend.daily_calls,
            monthly_calls: spend.monthly_calls,
            daily_limit_usd: budget.daily_usd,
            monthly_limit_usd: budget.monthly_usd,
            daily_limit_calls: budget.daily_calls,
            monthly_limit_calls: budget.monthly_calls,
            alerts: Vec::new(),
        };

        // 한도 모두 0 = 무제한
        if budget.daily_usd == 0.0
            && budget.monthly_usd == 0.0
            && budget.daily_calls == 0
            && budget.monthly_calls == 0
        {
            return base;
        }

        // 차단 검사 — 옛 TS 와 동일 순서 (daily USD → monthly USD → daily calls → monthly calls)
        if budget.daily_usd > 0.0 && spend.daily_usd >= budget.daily_usd {
            return BudgetCheckResult {
                within_budget: false,
                reason: Some(format!(
                    "일일 비용 한도 초과 (${:.2} / ${:.2}). 한도 늘리거나 자정까지 대기.",
                    spend.daily_usd, budget.daily_usd
                )),
                ..base
            };
        }
        if budget.monthly_usd > 0.0 && spend.monthly_usd >= budget.monthly_usd {
            return BudgetCheckResult {
                within_budget: false,
                reason: Some(format!(
                    "월간 비용 한도 초과 (${:.2} / ${:.2}). 한도 늘리거나 다음 달 대기.",
                    spend.monthly_usd, budget.monthly_usd
                )),
                ..base
            };
        }
        if budget.daily_calls > 0 && spend.daily_calls >= budget.daily_calls {
            return BudgetCheckResult {
                within_budget: false,
                reason: Some(format!(
                    "일일 호출 수 한도 초과 ({} / {}). 한도 늘리거나 자정까지 대기.",
                    spend.daily_calls, budget.daily_calls
                )),
                ..base
            };
        }
        if budget.monthly_calls > 0 && spend.monthly_calls >= budget.monthly_calls {
            return BudgetCheckResult {
                within_budget: false,
                reason: Some(format!(
                    "월간 호출 수 한도 초과 ({} / {}). 한도 늘리거나 다음 달 대기.",
                    spend.monthly_calls, budget.monthly_calls
                )),
                ..base
            };
        }

        // 사전 알림 (alert_at_percent 도달 시) 4종 — 차단 안 됨, alerts[] 추가만.
        // 일반 로직 — 4 케이스 동일 패턴 함수화.
        let mut alerts = Vec::new();
        if budget.alert_at_percent > 0 {
            let threshold = budget.alert_at_percent as f64;
            let push_alert =
                |alerts: &mut Vec<String>, used: f64, limit: f64, label: &str, fmt_used: &str| {
                    if limit > 0.0 {
                        let pct = (used / limit) * 100.0;
                        if pct >= threshold {
                            alerts.push(format!(
                                "{} 알림: {:.0}% ({}/{})",
                                label,
                                pct,
                                fmt_used,
                                if label.contains("호출") {
                                    format!("{:.0}", limit)
                                } else {
                                    format!("${:.2}", limit)
                                }
                            ));
                        }
                    }
                };
            push_alert(
                &mut alerts,
                spend.daily_usd,
                budget.daily_usd,
                "일일 USD",
                &format!("${:.2}", spend.daily_usd),
            );
            push_alert(
                &mut alerts,
                spend.monthly_usd,
                budget.monthly_usd,
                "월간 USD",
                &format!("${:.2}", spend.monthly_usd),
            );
            push_alert(
                &mut alerts,
                spend.daily_calls as f64,
                budget.daily_calls as f64,
                "일일 호출",
                &format!("{}", spend.daily_calls),
            );
            push_alert(
                &mut alerts,
                spend.monthly_calls as f64,
                budget.monthly_calls as f64,
                "월간 호출",
                &format!("{}", spend.monthly_calls),
            );
        }

        BudgetCheckResult { alerts, ..base }
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::database::SqliteDatabaseAdapter;
    use firebat_infra::adapters::vault::SqliteVaultAdapter;

    fn make_manager() -> CostManager {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        CostManager::new(db, vault)
    }

    #[test]
    fn record_and_stats() {
        let mgr = make_manager();
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
        let mgr = make_manager();
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
        let mgr = make_manager();
        // record 박힘 — 현재 월에 들어감
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
        let mgr = make_manager();
        let budget = CostBudget {
            daily_usd: 1.0,
            monthly_usd: 10.0,
            daily_calls: 10,
            monthly_calls: 100,
            alert_at_percent: 80,
        };
        mgr.set_budget(&budget);

        // 80% 도달 — 4종 모두 알림 (1 record 로 4 한도 다 80% 가까이)
        mgr.record("m", 100, 100, 0, 0.85, None); // daily 85% / monthly 8.5% / daily calls 10%
        for _ in 0..7 {
            mgr.record("m", 100, 100, 0, 0.0, None); // 호출 수만 늘림 (8 calls = 80%)
        }
        let check = mgr.check_budget();
        // alerts 의 4 종 확인 — daily USD 알림 + daily calls 알림 (8/10=80%)
        assert!(check.within_budget); // 한도 미초과
        let has_daily_usd = check.alerts.iter().any(|a| a.contains("일일 USD"));
        let has_daily_calls = check.alerts.iter().any(|a| a.contains("일일 호출"));
        assert!(has_daily_usd, "alerts: {:?}", check.alerts);
        assert!(has_daily_calls, "alerts: {:?}", check.alerts);
    }

    #[test]
    fn user_tz_default_seoul() {
        let mgr = make_manager();
        // Vault 미설정 → Asia/Seoul fallback
        let tz = mgr.user_tz();
        assert_eq!(tz, Tz::Asia__Seoul);

        // 명시 박음
        mgr.vault.set_secret(VK_TIMEZONE, "America/New_York");
        let tz = mgr.user_tz();
        assert_eq!(tz, Tz::America__New_York);

        // 잘못된 입력 → fallback
        mgr.vault.set_secret(VK_TIMEZONE, "Invalid/Tz");
        let tz = mgr.user_tz();
        assert_eq!(tz, Tz::Asia__Seoul);
    }

    #[test]
    fn unlimited_budget_returns_within() {
        let mgr = make_manager();
        // budget 모두 0 = 무제한
        mgr.record("m", 100, 100, 0, 1000.0, None);
        let check = mgr.check_budget();
        assert!(check.within_budget);
        assert!(check.reason.is_none());
        assert!(check.alerts.is_empty());
    }
}
