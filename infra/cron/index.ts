import { ICronPort, CronScheduleOptions, CronJobResult, CronTriggerInfo, ILogPort, PipelineStep } from '../../core/ports';
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
  inputData?: any;
  pipeline?: PipelineStep[];
  createdAt: string;
  mode: 'cron' | 'once' | 'delay';
}

/** 실행 로그 엔트리 */
export interface CronLogEntry {
  jobId: string;
  targetPath: string;
  triggeredAt: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

import { CRON_JOBS_FILE, CRON_LOGS_FILE, CRON_NOTIFY_FILE, CRON_MAX_LOGS, CRON_DEFAULT_TIMEZONE, CRON_RECENT_NOTIFY_MS } from '../config';

const JOBS_FILE = CRON_JOBS_FILE;
const LOGS_FILE = CRON_LOGS_FILE;
const NOTIFY_FILE = CRON_NOTIFY_FILE;
const MAX_LOGS = CRON_MAX_LOGS;
const DEFAULT_TIMEZONE = CRON_DEFAULT_TIMEZONE;

export class NodeCronAdapter implements ICronPort {
  private cronTasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private records: Map<string, CronJobRecord> = new Map();
  private log?: ILogPort;
  private timezone: string = DEFAULT_TIMEZONE;
  private triggerCallback?: (info: CronTriggerInfo) => Promise<CronJobResult>;

  constructor() {}

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
      if (fs.existsSync(NOTIFY_FILE)) fs.writeFileSync(NOTIFY_FILE, '[]');
    } catch {}
    try {
      if (!fs.existsSync(JOBS_FILE)) return;
      const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
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

      const { cronTime, runAt, delaySec, startAt, endAt, inputData, pipeline, title, description } = opts;

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
    return Array.from(this.records.values()).map(r => ({
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
    }));
  }

  getLogs(limit: number = 50): CronLogEntry[] {
    try {
      if (!fs.existsSync(LOGS_FILE)) return [];
      const logs: CronLogEntry[] = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
      return logs.slice(-limit);
    } catch { return []; }
  }

  clearLogs(): void {
    try {
      if (fs.existsSync(LOGS_FILE)) fs.writeFileSync(LOGS_FILE, '[]');
    } catch {}
  }

  // ── 내부 등록 로직 ──────────────────────────────────────────────────────

  private registerCron(record: CronJobRecord): void {
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

      await this.fireTrigger(record.jobId, record.targetPath, 'CRON_SCHEDULER', record.inputData, record.pipeline);
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
      await this.fireTrigger(record.jobId, record.targetPath, 'SCHEDULED_ONCE', record.inputData, record.pipeline);
    }, msUntilRun);
    this.timers.set(record.jobId, timer);
  }

  private registerDelay(record: CronJobRecord): void {
    const timer = setTimeout(async () => {
      this.timers.delete(record.jobId);
      this.records.delete(record.jobId);
      await this.fireTrigger(record.jobId, record.targetPath, 'DELAYED_RUN', record.inputData, record.pipeline);
    }, record.delaySec! * 1000);
    this.timers.set(record.jobId, timer);
  }

  /** 트리거 발화 — Core에 실행 위임, 결과를 로그에 기록 */
  private async fireTrigger(jobId: string, targetPath: string, trigger: string, inputData?: any, pipeline?: PipelineStep[]): Promise<void> {
    if (!this.triggerCallback) {
      this.log?.error(`[Cron] 트리거 콜백 미등록 — 잡 실행 불가: ${jobId}`);
      return;
    }

    this.log?.info(`[Cron] 트리거 발화: ${jobId} → ${targetPath || '(pipeline)'} (${trigger})`);
    try {
      const result = await this.triggerCallback({ jobId, targetPath, trigger, inputData, pipeline });
      this.log?.[result.success ? 'info' : 'error'](`[Cron] 잡 ${result.success ? '완료' : '실패'}: ${jobId} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ''}`);
      this.appendLog({ jobId, targetPath, triggeredAt: new Date().toISOString(), success: result.success, durationMs: result.durationMs, error: result.error });
    } catch (e: any) {
      this.log?.error(`[Cron] 트리거 콜백 오류: ${jobId} — ${e.message}`);
      this.appendLog({ jobId, targetPath, triggeredAt: new Date().toISOString(), success: false, durationMs: 0, error: e.message });
    }
  }

  // ── 영속 저장 ──────────────────────────────────────────────────────────

  private persist(): void {
    try {
      const dir = path.dirname(JOBS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // delay 모드는 저장하지 않음
      const saveable = Array.from(this.records.values()).filter(r => r.mode !== 'delay');
      fs.writeFileSync(JOBS_FILE, JSON.stringify(saveable, null, 2));
    } catch (e: any) {
      this.log?.error(`[Cron] 잡 저장 실패: ${e.message}`);
    }
  }

  /** 특정 잡의 알림 제거 (잡 해제 시) */
  private clearNotificationsFor(jobId: string): void {
    try {
      if (!fs.existsSync(NOTIFY_FILE)) return;
      const items = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf-8'));
      const filtered = items.filter((n: any) => n.jobId !== jobId);
      fs.writeFileSync(NOTIFY_FILE, JSON.stringify(filtered, null, 2));
    } catch {}
  }

  /** 알림 조회 후 파일 비우기 (클라이언트가 폴링) */
  consumeNotifications(): { jobId: string; url: string; triggeredAt: string }[] {
    try {
      if (!fs.existsSync(NOTIFY_FILE)) return [];
      const raw = fs.readFileSync(NOTIFY_FILE, 'utf-8');
      const items = JSON.parse(raw);
      if (items.length === 0) return [];
      // 30초 이상 된 알림은 버림 (서버 재시작 시 쌓인 알림 방지)
      const now = Date.now();
      const fresh = items.filter((n: any) => now - new Date(n.triggeredAt).getTime() < CRON_RECENT_NOTIFY_MS);
      fs.writeFileSync(NOTIFY_FILE, '[]');
      return fresh;
    } catch { return []; }
  }

  appendNotify(entry: { jobId: string; url: string; triggeredAt: string }): void {
    try {
      let items: any[] = [];
      if (fs.existsSync(NOTIFY_FILE)) {
        items = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf-8'));
      }
      items.push(entry);
      const dir = path.dirname(NOTIFY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(NOTIFY_FILE, JSON.stringify(items, null, 2));
    } catch (e: any) {
      this.log?.error(`[Cron] 알림 저장 실패: ${e.message}`);
    }
  }

  private appendLog(entry: CronLogEntry): void {
    try {
      let logs: CronLogEntry[] = [];
      if (fs.existsSync(LOGS_FILE)) {
        logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
      }
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
      fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
    } catch (e: any) {
      this.log?.error(`[Cron] 로그 저장 실패: ${e.message}`);
    }
  }
}
