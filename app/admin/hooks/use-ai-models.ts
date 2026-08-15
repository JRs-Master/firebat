/**
 * AI 모델 list — Rust core::llm::config::builtin_models() 단일 source.
 *
 * frontend 의 매 사용처 hardcoded 25 entry 중복 회피 — GET /api/settings 응답의
 * `aiModels` 배열을 React Query 단일 cache 로 공유 (Phase 7 정공).
 *
 * thinking 정보 포함 (2026-05-13 확장) — 옛 types.ts hardcoded
 * THINKING_LEVELS / getThinkingKind / filterThinkingLevels 폐기. 각 모델의
 * `thinking.kind` + `thinking.levels[i].value` 직접 사용 (표시 이름은 값에서 파생).
 *
 * 사용:
 *   const { models, ready } = useAiModels();
 *   const m = models.find(x => x.value === currentModel);
 *   if (m?.thinking) { /* dropdown render */ /* }
 */

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api-fetch';

export type AiModelThinkingLevel = {
  value: string;
  /**
   * Retired. 158 hand-written label entries across 31 models produced 17 spellings of 7 values —
   * `high` read as "High", "High (높음)" and "High (높음, 기본)" depending on which model you had
   * selected. The name is a function of the value, so it is derived now (`thinkingLevelLabel`) and
   * the field is left unread until the proto field can be dropped.
   */
  labels?: Record<string, string>;
};

export type AiModelThinking = {
  kind: 'reasoning' | 'thinking' | 'extendedThinking';
  levels: AiModelThinkingLevel[];
};

export type AiModelEntry = {
  value: string;
  label: string;
  /** 미지원 모델은 undefined. */
  thinking?: AiModelThinking;
  /** 실행 모드 — "api" (pay-per-token) 또는 "cli" (구독). 옛 frontend prefix 분기 폐기 (2026-05-13). */
  execMode: 'api' | 'cli';
  /** CLI provider sub-category. API 모델은 undefined. */
  cliProvider?: 'claude' | 'codex' | 'gemini';
  /** UI 분류 키 — "cli-claude" / "vertex-google" / "api-openai" 등. firebat_last_model_by_category 분류. */
  category: string;
};

type SettingsAiModelsPayload = {
  aiModels?: Array<{
    id: string;
    displayName?: string;
    thinking?: AiModelThinking;
    execMode?: string;
    cliProvider?: string;
    category?: string;
  }>;
};

const QUERY_KEY = ['ai-models'] as const;

async function fetchAiModels(): Promise<AiModelEntry[]> {
  const data = await apiGet<SettingsAiModelsPayload>('/api/settings', { category: 'ai-models' });
  if (!Array.isArray(data.aiModels) || data.aiModels.length === 0) return [];
  return data.aiModels.map((m) => ({
    value: m.id,
    label: m.displayName || m.id,
    execMode: (m.execMode === 'cli' ? 'cli' : 'api') as 'api' | 'cli',
    category: m.category ?? '',
    ...(m.cliProvider ? { cliProvider: m.cliProvider as 'claude' | 'codex' | 'gemini' } : {}),
    ...(m.thinking ? { thinking: m.thinking } : {}),
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

/** Display name for a level — the declared value, capitalized. See `AiModelThinkingLevel.labels`. */
export function thinkingLevelLabel(level: AiModelThinkingLevel): string {
  const v = level.value;
  return v === 'xhigh' ? 'XHigh' : v.charAt(0).toUpperCase() + v.slice(1);
}

/// The level to start a model on when nothing has been chosen for it yet.
///
/// The lowest it declares, except `none` — that one is "reasoning off", not "cheap reasoning", and
/// landing there by default would silently switch thinking off for the 13 models that offer it
/// (solar-pro4 and the whole GPT-5.x family). Same rule the consolidation job picks by, derived
/// from the same declared list on both sides rather than written down twice.
export function baselineThinkingLevel(thinking: AiModelThinking | undefined): string {
  const levels = thinking?.levels ?? [];
  return (levels.find(l => l.value !== 'none') ?? levels[0])?.value ?? '';
}
