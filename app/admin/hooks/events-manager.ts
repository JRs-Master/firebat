/**
 * EventsManager — SSE /api/events 단일 구독 + fan-out
 *
 * 배경: Sidebar 와 CronPanel 이 각자 `new EventSource('/api/events')` → 한 클라이언트가
 *   서버에 여러 개 연결. 모바일 배터리, 서버 리소스 낭비.
 *
 * 해결: 싱글톤 EventSource 1개 + 구독자 fan-out. 훅에서 `useEvents(types, handler)` 로 구독.
 *   - 첫 구독자 생기면 EventSource 생성, 마지막 해지 시 close.
 *   - type 필터로 해당 이벤트만 핸들러 호출.
 *   - `firebat-refresh` window 이벤트도 통합 — 같은 handler 로 fan-out.
 */

'use client';

import { useEffect, useRef } from 'react';
import { logger } from '../../../lib/util/logger';

type ServerEvent = { type: string; data?: any };
type Listener = (ev: ServerEvent) => void;

/**
 * 라이브 토픽 링버퍼 (2026-07-13) — `ws-stream:*` 프레임을 토픽별 고정 크기 원형 버퍼에 보관.
 * 라이브 컴포넌트(live_feed/live_chart)는 뷰포트를 벗어나면 구독을 끊는데(수명 룰), 재방문 시
 * 다음 틱까지 빈 화면("틱 대기")이던 것을 이 버퍼 재생으로 즉시 채운다. SSE 는 active-jobs
 * 싱글톤이 admin 앱 수명 동안 유지하므로 컴포넌트가 숨어 있어도 버퍼는 계속 쌓인다.
 * 가득 차면 오래된 프레임부터 덮어씀(= 메모리 상한 고정, 토픽당 ~수 KB).
 */
const RING_FRAMES_PER_TOPIC = 50;
const RING_MAX_TOPICS = 20;
const topicRings = new Map<string, unknown[]>();

function bufferTopicFrame(ev: ServerEvent) {
  if (!ev.type || !ev.type.startsWith('ws-stream:')) return;
  let ring = topicRings.get(ev.type);
  if (!ring) {
    // 토픽 수 상한 — 제일 오래 전에 만들어진 토픽부터 방출 (Map 은 삽입 순서 유지).
    if (topicRings.size >= RING_MAX_TOPICS) {
      const oldest = topicRings.keys().next().value;
      if (oldest !== undefined) topicRings.delete(oldest);
    }
    ring = [];
    topicRings.set(ev.type, ring);
  }
  ring.push(ev.data);
  if (ring.length > RING_FRAMES_PER_TOPIC) ring.splice(0, ring.length - RING_FRAMES_PER_TOPIC);
}

/** 토픽의 버퍼 스냅샷 — 라이브 컴포넌트 재방문 시 구독 직전에 재생용. */
export function getTopicBuffer(topic: string): unknown[] {
  return topicRings.get(topic)?.slice() ?? [];
}

