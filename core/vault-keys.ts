/**
 * Vault 키 이름 중앙 관리
 *
 * 모든 Vault 키 접근은 이 파일의 상수/함수를 통해야 한다.
 * 키 이름이 변경되면 여기만 수정하면 된다.
 */

// ── 시스템 설정 ──
export const VK_SYSTEM_TIMEZONE = 'system:timezone';

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
