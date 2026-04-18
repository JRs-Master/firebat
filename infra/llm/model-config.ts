/**
 * LLM 모델 Config 스키마
 *
 * 각 모델별 1개 JSON 파일. configs/ 디렉토리에 저장.
 * Firebat은 config 읽어서 해당 format handler에 위임.
 *
 * 새 LLM 도입 시:
 * - 같은 format(OpenAI-compat 등) → configs/에 JSON만 추가
 * - 새 format → formats/ 핸들러 추가 + config 생성
 */

export type LlmFormat = 'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'vertex-gemini' | 'gemini-native';

export interface ModelFeatures {
  /** OpenAI hosted MCP connector (Responses API 전용) */
  mcpConnector?: boolean;
  /** Function calling strict 모드 (스키마 엄격) */
  strictTools?: boolean;
  /** Reasoning effort (gpt-5/o 시리즈) */
  reasoning?: boolean;
  /** previous_response_id 서버 상태 (Responses API 전용) */
  previousResponseId?: boolean;
  /** 24시간 확장 prompt caching */
  promptCache24h?: boolean;
  /** Gemini thinking config */
  thinking?: boolean;
  /** Anthropic extended thinking */
  extendedThinking?: boolean;
  /** tool_search (gpt-5.4+) */
  toolSearch?: boolean;
  /** vision (이미지 입력) */
  vision?: boolean;
  /** temperature 파라미터 허용 */
  temperature?: boolean;
}

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens (있으면) */
  cachedInput?: number;
}

export interface ModelConfig {
  /** 모델 고유 ID (예: "gpt-5.4-mini", "gemini-3-flash-preview") */
  id: string;
  /** UI 표시용 이름 */
  displayName: string;
  /** 프로바이더 (openai, google-aistudio, anthropic 등) */
  provider: string;
  /** 요청 포맷 — 해당 format handler가 실제 HTTP 호출 담당 */
  format: LlmFormat;
  /** API 엔드포인트 URL */
  endpoint: string;
  /** Vault에 저장된 API 키 이름 */
  apiKeyVaultKey: string;
  /** 추가 HTTP 헤더 (예: Anthropic은 anthropic-version 필요) */
  extraHeaders?: Record<string, string>;
  /** 이 모델이 지원하는 기능들 */
  features?: ModelFeatures;
  /** 1M 토큰당 가격 (정보용, UI 표시) */
  pricing?: ModelPricing;
}

/** 여러 모델 config의 묶음 (configs/*.json 로드 결과) */
export type ModelRegistry = Record<string, ModelConfig>;
