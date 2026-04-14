import type { ILlmPort } from '../../core/ports';
import { VertexAiAdapter } from './vertex-adapter';

/** Vertex AI Vault 키 이름 */
export const VERTEX_VAULT_KEYS = {
  apiKey:   'VERTEX_AI_API_KEY',
  project:  'VERTEX_AI_PROJECT',
  location: 'VERTEX_AI_LOCATION',
};

/** Vertex AI 어댑터 생성 (싱글톤용 — lazy API 키 로드) */
export function buildVertexAdapter(
  resolveApiKey: () => string | null,
  defaultModel: string,
  resolveProject: () => string | undefined,
  resolveLocation: () => string,
): ILlmPort {
  return new VertexAiAdapter(resolveApiKey, resolveProject, resolveLocation, defaultModel);
}
