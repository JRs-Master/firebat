/**
 * StatusManager — 작업 상태 단일 진실의 source.
 *
 * 배경 (CLAUDE.md "마스터 패턴 — StatusManager + Observability 통합"):
 *   지금까지 fix 한 다수 UX 문제가 같은 root cause — 인프라에 통합 status 가 없어
 *   각 layer 가 자기 콜백으로 자기 신호만 보냄.
 *   - 로봇 사라짐 (CLI chunk timing)
 *   - 이미지 60초 침묵
 *   - cron 백그라운드 가시화 X
 *   - AI 도구 호출 흐름 추적 불가
 *   - 비용 폭탄 (timeout retry — 진행 status 가시화 됐으면 인지 후 정지 가능)
 *
 * 해법 — 작업 시작·진행·완료를 한 곳에서 관리. 3축 활용:
 *   1. UI subscribe (EventManager 통한 SSE) — 진행도·취소 버튼
 *   2. AI 비동기 도구 패턴 (start/status polling)
 *   3. Observability hook — Sentry / 메트릭 자동 forward
 *
 * BIBLE 준수:
 *   - SSE 발행은 Core facade 에서. StatusManager 는 EventManager.emit 호출만.
 *   - 매니저 직접 호출 X — Core facade 의 startJob/updateJobStatus/completeJob/errorJob 경유.
 *
 * Step 1 (현재): backbone 만 — start/update/done/error/get/list/subscribe + SSE emit + GC.
 * Step 2~4 (후속): ImageManager/TaskManager/ScheduleManager 마이그레이션.
 */
import type { ILogPort } from '../ports';
import type { EventManager } from './event-manager';

/** 작업 분류 — UI 그루핑·필터·자동 forward 룰 매칭에 사용 */
export type JobType = 'tool' | 'pipeline' | 'cron' | 'image' | 'sandbox' | 'llm' | 'custom';

/** 작업 상태 머신 */
export type JobStatusKind = 'queued' | 'running' | 'done' | 'error';

export interface JobStatus {
  /** 호출자가 발급 또는 자동 (uuid 형식) */
  id: string;
  /** 작업 분류 */
  type: JobType;
  /** 현재 상태 */
  status: JobStatusKind;
  /** 진행도 0~1 (선택). 비결정 작업은 미설정 */
  progress?: number;
  /** 사용자 노출용 메시지 (예: "이미지 생성 중 (45/120초)") */
  message?: string;
  /** 시작 시각 (ms epoch) */
  startedAt: number;
  /** 마지막 update 시각 */
  updatedAt: number;
  /** 종료 시각 (status='done' | 'error' 일 때) */
  doneAt?: number;
  /** status='done' 일 때 결과 */
  result?: unknown;
  /** status='error' 일 때 에러 메시지 */
  error?: string;
  /** 도구 호출 → sub-task 추적 (parent jobId) */
  parentJobId?: string;
  /** 도메인별 추가 메타 (예: { imageSlug, cronJobId, modulePath, tokenUsage }) */
  meta?: Record<string, unknown>;
}

/** 작업 변화 알림 */
export type JobChangeKind = 'created' | 'updated' | 'completed' | 'failed';

export interface JobChangeEvent {
  job: JobStatus;
  change: JobChangeKind;
}

type JobChangeListener = (event: JobChangeEvent) => void;

/** GC·메모리 한도 — 일반 로직 (특정 작업 분류 무관) */
const ACTIVE_JOB_RETENTION_MS = 60 * 60 * 1000;     // 종료된 job 1시간 후 자동 정리
const MAX_JOB_HISTORY = 200;                          // 메모리 cap (오래된 종료 작업 우선 제거)
const GC_INTERVAL_MS = 10 * 60 * 1000;                // 10분마다 GC 스윕

