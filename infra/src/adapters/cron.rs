//! TokioCronAdapter — ICronPort 의 tokio + cron crate 구현체.
//!
//! 옛 TS infra/cron/index.ts (542줄) Rust 재현 (Phase B-13 minimum).
//!
//! 3 mode:
//! - cron: cronTime expression 반복 발화 (cron crate parser + tokio::time::sleep_until)
//! - once: runAt 특정 시각 1회 발화
//! - delay: delaySec N초 후 1회 발화
//!
//! 영속:
//! - data/cron-jobs.json — 등록된 잡 (PM2 재시작 시 cron/once 자동 복원, delay 잡 복원 불가)
//! - data/cron-logs.json — 실행 로그 (최대 200건 LRU)
//! - data/cron-notifications.json — 페이지 URL 알림 (소비 후 정리)
//!
//! Phase B-13 minimum:
//! - schedule / cancel / list / getLogs / consumeNotifications 활성
//! - cron expression 파싱 (cron crate) + chrono-tz timezone 변환
//! - on_trigger callback 박음 — Schedule manager 가 등록, 트리거 시 호출
//! - triggerNow / runWhen / retry / oneShot 자동 취소 등은 Schedule manager (manager 차원 책임)

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use firebat_core::ports::{
    CronJobInfo, CronJobMode, CronJobResult, CronLogEntry, CronNotification, CronScheduleOptions,
    CronTriggerCallback, CronTriggerInfo, CronTriggerType, ICronPort, InfraResult,
};

const MAX_LOGS: usize = 200;

pub struct TokioCronAdapter {
    /// 등록 잡 (jobId → CronJobInfo)
    jobs: Mutex<HashMap<String, CronJobInfo>>,
    /// 실행 중 task (jobId → JoinHandle) — cancel 시 abort
    tasks: AsyncMutex<HashMap<String, JoinHandle<()>>>,
    /// 콜백 — schedule manager 가 등록
    callback: Mutex<Option<CronTriggerCallback>>,
    /// 영속 파일
    jobs_file: PathBuf,
    logs_file: PathBuf,
    notifications_file: PathBuf,
    /// in-memory 로그 (lazy load from file)
    logs: Mutex<Vec<CronLogEntry>>,
    /// in-memory 알림 (consume 시 비움)
    notifications: Mutex<Vec<CronNotification>>,
    /// timezone (default Asia/Seoul, vault override)
    timezone: Mutex<String>,
}

impl TokioCronAdapter {
    pub fn new(
        jobs_file: PathBuf,
        logs_file: PathBuf,
        notifications_file: PathBuf,
        default_timezone: &str,
    ) -> InfraResult<Arc<Self>> {
        if let Some(parent) = jobs_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cron 디렉토리 생성 실패: {e}"))?;
        }

        // 영속 파일에서 로드
        let jobs: HashMap<String, CronJobInfo> = if jobs_file.exists() {
            match std::fs::read_to_string(&jobs_file) {
                Ok(raw) => match serde_json::from_str::<Vec<CronJobInfo>>(&raw) {
                    Ok(list) => list.into_iter().map(|j| (j.job_id.clone(), j)).collect(),
                    Err(_) => HashMap::new(),
                },
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };

        let logs: Vec<CronLogEntry> = if logs_file.exists() {
            std::fs::read_to_string(&logs_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let notifications: Vec<CronNotification> = if notifications_file.exists() {
            std::fs::read_to_string(&notifications_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        Ok(Arc::new(Self {
            jobs: Mutex::new(jobs),
            tasks: AsyncMutex::new(HashMap::new()),
            callback: Mutex::new(None),
            jobs_file,
            logs_file,
            notifications_file,
            logs: Mutex::new(logs),
            notifications: Mutex::new(notifications),
            timezone: Mutex::new(default_timezone.to_string()),
        }))
    }

    fn flush_jobs(&self, jobs: &HashMap<String, CronJobInfo>) {
        let list: Vec<&CronJobInfo> = jobs.values().collect();
        if let Ok(raw) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(&self.jobs_file, raw);
        }
    }

    fn flush_logs(&self, logs: &[CronLogEntry]) {
        if let Ok(raw) = serde_json::to_string_pretty(logs) {
            let _ = std::fs::write(&self.logs_file, raw);
        }
    }

    fn flush_notifications(&self, notes: &[CronNotification]) {
        if let Ok(raw) = serde_json::to_string_pretty(notes) {
            let _ = std::fs::write(&self.notifications_file, raw);
        }
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    /// naive datetime 문자열 + tz → UTC.
    /// 옛 TS parseInTimezone Rust port — "2026-05-04T15:00:00" 처럼 offset 없으면 tz 기준 로컬로 해석.
    fn parse_in_timezone(value: &str, tz_name: &str) -> Option<DateTime<Utc>> {
        let trimmed = value.trim();
        // 이미 offset 박힘 (Z 또는 +HH:MM)
        if trimmed.ends_with('Z')
            || trimmed.contains("+")
            || (trimmed.len() > 10 && trimmed[10..].contains('-'))
        {
            if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
                return Some(dt.with_timezone(&Utc));
            }
        }
        // naive — tz 기준 로컬로 해석
        let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::UTC);
        let formats = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S"];
        for fmt in &formats {
            if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, fmt) {
                if let chrono::LocalResult::Single(dt) = tz.from_local_datetime(&naive) {
                    return Some(dt.with_timezone(&Utc));
                }
            }
        }
        None
    }

    /// 다음 cron 발화 시각 — cron crate 활용.
    fn next_cron_fire(cron_time: &str, tz_name: &str) -> Option<DateTime<Utc>> {
        let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::UTC);
        let schedule = Schedule::from_str(cron_time).ok()?;
        schedule.upcoming(tz).next().map(|d| d.with_timezone(&Utc))
    }

