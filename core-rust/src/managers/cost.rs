//! CostManager — LLM 비용 누적 + budget 관리.
//!
//! 옛 TS CostManager (`core/managers/cost-manager.ts`) Rust 재구현 (간소화).
//! Phase B 단계: SQLite 위에 llm_costs 테이블 + budget Vault 저장.
//! 옛 60초 dirty flush 패턴은 단순화 — 매 record 즉시 INSERT (rusqlite 가 매우 빠름).

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::adapters::database::SqliteDatabaseAdapter;
use crate::ports::IVaultPort;
use rusqlite::params;

const VK_COST_BUDGET: &str = "system:cost:budget";

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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostStatsFilter {
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub model: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostStatsSummary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cached_tokens: i64,
    pub total_cost_usd: f64,
    pub call_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetCheckResult {
    pub within_budget: bool,
    pub daily_used_usd: f64,
    pub monthly_used_usd: f64,
    pub daily_calls: i64,
    pub monthly_calls: i64,
    pub alerts: Vec<String>,
}

pub struct CostManager {
    db: Arc<SqliteDatabaseAdapter>,
    vault: Arc<dyn IVaultPort>,
}

impl CostManager {
    pub fn new(db: Arc<SqliteDatabaseAdapter>, vault: Arc<dyn IVaultPort>) -> Self {
        Self { db, vault }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
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
        self.db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO llm_costs (ts, model, input_tokens, output_tokens, cached_tokens, cost_usd, purpose)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![now, model, input_tokens, output_tokens, cached_tokens, cost_usd, purpose],
                )
            })
            .is_ok()
    }

    /// 통계 조회 (filter 적용).
    pub fn get_stats(&self, filter: &CostStatsFilter) -> CostStatsSummary {
        let mut sql = String::from(
            "SELECT \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cached_tokens), 0), \
                COALESCE(SUM(cost_usd), 0.0), \
                COUNT(*) \
             FROM llm_costs WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(since) = filter.since {
            sql.push_str(" AND ts >= ?");
            params.push(Box::new(since));
        }
        if let Some(until) = filter.until {
            sql.push_str(" AND ts <= ?");
            params.push(Box::new(until));
        }
        if let Some(model) = &filter.model {
            sql.push_str(" AND model = ?");
            params.push(Box::new(model.clone()));
        }
        if let Some(purpose) = &filter.purpose {
            sql.push_str(" AND purpose = ?");
            params.push(Box::new(purpose.clone()));
        }
        self.db
            .with_conn(|conn| {
                let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
                conn.query_row(&sql, params_refs.as_slice(), |row| {
                    Ok(CostStatsSummary {
                        total_input_tokens: row.get(0)?,
                        total_output_tokens: row.get(1)?,
                        total_cached_tokens: row.get(2)?,
                        total_cost_usd: row.get(3)?,
                        call_count: row.get(4)?,
                    })
                })
            })
            .unwrap_or_default()
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

    /// 현재 사용량 vs budget 검사. alert_at_percent 도달 시 alert 추가.
    pub fn check_budget(&self) -> BudgetCheckResult {
        let budget = self.get_budget();
        let now = Self::now_ms();
        let day_start = now - (now % (24 * 60 * 60 * 1000));
        let month_start = now - (now % (30i64 * 24 * 60 * 60 * 1000)); // 단순 30일 windowed (실 calendar 월 X)

        let daily = self.get_stats(&CostStatsFilter {
            since: Some(day_start),
            ..Default::default()
        });
        let monthly = self.get_stats(&CostStatsFilter {
            since: Some(month_start),
            ..Default::default()
        });

        let mut alerts = Vec::new();
        let mut within = true;

        if budget.daily_usd > 0.0 && daily.total_cost_usd >= budget.daily_usd {
            alerts.push(format!(
                "일일 USD 한도 초과: ${:.2} >= ${:.2}",
                daily.total_cost_usd, budget.daily_usd
            ));
            within = false;
        } else if budget.daily_usd > 0.0 && budget.alert_at_percent > 0 {
            let pct = (daily.total_cost_usd / budget.daily_usd) * 100.0;
            if pct >= budget.alert_at_percent as f64 {
                alerts.push(format!(
                    "일일 USD 알림: {:.0}% (${:.2}/${:.2})",
                    pct, daily.total_cost_usd, budget.daily_usd
                ));
            }
        }

        if budget.monthly_usd > 0.0 && monthly.total_cost_usd >= budget.monthly_usd {
            alerts.push(format!(
                "월간 USD 한도 초과: ${:.2} >= ${:.2}",
                monthly.total_cost_usd, budget.monthly_usd
            ));
            within = false;
        }

        if budget.daily_calls > 0 && daily.call_count >= budget.daily_calls {
            alerts.push(format!(
                "일일 호출 한도 초과: {} >= {}",
                daily.call_count, budget.daily_calls
            ));
            within = false;
        }

        if budget.monthly_calls > 0 && monthly.call_count >= budget.monthly_calls {
            alerts.push(format!(
                "월간 호출 한도 초과: {} >= {}",
                monthly.call_count, budget.monthly_calls
            ));
            within = false;
        }

        BudgetCheckResult {
            within_budget: within,
            daily_used_usd: daily.total_cost_usd,
            monthly_used_usd: monthly.total_cost_usd,
            daily_calls: daily.call_count,
            monthly_calls: monthly.call_count,
            alerts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;

    fn make_manager() -> CostManager {
        let db: Arc<SqliteDatabaseAdapter> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
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

        // 한도 초과
        mgr.record("m", 100, 100, 0, 1.0, None);
        let check = mgr.check_budget();
        assert!(!check.within_budget);
        assert!(!check.alerts.is_empty());
    }
}