export class StatusManager {
  /** id → JobStatus 메모리 저장. 종료된 작업은 GC 가 정리 */
  private jobs = new Map<string, JobStatus>();
  /** 변화 감지 subscriber (UI·Sentry forward·Cost tracker 등) */
  private listeners = new Set<JobChangeListener>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private logger: ILogPort,
    private events: EventManager,
  ) {
    // 주기적 GC — 종료된 오래된 작업 정리. unref 로 프로세스 종료 방해 X
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    if (typeof this.gcTimer === 'object' && 'unref' in this.gcTimer) {
      (this.gcTimer as { unref?: () => void }).unref?.();
    }
  }

  /** 작업 시작 등록. id 미지정 시 자동 발급 (timestamp + random) */
  start(opts: {
    id?: string;
    type: JobType;
    message?: string;
    parentJobId?: string;
    meta?: Record<string, unknown>;
  }): JobStatus {
    const id = opts.id ?? this.generateId(opts.type);
    const now = Date.now();
    const job: JobStatus = {
      id,
      type: opts.type,
      status: 'running',  // 등록 즉시 running. queued 상태는 외부 큐 패턴 필요 시 별도
      startedAt: now,
      updatedAt: now,
      ...(opts.message ? { message: opts.message } : {}),
      ...(opts.parentJobId ? { parentJobId: opts.parentJobId } : {}),
      ...(opts.meta ? { meta: opts.meta } : {}),
    };
    this.jobs.set(id, job);
    this.notifyChange(job, 'created');
    return job;
  }

  /** 진행도·메시지·메타 갱신. 종료된 작업에 update 호출은 무시 (warning 로그) */
  update(id: string, patch: { progress?: number; message?: string; meta?: Record<string, unknown> }): JobStatus | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'error') {
      this.logger.warn(`[StatusManager] update on terminal job id=${id} status=${job.status} — 무시`);
      return job;
    }
    if (typeof patch.progress === 'number') job.progress = Math.max(0, Math.min(1, patch.progress));
    if (typeof patch.message === 'string') job.message = patch.message;
    if (patch.meta) job.meta = { ...(job.meta ?? {}), ...patch.meta };
    job.updatedAt = Date.now();
    this.notifyChange(job, 'updated');
    return job;
  }

  /** 정상 완료. result 는 도메인별 (이미지 slug · pipeline 결과 등) */
  done(id: string, result?: unknown): JobStatus | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'error') return job;
    job.status = 'done';
    job.result = result;
    job.doneAt = Date.now();
    job.updatedAt = job.doneAt;
    this.notifyChange(job, 'completed');
    return job;
  }

  /** 실패 종료. error 메시지는 사용자 노출 가능 형태 권장 */
  error(id: string, msg: string): JobStatus | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'error') return job;
    job.status = 'error';
    job.error = msg;
    job.doneAt = Date.now();
    job.updatedAt = job.doneAt;
    this.notifyChange(job, 'failed');
    return job;
  }

  /** 단일 조회 */
  get(id: string): JobStatus | null {
    return this.jobs.get(id) ?? null;
  }

  /** 필터 조회 — 활성 작업·특정 type·이후 시점 등.
   *  filter 모두 미지정 시 메모리에 남아있는 모든 작업 반환 (최신순). */
  list(filter?: {
    type?: JobType;
    status?: JobStatusKind | JobStatusKind[];
    since?: number;
    parentJobId?: string;
    limit?: number;
  }): JobStatus[] {
    const jobs = Array.from(this.jobs.values());
    const statusFilter = filter?.status
      ? (Array.isArray(filter.status) ? filter.status : [filter.status])
      : null;
    const filtered = jobs.filter(j => {
      if (filter?.type && j.type !== filter.type) return false;
      if (statusFilter && !statusFilter.includes(j.status)) return false;
      if (filter?.since && j.startedAt < filter.since) return false;
      if (filter?.parentJobId && j.parentJobId !== filter.parentJobId) return false;
      return true;
    });
    filtered.sort((a, b) => b.startedAt - a.startedAt);
    return filter?.limit ? filtered.slice(0, filter.limit) : filtered;
  }

  /** 변화 감지 subscribe — UI 갱신·Sentry forward·Cost tracker 등이 등록.
   *  unsubscribe handle 반환. */
  subscribe(handler: JobChangeListener): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  /** 디버깅 — 현재 메모리 상태 요약 */
  getStats(): { total: number; running: number; done: number; error: number; listeners: number } {
    let running = 0, done = 0, error = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'running' || j.status === 'queued') running++;
      else if (j.status === 'done') done++;
      else if (j.status === 'error') error++;
    }
    return { total: this.jobs.size, running, done, error, listeners: this.listeners.size };
  }

  /** 테스트·셧다운용 — GC 타이머 정리 */
  shutdown(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Private — id 발급, GC, 알림 fanout
  // ────────────────────────────────────────────────────────────────────────

  /** id 자동 발급 — type + timestamp + random hex. 일반 로직, 특정 도메인 분기 0 */
  private generateId(type: JobType): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${type}-${ts}-${rand}`;
  }

  /** 종료된 오래된 작업 정리 + 메모리 cap 적용 */
  private gc(): void {
    const now = Date.now();
    let evicted = 0;
    // 1) 종료 후 retention 지난 작업 제거
    for (const [id, job] of this.jobs) {
      if ((job.status === 'done' || job.status === 'error')
          && job.doneAt
          && now - job.doneAt > ACTIVE_JOB_RETENTION_MS) {
        this.jobs.delete(id);
        evicted++;
      }
    }
    // 2) 메모리 cap 초과 시 오래된 종료 작업 우선 제거 (활성 작업은 유지)
    if (this.jobs.size > MAX_JOB_HISTORY) {
      const terminal = Array.from(this.jobs.values())
        .filter(j => j.status === 'done' || j.status === 'error')
        .sort((a, b) => (a.doneAt ?? a.updatedAt) - (b.doneAt ?? b.updatedAt));
      const toRemove = this.jobs.size - MAX_JOB_HISTORY;
      for (let i = 0; i < toRemove && i < terminal.length; i++) {
        this.jobs.delete(terminal[i].id);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.debug(`[StatusManager] GC: ${evicted}개 작업 정리, 현재 ${this.jobs.size}개`);
    }
  }

  /** subscriber + EventManager (SSE) 양쪽으로 변화 fanout.
   *  subscriber 한 명 throw 가 다른 subscriber·SSE 영향 X (try/catch 격리). */
  private notifyChange(job: JobStatus, change: JobChangeKind): void {
    // 1) 내부 subscriber (Sentry forward·Cost tracker·UI 인디케이터 등)
    const event: JobChangeEvent = { job, change };
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[StatusManager] subscriber failed (jobId=${job.id} change=${change}): ${msg}`);
      }
    }
    // 2) EventManager (SSE) — Frontend useEvents(['status:update']) 가 받음
    try {
      this.events.emit({
        type: 'status:update',
        data: { job, change },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[StatusManager] SSE emit failed: ${msg}`);
    }
  }
}
