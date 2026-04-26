/**
 * Vault 키 이름 중앙 관리
 *
 * 모든 Vault 키 접근은 이 파일의 상수/함수를 통해야 한다.
 * 키 이름이 변경되면 여기만 수정하면 된다.
 */

// ── 시스템 설정 ──
export const VK_SYSTEM_TIMEZONE = 'system:timezone';
export const VK_SYSTEM_AI_MODEL = 'system:ai-model';
export const VK_SYSTEM_AI_THINKING_LEVEL = 'system:ai-thinking-level';
/** 사용자가 직접 입력하는 커스텀 프롬프트 — 어드민 채팅·모나코 에디터 모두 주입 */
export const VK_SYSTEM_USER_PROMPT = 'system:user-prompt';
/** AI Assistant (도구 라우터·자기진화 등 시스템 내부 서브 AI) 모델 선택 */
export const VK_SYSTEM_AI_ASSISTANT_MODEL = 'system:ai-router:model';
/** Anthropic API prompt caching 토글 — Claude API 모드 전용. Vault 값 'true' 일 때만 cache_control 마커 박음.
 *  CLI 모드는 Anthropic 백엔드 자동 caching → 토글 무관. */
export const VK_LLM_ANTHROPIC_CACHE = 'system:llm:anthropic-cache';
/** 설정 모달 "AI 카테고리별 마지막 선택 모델" — 멀티기기 동기화.
 *  JSON 문자열 저장: {"cli-claude":"cli-claude-code-opus","api-anthropic":"claude-sonnet-4-6",...} */
export const VK_SYSTEM_LAST_MODEL_BY_CATEGORY = 'system:last-model-by-category';

/** AI Assistant 기본 모델. User AI 와 별개의 백엔드 헬퍼 — 싸고 빠른 모델 선호.
 *  `infra/llm/configs/<id>.json` 에 대응 설정 필요. */
export const DEFAULT_AI_ASSISTANT_MODEL = 'gemini-3.1-flash-lite-preview';
/** UI 에 노출할 AI Assistant 선택지. 토글·드롭다운 옵션 출처. */
export const AI_ASSISTANT_MODELS: readonly string[] = ['gemini-3.1-flash-lite-preview', 'gpt-5-nano'];

// ── 인증 ──
export const VK_ADMIN_ID = 'FIREBAT_ADMIN_ID';
export const VK_ADMIN_PASSWORD = 'FIREBAT_ADMIN_PASSWORD';

// ── Capability ──
export const vkCapabilitySettings = (capId: string) => `system:capability:${capId}:settings`;

// ── 모듈 ──
export const vkModuleSettings = (name: string) => `system:module:${name}:settings`;

// ── 프로젝트 ──
export const vkProjectVisibility = (project: string) => `system:project:${project}:visibility`;
export const vkProjectPassword = (project: string) => `system:project:${project}:password`;

// ── 사용자 시크릿 ──
export const vkUserSecret = (name: string) => `user:${name}`;
