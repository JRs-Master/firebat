/**
 * Image generation 모델 config 로더 — LLM 의 model-config 와 병렬 구조.
 * configs/*.json 을 빌드 타임 스캔해서 registry 구성.
 */
import fs from 'fs';
import path from 'path';

export type ImageGenFormat =
  | 'openai-image'        // OpenAI gpt-image-1 / gpt-image-2 (Images API)
  | 'gemini-native-image' // Gemini 3.1 Flash Image Preview (AI Studio, generateContent)
  | 'vertex-gemini-image' // Vertex AI Gemini 이미지 (향후)
  | 'stability-api'       // Stability AI (SD3 등, 향후)
  | 'cli-codex-image';    // Codex CLI $imagegen (구독)
  // Gemini CLI 는 공식 이미지 생성 skill 미지원 — Gemini 쪽은 API 경로만 사용

export interface ImageGenModelConfig {
  id: string;
  displayName: string;
  provider: string;                   // 'openai' | 'google' | 'anthropic' | 'stability' 등
  format: ImageGenFormat;
  endpoint: string;
  apiKeyVaultKey: string;             // Vault 키 이름 — 없어도 되는 CLI 모드 포함
  features?: Record<string, unknown>; // multilingualText / sizes / qualities 등
  pricing?: Record<string, unknown>;  // low/medium/high per-image 단가
  extraHeaders?: Record<string, string>;
}

export type ImageGenRegistry = Record<string, ImageGenModelConfig>;

/**
 * config.pricing 에서 quality 별 단가 lookup.
 *
 * 지원 형식:
 *   - { lowPerImage, mediumPerImage, highPerImage } — quality 별 (OpenAI gpt-image-*)
 *   - { perImage } — 단일 단가 (Gemini Imagen)
 *   - { note: ... } — 구독 기반 (Codex CLI) → null 반환 (cost 0)
 *
 * 미정의 / 매칭 실패 시 null. 어댑터가 null 받으면 ImageGenResult.costUsd 박지 않음.
 */
export function computeImageCost(config: ImageGenModelConfig, quality?: string): number | null {
  const pricing = config.pricing;
  if (!pricing || typeof pricing !== 'object') return null;

  // 단일 단가 (Gemini)
  if (typeof (pricing as { perImage?: unknown }).perImage === 'number') {
    return (pricing as { perImage: number }).perImage;
  }

  // quality 별 (OpenAI). quality 미명시 시 medium fallback (가장 흔한 default)
  const q = (quality ?? 'medium').toLowerCase();
  const key = `${q}PerImage` as keyof typeof pricing;
  const v = (pricing as Record<string, unknown>)[key];
  if (typeof v === 'number') return v;

  return null;  // 구독 기반 / 미정의
}

export function loadImageGenRegistry(configsDir: string): ImageGenRegistry {
  const registry: ImageGenRegistry = {};
  try {
    if (!fs.existsSync(configsDir)) return registry;
    const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(configsDir, f), 'utf-8');
        const cfg = JSON.parse(raw) as ImageGenModelConfig;
        if (cfg.id) registry[cfg.id] = cfg;
      } catch { /* 개별 파일 파싱 실패 무시 */ }
    }
  } catch { /* 디렉토리 없음 등 — 빈 registry */ }
  return registry;
}
