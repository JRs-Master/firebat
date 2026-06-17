'use client';

/**
 * ActiveJobs store — StatusManager 의 SSE 'status:update' 를 **모듈 레벨 싱글톤**으로 유지.
 *
 * 왜 싱글톤인가: 옛 ActiveJobsIndicator 는 jobs Map 을 컴포넌트 useState 에 들고 있어,
 * 패널을 바꾸거나(언마운트) 다른 화면을 보고 오면 상태가 초기화 → **뱃지·스피너가 사라짐**.
 * 게다가 cron 은 진행 중 'update' 이벤트가 없어(started/completed 2발), 돌아온 직후엔 다음
 * completed 까지 빈 화면. → 작업 상태는 컴포넌트 수명과 분리된 store 에 둬야 한다.
 *
 * store 는 bus(SSE)에 한 번만 구독(앱 수명 유지)하므로, 화면을 떠나 있어도 status:update 를
 * 계속 받아 Map 을 갱신. 컴포넌트는 useActiveJobs()로 현재 스냅샷을 즉시 읽음(remount 시 복원).
 *
 * 이걸로 한 번에 해결:
 *   - 뱃지(ActiveJobsIndicator) 가 패널 전환 후에도 유지
 *   - CronPanel 스피너가 **어디서 실행하든**(캘린더/워크스페이스/스케줄) 그 잡 row 에서 회전,
 *     화면을 떠났다 와도 회전, 완료되면 원래 아이콘 복귀 (meta.jobId 로 매칭)
 */

import { useEffect, useState } from 'react';
import { subscribeServerEvents } from './events-manager';
import { STALE_RUNNING_MS } from '../../../lib/config';

export interface JobStatus {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress?: number;
  message?: string;
  startedAt: number;
  updatedAt: number;
  doneAt?: number;
  result?: unknown;
  error?: string;
  parentJobId?: string;
  meta?: Record<string, unknown>;
}

const FINISHED_RETENTION_MS = 5_000;
const SWEEP_INTERVAL_MS = 30_000;

class ActiveJobsStore {
  private jobs = new Map<string, JobStatus>();
  private subs = new Set<() => void>();
  private started = false;

  /** 첫 useActiveJobs() 구독 시 1회 — bus 구독 + stale sweep 타이머. 이후 앱 수명 유지. */
  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    subscribeServerEvents((ev) => {
      if (ev.type !== 'status:update') return;
      const payload = ev.data as { job: JobStatus; change: string } | undefined;
      if (!payload?.job) return;
      const { job, change } = payload;
      this.jobs.set(job.id, job);
      this.notify();
      // 종료 작업은 retention 후 자동 제거 (사용자가 결과 인지). 라벨 + terminal status 둘 다 인정.
      if (change === 'completed' || change === 'failed' || job.status === 'done' || job.status === 'error') {
        setTimeout(() => {
          if (this.jobs.delete(job.id)) this.notify();
        }, FINISHED_RETENTION_MS);
      }
    });
    // stale 청소 — SSE drop(모바일 백그라운드) 으로 completed 못 받아 running 박제되는 것 방어.
    if (typeof window !== 'undefined') {
      setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const [id, j] of this.jobs) {
          if ((j.status === 'running' || j.status === 'queued') && now - j.updatedAt > STALE_RUNNING_MS) {
            this.jobs.delete(id);
            changed = true;
          }
        }
        if (changed) this.notify();
      }, SWEEP_INTERVAL_MS);
    }
  }

  subscribe(cb: () => void): () => void {
    this.ensureStarted();
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  private notify() {
    for (const cb of this.subs) cb();
  }

  list(): JobStatus[] {
    return Array.from(this.jobs.values());
  }
}

const store = new ActiveJobsStore();

/** 현재 작업 목록(스냅샷). store 가 모듈 레벨이라 remount 시 즉시 복원 = 화면 전환에도 유지. */
export function useActiveJobs(): JobStatus[] {
  const [jobs, setJobs] = useState<JobStatus[]>(() => store.list());
  useEffect(() => {
    setJobs(store.list()); // mount 시점 스냅샷 동기 (이미 진행 중인 작업 복원)
    return store.subscribe(() => setJobs(store.list()));
  }, []);
  return jobs;
}

/** 특정 cron jobId 가 현재 실행 중인지 판정하는 함수 반환 (meta.jobId 매칭).
 *  CronPanel row 스피너용 — 어느 경로(캘린더/워크스페이스/스케줄)로 트리거됐든 동작. */
export function useRunningCronJobs(): (jobId: string) => boolean {
  const jobs = useActiveJobs();
  const running = new Set(
    jobs
      .filter((j) => j.status === 'running' || j.status === 'queued')
      .map((j) => (j.meta?.jobId as string | undefined) || '')
      .filter(Boolean),
  );
  return (jobId: string) => running.has(jobId);
}
