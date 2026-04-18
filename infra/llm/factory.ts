import type { ILlmPort } from '../../core/ports';
import { OpenAiAdapter } from './openai-adapter';

/** OpenAI Vault 키 이름 */
export const OPENAI_VAULT_KEYS = {
  apiKey: 'OPENAI_API_KEY',
};

/** OpenAI 어댑터 생성 (싱글톤용 — lazy API 키 + 내부 MCP connector) */
export function buildOpenAiAdapter(
  resolveApiKey: () => string | null,
  defaultModel: string,
  resolveMcpConfig?: () => { url: string; token: string } | null,
): ILlmPort {
  return new OpenAiAdapter(resolveApiKey, defaultModel, resolveMcpConfig);
}
