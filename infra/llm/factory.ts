/**
 * LLM 어댑터 팩토리
 *
 * - ConfigDrivenAdapter: configs/*.json 파일 로드 → format handler 위임
 *   새 모델 도입 시 JSON 파일 추가만으로 지원 확장 (프로바이더별 개별 어댑터 금지 원칙)
 */
import fs from 'fs';
import path from 'path';
import type { ILlmPort } from '../../core/ports';
import { ConfigDrivenAdapter } from './config-adapter';
import type { ModelConfig, ModelRegistry } from './model-config';

/** Provider별 Vault 키 (설정 UI, 환경변수 폴백용) */
export const PROVIDER_VAULT_KEYS = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
} as const;

/** 기존 호환 (단일 OpenAI 키) */
export const OPENAI_VAULT_KEYS = { apiKey: PROVIDER_VAULT_KEYS.openai };

/** configs/ 디렉토리에서 모델 JSON 파일 전체 로드 */
export function loadModelRegistry(dir?: string): ModelRegistry {
  const baseDir = dir || path.join(process.cwd(), 'infra', 'llm', 'configs');
  const registry: ModelRegistry = {};
  if (!fs.existsSync(baseDir)) return registry;
  const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(baseDir, f), 'utf-8');
      const cfg = JSON.parse(raw) as ModelConfig;
      if (cfg?.id && cfg?.format && cfg?.endpoint) registry[cfg.id] = cfg;
    } catch {
      // 파싱 실패 파일 무시 (로그는 boot에서 처리)
    }
  }
  return registry;
}

/** ConfigDrivenAdapter 생성 — 모든 등록 모델을 하나의 ILlmPort로 통합 */
export function buildConfigDrivenAdapter(
  registry: ModelRegistry,
  defaultModelId: string,
  resolveSecret: (key: string) => string | null,
  resolveMcpConfig?: () => { url: string; token: string } | null,
  resolveAnthropicCache?: () => boolean,
): ILlmPort {
  return new ConfigDrivenAdapter(registry, defaultModelId, resolveSecret, resolveMcpConfig, resolveAnthropicCache);
}
