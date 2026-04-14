/**
 * Capability Registry — 빌트인 기능 목록
 *
 * 같은 기능(capability)을 수행하는 여러 모듈(provider)을 묶고
 * 우선순위/폴백을 관리하기 위한 기능 ID 레지스트리.
 *
 * 미등록 capability는 모듈 스캔 시 자동 등록된다.
 */

export interface CapabilityDef {
  label: string;
  description: string;
}

/** 빌트인 capability 목록 — 새 기능 추가 시 여기에 등록 */
export const BUILTIN_CAPABILITIES: Record<string, CapabilityDef> = {
  'web-scrape':   { label: '웹 스크래핑', description: 'URL → 텍스트/링크 추출' },
  'email-send':   { label: '이메일 발송', description: '이메일 전송' },
  'image-gen':    { label: '이미지 생성', description: '텍스트 → 이미지' },
  'translate':    { label: '번역', description: '텍스트 번역' },
  'notification': { label: '알림', description: '슬랙/텔레그램/카톡 알림' },
  'pdf-gen':      { label: 'PDF 생성', description: 'HTML/마크다운 → PDF' },
};

/** Provider 선택 모드 */
export type CapabilityMode = 'api-first' | 'local-first' | 'api-only' | 'local-only' | 'manual';

/** capability별 설정 */
export interface CapabilitySettings {
  mode: CapabilityMode;
  providers: string[]; // manual 모드에서 시도 순서
}

/** capability에 연결된 provider 정보 */
export interface CapabilityProvider {
  moduleName: string;
  providerType: 'local' | 'api';
  location: 'system' | 'user';
  description: string;
}
