/**
 * AI 모델 list — Rust core::llm::config::builtin_models() 단일 source.
 *
 * frontend 의 매 사용처 hardcoded 25 entry 중복 회피 — GET /api/settings 응답의
 * `aiModels` 배열을 React Query 단일 cache 로 공유 (Phase 7 정공).
 *
 * 사용:
 *   const { models, ready } = useAiModels();
 *
 *   readAiModels() — useEffect 밖 동기 접근 (cache hit 시점만 정확).
 *   invalidateAiModelsCache() — 모델 list 변경 시점 (현재 미사용 — 제공만).
 */

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api-fetch';

export type AiModelEntry = { value: string; label: string };

type SettingsAiModelsPayload = {
  aiModels?: Array<{ id: string; displayName?: string }>;
};

const QUERY_KEY = ['ai-models'] as const;

async function fetchAiModels(): Promise<AiModelEntry[]> {
  const data = await apiGet<SettingsAiModelsPayload>('/api/settings', { category: 'ai-models' });
  if (!Array.isArray(data.aiModels) || data.aiModels.length === 0) return [];
  return data.aiModels.map((m) => ({
    value: m.id,
    label: m.displayName || m.id,
  }));
}

/** React hook — React Query single source. */
export function useAiModels(): { models: AiModelEntry[]; ready: boolean } {
  const { data, isSuccess, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAiModels,
    // 모델 list 는 거의 안 바뀜 — staleTime 길게
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return {
    models: data ?? [],
    ready: isSuccess || isError, // 에러여도 빈 list 로 UI 진행 (옛 silent catch 동작 보존)
  };
}

/** 동기 helper — React Query cache 직접 read. cache miss 시 빈 array. */
export function readAiModels(queryClient?: ReturnType<typeof useQueryClient>): AiModelEntry[] {
  if (!queryClient) return [];
  return queryClient.getQueryData<AiModelEntry[]>(QUERY_KEY) ?? [];
}

/** cache 강제 리셋 — 모델 list 변경 시점 (현재 미사용 — 제공만). */
export function invalidateAiModelsCache(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: QUERY_KEY });
}