    fn determine_mode(opts: &CronScheduleOptions, tz_name: &str) -> Result<CronJobMode, String> {
        match (
            opts.cron_time.is_some(),
            opts.run_at.is_some(),
            opts.delay_sec.is_some(),
        ) {
            (true, _, _) => {
                // cron expression 유효성 검증 — 옛 TS `cron.validate(cronTime)` 1:1.
                let cron_time = opts.cron_time.as_deref().unwrap_or("");
                Schedule::from_str(cron_time)
                    .map_err(|e| format!("잘못된 CRON 표현식: {} ({e})", cron_time))?;
                Ok(CronJobMode::Cron)
            }
            (false, true, _) => {
                // runAt 과거 시각 검증 — 옛 TS `runTime <= now` 거부 1:1.
                let run_at = opts.run_at.as_deref().unwrap_or("");
                if let Some(target) = Self::parse_in_timezone(run_at, tz_name) {
                    if target.timestamp_millis() <= Utc::now().timestamp_millis() {
                        return Err(format!("runAt 이 과거 시각입니다: {}", run_at));
                    }
                }
                Ok(CronJobMode::Once)
            }
            (false, false, true) => {
                // delaySec 1~86400 범위 검증 — 옛 TS 1:1 (1초~24시간).
                let delay = opts.delay_sec.unwrap_or(0);
                if !(1..=86400).contains(&delay) {
                    return Err(format!(
                        "지연 시간은 1~86400초 사이: {}초",
                        delay
                    ));
                }
                Ok(CronJobMode::Delay)
            }
            _ => Err("schedule: cronTime / runAt / delaySec 중 하나는 필수".to_string()),
        }
    }

    fn build_trigger_info(job: &CronJobInfo, trigger: CronTriggerType) -> CronTriggerInfo {
        CronTriggerInfo {
            job_id: job.job_id.clone(),
            target_path: job.target_path.clone(),
            trigger,
            title: job.options.title.clone(),
            input_data: job.options.input_data.clone(),
            pipeline: job.options.pipeline.clone(),
            one_shot: job.options.one_shot,
            run_when: job.options.run_when.clone(),
            retry: job.options.retry.clone(),
            notify: job.options.notify.clone(),
            execution_mode: job.options.execution_mode.clone(),
            agent_prompt: job.options.agent_prompt.clone(),
        }
    }

    /// callback 호출 + 로그 기록.
    async fn fire_trigger(self: Arc<Self>, info: CronTriggerInfo) {
        let cb = {
            let guard = self.callback.lock().unwrap();
            guard.clone()
        };
        let triggered_at = Self::now_iso();
        let title = info.title.clone();
        let target_path = info.target_path.clone();
        let job_id = info.job_id.clone();

        let result = match cb {
            Some(callback) => callback(info).await,
            None => CronJobResult {
                job_id: job_id.clone(),
                target_path: target_path.clone(),
                trigger: CronTriggerType::CronScheduler,
                success: false,
                duration_ms: 0,
                error: Some("on_trigger callback 미등록".to_string()),
                output: None,
                steps_executed: None,
                steps_total: None,
            },
        };

        // 로그 기록 — 최대 MAX_LOGS LRU
        let entry = CronLogEntry {
            job_id,
            target_path,
            title,
            triggered_at,
            success: result.success,
            duration_ms: result.duration_ms,
            error: result.error,
            output: result.output,
            steps_executed: result.steps_executed,
            steps_total: result.steps_total,
        };
        let mut logs = self.logs.lock().unwrap();
        logs.insert(0, entry);
        if logs.len() > MAX_LOGS {
            logs.truncate(MAX_LOGS);
        }
        self.flush_logs(&logs);
    }

