import { safeJsonParse } from './json';

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** cron 식 → 사람 말 (ko). 5필드(분 시 일 월 요일) + 6필드(초 포함 — 시스템 잡
 *  "0 0 (초/6단위) ..." 류는 초 필드를 떼고 같은 로직) 지원, 못 읽는 패턴이면 원문 반환.
 *  복수 표현식(`|` 구분 = 한 잡의 여러 시각)은 각각 풀어서 " · " 로 병기.
 *  ScheduleModal 과 승인 카드(스케줄 실행 시각 표시)가 공유. */
export function describeCron(expr: string): string {
  if (expr.includes('|')) {
    return expr
      .split('|')
      .map(e => e.trim())
      .filter(Boolean)
      .map(describeCron)
      .join(' · ');
  }
  let p = expr.trim().split(/\s+/);
  if (p.length === 6) p = p.slice(1);
  if (p.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = p;
  if (min.startsWith('*/')) return `${min.slice(2)}분마다`;
  if (hour.startsWith('*/')) return `${hour.slice(2)}시간마다`;
  const timeStr = `${hour}:${min.padStart(2, '0')}`;
  if (dom !== '*' && mon === '*') return `매월 ${dom}일 ${timeStr}`;
  if (dow !== '*') {
    const days = dow.split(',').map(d => DOW_KO[parseInt(d)] || d).join('·');
    return `매주 ${days} ${timeStr}`;
  }
  if (min !== '*' && hour !== '*') return `매일 ${timeStr}`;
  return expr;
}

/** Gaps at least this long separate firings rather than keep a session's rhythm. */
const SESSION_BREAK_MS = 6 * 60 * 60 * 1000;

/**
 * Firing instants → how they read in `tz`: "평일 22:50~03:50 매시", "매일 09:00 · 21:00".
 *
 * For a job whose clock is not the reader's. Its rule is written in its own zone, and translating
 * the rule is where it goes wrong: a New York morning session crosses midnight in Seoul, and moves
 * an hour against it twice a year. The instants the scheduler will actually fire already carry all
 * of that, so this only reads them — in the reader's zone. Null when there is nothing to read.
 */
export function describeFires(fires: number[], tz: string | null): string | null {
  const ms = [...new Set(fires)].filter(Number.isFinite).sort((a, b) => a - b);
  if (ms.length === 0) return null;
  let hm: Intl.DateTimeFormat;
  let wd: Intl.DateTimeFormat;
  try {
    hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz ?? undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    wd = new Intl.DateTimeFormat('en-US', { timeZone: tz ?? undefined, weekday: 'short' });
  } catch {
    return null; // an unknown zone name reads nothing rather than something wrong
  }
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hhmm = (t: number) => hm.format(t);
  const dayOf = (t: number) => WEEKDAYS.indexOf(wd.format(t));
  const dayLabel = (days: Set<number>) => {
    const sorted = [...days].filter(d => d >= 0).sort((a, b) => a - b);
    if (sorted.length === 7) return '매일';
    if (sorted.join(',') === '1,2,3,4,5') return '평일';
    if (sorted.join(',') === '0,6') return '주말';
    return sorted.map(d => DOW_KO[d]).join('·');
  };

  let step = Infinity;
  for (let i = 1; i < ms.length; i++) step = Math.min(step, ms[i] - ms[i - 1]);

  // Separate firings (one a day, twice a day): the clock times they land on.
  if (!(step < SESSION_BREAK_MS)) {
    const times = [...new Set(ms.map(hhmm))].sort();
    const shown = times.slice(0, 3).join(' · ') + (times.length > 3 ? ` 외 ${times.length - 3}` : '');
    return `${dayLabel(new Set(ms.map(dayOf)))} ${shown}`;
  }

  // Sessions: runs at the job's own rhythm. The longest one is the job — the first may already be
  // under way — and the days are the days sessions of that length start on.
  const sessions: number[][] = [];
  for (const t of ms) {
    const cur = sessions[sessions.length - 1];
    if (cur && t - cur[cur.length - 1] <= step) cur.push(t);
    else sessions.push([t]);
  }
  const rep = sessions.reduce((a, b) => (b.length > a.length ? b : a));
  const mins = Math.round(step / 60000);
  const every = mins === 60 ? '매시' : mins < 60 ? `${mins}분마다` : mins % 60 === 0 ? `${mins / 60}시간마다` : `${mins}분 간격`;
  // Around the clock there is no window to show, only the rhythm.
  if (rep[rep.length - 1] - rep[0] >= 23 * 60 * 60 * 1000) return every;
  const days = new Set(sessions.filter(s => s.length === rep.length).map(s => dayOf(s[0])));
  const span = rep.length === 1 ? hhmm(rep[0]) : `${hhmm(rep[0])}~${hhmm(rep[rep.length - 1])} ${every}`;
  return `${dayLabel(days)} ${span}`;
}

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
