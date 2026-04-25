/**
 * SSE Event Bus — Core → 클라이언트 실시간 이벤트 스트림
 *
 * Core가 이벤트를 발행하면 연결된 모든 SSE 클라이언트에 전달된다.
 * 클라이언트는 /api/events 엔드포인트를 통해 EventSource로 수신한다.
 */

export type FirebatEvent = {
  type: 'cron:complete' | 'sidebar:refresh' | 'notification' | 'gallery:refresh';
  data: any;
};

type EventListener = (event: FirebatEvent) => void;

class EventBus {
  private listeners: Set<EventListener> = new Set();

  /** SSE 클라이언트 리스너 등록 */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 이벤트 발행 — 모든 연결된 클라이언트에 전달 */
  emit(event: FirebatEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  /** 현재 연결된 클라이언트 수 */
  get clientCount(): number {
    return this.listeners.size;
  }
}

// 싱글톤 (Next.js 핫리로드 안전)
const globalForEvents = globalThis as unknown as { firebatEventBus: EventBus | undefined };
if (!globalForEvents.firebatEventBus) {
  globalForEvents.firebatEventBus = new EventBus();
}

export const eventBus = globalForEvents.firebatEventBus;
