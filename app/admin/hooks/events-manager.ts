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

type ServerEvent = { type: string; data?: any };
type Listener = (ev: ServerEvent) => void;

class EventBusSingleton {
  private es: EventSource | null = null;
  private listeners = new Set<Listener>();
  private refCount = 0;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.refCount++;
    if (this.refCount === 1) this.connect();
    return () => {
      this.listeners.delete(listener);
      this.refCount--;
      if (this.refCount <= 0) this.disconnect();
    };
  }

  private connect() {
    if (this.es) return;
    try {
      this.es = new EventSource('/api/events');
      // 첫 연결은 무시하고 재연결만 'sidebar:refresh' 강제 emit — 서버 재시작(deploy) 후
      // 클라이언트 stale state 방지. 처음 연결 시엔 구독자가 자체 초기 fetch 해놨음.
      let firstOpen = true;
      this.es.onopen = () => {
        if (firstOpen) { firstOpen = false; return; }
        const reconnectEv: ServerEvent = { type: 'sidebar:refresh', data: { reason: 'sse-reconnect' } };
        for (const l of this.listeners) {
          try { l(reconnectEv); } catch {}
        }
      };
      this.es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as ServerEvent;
          for (const l of this.listeners) {
            try { l(ev); } catch {}
          }
        } catch {}
      };
      this.es.onerror = () => {
        // 브라우저가 자동 재연결 → 위 onopen 이 다시 발화하여 fetch 트리거.
        // 실제 서비스 중단은 SSE /api/events 자체 keepalive 가 보장.
      };
    } catch {}
  }

  private disconnect() {
    this.es?.close();
    this.es = null;
  }
}

// 모듈 스코프 싱글톤 — 페이지 전체에서 1 EventSource
const bus = new EventBusSingleton();

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
