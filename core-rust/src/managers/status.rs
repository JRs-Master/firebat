//! StatusManager — long-running job 의 진행 상태 단일 source.
//!
//! 옛 TS StatusManager (`core/managers/status-manager.ts`) Rust 재구현 (간소화).
//! Phase B 단계: in-memory job map + EventManager 통한 SSE 발행 (선택).
//! 추후 영속 저장 (sqlite + jobs 테이블) 검토 가능.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::managers::event::{EventManager, FirebatEvent};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatusKind {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStatus {
    pub id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    pub status: JobStatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>, // 0.0 ~ 1.0
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "parentJobId", skip_serializing_if = "Option::is_none")]
    pub parent_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub meta: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JobStats {
    pub queued: usize,
    pub running: usize,
    pub done: usize,
    pub error: usize,
    pub cancelled: usize,
    pub total: usize,
}

pub struct StatusManager {
    state: Mutex<HashMap<String, JobStatus>>,
    /// EventManager — SSE status:update 이벤트 발행. None 이면 발행 안 함.
    event: Option<Arc<EventManager>>,
}

impl StatusManager {
    pub fn new(event: Option<Arc<EventManager>>) -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
            event,
        }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn emit_update(&self, job: &JobStatus) {
        if let Some(ev) = &self.event {
            ev.emit(FirebatEvent {
                event_type: "status:update".to_string(),
                data: serde_json::to_value(job).unwrap_or(serde_json::Value::Null),
            });
        }
    }

    /// 새 job 시작 — id 미지정 시 자동 생성. Queued 상태.
    pub fn start(
        &self,
        id: Option<String>,
        job_type: String,
        message: Option<String>,
        parent_job_id: Option<String>,
        meta: serde_json::Value,
    ) -> JobStatus {
        let now = Self::now_ms();
        let id = id.unwrap_or_else(|| format!("job-{now}-{:04x}", rand::random::<u16>()));
        let job = JobStatus {
            id: id.clone(),
            job_type,
            status: JobStatusKind::Queued,
            progress: None,
            message,
            started_at: now,
            updated_at: now,
            parent_job_id,
            meta,
            result: None,
            error: None,
        };
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.insert(id, job.clone());
        drop(state);
        self.emit_update(&job);
        job
    }

    /// Job progress / message / meta 업데이트. 자동으로 Running 상태로 전환.
    pub fn update(
        &self,
        id: &str,
        progress: Option<f64>,
        message: Option<String>,
        meta: Option<serde_json::Value>,
    ) -> Option<JobStatus> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let job = state.get_mut(id)?;
        if job.status == JobStatusKind::Queued {
            job.status = JobStatusKind::Running;
        }
        if let Some(p) = progress {
            job.progress = Some(p.clamp(0.0, 1.0));
        }
        if let Some(m) = message {
            job.message = Some(m);
        }
        if let Some(m) = meta {
            job.meta = m;
        }
        job.updated_at = Self::now_ms();
        let snapshot = job.clone();
        drop(state);
        self.emit_update(&snapshot);
        Some(snapshot)
    }

    /// Job 완료. status=Done + result 박음.
    pub fn complete(&self, id: &str, result: Option<serde_json::Value>) -> Option<JobStatus> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let job = state.get_mut(id)?;
        job.status = JobStatusKind::Done;
        job.progress = Some(1.0);
        job.result = result;
        job.updated_at = Self::now_ms();
        let snapshot = job.clone();
        drop(state);
        self.emit_update(&snapshot);
        Some(snapshot)
    }

    /// Job 실패. status=Error + error 박음.
    pub fn fail(&self, id: &str, msg: String) -> Option<JobStatus> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let job = state.get_mut(id)?;
        job.status = JobStatusKind::Error;
        job.error = Some(msg);
        job.updated_at = Self::now_ms();
        let snapshot = job.clone();
        drop(state);
        self.emit_update(&snapshot);
        Some(snapshot)
    }

    pub fn get(&self, id: &str) -> Option<JobStatus> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.get(id).cloned()
    }

    /// 필터 — type / status / since (updated_at 이후) / parent_job_id / limit.
    pub fn list(
        &self,
        job_type: Option<&str>,
        status: Option<JobStatusKind>,
        since: Option<i64>,
        parent_job_id: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<JobStatus> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut all: Vec<JobStatus> = state
            .values()
            .filter(|j| job_type.map(|t| j.job_type == t).unwrap_or(true))
            .filter(|j| status.map(|s| j.status == s).unwrap_or(true))
            .filter(|j| since.map(|t| j.updated_at >= t).unwrap_or(true))
            .filter(|j| {
                parent_job_id
                    .map(|p| j.parent_job_id.as_deref() == Some(p))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if let Some(l) = limit {
            all.truncate(l);
        }
        all
    }

    pub fn stats(&self) -> JobStats {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut s = JobStats::default();
        for j in state.values() {
            match j.status {
                JobStatusKind::Queued => s.queued += 1,
                JobStatusKind::Running => s.running += 1,
                JobStatusKind::Done => s.done += 1,
                JobStatusKind::Error => s.error += 1,
                JobStatusKind::Cancelled => s.cancelled += 1,
            }
            s.total += 1;
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_lifecycle() {
        let mgr = StatusManager::new(None);
        let job = mgr.start(
            None,
            "image_gen".to_string(),
            Some("starting".to_string()),
            None,
            serde_json::json!({"prompt": "hello"}),
        );
        assert_eq!(job.status, JobStatusKind::Queued);

        let updated = mgr.update(&job.id, Some(0.5), Some("halfway".to_string()), None).unwrap();
        assert_eq!(updated.status, JobStatusKind::Running);
        assert_eq!(updated.progress, Some(0.5));

        let done = mgr.complete(&job.id, Some(serde_json::json!({"url": "/img.png"}))).unwrap();
        assert_eq!(done.status, JobStatusKind::Done);
        assert_eq!(done.progress, Some(1.0));
    }

    #[test]
    fn fail_sets_error() {
        let mgr = StatusManager::new(None);
        let job = mgr.start(None, "test".to_string(), None, None, serde_json::json!({}));
        let failed = mgr.fail(&job.id, "OOM".to_string()).unwrap();
        assert_eq!(failed.status, JobStatusKind::Error);
        assert_eq!(failed.error.as_deref(), Some("OOM"));
    }

    #[test]
    fn list_filters() {
        let mgr = StatusManager::new(None);
        let j1 = mgr.start(None, "image".to_string(), None, None, serde_json::json!({}));
        let _j2 = mgr.start(None, "cron".to_string(), None, None, serde_json::json!({}));
        mgr.complete(&j1.id, None);

        let images = mgr.list(Some("image"), None, None, None, None);
        assert_eq!(images.len(), 1);

        let done = mgr.list(None, Some(JobStatusKind::Done), None, None, None);
        assert_eq!(done.len(), 1);

        let stats = mgr.stats();
        assert_eq!(stats.total, 2);
        assert_eq!(stats.done, 1);
    }
}