    /// task spawn — mode 별 다른 schedule 로직.
    fn spawn_task(self: &Arc<Self>, job_id: String) -> JoinHandle<()> {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(strong) = weak.upgrade() else {
                    return;
                };
                let job = match strong.jobs.lock().unwrap().get(&job_id).cloned() {
                    Some(j) => j,
                    None => return, // 잡 삭제됨
                };
                let tz_name = strong.timezone.lock().unwrap().clone();

                // 다음 발화 시각 계산
                let (next_fire, trigger_type, is_one_shot) = match job.mode {
                    CronJobMode::Cron => {
                        let Some(cron_time) = &job.options.cron_time else {
                            return;
                        };
                        let next = match Self::next_cron_fire(cron_time, &tz_name) {
                            Some(t) => t,
                            None => return,
                        };
                        // endAt 검사 — endAt 지나면 자동 종료
                        if let Some(end_at) = &job.options.end_at {
                            if let Some(end_dt) = Self::parse_in_timezone(end_at, &tz_name) {
                                if next > end_dt {
                                    return;
                                }
                            }
                        }
                        (next, CronTriggerType::CronScheduler, false)
                    }
                    CronJobMode::Once => {
                        let Some(run_at) = &job.options.run_at else {
                            return;
                        };
                        let Some(target) = Self::parse_in_timezone(run_at, &tz_name) else {
                            return;
                        };
                        (target, CronTriggerType::ScheduledOnce, true)
                    }
                    CronJobMode::Delay => {
                        let Some(delay_sec) = job.options.delay_sec else {
                            return;
                        };
                        let target = Utc::now() + chrono::Duration::seconds(delay_sec);
                        (target, CronTriggerType::DelayedRun, true)
                    }
                };

                // 다음 발화 시각까지 sleep
                let now = Utc::now();
                let wait = (next_fire - now)
                    .to_std()
                    .unwrap_or(std::time::Duration::from_millis(0));
                tokio::time::sleep(wait).await;

                let info = Self::build_trigger_info(&job, trigger_type);
                let cloned = strong.clone();
                cloned.fire_trigger(info).await;

                if is_one_shot {
                    // 1회 발화 후 자동 정리
                    let mut jobs = strong.jobs.lock().unwrap();
                    if jobs.remove(&job_id).is_some() {
                        strong.flush_jobs(&jobs);
                    }
                    return;
                }
                // cron 반복 — 다음 발화 시각 재계산 후 loop 계속
            }
        })
    }

}

