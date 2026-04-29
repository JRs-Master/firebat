/**
 * EventManager — Backend SSE 이벤트 발행·구독 관리.
 *
 * 위치: lib/events.ts 의 단순 EventBus 위에 wrap.
 * - lib/events.ts 의 `eventBus` 싱글톤 = source of truth (변경 0)
 * - EventManager = wrapper. eventBus 구독 → audit log 기록 + filtered subscribe API 제공
 * - 기존 호출자 (`eventBus.emit(...)`) 모두 변경 0. 점진 마이그레이션.
 *
 * BIBLE 준수: SSE 이벤트는 Core facade 에서 발행 (매니저 직접 발행 금지).
 *   기존 패턴 — Core 메서드가 `eventBus.emit({type:..., data:...})` 호출
 *   EventManager 도입 후 — Core 메서드가 `core.event.emit(...)` 또는 그대로 `eventBus.emit(...)`
 *
 * 신기능 (이전 lib/events.ts 에 없던 것):
 *   1. audit log — 최근 N건 메모리 보존. 디버깅·관리자 UI 활용
 *   2. filtered subscribe — type 별 구독 (Frontend 의 useEvents 패턴과 대칭)
 *   3. subscriber 격리 — 한 listener throw 가 다른 subscriber 영향 X (이미 lib/events.ts 에 try/catch 있음, 일관 유지)
 *
 * Frontend EventsManager 와 충돌 회피: Backend = EventManager, Frontend = EventsManager (이름 다름, 역할 분리).
 */
import type { ILogPort } from '../ports';
import type { InfraResult } from '../types';
import { eventBus, type FirebatEvent } from '../../lib/events';

type EventListener = (event: FirebatEvent) => void;
type EventFilter = ((event: FirebatEvent) => boolean) | string[] | '*';

interface AuditEntry {
  event: FirebatEvent;
  emittedAt: number;
}

const AUDIT_MAX = 100;

export class EventManager {
  private filteredListeners = new Set<{ filter: EventFilter; handler: EventListener }>();
  private auditLog: AuditEntry[] = [];

  constructor(private logger: ILogPort) {
    // 기존 lib/events.ts eventBus 구독 → audit log 기록 + filtered listener fanout
    eventBus.subscribe((event) => {
      this.recordAudit(event);
      this.fanoutToFiltered(event);
    });
  }

  /** 이벤트 발행 — backward compat: lib/events.ts eventBus.emit 그대로 사용해도 OK.
   *  EventManager.emit 은 typed wrapper. 둘 다 같은 이벤트 stream 으로 흘러간다. */
  emit(event: FirebatEvent): void {
    eventBus.emit(event);
    // audit·fanout 은 eventBus.subscribe 콜백에서 자동 처리됨 (위 constructor)
  }

  /** type 별 구독. filter:
   *   - 함수: (event) => boolean
   *   - 문자열 배열: type 매칭만 (예: ['cron:complete', 'sidebar:refresh'])
   *   - '*': 모든 이벤트
   *  unsubscribe handle 반환. */
  subscribe(filter: EventFilter, handler: EventListener): () => void {
    const sub = { filter, handler };
    this.filteredListeners.add(sub);
    return () => { this.filteredListeners.delete(sub); };
  }

  /** 디버깅·관리자 UI 활용 — 최근 audit log */
  listAuditLog(limit = 50): AuditEntry[] {
    const sliceFrom = Math.max(0, this.auditLog.length - limit);
    return this.auditLog.slice(sliceFrom);
  }

  /** 디버깅 — 현재 active 구독자 수 */
  get listenerCount(): number {
    return this.filteredListeners.size;
  }

  private recordAudit(event: FirebatEvent): void {
    this.auditLog.push({ event, emittedAt: Date.now() });
    if (this.auditLog.length > AUDIT_MAX) this.auditLog.shift();
  }

  private fanoutToFiltered(event: FirebatEvent): void {
    for (const sub of this.filteredListeners) {
      try {
        if (!this.matchesFilter(sub.filter, event)) continue;
        sub.handler(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[EventManager] subscriber failed (event type=${event.type}): ${msg}`);
      }
    }
  }

  private matchesFilter(filter: EventFilter, event: FirebatEvent): boolean {
    if (filter === '*') return true;
    if (Array.isArray(filter)) return filter.includes(event.type);
    if (typeof filter === 'function') return filter(event);
    return false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 도메인 메서드 — Core facade 의 boilerplate 제거. 매니저 간 직접 호출 X 원칙
  // 유지 + 같은 emit 패턴 13+ 곳 hardcoded 됐던 거 한 곳 (이 매니저) 으로 응집.
  // 새 이벤트 타입 추가 시 도메인 메서드만 추가하면 됨 — Core facade 13곳 수정 X.
  // ──────────────────────────────────────────────────────────────────────────

  /** 사이드바 갱신 신호 — 페이지·프로젝트·모듈·파일·템플릿 변경 시 호출. */
  notifySidebar(): void {
    eventBus.emit({ type: 'sidebar:refresh', data: {} });
  }

  /** InfraResult 통과 wrap — success 시만 sidebar 갱신, res 그대로 반환.
   *  사용 패턴: `return this.event.notifySidebarIfSuccess(await this.page.delete(slug));` */
  notifySidebarIfSuccess<T>(res: InfraResult<T>): InfraResult<T> {
    if (res.success) this.notifySidebar();
    return res;
  }

  /** 갤러리 갱신 신호 — 미디어 생성·재생성·삭제·업로드 시 호출.
   *  data 는 시점별 다름: { slug } / { error } / { slug, removed } / { slug, source: 'upload' } / { slug, replacedSlug }. */
  notifyGallery(data: { slug?: string; scope?: 'user' | 'system'; error?: string; removed?: boolean; source?: string; replacedSlug?: string }): void {
    eventBus.emit({ type: 'gallery:refresh', data });
  }

  /** 크론 완료 신호 — 결과 메타 + sidebar 갱신 동시 발화 (잡 결과가 페이지 변경 동반 가정). */
  notifyCronComplete(meta: { jobId: string; success: boolean; durationMs: number; error?: string }): void {
    eventBus.emit({ type: 'cron:complete', data: meta });
    this.notifySidebar();
  }
}
