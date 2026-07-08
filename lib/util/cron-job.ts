import { safeJsonParse } from './json';

/**
 * proto CronJobPb 의 *Json 문자열 필드를 프론트가 기대하는 객체 필드로 정규화.
 *
 * list RPC 는 pipelineJson/inputDataJson/runWhenJson/retryJson/notifyJson (문자열)만 주는데
 * ScheduleModal·CalendarPanel 은 pipeline/inputData/runWhen/retry/notify (객체)를 읽는다 —
 * 미정규화 시 편집 모달에 표시 0 이고, 편집 저장(해제 후 재등록)이 undefined 로 덮어
 * 해당 필드가 통째로 유실된다. 라우트(list 반환 지점) 한 곳에서 정규화해 전 소비처 커버.
 */
export function normalizeCronJob<T extends Record<string, unknown>>(job: T): T {
  const parsed = (key: string): unknown => {
    const raw = job[key];
    return typeof raw === 'string' && raw ? safeJsonParse(raw) ?? undefined : undefined;
  };
  return {
    ...job,
    pipeline: job.pipeline ?? parsed('pipelineJson'),
    inputData: job.inputData ?? parsed('inputDataJson'),
    runWhen: job.runWhen ?? parsed('runWhenJson'),
    retry: job.retry ?? parsed('retryJson'),
    notify: job.notify ?? parsed('notifyJson'),
  };
}
