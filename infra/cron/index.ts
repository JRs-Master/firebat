import { ICronPort, CronScheduleOptions, CronJobResult, CronTriggerInfo, CronJobInfo, CronTriggerType, CronLogEntry, ILogPort, PipelineStep, CronRunWhen, CronRetry, CronNotify, CronExecutionMode } from '../../core/ports';
import { InfraResult } from '../../core/types';
import cron, { ScheduledTask } from 'node-cron';
import fs from 'fs';
import path from 'path';

/** 영속 저장용 잡 레코드 */
interface CronJobRecord {
  jobId: string;
  targetPath: string;
  title?: string;
  description?: string;
  cronTime?: string;
  runAt?: string;
  delaySec?: number;
  startAt?: string;
  endAt?: string;
  inputData?: Record<string, unknown>;
  pipeline?: PipelineStep[];
  oneShot?: boolean;
  createdAt: string;
  mode: CronJobInfo['mode'];
  /** 발화 전 조건 체크 — 미충족 시 skip */
  runWhen?: CronRunWhen;
  /** 자동 retry 정책 */
  retry?: CronRetry;
  /** 결과 알림 hook */
  notify?: CronNotify;
  /** 실행 모드 (pipeline 기본) */
  executionMode?: CronExecutionMode;
  /** agent 모드 prompt */
  agentPrompt?: string;
}

// CronLogEntry는 core/ports에서 import (포트 정의가 정본)

import { CRON_JOBS_FILE, CRON_LOGS_FILE, CRON_NOTIFY_FILE, CRON_MAX_LOGS, CRON_DEFAULT_TIMEZONE, CRON_RECENT_NOTIFY_MS } from '../config';

const MAX_LOGS = CRON_MAX_LOGS;
const DEFAULT_TIMEZONE = CRON_DEFAULT_TIMEZONE;

/** 옵션 — 테스트 격리·다중 인스턴스 시 파일 경로 override.
 *  미지정 시 infra/config 의 기본 경로 (data/cron-*.json) 사용. */
export interface NodeCronAdapterOptions {
  jobsFile?: string;
  logsFile?: string;
  notifyFile?: string;
}

export class NodeCronAdapter implements ICronPort {
  private cronTasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private records: Map<string, CronJobRecord> = new Map();
  private log?: ILogPort;
  private timezone: string = DEFAULT_TIMEZONE;
  private triggerCallback?: (info: CronTriggerInfo) => Promise<CronJobResult>;
  private readonly jobsFile: string;
  private readonly logsFile: string;
  private readonly notifyFile: string;

  constructor(opts?: NodeCronAdapterOptions) {
    this.jobsFile = opts?.jobsFile ?? CRON_JOBS_FILE;
    this.logsFile = opts?.logsFile ?? CRON_LOGS_FILE;
    this.notifyFile = opts?.notifyFile ?? CRON_NOTIFY_FILE;
  }

  /** 타임존 설정 (IANA 형식: Asia/Seoul, America/New_York 등) */
  setTimezone(tz: string) { this.timezone = tz; }

  /** 현재 설정된 타임존 조회 */
  getTimezone(): string { return this.timezone; }

  setLogger(log: ILogPort) { this.log = log; }

  onTrigger(callback: (info: CronTriggerInfo) => Promise<CronJobResult>): void {
    this.triggerCallback = callback;
  }

