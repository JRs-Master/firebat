//! gRPC CostService impl — CostManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! 2026-05-15: buf STANDARD lint 정공 — 매 RPC unique Request/Response message.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::cost::{CostBudget, CostManager, CostStatsFilter};
use crate::ports::{LlmCostStatsRecord, LlmCostStatsSummary};
use crate::proto::{
    cost_service_server::CostService, CostCheckBudgetRequest, CostCheckBudgetResponse,
    CostFlushRequest, CostFlushResponse, CostGetBudgetRequest, CostGetBudgetResponse,
    CostGetStatsRequest, CostGetStatsResponse, CostSetBudgetRequest, CostSetBudgetResponse,
    LlmCostStatsRecordPb,
};

pub struct CostServiceImpl {
    manager: Arc<CostManager>,
}

impl CostServiceImpl {
    pub fn new(manager: Arc<CostManager>) -> Self {
        Self { manager }
    }
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

impl From<LlmCostStatsSummary> for CostGetStatsResponse {
    fn from(s: LlmCostStatsSummary) -> Self {
        CostGetStatsResponse {
            total_input_tokens: s.total_input_tokens,
            total_output_tokens: s.total_output_tokens,
            total_cached_tokens: s.total_cached_tokens,
            total_cost_usd: s.total_cost_usd,
            total_calls: s.call_count,
            records: s.records.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<CostBudget> for CostGetBudgetResponse {
    fn from(b: CostBudget) -> Self {
        CostGetBudgetResponse {
            daily_usd: b.daily_usd,
            monthly_usd: b.monthly_usd,
            daily_calls: b.daily_calls,
            monthly_calls: b.monthly_calls,
            alert_at_percent: b.alert_at_percent,
        }
    }
}

impl From<crate::managers::cost::BudgetCheckResult> for CostCheckBudgetResponse {
    fn from(r: crate::managers::cost::BudgetCheckResult) -> Self {
        CostCheckBudgetResponse {
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
    ) -> Result<Response<CostGetStatsResponse>, TonicStatus> {
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

    async fn flush(
        &self,
        _req: Request<CostFlushRequest>,
    ) -> Result<Response<CostFlushResponse>, TonicStatus> {
        // Rust 에선 즉시 INSERT 라 별도 flush 불필요. ok 반환 (호환성).
        Ok(Response::new(CostFlushResponse {}))
    }

    async fn get_budget(
        &self,
        _req: Request<CostGetBudgetRequest>,
    ) -> Result<Response<CostGetBudgetResponse>, TonicStatus> {
        let budget = self.manager.get_budget();
        Ok(Response::new(budget.into()))
    }

    async fn set_budget(
        &self,
        req: Request<CostSetBudgetRequest>,
    ) -> Result<Response<CostSetBudgetResponse>, TonicStatus> {
        let args = req.into_inner();
        let budget = CostBudget {
            daily_usd: args.daily_usd,
            monthly_usd: args.monthly_usd,
            daily_calls: args.daily_calls,
            monthly_calls: args.monthly_calls,
            alert_at_percent: args.alert_at_percent,
        };
        if self.manager.set_budget(&budget) {
            Ok(Response::new(CostSetBudgetResponse {}))
        } else {
            Err(TonicStatus::internal(crate::i18n::t(
                "core.error.rpc.set_budget_failed",
                None,
                &[],
            )))
        }
    }

    async fn check_budget(
        &self,
        _req: Request<CostCheckBudgetRequest>,
    ) -> Result<Response<CostCheckBudgetResponse>, TonicStatus> {
        let result = self.manager.check_budget();
        Ok(Response::new(result.into()))
    }
}
