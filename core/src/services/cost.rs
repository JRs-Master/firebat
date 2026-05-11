//! gRPC CostService impl — CostManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::cost::{CostBudget, CostManager, CostStatsFilter};
use crate::ports::{LlmCostStatsRecord, LlmCostStatsSummary};
use crate::proto::{
    cost_service_server::CostService, BudgetCheckResultPb, CostBudgetPb, CostGetStatsRequest,
    CostSetBudgetRequest, Empty, LlmCostStatsRecordPb, LlmCostStatsSummaryPb, Status,
};

pub struct CostServiceImpl {
    manager: Arc<CostManager>,
}

impl CostServiceImpl {
    pub fn new(manager: Arc<CostManager>) -> Self {
        Self { manager }
    }
}

fn ok_status() -> Response<Status> {
    Response::new(Status {
        ok: true,
        error: String::new(),
        error_code: String::new(),
    })
}

fn err_status(msg: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: String::new(),
    })
}

// ─── proto ↔ core port struct 변환 ─────────────────────────────────────────

impl From<LlmCostStatsRecord> for LlmCostStatsRecordPb {
    fn from(r: LlmCostStatsRecord) -> Self {
        LlmCostStatsRecordPb {
            date: r.date,
            model: r.model,
            calls: r.calls,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cost_usd: r.cost_usd,
        }
    }
}

impl From<LlmCostStatsSummary> for LlmCostStatsSummaryPb {
    fn from(s: LlmCostStatsSummary) -> Self {
        LlmCostStatsSummaryPb {
            total_input_tokens: s.total_input_tokens,
            total_output_tokens: s.total_output_tokens,
            total_cached_tokens: s.total_cached_tokens,
            total_cost_usd: s.total_cost_usd,
            total_calls: s.call_count,
            records: s.records.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<CostBudget> for CostBudgetPb {
    fn from(b: CostBudget) -> Self {
        CostBudgetPb {
            daily_usd: b.daily_usd,
            monthly_usd: b.monthly_usd,
            daily_calls: b.daily_calls,
            monthly_calls: b.monthly_calls,
            alert_at_percent: b.alert_at_percent,
        }
    }
}

impl From<crate::managers::cost::BudgetCheckResult> for BudgetCheckResultPb {
    fn from(r: crate::managers::cost::BudgetCheckResult) -> Self {
        BudgetCheckResultPb {
            within_budget: r.within_budget,
            reason: r.reason,
            daily_used_usd: r.daily_used_usd,
            monthly_used_usd: r.monthly_used_usd,
            daily_calls: r.daily_calls,
            monthly_calls: r.monthly_calls,
            daily_limit_usd: r.daily_limit_usd,
            monthly_limit_usd: r.monthly_limit_usd,
            daily_limit_calls: r.daily_limit_calls,
            monthly_limit_calls: r.monthly_limit_calls,
            alerts: r.alerts,
        }
    }
}

#[tonic::async_trait]
impl CostService for CostServiceImpl {
    async fn get_stats(
        &self,
        req: Request<CostGetStatsRequest>,
    ) -> Result<Response<LlmCostStatsSummaryPb>, TonicStatus> {
        let args = req.into_inner();
        let filter = CostStatsFilter {
            since: args.since,
            until: args.until,
            model: args.model,
            purpose: args.purpose,
        };
        let stats = self.manager.get_stats(&filter);
        Ok(Response::new(stats.into()))
    }

    async fn flush(&self, _req: Request<Empty>) -> Result<Response<Status>, TonicStatus> {
        // Rust 에선 즉시 INSERT 라 별도 flush 불필요. ok 반환 (호환성).
        Ok(ok_status())
    }

    async fn get_budget(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<CostBudgetPb>, TonicStatus> {
        let budget = self.manager.get_budget();
        Ok(Response::new(budget.into()))
    }

    async fn set_budget(&self, req: Request<CostSetBudgetRequest>) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        let budget = CostBudget {
            daily_usd: args.daily_usd,
            monthly_usd: args.monthly_usd,
            daily_calls: args.daily_calls,
            monthly_calls: args.monthly_calls,
            alert_at_percent: args.alert_at_percent,
        };
        if self.manager.set_budget(&budget) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_budget 실패"))
        }
    }

    async fn check_budget(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<BudgetCheckResultPb>, TonicStatus> {
        let result = self.manager.check_budget();
        Ok(Response::new(result.into()))
    }
}