  /**
   * 타임존 정보가 없는 날짜 문자열을 설정된 타임존 기준으로 해석하여 UTC ms를 반환.
   * 예: "2026-04-14T12:48:00" + timezone="Asia/Seoul" → 03:48 UTC
   */
  private parseInTimezone(dateStr: string): number {
    // 이미 타임존 정보가 있으면 그대로 파싱
    if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(dateStr)) {
      return new Date(dateStr).getTime();
    }
    // dateStr을 UTC로 간주하여 파싱
    const asUtc = new Date(dateStr + 'Z').getTime();
    // 설정된 타임존에서 그 시각이 몇 시인지 확인하여 offset 계산
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(asUtc));
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
    const tzLocalStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`;
    const tzLocal = new Date(tzLocalStr).getTime();
    const offset = tzLocal - asUtc; // 양수 = UTC보다 앞 (예: Asia/Seoul = +9h)
    return asUtc - offset;
  }

  /** 부팅 시 저장된 잡 복원 */
  restore(): void {
    // 부팅 시 쌓인 알림 초기화 (재시작 후 옛 알림이 한꺼번에 뜨는 것 방지)
    try {
      if (fs.existsSync(this.notifyFile)) fs.writeFileSync(this.notifyFile, '[]');
    } catch (e: any) {
      this.log?.debug(`[Cron] notify 초기화 실패 (silent): ${e?.message ?? String(e)}`);
    }
    try {
      if (!fs.existsSync(this.jobsFile)) return;
      const raw = fs.readFileSync(this.jobsFile, 'utf-8');
      const jobs: CronJobRecord[] = JSON.parse(raw);
      let restored = 0;
      const now = Date.now();

      for (const job of jobs) {
        // 만료된 잡은 복원하지 않음
        if (job.endAt && this.parseInTimezone(job.endAt) <= now) continue;

        // 일회성(runAt) 잡이 이미 지났으면 스킵
        if (job.mode === 'once' && job.runAt && this.parseInTimezone(job.runAt) <= now) continue;

        // delay 잡은 메모리 전용이므로 복원 불가
        if (job.mode === 'delay') continue;

        if (job.mode === 'cron' && job.cronTime) {
          if (!cron.validate(job.cronTime)) continue;
          this.registerCron(job);
          restored++;
        } else if (job.mode === 'once' && job.runAt) {
          this.registerOnce(job);
          restored++;
        }
      }
      this.log?.info(`[Cron] ${restored}개 잡 복원 완료`);
    } catch (e: any) {
      this.log?.error(`[Cron] 잡 복원 실패: ${e.message}`);
    }
  }

  /** 통합 스케줄링 등록 */
  async schedule(jobId: string, targetPath: string, opts: CronScheduleOptions): Promise<InfraResult<void>> {
    try {
      if (this.cronTasks.has(jobId) || this.timers.has(jobId)) {
        return { success: false, error: `이미 등록된 잡 ID입니다: ${jobId}` };
      }

      const { cronTime, runAt, delaySec, startAt, endAt, inputData, pipeline, title, description, oneShot, runWhen, retry, notify, executionMode, agentPrompt } = opts;

      // 유효성 검사
      if (!cronTime && !runAt && delaySec == null) {
        return { success: false, error: 'cronTime, runAt, delaySec 중 하나는 필수입니다.' };
      }
      if (cronTime && !cron.validate(cronTime)) {
        return { success: false, error: `잘못된 CRON 표현식: ${cronTime}` };
      }
      if (delaySec != null && (delaySec < 1 || delaySec > 86400)) {
        return { success: false, error: `지연 시간은 1~86400초 사이: ${delaySec}초` };
      }

      const now = new Date();
      const record: CronJobRecord = {
        jobId, targetPath,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        cronTime, runAt, delaySec, startAt, endAt,
        ...(inputData !== undefined ? { inputData } : {}),
        ...(pipeline ? { pipeline } : {}),
        ...(oneShot ? { oneShot } : {}),
        ...(runWhen ? { runWhen } : {}),
        ...(retry ? { retry } : {}),
        ...(notify ? { notify } : {}),
        ...(executionMode ? { executionMode } : {}),
        ...(agentPrompt ? { agentPrompt } : {}),
        createdAt: now.toISOString(),
        mode: cronTime ? 'cron' : (runAt ? 'once' : 'delay'),
      };

      if (cronTime) {
        // 반복 스케줄
        this.registerCron(record);
      } else if (runAt) {
        // 특정 시각 1회 실행 (타임존 보정)
        const runTime = this.parseInTimezone(runAt);
        if (runTime <= now.getTime()) {
          return { success: false, error: `runAt이 과거 시각입니다: ${runAt}` };
        }
        this.registerOnce(record);
      } else if (delaySec != null) {
        // N초 후 1회 실행
        this.registerDelay(record);
      }

      this.records.set(jobId, record);
      // delay 모드는 영속 저장하지 않음 (PM2 재시작 시 복원 불가)
      if (record.mode !== 'delay') this.persist();

      const modeLabel = cronTime ? `반복 (${cronTime})` : (runAt ? `1회 (${runAt})` : `${delaySec}초 후 1회`);
      this.log?.info(`[Cron] 잡 등록: ${jobId} → ${targetPath} [${modeLabel}]${endAt ? ` ~${endAt}` : ''}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 잡 즉시 발화 — 기존 record 로 fireTrigger 호출. cron-logs 기록 보장. */
  async triggerNow(jobId: string): Promise<InfraResult<void>> {
    let record = this.records.get(jobId);
    // 메모리 비어있으면 파일 폴백 (Next.js multi-isolate 안전망)
    if (!record) {
      try {
        if (fs.existsSync(this.jobsFile)) {
          const jobs: CronJobRecord[] = JSON.parse(fs.readFileSync(this.jobsFile, 'utf-8'));
          record = jobs.find(j => j.jobId === jobId);
        }
      } catch (e: any) {
        this.log?.debug(`[Cron] triggerNow 파일 폴백 실패 (silent): ${e?.message ?? String(e)}`);
      }
    }
    if (!record) return { success: false, error: `잡을 찾을 수 없음: ${jobId}` };
    // fire-and-forget — fireTrigger 안에서 cron-logs 기록 + triggerCallback 호출
    this.fireTrigger(record, 'DELAYED_RUN').catch((e: any) => {
      this.log?.error(`[Cron] triggerNow 실행 실패: ${jobId} — ${e.message}`);
    });
    return { success: true };
  }

  async cancel(jobId: string): Promise<InfraResult<void>> {
    try {
      const task = this.cronTasks.get(jobId);
      const timer = this.timers.get(jobId);
      if (!task && !timer) return { success: false, error: `존재하지 않는 잡: ${jobId}` };

      if (task) { task.stop(); this.cronTasks.delete(jobId); }
      if (timer) { clearTimeout(timer); this.timers.delete(jobId); }
      this.records.delete(jobId);
      this.persist();
      this.clearNotificationsFor(jobId);

      this.log?.info(`[Cron] 잡 해제: ${jobId}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  list() {
    // 1차: 메모리 records (정상 boot 후 사용)
    if (this.records.size > 0) {
      return this.toListEntries(Array.from(this.records.values()));
    }
    // 2차: 파일 폴백 — records 비어있으면 cron-jobs.json 직접 읽어 응답.
    // **self-heal restore() 호출 안 함** — Next.js 16 의 module isolate 분리로 같은 process 안에
    // N isolate 가 globalThis 별로 분리되어 각자 firebatInfra 만들 수 있음. 각 isolate 가 list()
    // 호출 시 self-heal restore() 발동하면 그 isolate 에 cron task 추가 등록 → 같은 cronTime 매칭
    // 시 N번 fireTrigger → 2026-04-29 ENOENT race condition 의 직접 원인.
    // 발화는 boot 시점 (main isolate) 의 cron task 1개로 충분. 다른 isolate 의 list() 는
    // file 만 읽어 응답 — cron task 등록 X.
    try {
      if (!fs.existsSync(this.jobsFile)) return [];
      const raw = fs.readFileSync(this.jobsFile, 'utf-8');
      const jobs: CronJobRecord[] = JSON.parse(raw);
      return this.toListEntries(jobs);
    } catch (e: any) {
      this.log?.error(`[Cron] list() 파일 폴백 실패: ${e.message}`);
      return [];
    }
  }

  /** 메모리 record / 파일 record → list 응답 entry 변환 (DRY) */
  private toListEntries(records: CronJobRecord[]) {
    return records.map(r => ({
      jobId: r.jobId,
      targetPath: r.targetPath,
      title: r.title,
      description: r.description,
      cronTime: r.cronTime,
      runAt: r.runAt,
      delaySec: r.delaySec,
      startAt: r.startAt,
      endAt: r.endAt,
      inputData: r.inputData,
      pipeline: r.pipeline,
      createdAt: r.createdAt,
      mode: r.mode,
      runWhen: r.runWhen,
      retry: r.retry,
      notify: r.notify,
      executionMode: r.executionMode,
      agentPrompt: r.agentPrompt,
    }));
  }

  getLogs(limit: number = 50): CronLogEntry[] {
    try {
      if (!fs.existsSync(this.logsFile)) {
        this.log?.warn(`[Cron] getLogs: this.logsFile 없음 (${this.logsFile})`);
        return [];
      }
      const raw = fs.readFileSync(this.logsFile, 'utf-8');
      const logs: CronLogEntry[] = JSON.parse(raw);
      return logs.slice(-limit);
    } catch (e: any) {
      this.log?.error(`[Cron] getLogs 실패: ${e.message} (path=${this.logsFile})`);
      return [];
    }
  }

  clearLogs(): void {
    try {
      if (fs.existsSync(this.logsFile)) fs.writeFileSync(this.logsFile, '[]');
    } catch {}
  }

  // ── 내부 등록 로직 ──────────────────────────────────────────────────────

  private registerCron(record: CronJobRecord): void {
    // 중복 등록 방지 — restore() / self-heal 다회 호출 시 옛 task 가 node-cron 내부에
    // 살아남아 cronTime 매칭마다 N번 발화하는 버그 회피. Map.set 만으로는 옛 task stop 안 됨.
    const existing = this.cronTasks.get(record.jobId);
    if (existing) {
      existing.stop();
      this.cronTasks.delete(record.jobId);
    }
    const task = cron.schedule(record.cronTime!, async () => {
      const now = Date.now();

      if (record.startAt && now < this.parseInTimezone(record.startAt)) return;

      if (record.endAt && now >= this.parseInTimezone(record.endAt)) {
        this.log?.info(`[Cron] 기간 만료 자동 해제: ${record.jobId}`);
        task.stop();
        this.cronTasks.delete(record.jobId);
        this.records.delete(record.jobId);
        this.persist();
        return;
      }

      await this.fireTrigger(record, 'CRON_SCHEDULER');
    }, { timezone: this.timezone });
    this.cronTasks.set(record.jobId, task);

    // endAt이 있으면 만료 시 자동 해제 타이머 (크론 틱 사이에 만료될 경우 대비)
    if (record.endAt) {
      const msUntilEnd = this.parseInTimezone(record.endAt) - Date.now();
      if (msUntilEnd > 0) {
        setTimeout(() => {
          if (this.cronTasks.has(record.jobId)) {
            this.log?.info(`[Cron] 기간 만료 자동 해제: ${record.jobId}`);
            task.stop();
            this.cronTasks.delete(record.jobId);
            this.records.delete(record.jobId);
            this.persist();
          }
        }, msUntilEnd);
      }
    }
  }

  private registerOnce(record: CronJobRecord): void {
    const msUntilRun = this.parseInTimezone(record.runAt!) - Date.now();
    if (msUntilRun <= 0) return;

    const timer = setTimeout(async () => {
      this.timers.delete(record.jobId);
      this.records.delete(record.jobId);
      this.persist();
      await this.fireTrigger(record, 'SCHEDULED_ONCE');
    }, msUntilRun);
    this.timers.set(record.jobId, timer);
  }

  private registerDelay(record: CronJobRecord): void {
    const timer = setTimeout(async () => {
      this.timers.delete(record.jobId);
      this.records.delete(record.jobId);
      await this.fireTrigger(record, 'DELAYED_RUN');
    }, record.delaySec! * 1000);
    this.timers.set(record.jobId, timer);
  }

  /** 발화 중복 방지 lock — Next.js 16 의 isolate 분리로 같은 PM2 process 안에 N isolate 가
   *  각자 cron task 등록하면 cronTime 매칭 시 N번 fireTrigger 호출됨. atomic file create
   *  (flag: 'wx') 로 첫 isolate 만 lock 잡고 발화, 나머지는 throw 받고 skip.
   *
   *  lock path 는 분 단위 timestamp 포함 — 매 분마다 새 lock 파일이라 다음 발화는 자연 가능.
   *  옛 lock 파일은 누적되지만 lockfile 자체 작아 (~10 bytes) 실용 영향 무시. 별도 cleanup
   *  필요 없음 (사이즈 작고 cron 잡 수 한정).
   *
   *  반환: true = lock 잡음 (발화 진행), false = 다른 isolate 가 이미 발화 중 (skip). */
  private acquireFireLock(jobId: string): boolean {
    try {
      const dir = path.dirname(this.jobsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 분 단위 timestamp — 같은 분 안에 fireTrigger 재호출은 1번만 통과
      const minuteKey = Math.floor(Date.now() / 60000);
      const lockPath = path.join(dir, `.cron-fire-${jobId}-${minuteKey}.lock`);
      // atomic create — 이미 존재하면 EEXIST throw
      fs.writeFileSync(lockPath, `${process.pid}@${Date.now()}`, { flag: 'wx' });
      return true;
    } catch (e: any) {
      if (e.code === 'EEXIST') return false;
      // 다른 에러 (디스크 풀, 권한 등) — 안전 측 lock 잡음으로 간주 (기존 동작 보존)
      this.log?.warn(`[Cron] fireLock 시도 실패 (${e.code ?? e.message}) — lock 우회하고 발화`);
      return true;
    }
  }

  /** 트리거 발화 — Core에 실행 위임, 결과를 로그에 기록.
   *  Next.js isolate 분리로 같은 cronTime 에 N isolate 가 발화 시도해도 lock 으로 1회만 진행. */
  private async fireTrigger(record: CronJobRecord, trigger: CronTriggerType, attempt: number = 1): Promise<void> {
    const { jobId, targetPath, title } = record;
    if (!this.triggerCallback) {
      this.log?.error(`[Cron] 트리거 콜백 미등록 — 잡 실행 불가: ${jobId}`);
      return;
    }

    // isolate 중복 발화 차단 — 첫 isolate 만 진행. 단 attempt > 1 (retry) 은 lock 우회.
    if (attempt === 1 && !this.acquireFireLock(jobId)) {
      this.log?.info(`[Cron] 발화 skip (다른 isolate 가 같은 분 안에 진행 중): ${jobId}`);
      return;
    }

    const attemptLabel = attempt > 1 ? ` (retry ${attempt - 1}/${record.retry?.count ?? 0})` : '';
    this.log?.info(`[Cron] 트리거 발화: ${jobId} → ${targetPath || '(pipeline)'} (${trigger})${attemptLabel}`);
    let result: CronJobResult | undefined;
    try {
      result = await this.triggerCallback({
        jobId,
        targetPath,
        trigger,
        inputData: record.inputData,
        pipeline: record.pipeline,
        oneShot: record.oneShot,
        runWhen: record.runWhen,
        retry: record.retry,
        notify: record.notify,
        title: record.title,
        executionMode: record.executionMode,
        agentPrompt: record.agentPrompt,
      });
      const outputSummary = result.output ? ` output=${JSON.stringify(result.output).slice(0, 100)}` : '';
      const stepsSummary = result.stepsTotal != null ? ` steps=${result.stepsExecuted ?? '?'}/${result.stepsTotal}` : '';
      this.log?.[result.success ? 'info' : 'error'](`[Cron] 잡 ${result.success ? '완료' : '실패'}: ${jobId} (${result.durationMs}ms)${attemptLabel}${stepsSummary}${outputSummary}${result.error ? ` — ${result.error}` : ''}`);
      this.appendLog({
        jobId, targetPath, title, triggeredAt: new Date().toISOString(),
        success: result.success, durationMs: result.durationMs, error: result.error,
        ...(result.output ? { output: result.output } : {}),
        ...(result.stepsExecuted != null ? { stepsExecuted: result.stepsExecuted } : {}),
        ...(result.stepsTotal != null ? { stepsTotal: result.stepsTotal } : {}),
      });
    } catch (e: any) {
      this.log?.error(`[Cron] 트리거 콜백 오류: ${jobId}${attemptLabel} — ${e.message}`);
      this.appendLog({ jobId, targetPath, title, triggeredAt: new Date().toISOString(), success: false, durationMs: 0, error: e.message });
      result = { jobId, targetPath, trigger, success: false, durationMs: 0, error: e.message };
    }

    // retry 처리 — result.success === false + retry.count 미소진 시 delayMs 후 재발화.
    // 진짜 retry 박힘 (이전엔 옵션만 정의되고 작동 X). LLM API 일시 실패·ENOENT 자동 회복.
    if (result && !result.success && record.retry && record.retry.count > 0 && attempt <= record.retry.count) {
      const delay = record.retry.delayMs ?? 60000;
      this.log?.warn(`[Cron] retry 예약 ${attempt}/${record.retry.count} (${delay}ms 후): ${jobId} — ${result.error || '실패'}`);
      setTimeout(() => {
        this.fireTrigger(record, trigger, attempt + 1).catch((err) => {
          this.log?.error(`[Cron] retry 발화 실패: ${jobId} — ${err.message}`);
        });
      }, delay).unref();
    }
  }

  // ── 영속 저장 ──────────────────────────────────────────────────────────

  private persist(): void {
    try {
      const dir = path.dirname(this.jobsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // delay 모드는 저장하지 않음
      const saveable = Array.from(this.records.values()).filter(r => r.mode !== 'delay');
      fs.writeFileSync(this.jobsFile, JSON.stringify(saveable, null, 2));
    } catch (e: any) {
      this.log?.error(`[Cron] 잡 저장 실패: ${e.message}`);
    }
  }

  /** 특정 잡의 알림 제거 (잡 해제 시) */
  private clearNotificationsFor(jobId: string): void {
    try {
      if (!fs.existsSync(this.notifyFile)) return;
      const items = JSON.parse(fs.readFileSync(this.notifyFile, 'utf-8'));
      const filtered = (items as Array<{ jobId: string }>).filter(n => n.jobId !== jobId);
      fs.writeFileSync(this.notifyFile, JSON.stringify(filtered, null, 2));
    } catch {}
  }

  /** 알림 조회 후 파일 비우기 (클라이언트가 폴링) */
  consumeNotifications(): { jobId: string; url: string; triggeredAt: string }[] {
    try {
      if (!fs.existsSync(this.notifyFile)) return [];
      const raw = fs.readFileSync(this.notifyFile, 'utf-8');
      const items = JSON.parse(raw);
      if (items.length === 0) return [];
      // 30초 이상 된 알림은 버림 (서버 재시작 시 쌓인 알림 방지)
      const now = Date.now();
      const fresh = (items as Array<{ jobId: string; url: string; triggeredAt: string }>).filter(n => now - new Date(n.triggeredAt).getTime() < CRON_RECENT_NOTIFY_MS);
      fs.writeFileSync(this.notifyFile, '[]');
      return fresh;
    } catch { return []; }
  }

  appendNotify(entry: { jobId: string; url: string; triggeredAt: string }): void {
    try {
      let items: Array<{ jobId: string; url: string; triggeredAt: string }> = [];
      if (fs.existsSync(this.notifyFile)) {
        items = JSON.parse(fs.readFileSync(this.notifyFile, 'utf-8'));
      }
      items.push(entry);
      const dir = path.dirname(this.notifyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.notifyFile, JSON.stringify(items, null, 2));
    } catch (e: any) {
      this.log?.error(`[Cron] 알림 저장 실패: ${e.message}`);
    }
  }

  private appendLog(entry: CronLogEntry): void {
    try {
      let logs: CronLogEntry[] = [];
      if (fs.existsSync(this.logsFile)) {
        logs = JSON.parse(fs.readFileSync(this.logsFile, 'utf-8'));
      }
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
      fs.writeFileSync(this.logsFile, JSON.stringify(logs, null, 2));
    } catch (e: any) {
      this.log?.error(`[Cron] 로그 저장 실패: ${e.message}`);
    }
  }
}
