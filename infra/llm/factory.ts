import type { ILlmPort } from '../../core/ports';
import { GeminiAdapter } from './vertex-adapter';

/** Gemini Vault 키 이름 */
export const GEMINI_VAULT_KEYS = {
  apiKey: 'GEMINI_API_KEY',
};

/** Gemini 어댑터 생성 (싱글톤용 — lazy API 키 로드) */
export function buildGeminiAdapter(
  resolveApiKey: () => string | null,
  defaultModel: string,
): ILlmPort {
  return new GeminiAdapter(resolveApiKey, defaultModel);
}
