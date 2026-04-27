/**
 * Design Tokens — CMS 의 디자인 일관성 통합 source.
 *
 * 22개 render_* 컴포넌트가 hardcoded Tailwind class 대신 CSS var 토큰 사용.
 * 사용자가 CMS 어드민에서 색·폰트·spacing·heading 스타일 편집 → 모든 컴포넌트 일관 적용.
 *
 * 적용 흐름:
 *   1. 사용자가 어드민에서 프리셋 선택 또는 커스텀 토큰 편집
 *   2. CMS settings 에 저장 (Vault `system:module:cms:settings.theme`)
 *   3. user route SSR 시점에 settings 로드 → globals.css 의 :root + .firebat-cms-block 에 CSS var 주입
 *   4. 22 컴포넌트가 `bg-(--cms-primary)`, `text-(--cms-up)` 등 var 참조
 *
 * 향후 CMS Phase 3 (프로젝트별 override) 도입 시 이 토큰 구조 위에 자연 확장.
 */

// ── 토큰 인터페이스 ──────────────────────────────────────────────────────────

export interface ColorTokens {
  /** 주 강조색 — 링크·primary 버튼·강조 영역 */
  primary: string;
  /** 보조 강조색 — secondary CTA·badge accent */
  accent: string;
  /** 상승·양수 — 한국 주식 컨벤션 (빨강) */
  up: string;
  /** 하락·음수 — 한국 주식 컨벤션 (파랑) */
  down: string;
  /** 본문 텍스트 */
  text: string;
  /** 보조 텍스트·캡션·메타 */
  textMuted: string;
  /** 페이지 배경 */
  bg: string;
  /** 카드·박스 배경 */
  bgCard: string;
  /** 테두리 */
  border: string;
}

export interface FontTokens {
  /** 본문 폰트 stack */
  body: string;
  /** 제목 폰트 stack */
  heading: string;
  /** 코드·등폭 폰트 stack */
  mono: string;
}

export interface LayoutTokens {
  /** 본문 최대 폭 (px 또는 rem) — 페이지 콘텐츠 영역 */
  contentMaxWidth: string;
  /** 모바일 좌우 padding (≤640px) */
  paddingMobile: string;
  /** 태블릿 좌우 padding (≤1024px) */
  paddingTablet: string;
  /** 데스크톱 좌우 padding (>1024px) */
  paddingDesktop: string;
  /** 기본 border-radius (카드·버튼 등) */
  radius: string;
}

/** Heading 스타일 6 옵션 — h1/h2/h3 각자 별도 적용 가능. */
export type HeadingStyle =
  | 'plain'           // 기본 — 단순 텍스트
  | 'border-bottom'   // 하단 라인 강조
  | 'border-left'     // 좌측 accent 바
  | 'underline'       // 텍스트 밑줄
  | 'bold-bg'         // 강조 배경 박스
  | 'accent-square';  // accent 색 작은 사각형 prefix

export interface HeadingTokens {
  h1: HeadingStyle;
  h2: HeadingStyle;
  h3: HeadingStyle;
}

export interface DesignTokens {
  colors: ColorTokens;
  fonts: FontTokens;
  layout: LayoutTokens;
  heading: HeadingTokens;
}

// ── 색 프리셋 10개 (Light 7 + Dark 3) ─────────────────────────────────────────

/** 색 프리셋 카탈로그 — 어드민 UI 에서 클릭 한 번으로 적용. */
export const COLOR_PRESETS: Record<string, { label: string; mode: 'light' | 'dark'; colors: ColorTokens }> = {
  'slate-pro': {
    label: 'Slate Pro',
    mode: 'light',
    colors: {
      primary: '#2563eb', accent: '#f59e0b',
      up: '#dc2626', down: '#2563eb',
      text: '#0f172a', textMuted: '#64748b',
      bg: '#ffffff', bgCard: '#f8fafc', border: '#e2e8f0',
    },
  },
  'navy-finance': {
    label: 'Navy Finance',
    mode: 'light',
    colors: {
      primary: '#1e40af', accent: '#0891b2',
      up: '#dc2626', down: '#2563eb',
      text: '#0c1326', textMuted: '#475569',
      bg: '#fafbfc', bgCard: '#f1f5f9', border: '#cbd5e1',
    },
  },
  'warm-notion': {
    label: 'Warm Notion',
    mode: 'light',
    colors: {
      primary: '#374151', accent: '#d97706',
      up: '#dc2626', down: '#2563eb',
      text: '#1f2937', textMuted: '#78716c',
      bg: '#fafaf9', bgCard: '#f5f5f4', border: '#e7e5e4',
    },
  },
  'vercel-mono': {
    label: 'Vercel Mono',
    mode: 'light',
    colors: {
      primary: '#000000', accent: '#666666',
      up: '#dc2626', down: '#2563eb',
      text: '#000000', textMuted: '#666666',
      bg: '#ffffff', bgCard: '#fafafa', border: '#eaeaea',
    },
  },
  'stripe-soft': {
    label: 'Stripe Soft',
    mode: 'light',
    colors: {
      primary: '#635bff', accent: '#ff5996',
      up: '#dc2626', down: '#2563eb',
      text: '#0a2540', textMuted: '#425466',
      bg: '#ffffff', bgCard: '#f6f9fc', border: '#e3e8ee',
    },
  },
  'korean-elegant': {
    label: 'Korean Elegant',
    mode: 'light',
    colors: {
      primary: '#0066cc', accent: '#c8102e',
      up: '#c8102e', down: '#0066cc',
      text: '#1a1a1a', textMuted: '#666666',
      bg: '#fdfdfd', bgCard: '#f7f8fa', border: '#dde2eb',
    },
  },
  'soft-pastel': {
    label: 'Soft Pastel',
    mode: 'light',
    colors: {
      primary: '#7c3aed', accent: '#ec4899',
      up: '#f43f5e', down: '#3b82f6',
      text: '#3f3f46', textMuted: '#71717a',
      bg: '#fafaff', bgCard: '#f4f4ff', border: '#e4e4f7',
    },
  },
  'dark-slate': {
    label: 'Dark Slate',
    mode: 'dark',
    colors: {
      primary: '#60a5fa', accent: '#fbbf24',
      up: '#f87171', down: '#60a5fa',
      text: '#f1f5f9', textMuted: '#94a3b8',
      bg: '#0f172a', bgCard: '#1e293b', border: '#334155',
    },
  },
  'dark-navy': {
    label: 'Dark Navy',
    mode: 'dark',
    colors: {
      primary: '#3b82f6', accent: '#06b6d4',
      up: '#ef4444', down: '#3b82f6',
      text: '#e0e7ff', textMuted: '#7c8db5',
      bg: '#0c1326', bgCard: '#1a2540', border: '#2d3a5f',
    },
  },
  'pure-black': {
    label: 'Pure Black',
    mode: 'dark',
    colors: {
      primary: '#ffffff', accent: '#a3a3a3',
      up: '#ff6b6b', down: '#4dabf7',
      text: '#ffffff', textMuted: '#a3a3a3',
      bg: '#000000', bgCard: '#0a0a0a', border: '#262626',
    },
  },
};