class EventBusSingleton {
  private es: EventSource | null = null;
  private listeners = new Set<Listener>();
  private refCount = 0;
  private firstOpen = true;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.refCount++;
    if (this.refCount === 1) {
      this.connect();
      // 백그라운드 → 포그라운드 복귀 시 강제 reconnect — 모바일 일부 브라우저
      // (Samsung Internet 등) 가 EventSource 자동 재연결 안 하는 quirk 회피.
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.handleVisibility);
      }
    }
    return () => {
      this.listeners.delete(listener);
      this.refCount--;
      if (this.refCount <= 0) this.disconnect();
    };
  }

  private handleVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    // EventSource 가 OPEN 이 아니면 (CLOSED 또는 CONNECTING 정체) 강제 reconnect
    if (!this.es || this.es.readyState !== EventSource.OPEN) {
      this.es?.close();
      this.es = null;
      this.connect();
    }
  };

  private connect() {
    // hub mode (익명 visitor) = admin SSE `/api/events` (requireAuth 필요) 구독 금지.
    // 옛 = hub page 안 Sidebar / GalleryPanel 등이 구독 → 인증 실패로 SSE 중단 →
    // EventSource 무한 재연결 (ERR_INCOMPLETE_CHUNKED_ENCODING 반복).
    if (eventsHubMode) return;
    if (this.es) return;
    try {
      this.es = new EventSource('/api/events');
      this.es.onopen = () => {
        if (this.firstOpen) { this.firstOpen = false; return; }
        // 재연결 시 sidebar:refresh 강제 emit — 끊긴 사이 발생한 이벤트 누락 보상.
        const reconnectEv: ServerEvent = { type: 'sidebar:refresh', data: { reason: 'sse-reconnect' } };
        for (const l of this.listeners) {
          try { l(reconnectEv); }
          catch (e) { logger.warn('sse', 'reconnect listener 실패', { error: e }); }
        }
      };
      this.es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as ServerEvent;
          bufferTopicFrame(ev); // 라이브 토픽 링버퍼 — 재방문 재생용 (fan-out 과 무관)
          for (const l of this.listeners) {
            try { l(ev); }
            catch (le) { logger.warn('sse', 'event listener 실패', { error: le, eventType: ev.type }); }
          }
        } catch (parseErr) { logger.debug('sse', 'event parse 실패', { error: parseErr }); }
      };
      this.es.onerror = () => {
        // 브라우저 자동 재연결 시도 → onopen 이 다시 발화하여 fetch 트리거.
        // visibilitychange 핸들러가 stale CLOSED 상태도 catch.
      };
    } catch (e) { logger.warn('sse', 'EventSource 생성 실패', { error: e }); }
  }

  private disconnect() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    this.es?.close();
    this.es = null;
    this.firstOpen = true;
  }
}

// 모듈 스코프 싱글톤 — 페이지 전체에서 1 EventSource
const bus = new EventBusSingleton();

/** 모듈 레벨 영속 구독 — bus 에 직접 리스너 등록(컴포넌트 unmount 와 무관하게 살아있는 store 용).
 *  active-jobs 처럼 패널 전환에도 상태를 유지해야 하는 싱글톤 store 가 사용. 반환 unsubscribe 는
 *  보통 호출하지 않음(앱 수명 동안 유지 — 그래야 화면을 떠나 있어도 작업 상태가 누락되지 않음). */
export function subscribeServerEvents(listener: Listener): () => void {
  return bus.subscribe(listener);
}

// hub page mode 플래그 — true 면 admin SSE `/api/events` 구독 차단 (익명 visitor 인증 없음).
// ConsoleLayoutInner (hub mode) 가 mount 시 setEventsHubMode(true) 호출.
let eventsHubMode = false;
export function setEventsHubMode(v: boolean) {
  eventsHubMode = v;
}

/** SSE 이벤트 구독. types 배열에 포함된 이벤트만 handler 호출.
 *  handler 는 리렌더마다 새로 만들어져도 OK — 내부적으로 ref 로 안정화. */
export function useEvents(
  types: string[] | '*',
  handler: (ev: ServerEvent) => void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const typesRef = useRef(types);
  typesRef.current = types;

  useEffect(() => {
    return bus.subscribe((ev) => {
      const filter = typesRef.current;
      if (filter !== '*' && !filter.includes(ev.type)) return;
      handlerRef.current(ev);
    });
  }, []);
}

/** window 'firebat-refresh' 이벤트 구독 — AI 액션 완료 등 로컬 트리거.
 *  SSE sidebar:refresh 와 함께 fan-out 대상. Sidebar/CronPanel 이 같이 듣는 패턴이라 통합. */
export function useLocalRefresh(handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const h = () => handlerRef.current();
    window.addEventListener('firebat-refresh', h);
    return () => window.removeEventListener('firebat-refresh', h);
  }, []);
}

/** 서버 SSE + window 로컬 이벤트 양쪽에 동일 handler 바인딩. */
export function useSidebarRefresh(handler: () => void) {
  useEvents(['sidebar:refresh', 'cron:complete'], handler);
  useLocalRefresh(handler);
}

/** window 'firebat-refresh' 이벤트 발행 — AI 액션 완료 후 Sidebar·CronPanel 갱신 트리거. */
export function emitLocalRefresh() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('firebat-refresh'));
  }
}
