'use client';

/**
 * useLiveTopic — viewport-gated SSE topic subscription (live components lifetime rule):
 * live only while VISIBLE (IntersectionObserver, handled by the caller via `active`),
 * frozen at the last value when hidden, transcript persistence stays the creation-time
 * snapshot (live updates are client state only). Upstream cost: the shared singleton
 * EventSource (events-manager) exists only while some subscriber is active (ref-counted).
 */
import { useEffect, useRef, useState } from 'react';
import { subscribeServerEvents, getTopicBuffer } from '../../app/admin/hooks/events-manager';

/** Live surfaces: the events SSE is admin-authed — published/shared pages stay frozen. */
export function canLiveHere(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/admin');
}

export function useLiveTopic(
  topic: string | undefined,
  active: boolean,
  onEvent: (data: unknown) => void,
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!topic || !active || !canLiveHere()) return;
    // 재방문 재생 (2026-07-13) — 링버퍼의 최근 프레임을 구독 직전에 되감기해 "틱 대기" 빈
    // 화면을 즉시 채운다. 스냅샷과 라이브 구독 사이 프레임 1개가 중복 전달될 수 있으나
    // 피드 줄·차트 점 중복 1건 = 무해 (dedup 비용 > 이득).
    for (const data of getTopicBuffer(topic)) cb.current(data);
    const unsub = subscribeServerEvents((ev: { type?: string; data?: unknown }) => {
      if (ev?.type === topic) cb.current(ev.data);
    });
    return unsub;
  }, [topic, active]);
}

/** Viewport visibility for the lifetime rule — subscribe only while on screen. */
export function useInViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const ob = new IntersectionObserver((es) => setVisible(es.some(e => e.isIntersecting)));
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return [ref, visible];
}
