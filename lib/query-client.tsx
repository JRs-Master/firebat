/**
 * React Query setup — Phase 7 정공 (2026-05-13).
 *
 * 옛 산재된 raw fetch + useState + useEffect 패턴 (73곳) → standardized fetch.
 * 기능:
 *  - 자동 cache (반복 fetch 0)
 *  - 자동 retry + exponential backoff
 *  - background refetch + revalidate
 *  - cross-tab 동기화 (SSE invalidation 같이 사용)
 *  - DevTools (개발 환경 자동)
 *
 * 사용 패턴:
 *   import { useQuery } from '@tanstack/react-query';
 *   import { apiGet } from '@/lib/api-fetch';
 *
 *   const { data, isLoading, error } = useQuery({
 *     queryKey: ['pages'],
 *     queryFn: () => apiGet<{ pages: Page[] }>('/api/pages'),
 *   });
 *
 * 마이그 가이드 (옛 raw fetch → React Query):
 *   옛:
 *     const [data, setData] = useState();
 *     useEffect(() => { fetch('/api/x').then(r => r.json()).then(setData).catch(...); }, []);
 *   새:
 *     const { data } = useQuery({ queryKey: ['x'], queryFn: () => apiGet('/api/x') });
 */

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { TIME } from './util/time';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 5분 fresh — 그 안에 같은 query 호출 시 cache hit (네트워크 0)
        staleTime: 5 * TIME.MINUTE_MS,
        // 30분 후 GC — 사용 안 된 query 자동 정리
        gcTime: 30 * TIME.MINUTE_MS,
        // 1회 자동 retry (network blip 대응) + exponential backoff
        retry: 1,
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 30000),
        // background 자동 refetch — 탭 활성화 시 stale data 자동 갱신
        refetchOnWindowFocus: true,
        // network reconnect 시 자동 retry
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 0, // mutation 은 사용자 의도 — 자동 retry 위험
      },
    },
  });
}

let clientSingleton: QueryClient | undefined;
function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    // server — request 별 fresh client (cache leakage 차단)
    return makeQueryClient();
  }
  if (!clientSingleton) clientSingleton = makeQueryClient();
  return clientSingleton;
}

/** layout.tsx 에서 admin / user 영역 wrap. SSR + client 둘 다 안전. */
export function FirebatQueryProvider({ children }: { children: ReactNode }) {
  // useState 으로 client 고정 — re-render 시 동일 instance
  const [client] = useState(() => getQueryClient());
  // 백그라운드 탭 안전망 — 탭이 숨겨진 동안 SSE 이벤트(cron:complete 등)를 놓치면
  // refetchOnWindowFocus 도 staleTime(5분 fresh)에 막혀 옛 목록이 보인다(2026-07-08 실측:
  // 정시 발화 로그가 F5 필요). 복귀 시 캐시 전체 무효화 = 놓친 이벤트 일반 커버
  // (활성 쿼리만 refetch 라 비용 소폭, ai-models 류 정적 캐시는 제외).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void client.invalidateQueries({ predicate: q => q.queryKey[0] !== 'ai-models' });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client]);
  return (
    <QueryClientProvider client={client}>
      {children}
      {process.env.NODE_ENV !== 'production' && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
