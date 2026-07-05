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
//! - data/cron-jobs.json — 등록된 잡 (systemd 재시작 시 cron/once 자동 복원, delay 잡 복원 불가)
//! - data/cron-logs.json — 실행 로그 (최대 200건 LRU)
//! - data/cron-notifications.json — 페이지 URL 알림 (소비 후 정리)
//!
//! Phase B-13 minimum:
//! - schedule / cancel / list / getLogs / consumeNotifications 활성
//! - cron expression 파싱 (cron crate) + chrono-tz timezone 변환
//! - on_trigger callback 저장 — Schedule manager 가 등록, 트리거 시 호출
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
    CronJobInfo, CronJobMode, CronJobResult, CronLogEntry, CronNotification, CronOccurrence,
    CronScheduleOptions, CronTriggerCallback, CronTriggerInfo, CronTriggerType, ICronPort,
    InfraResult,
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
            // Job DEFINITIONS — a silently dropped write here means schedules vanish on
            // restart with zero trace (disk full / permissions). Log loudly.
            if let Err(e) = std::fs::write(&self.jobs_file, raw) {
                tracing::error!(target: "cron", error = %e, "cron jobs 파일 저장 실패 — 재시작 시 스케줄 유실 위험");
            }
        }
    }

    fn flush_logs(&self, logs: &[CronLogEntry]) {
        if let Ok(raw) = serde_json::to_string_pretty(logs) {
            if let Err(e) = std::fs::write(&self.logs_file, raw) {
                tracing::warn!(target: "cron", error = %e, "cron 로그 파일 저장 실패");
            }
        }
    }

    fn flush_notifications(&self, notes: &[CronNotification]) {
        if let Ok(raw) = serde_json::to_string_pretty(notes) {
            if let Err(e) = std::fs::write(&self.notifications_file, raw) {
                tracing::warn!(target: "cron", error = %e, "cron 알림 파일 저장 실패");
            }
        }
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    /// naive datetime 문자열 + tz → UTC.
    /// 옛 TS parseInTimezone Rust port — "2026-05-04T15:00:00" 처럼 offset 없으면 tz 기준 로컬로 해석.
    fn parse_in_timezone(value: &str, tz_name: &str) -> Option<DateTime<Utc>> {
        let trimmed = value.trim();
        // 이미 offset 설정 (Z 또는 +HH:MM)
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
        // 날짜만("YYYY-MM-DD") — tz 기준 자정으로 해석. 캘린더 occurrence 조회가 from/to 를 날짜만 보내는데
        // 위 포맷들은 전부 시간 필수라 파싱 실패 → 예약(occurrence) 이 항상 빈 배열로 안 뜨던 버그 fix.
        if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
            if let Some(naive) = date.and_hms_opt(0, 0, 0) {
                if let chrono::LocalResult::Single(dt) = tz.from_local_datetime(&naive) {
                    return Some(dt.with_timezone(&Utc));
                }
            }
        }
        None
    }

    /// 표준 5-필드 cron(`min hour dom month dow`, 예: `0 22 * * *`)을 cron 크레이트(0.12)가 요구하는
    /// 6-필드(초 포함 `sec min hour dom month dow`)로 정규화. AI·사용자가 보내는 표준 Unix cron 수용 —
    /// cron 0.12 는 초 필드 필수라 5-필드를 "Invalid cron expression" 으로 거부하던 버그 fix. 6~7 필드는 그대로.
    fn normalize_cron(expr: &str) -> String {
        let t = expr.trim();
        if t.split_whitespace().count() == 5 { format!("0 {t}") } else { t.to_string() }
    }

    /// 다음 cron 발화 시각 — cron crate 활용.
    fn next_cron_fire(cron_time: &str, tz_name: &str) -> Option<DateTime<Utc>> {
        let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::UTC);
        let schedule = Schedule::from_str(&Self::normalize_cron(cron_time)).ok()?;
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
                Schedule::from_str(&Self::normalize_cron(cron_time))
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
            builtin_kind: job.options.builtin_kind.clone(),
            show_in_calendar: job.options.show_in_calendar,
        }
    }

    /// callback 호출 + 로그 기록.
    async fn fire_trigger(self: Arc<Self>, info: CronTriggerInfo) {
        let cb = {
            let guard = self.callback.lock().unwrap_or_else(|p| p.into_inner());
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
        let mut logs = self.logs.lock().unwrap_or_else(|p| p.into_inner());
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
                let job = match strong.jobs.lock().unwrap_or_else(|p| p.into_inner()).get(&job_id).cloned() {
                    Some(j) => j,
                    None => return, // 잡 삭제됨
                };
                let tz_name = strong.timezone.lock().unwrap_or_else(|p| p.into_inner()).clone();

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
                    let mut jobs = strong.jobs.lock().unwrap_or_else(|p| p.into_inner());
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
            let jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
            if jobs.contains_key(job_id) {
                return Err(format!("이미 등록된 잡 ID입니다: {}", job_id));
            }
        }
        let tz_name = self.timezone.lock().unwrap_or_else(|p| p.into_inner()).clone();
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
            let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
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

    async fn cancel(&self, job_id: &str) -> InfraResult<bool> {
        let mut tasks = self.tasks.lock().await;
        if let Some(h) = tasks.remove(job_id) {
            h.abort();
        }
        let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        if jobs.remove(job_id).is_none() {
            return Ok(false);
        }
        self.flush_jobs(&jobs);
        Ok(true)
    }

    async fn trigger_now(&self, job_id: &str) -> InfraResult<()> {
        let job = {
            let jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
            jobs.get(job_id).cloned()
        };
        let job = job.ok_or_else(|| format!("cron 잡 {} 미등록", job_id))?;
        let info = TokioCronAdapter::build_trigger_info(&job, CronTriggerType::CronScheduler);
        // callback 호출은 Arc<Self> 필요. trigger_now 는 Arc 외부에서 호출되므로 인라인 spawn.
        let cb = {
            let guard = self.callback.lock().unwrap_or_else(|p| p.into_inner());
            guard.clone()
        };
        let triggered_at = TokioCronAdapter::now_iso();
        let title = info.title.clone();
        let target_path = info.target_path.clone();
        let job_id_str = info.job_id.clone();

        // StatusManager 뱃지는 handle_trigger(콜백) 단일 지점에서 등록 — run-now·스케줄 공통.
        // 여기서 또 등록하면 run-now 시 뱃지 2개가 됨(중복). 그래서 trigger_now 는 status 안 만듦.
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
        let mut logs = self.logs.lock().unwrap_or_else(|p| p.into_inner());
        logs.insert(0, entry);
        if logs.len() > MAX_LOGS {
            logs.truncate(MAX_LOGS);
        }
        self.flush_logs(&logs);
        Ok(())
    }

    fn list(&self) -> Vec<CronJobInfo> {
        let jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let mut list: Vec<CronJobInfo> = jobs.values().cloned().collect();
        list.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        list
    }

    /// 캘린더 투영용 — [from, to] 구간 내 cron 발화 시각 전개. 반복(cron_time)은 cron crate 로
    /// 구간 내 N건, runAt/delay 는 1건. start_at/end_at 윈도 + owner 필터 적용. 잡당 상한으로
    /// runaway 방어. occurs_at = RFC3339 UTC.
    fn list_occurrences(
        &self,
        from_iso: &str,
        to_iso: &str,
        owner: Option<&str>,
    ) -> Vec<CronOccurrence> {
        let tz_name = self.get_timezone();
        let (Some(from_dt), Some(to_dt)) = (
            Self::parse_in_timezone(from_iso, &tz_name),
            Self::parse_in_timezone(to_iso, &tz_name),
        ) else {
            return Vec::new();
        };
        if to_dt < from_dt {
            return Vec::new();
        }
        let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::UTC);
        // 예정(occurrence)은 **미래만** — 과거 발화는 실행 이력(log)이 담당. 하한을 now 로 막아 (1) cron 생성
        // 전(과거) occurrence 가 캘린더에 뜨던 것, (2) 이미 발화한 occurrence 가 예정+완료로 중복 표시되던 것 차단.
        let now_utc = Utc::now();
        // 반복 잡 runaway 방어 — 캘린더는 월 단위 조회라 잡당 500건이면 분 단위 반복도 충분.
        const MAX_PER_JOB: usize = 500;

        let jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<CronOccurrence> = Vec::new();
        for job in jobs.values() {
            if job.options.owner.as_deref() != owner {
                continue;
            }
            // 발화 시각만 먼저 모으고(차용 단순화) 이후 CronOccurrence 로 매핑.
            let mut fires: Vec<DateTime<Utc>> = Vec::new();
            match job.mode {
                CronJobMode::Cron => {
                    if let Some(cron_time) = job.options.cron_time.as_deref() {
                        if let Ok(schedule) = Schedule::from_str(&Self::normalize_cron(cron_time)) {
                            let start_w = job
                                .options
                                .start_at
                                .as_deref()
                                .and_then(|s| Self::parse_in_timezone(s, &tz_name));
                            let end_w = job
                                .options
                                .end_at
                                .as_deref()
                                .and_then(|e| Self::parse_in_timezone(e, &tz_name));
                            // schedule.after 는 strictly after — anchor 직후부터. 예정은 미래만이라 하한을
                            // now 로 막음 (과거 발화는 log 로 표시; 미래 달 조회는 from_dt 가 더 커 그대로).
                            let occ_from = if from_dt > now_utc { from_dt } else { now_utc };
                            let anchor =
                                (occ_from - chrono::Duration::seconds(1)).with_timezone(&tz);
                            for fire in schedule.after(&anchor).take(MAX_PER_JOB) {
                                let fire_utc = fire.with_timezone(&Utc);
                                if fire_utc > to_dt {
                                    break;
                                }
                                if fire_utc < from_dt {
                                    continue;
                                }
                                if start_w.map(|s| fire_utc < s).unwrap_or(false) {
                                    continue;
                                }
                                if end_w.map(|e| fire_utc > e).unwrap_or(false) {
                                    break;
                                }
                                fires.push(fire_utc);
                            }
                        }
                    }
                }
                CronJobMode::Once => {
                    if let Some(target) = job
                        .options
                        .run_at
                        .as_deref()
                        .and_then(|r| Self::parse_in_timezone(r, &tz_name))
                    {
                        if target >= from_dt && target <= to_dt {
                            fires.push(target);
                        }
                    }
                }
                CronJobMode::Delay => {
                    // created_at + delay_sec 추정 (영속 복원은 안 되지만 미래 구간 표시용).
                    if let Some(delay) = job.options.delay_sec {
                        if let Some(created) = Self::parse_in_timezone(&job.created_at, &tz_name) {
                            let target = created + chrono::Duration::seconds(delay);
                            if target >= from_dt && target <= to_dt {
                                fires.push(target);
                            }
                        }
                    }
                }
            }
            let mode_str = match job.mode {
                CronJobMode::Cron => "cron",
                CronJobMode::Once => "once",
                CronJobMode::Delay => "delay",
            };
            for at in fires {
                out.push(CronOccurrence {
                    job_id: job.job_id.clone(),
                    title: job.options.title.clone(),
                    target_path: job.target_path.clone(),
                    occurs_at: at.to_rfc3339(),
                    mode: mode_str.to_string(),
                });
            }
        }
        out
    }

    fn set_timezone(&self, tz: &str) {
        let mut guard = self.timezone.lock().unwrap_or_else(|p| p.into_inner());
        *guard = tz.to_string();
    }

    fn get_timezone(&self) -> String {
        self.timezone.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn on_trigger(&self, callback: CronTriggerCallback) {
        let mut guard = self.callback.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(callback);
    }

    fn get_logs(&self, limit: Option<usize>) -> Vec<CronLogEntry> {
        let logs = self.logs.lock().unwrap_or_else(|p| p.into_inner());
        let take = limit.unwrap_or(MAX_LOGS);
        logs.iter().take(take).cloned().collect()
    }

    fn clear_logs(&self) {
        let mut logs = self.logs.lock().unwrap_or_else(|p| p.into_inner());
        logs.clear();
        self.flush_logs(&logs);
    }

    fn consume_notifications(&self) -> Vec<CronNotification> {
        let mut notes = self.notifications.lock().unwrap_or_else(|p| p.into_inner());
        let out = std::mem::take(&mut *notes);
        self.flush_notifications(&notes);
        out
    }

    fn append_notify(&self, entry: CronNotification) {
        let mut notes = self.notifications.lock().unwrap_or_else(|p| p.into_inner());
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

    /// 부팅 시 영속 파일에 설정되어 있던 잡들 task 재시작.
    /// delay 잡은 복원 불가 (시각 정보 부재), cron / once 만 복원.
    async fn restore(self: Arc<Self>) {
        // 부팅 시 옛 알림 초기화 — 재시작 후 옛 알림이 한꺼번에 뜨는 것 방지 (옛 TS 1:1).
        {
            let mut notes = self.notifications.lock().unwrap_or_else(|p| p.into_inner());
            notes.clear();
            self.flush_notifications(&notes);
        }

        let now_ms = Utc::now().timestamp_millis();
        let tz_name = self.timezone.lock().unwrap_or_else(|p| p.into_inner()).clone();

        // 만료 / 과거 1회 잡은 복원 안 함 (옛 TS restore 의 endAt + once+runAt 검사 1:1).
        let to_remove: Vec<String> = {
            let jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
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
            let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
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
                if let Some(sender) = tx_clone.lock().unwrap_or_else(|p| p.into_inner()).take() {
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

        // 로그 설정
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
