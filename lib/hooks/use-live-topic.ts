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

/**
 * Live surfaces (S6): admin = 인증 전체 스트림(events-manager 싱글톤) / 발행 페이지 =
 * per-topic 공개 relay(/api/page-stream, 서버측 topic 필터 + 페이지 spec allowlist).
 * share 전사본은 동결 유지(라이브 표면 아님).
 */
export function liveSurface(): 'admin' | 'page' | false {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname;
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/share/')) return false;
  return 'page'; // published page (catch-all) — /api/page-stream 게이트가 최종 판정
}

/** 하위호환 별칭 — "이 표면에서 라이브 가능한가". */
export function canLiveHere(): boolean {
  return liveSurface() !== false;
}

/**
 * WS emit 봉투 언랩 — 스트림 프레임은 `{count, records:[{...}], trId}` (sandbox/ws 공용 배열
 * 봉투)로 도착한다. 소비자(live_chart·live_stock_chart)의 dot-path valueField(예: STCK_PRPR)는
 * **레코드 기준**이라, records 배열이면 레코드별로 콜백을 부른다(멀티레코드 = 틱 여러 개 = count>1
 * 프레임도 전부 반영). 봉투가 아니면 프레임 그대로 전달(하위호환).
 */
function deliverFrame(data: unknown, cb: (d: unknown) => void): void {
  if (data && typeof data === 'object' && Array.isArray((data as { records?: unknown }).records)) {
    for (const rec of (data as { records: unknown[] }).records) cb(rec);
    return;
  }
  cb(data);
}

export function useLiveTopic(
  topic: string | undefined,
  active: boolean,
  onEvent: (data: unknown) => void,
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!topic || !active) return;
    const surface = liveSurface();
    if (surface === 'admin') {
      // 재방문 재생 (2026-07-13) — 링버퍼의 최근 프레임을 구독 직전에 되감기해 "틱 대기" 빈
      // 화면을 즉시 채운다. 스냅샷과 라이브 구독 사이 프레임 1개가 중복 전달될 수 있으나
      // 피드 줄·차트 점 중복 1건 = 무해 (dedup 비용 > 이득).
      for (const data of getTopicBuffer(topic)) deliverFrame(data, cb.current);
      const unsub = subscribeServerEvents((ev: { type?: string; data?: unknown }) => {
        if (ev?.type === topic) deliverFrame(ev.data, cb.current);
      });
      return unsub;
    }
    if (surface === 'page') {
      // 발행 페이지 — 경량 per-topic EventSource. 게이트(공개 판정·spec allowlist·IP 캡)는
      // 라우트 몫. 거부(403/404)면 재시도 폭풍 방지 위해 즉시 close(동결 = 기존 동작).
      const slug = (() => {
        try { return decodeURIComponent(window.location.pathname.slice(1)); }
        catch { return window.location.pathname.slice(1); }
      })();
      if (!slug) return;
      const es = new EventSource(
        `/api/page-stream?slug=${encodeURIComponent(slug)}&topic=${encodeURIComponent(topic)}`,
      );
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data) as { type?: string; data?: unknown };
          if (ev?.type === topic) deliverFrame(ev.data, cb.current);
        } catch { /* keepalive/비JSON 무시 */ }
      };
      es.onerror = () => es.close();
      return () => es.close();
    }
    return;
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