// ── 폰트 프리셋 ──────────────────────────────────────────────────────────────

/** 폰트 stack 프리셋 — 어드민에서 선택 또는 외부 CSS URL 직접 입력. */
export const FONT_PRESETS: Record<string, FontTokens> = {
  'pretendard': {
    body: "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
    heading: "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  },
  'noto-sans-kr': {
    body: "'Noto Sans KR', sans-serif",
    heading: "'Noto Sans KR', sans-serif",
    mono: "'JetBrains Mono', monospace",
  },
  'inter': {
    body: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
    heading: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
    mono: "'JetBrains Mono', monospace",
  },
  'geist': {
    body: "'Geist Sans', -apple-system, sans-serif",
    heading: "'Geist Sans', -apple-system, sans-serif",
    mono: "'Geist Mono', monospace",
  },
  'cal-sans': {
    body: "'Pretendard Variable', sans-serif",
    heading: "'Cal Sans', 'Pretendard Variable', sans-serif",
    mono: "'JetBrains Mono', monospace",
  },
};

// ── 기본 토큰 ────────────────────────────────────────────────────────────────

/** 미설정 시 기본값 — Slate Pro 프리셋 + Pretendard + 1200px max-width. */
export const DEFAULT_TOKENS: DesignTokens = {
  colors: COLOR_PRESETS['slate-pro'].colors,
  fonts: FONT_PRESETS['pretendard'],
  layout: {
    contentMaxWidth: '1200px',
    paddingMobile: '16px',
    paddingTablet: '24px',
    paddingDesktop: '32px',
    radius: '8px',
  },
  heading: {
    h1: 'plain',
    h2: 'border-left',
    h3: 'plain',
  },
};

// ── CSS var 변환 유틸 ────────────────────────────────────────────────────────

/** DesignTokens → CSS custom property 문자열 변환.
 *  globals.css 의 :root 또는 .firebat-cms-block 에 inject 용. */
export function tokensToCss(tokens: DesignTokens): string {
  const t = tokens;
  return `
    --cms-primary: ${t.colors.primary};
    --cms-accent: ${t.colors.accent};
    --cms-up: ${t.colors.up};
    --cms-down: ${t.colors.down};
    --cms-text: ${t.colors.text};
    --cms-text-muted: ${t.colors.textMuted};
    --cms-bg: ${t.colors.bg};
    --cms-bg-card: ${t.colors.bgCard};
    --cms-border: ${t.colors.border};
    --cms-font-body: ${t.fonts.body};
    --cms-font-heading: ${t.fonts.heading};
    --cms-font-mono: ${t.fonts.mono};
    --cms-content-max-width: ${t.layout.contentMaxWidth};
    --cms-padding-mobile: ${t.layout.paddingMobile};
    --cms-padding-tablet: ${t.layout.paddingTablet};
    --cms-padding-desktop: ${t.layout.paddingDesktop};
    --cms-radius: ${t.layout.radius};
  `.trim();
}

/** Partial<DesignTokens> 를 default 와 deep merge — 사용자 일부 override 시 결합.
 *  CMS settings 에서 사용자가 일부 필드만 박은 경우 default 와 병합. */
export function mergeTokens(partial?: Partial<DesignTokens>): DesignTokens {
  if (!partial) return DEFAULT_TOKENS;
  return {
    colors: { ...DEFAULT_TOKENS.colors, ...(partial.colors ?? {}) },
    fonts: { ...DEFAULT_TOKENS.fonts, ...(partial.fonts ?? {}) },
    layout: { ...DEFAULT_TOKENS.layout, ...(partial.layout ?? {}) },
    heading: { ...DEFAULT_TOKENS.heading, ...(partial.heading ?? {}) },
  };
}