#[async_trait::async_trait]
impl ICronPort for TokioCronAdapter {
    async fn schedule(
        &self,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()> {
        if job_id.trim().is_empty() {
            return Err("schedule: jobId 누락".to_string());
        }
        // 중복 jobId 거부 — 옛 TS `cronTasks.has(jobId) || timers.has(jobId)` 1:1.
        {
            let jobs = self.jobs.lock().unwrap();
            if jobs.contains_key(job_id) {
                return Err(format!("이미 등록된 잡 ID입니다: {}", job_id));
            }
        }
        let tz_name = self.timezone.lock().unwrap().clone();
        let mode = TokioCronAdapter::determine_mode(&opts, &tz_name)?;

        // 기존 task abort
        {
            let mut tasks = self.tasks.lock().await;
            if let Some(h) = tasks.remove(job_id) {
                h.abort();
            }
        }

        let job = CronJobInfo {
            job_id: job_id.to_string(),
            target_path: target_path.to_string(),
            mode,
            created_at: TokioCronAdapter::now_iso(),
            options: opts,
        };

        {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.insert(job_id.to_string(), job);
            self.flush_jobs(&jobs);
        }

        // 새 task 시작 — Arc<Self> 가 필요. 여기서는 self 가 &Self 라 Arc 못 만듬.
        // 대신 caller (Manager) 가 strong Arc 보유 → on_trigger 패턴이 작동.
        // adapter 자체는 spawn 위해 Arc<Self> 필요 → external 로 wrapper 패턴 사용.
        // Phase B-13 minimum: spawn 은 별도 메서드 — schedule_with_arc.
        // 단순화: 이 schedule 메서드는 영속만 하고 spawn 은 별도. 보강 필요.
        // 실용 — Self 를 Arc 로 감싸야 하므로 inner Arc<Self> 를 lazy_static / OnceCell 로.
        // 여기서는 adapter 가 항상 Arc 통해 사용된다는 contract 로 schedule_arc 별도 노출.

        Ok(())
    }

    async fn cancel(&self, job_id: &str) -> InfraResult<()> {
        let mut tasks = self.tasks.lock().await;
        if let Some(h) = tasks.remove(job_id) {
            h.abort();
        }
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.remove(job_id).is_none() {
            return Err(format!("cron 잡 {} 미등록", job_id));
        }
        self.flush_jobs(&jobs);
        Ok(())
    }

    async fn trigger_now(&self, job_id: &str) -> InfraResult<()> {
        let job = {
            let jobs = self.jobs.lock().unwrap();
            jobs.get(job_id).cloned()
        };
        let job = job.ok_or_else(|| format!("cron 잡 {} 미등록", job_id))?;
        let info = TokioCronAdapter::build_trigger_info(&job, CronTriggerType::CronScheduler);
        // callback 호출은 Arc<Self> 필요. trigger_now 는 Arc 외부에서 호출되므로 인라인 spawn.
        let cb = {
            let guard = self.callback.lock().unwrap();
            guard.clone()
        };
        let triggered_at = TokioCronAdapter::now_iso();
        let title = info.title.clone();
        let target_path = info.target_path.clone();
        let job_id_str = info.job_id.clone();

        let result = match cb {
            Some(callback) => callback(info).await,
            None => CronJobResult {
                job_id: job_id_str.clone(),
                target_path: target_path.clone(),
                trigger: CronTriggerType::CronScheduler,
                success: false,
                duration_ms: 0,
                error: Some("on_trigger callback 미등록".to_string()),
                output: None,
                steps_executed: None,
                steps_total: None,
            },
        };

        let entry = CronLogEntry {
            job_id: job_id_str,
            target_path,
            title,
            triggered_at,
            success: result.success,
            duration_ms: result.duration_ms,
            error: result.error,
            output: result.output,
            steps_executed: result.steps_executed,
            steps_total: result.steps_total,
        };
        let mut logs = self.logs.lock().unwrap();
        logs.insert(0, entry);
        if logs.len() > MAX_LOGS {
            logs.truncate(MAX_LOGS);
        }
        self.flush_logs(&logs);
        Ok(())
    }

    fn list(&self) -> Vec<CronJobInfo> {
        let jobs = self.jobs.lock().unwrap();
        let mut list: Vec<CronJobInfo> = jobs.values().cloned().collect();
        list.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        list
    }

    fn set_timezone(&self, tz: &str) {
        let mut guard = self.timezone.lock().unwrap();
        *guard = tz.to_string();
    }

    fn get_timezone(&self) -> String {
        self.timezone.lock().unwrap().clone()
    }

    fn on_trigger(&self, callback: CronTriggerCallback) {
        let mut guard = self.callback.lock().unwrap();
        *guard = Some(callback);
    }

    fn get_logs(&self, limit: Option<usize>) -> Vec<CronLogEntry> {
        let logs = self.logs.lock().unwrap();
        let take = limit.unwrap_or(MAX_LOGS);
        logs.iter().take(take).cloned().collect()
    }

    fn clear_logs(&self) {
        let mut logs = self.logs.lock().unwrap();
        logs.clear();
        self.flush_logs(&logs);
    }

    fn consume_notifications(&self) -> Vec<CronNotification> {
        let mut notes = self.notifications.lock().unwrap();
        let out = std::mem::take(&mut *notes);
        self.flush_notifications(&notes);
        out
    }

    fn append_notify(&self, entry: CronNotification) {
        let mut notes = self.notifications.lock().unwrap();
        notes.push(entry);
        self.flush_notifications(&notes);
    }

    /// schedule + spawn 통합 — Arc 필요 메서드. trait 으로 격리.
    async fn schedule_with_spawn(
        self: Arc<Self>,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()> {
        // 1. 영속 등록 (기존 task abort 포함)
        self.schedule(job_id, target_path, opts).await?;
        // 2. spawn — Arc 필요
        let mut tasks = self.tasks.lock().await;
        let handle = self.spawn_task(job_id.to_string());
        tasks.insert(job_id.to_string(), handle);
        Ok(())
    }

    /// 부팅 시 영속 파일에 박혀있던 잡들 task 재시작.
    /// delay 잡은 복원 불가 (시각 정보 부재), cron / once 만 복원.
    async fn restore(self: Arc<Self>) {
        // 부팅 시 옛 알림 초기화 — 재시작 후 옛 알림이 한꺼번에 뜨는 것 방지 (옛 TS 1:1).
        {
            let mut notes = self.notifications.lock().unwrap();
            notes.clear();
            self.flush_notifications(&notes);
        }

        let now_ms = Utc::now().timestamp_millis();
        let tz_name = self.timezone.lock().unwrap().clone();

        // 만료 / 과거 1회 잡은 복원 안 함 (옛 TS restore 의 endAt + once+runAt 검사 1:1).
        let to_remove: Vec<String> = {
            let jobs = self.jobs.lock().unwrap();
            jobs.iter()
                .filter_map(|(id, j)| {
                    if j.mode == CronJobMode::Delay {
                        return Some(id.clone());
                    }
                    if let Some(end_at) = &j.options.end_at {
                        if let Some(end_dt) = Self::parse_in_timezone(end_at, &tz_name) {
                            if end_dt.timestamp_millis() <= now_ms {
                                return Some(id.clone());
                            }
                        }
                    }
                    if j.mode == CronJobMode::Once {
                        if let Some(run_at) = &j.options.run_at {
                            if let Some(run_dt) = Self::parse_in_timezone(run_at, &tz_name) {
                                if run_dt.timestamp_millis() <= now_ms {
                                    return Some(id.clone());
                                }
                            }
                        }
                    }
                    None
                })
                .collect()
        };

        let job_ids: Vec<String> = {
            let mut jobs = self.jobs.lock().unwrap();
            for id in &to_remove {
                jobs.remove(id);
            }
            if !to_remove.is_empty() {
                self.flush_jobs(&jobs);
            }
            jobs.iter()
                .filter(|(_, j)| j.mode != CronJobMode::Delay)
                .map(|(id, _)| id.clone())
                .collect()
        };

        let mut tasks = self.tasks.lock().await;
        for id in &job_ids {
            let handle = self.spawn_task(id.clone());
            tasks.insert(id.clone(), handle);
        }
        let _ = (job_ids, to_remove);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use tempfile::tempdir;
    use tokio::sync::oneshot;

    fn adapter() -> (Arc<TokioCronAdapter>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let jobs = dir.path().join("cron-jobs.json");
        let logs = dir.path().join("cron-logs.json");
        let notes = dir.path().join("cron-notifications.json");
        let a = TokioCronAdapter::new(jobs, logs, notes, "Asia/Seoul").unwrap();
        (a, dir)
    }

    #[tokio::test]
    async fn schedule_list_cancel_roundtrip() {
        let (a, _dir) = adapter();
        a.schedule(
            "j1",
            "/admin",
            CronScheduleOptions {
                cron_time: Some("0 * * * * *".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let list = a.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].job_id, "j1");
        assert_eq!(list[0].mode, CronJobMode::Cron);

        a.cancel("j1").await.unwrap();
        assert!(a.list().is_empty());
    }

    #[tokio::test]
    async fn schedule_invalid_returns_err() {
        let (a, _dir) = adapter();
        let result = a
            .schedule("bad", "/x", CronScheduleOptions::default())
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn delay_mode_fires_callback() {
        let (a, _dir) = adapter();
        let (tx, rx) = oneshot::channel::<String>();
        let tx = Arc::new(Mutex::new(Some(tx)));

        let cb: CronTriggerCallback = Arc::new(move |info: CronTriggerInfo| {
            let tx_clone = tx.clone();
            let job_id = info.job_id.clone();
            let target = info.target_path.clone();
            Box::pin(async move {
                if let Some(sender) = tx_clone.lock().unwrap().take() {
                    let _ = sender.send(job_id.clone());
                }
                CronJobResult {
                    job_id,
                    target_path: target,
                    trigger: CronTriggerType::DelayedRun,
                    success: true,
                    duration_ms: 1,
                    error: None,
                    output: None,
                    steps_executed: None,
                    steps_total: None,
                }
            }) as Pin<Box<dyn std::future::Future<Output = CronJobResult> + Send>>
        });
        a.on_trigger(cb);

        a.clone()
            .schedule_with_spawn(
                "fast",
                "/test",
                CronScheduleOptions {
                    // 옛 TS 와 동일하게 1초 이상 (validate 강제 — 1~86400)
                    delay_sec: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let received = tokio::time::timeout(std::time::Duration::from_secs(3), rx)
            .await
            .expect("timeout")
            .expect("channel");
        assert_eq!(received, "fast");

        // 1회 발화 후 자동 정리 (잠시 후)
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(a.list().is_empty());

        // 로그 박힘
        let logs = a.get_logs(None);
        assert_eq!(logs.len(), 1);
        assert!(logs[0].success);
    }

    #[tokio::test]
    async fn timezone_set_get() {
        let (a, _dir) = adapter();
        assert_eq!(a.get_timezone(), "Asia/Seoul");
        a.set_timezone("UTC");
        assert_eq!(a.get_timezone(), "UTC");
    }

    #[tokio::test]
    async fn notifications_append_consume() {
        let (a, _dir) = adapter();
        a.append_notify(CronNotification {
            job_id: "j".to_string(),
            url: "/p".to_string(),
            triggered_at: TokioCronAdapter::now_iso(),
        });
        let consumed = a.consume_notifications();
        assert_eq!(consumed.len(), 1);
        // 두 번째 consume 은 빈 배열
        assert!(a.consume_notifications().is_empty());
    }

    #[tokio::test]
    async fn jobs_persist_to_file() {
        let dir = tempdir().unwrap();
        let jobs_file = dir.path().join("jobs.json");
        let logs_file = dir.path().join("logs.json");
        let notes_file = dir.path().join("notes.json");

        {
            let a = TokioCronAdapter::new(
                jobs_file.clone(),
                logs_file.clone(),
                notes_file.clone(),
                "Asia/Seoul",
            )
            .unwrap();
            a.schedule(
                "p",
                "/x",
                CronScheduleOptions {
                    cron_time: Some("0 0 * * * *".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        // 새 어댑터 인스턴스 — 파일에서 복원
        let a2 = TokioCronAdapter::new(jobs_file, logs_file, notes_file, "Asia/Seoul").unwrap();
        let list = a2.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].job_id, "p");
    }

    #[tokio::test]
    async fn schedule_rejects_invalid_cron_expression() {
        // 옛 TS `cron.validate` 1:1 — 잘못된 cron expression 거부
        let (a, _dir) = adapter();
        let result = a
            .schedule(
                "bad",
                "/x",
                CronScheduleOptions {
                    cron_time: Some("not a cron".to_string()),
                    ..Default::default()
                },
            )
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("CRON 표현식"));
    }

    #[tokio::test]
    async fn schedule_rejects_delay_out_of_range() {
        let (a, _dir) = adapter();
        // delay_sec 0 거부
        let r1 = a
            .schedule(
                "x",
                "/x",
                CronScheduleOptions {
                    delay_sec: Some(0),
                    ..Default::default()
                },
            )
            .await;
        assert!(r1.is_err());
        assert!(r1.unwrap_err().contains("1~86400"));

        // delay_sec 86401 (24시간+1초) 거부
        let r2 = a
            .schedule(
                "y",
                "/y",
                CronScheduleOptions {
                    delay_sec: Some(86401),
                    ..Default::default()
                },
            )
            .await;
        assert!(r2.is_err());
    }

    #[tokio::test]
    async fn schedule_rejects_past_run_at() {
        let (a, _dir) = adapter();
        // 과거 시각 — 옛 TS 1:1 거부
        let result = a
            .schedule(
                "past",
                "/x",
                CronScheduleOptions {
                    run_at: Some("2020-01-01T00:00:00+09:00".to_string()),
                    ..Default::default()
                },
            )
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("과거"));
    }

    #[tokio::test]
    async fn schedule_rejects_duplicate_job_id() {
        let (a, _dir) = adapter();
        // 첫 등록 OK
        a.schedule(
            "dup",
            "/x",
            CronScheduleOptions {
                cron_time: Some("0 0 * * * *".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // 같은 jobId 재등록 거부 (옛 TS 1:1)
        let result = a
            .schedule(
                "dup",
                "/y",
                CronScheduleOptions {
                    cron_time: Some("30 0 * * * *".to_string()),
                    ..Default::default()
                },
            )
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("이미 등록"));
    }
}
