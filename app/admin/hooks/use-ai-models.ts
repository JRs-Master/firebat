/**
 * AI 모델 list — Rust core::llm::config::builtin_models() 단일 source.
 *
 * frontend 가 매 사용처 hardcoded 25 entry 박지 않고, GET /api/settings 응답의
 * `aiModels` 배열을 module-level cache + 1-shot fetch 패턴으로 공유.
 *
 * 사용:
 *   const { models, ready } = useAiModels();
 *   models.find(m => m.value === ...)
 *
 *   readAiModels() — useEffect 밖에서 동기 접근 (cache hit 시점만 정확).
 */

import { useState, useEffect } from 'react';

export type AiModelEntry = { value: string; label: string };

let cache: AiModelEntry[] | null = null;
let inflight: Promise<AiModelEntry[]> | null = null;

async function fetchAiModels(): Promise<AiModelEntry[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (Array.isArray(data.aiModels) && data.aiModels.length > 0) {
        const list: AiModelEntry[] = data.aiModels.map(
          (m: { id: string; displayName?: string }) => ({
            value: m.id,
            label: m.displayName || m.id,
          }),
        );
        cache = list;
        return list;
      }
    } catch {
      // fetch 실패 시 빈 list — UI 가 dropdown 0 표시. error toast 별도 안 박음 (silent).
    }
    cache = [];
    return cache;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** React hook — cache hit 시 즉시 반환, miss 시 fetch 후 set. */
export function useAiModels(): { models: AiModelEntry[]; ready: boolean } {
  const [models, setModels] = useState<AiModelEntry[]>(cache ?? []);
  const [ready, setReady] = useState(cache !== null);

  useEffect(() => {
    if (cache) {
      setModels(cache);
      setReady(true);
      return;
    }
    fetchAiModels().then((list) => {
      setModels(list);
      setReady(true);
    });
  }, []);

  return { models, ready };
}

/** 동기 helper — cache 박혀있을 때만 정확. 미박힘 시 빈 array. */
export function readAiModels(): AiModelEntry[] {
  return cache ?? [];
}

/** cache 강제 리셋 — 모델 list 변경 시점 (현재 미사용 — 제공만). */
export function invalidateAiModelsCache(): void {
  cache = null;
}
