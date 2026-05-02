/**
 * Widget Catalog — 헤더 / 사이드바 / 푸터 통합 위젯 시스템.
 *
 * 한 번 정의된 widget 은 scope 에 따라 여러 영역에서 재사용. 새 widget 추가 시
 * catalog 만 등록 → 모든 영역에서 자동 활용 가능.
 *
 * Phase A: 사이드바부터 widget 배열 시스템으로 마이그레이션. 기존 6 toggle 은
 * 호환 유지 (widgets 배열 박혀있으면 그 우선, 없으면 toggle 폴백).
 * Phase B/C: 헤더·푸터 도 같은 catalog 활용.
 */

/** Widget 사용 영역 분류.
 *  header-only:   사이트 로고 / 모바일 햄버거 (헤더 한정)
 *  sidebar-only:  최근글 / 태그클라우드 / 카테고리 (사이드바 한정)
 *  footer-only:   저작권 (푸터 한정)
 *  header-footer: 네비 / 소셜 (헤더 + 푸터 공용)
 *  universal:     검색박스 / HTML / 광고 / 사이트명 / RSS (어디든) */
export type WidgetScope =
  | 'header-only'
  | 'sidebar-only'
  | 'footer-only'
  | 'header-footer'
  | 'universal';

export type WidgetArea = 'header' | 'sidebar' | 'footer';

/** Widget 종류 — catalog key. 새 widget 추가 시 여기에 enum 추가 + WIDGET_CATALOG 등록. */
export type WidgetType =
  // 헤더 전용
  | 'site-logo'
  | 'mobile-toggle'
  // 사이드바 전용
  | 'recent-posts'
  | 'tag-cloud'
  | 'category-list'
  // 푸터 전용
  | 'copyright'
  // 헤더 + 푸터 공용
  | 'nav-links'
  | 'social-links'
  // 전체 공용
  | 'site-name'
  | 'search-box'
  | 'html-block'
  | 'ad-slot'
  | 'rss-subscribe';

/** Widget props 필드 schema — 어드민 UI 에서 props 편집 시 사용. */
export interface WidgetPropField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'toggle' | 'textarea';
  placeholder?: string;
  description?: string;
}

/** Widget 메타 — catalog 등록 정보. */
export interface WidgetMeta {
  type: WidgetType;
  label: string;
  scope: WidgetScope;
  description: string;
  /** Widget 의 default props — 사용자가 override 안 한 키는 default. */
  defaultProps?: Record<string, unknown>;
  /** 어드민 UI 에서 props 편집 시 노출할 필드 schema. */
  propsSchema?: WidgetPropField[];
}

/** Widget 인스턴스 — 사용자가 영역에 박은 widget 1개. */
export interface WidgetSlot {
  /** Widget 종류 (catalog key) */
  type: WidgetType;
  /** Visibility — 'all' (기본) / 'desktop' (모바일 hidden) / 'mobile' (데스크톱 hidden).
   *  Phase A 옵션 1 — slot 별 가시성. Phase B/C 에서 영역별 다른 layout 도 추후. */
  visibility?: 'all' | 'desktop' | 'mobile';
  /** 사용자 override props — catalog 의 defaultProps 위에 덮어씀. */
  props?: Record<string, unknown>;
}

// ── Catalog 정의 ────────────────────────────────────────────────────────────

export const WIDGET_CATALOG: Record<WidgetType, WidgetMeta> = {
  // ── 헤더 전용 ──
  'site-logo': {
    type: 'site-logo',
    label: '사이트 로고',
    scope: 'header-only',
    description: '로고 이미지 (CMS settings 의 layoutLogoUrl). 없으면 사이트명 텍스트.',
  },
  'mobile-toggle': {
    type: 'mobile-toggle',
    label: '모바일 햄버거',
    scope: 'header-only',
    description: '모바일(sm 미만) 에서 nav drawer 여는 햄버거 버튼. 데스크톱 자동 hidden.',
  },

  // ── 사이드바 전용 ──
  'recent-posts': {
    type: 'recent-posts',
    label: '최근 글',
    scope: 'sidebar-only',
    description: 'published + public 페이지 최신 N개. updatedAt 내림차순.',
    defaultProps: { count: 5, title: '최근 글' },
    propsSchema: [
      { key: 'count', label: '개수', type: 'number', placeholder: '5' },
      { key: 'title', label: '제목', type: 'text', placeholder: '최근 글' },
    ],
  },
  'tag-cloud': {
    type: 'tag-cloud',
    label: '태그 cloud',
    scope: 'sidebar-only',
    description: 'head.keywords 합집합 + 빈도수. 빈도 큰 태그가 더 큰 폰트.',
    defaultProps: { limit: 20, title: '태그' },
    propsSchema: [
      { key: 'limit', label: '개수', type: 'number', placeholder: '20' },
      { key: 'title', label: '제목', type: 'text', placeholder: '태그' },
    ],
  },
  'category-list': {
    type: 'category-list',
    label: '카테고리 list',
    scope: 'sidebar-only',
    description: 'project 합집합 + 글 수. 클릭 시 /{project}.',
    defaultProps: { title: '카테고리' },
    propsSchema: [
      { key: 'title', label: '제목', type: 'text', placeholder: '카테고리' },
    ],
  },

  // ── 푸터 전용 ──
  'copyright': {
    type: 'copyright',
    label: '저작권 텍스트',
    scope: 'footer-only',
    description: '저작권 / 법적 고지. 비우면 자동 © {year} {siteName}.',
    defaultProps: { text: '' },
    propsSchema: [
      { key: 'text', label: '텍스트', type: 'textarea', placeholder: '© 2026 사이트명. All rights reserved.' },
    ],
  },

  // ── 헤더 + 푸터 공용 ──
  'nav-links': {
    type: 'nav-links',
    label: '네비 링크',
    scope: 'header-footer',
    description: '글로벌 navLinks 사용 또는 자체 링크 입력.',
    defaultProps: { useGlobalNav: true, customLinks: '', title: '' },
    propsSchema: [
      { key: 'useGlobalNav', label: '글로벌 nav 사용', type: 'toggle', description: 'OFF 시 아래 자체 링크만 사용' },
      { key: 'customLinks', label: '자체 링크 (label | href 줄별)', type: 'textarea', placeholder: '소개 | /about\n연락처 | /contact' },
      { key: 'title', label: '제목 (선택)', type: 'text' },
    ],
  },
  'social-links': {
    type: 'social-links',
    label: '소셜 링크',
    scope: 'header-footer',
    description: 'X / 텔레그램 / GitHub 등 소셜 아이콘 링크.',
    defaultProps: { items: '', title: '' },
    propsSchema: [
      { key: 'items', label: '소셜 링크 (type | url 줄별)', type: 'textarea', placeholder: 'twitter | https://x.com/me\ntelegram | https://t.me/me\ngithub | https://github.com/me\nemail | mailto:me@example.com' },
      { key: 'title', label: '제목 (선택)', type: 'text' },
    ],
  },

  // ── 전체 공용 ──
  'site-name': {
    type: 'site-name',
    label: '사이트명 텍스트',
    scope: 'universal',
    description: 'CMS settings 의 siteTitle 텍스트 표시.',
  },
  'search-box': {
    type: 'search-box',
    label: '검색 박스',
    scope: 'universal',
    description: '/search GET form. submit 시 새 페이지로 이동.',
    defaultProps: { placeholder: '검색어...', title: '검색' },
    propsSchema: [
      { key: 'title', label: '제목 (선택)', type: 'text', placeholder: '검색' },
      { key: 'placeholder', label: 'Placeholder', type: 'text', placeholder: '검색어...' },
    ],
  },
  'html-block': {
    type: 'html-block',
    label: 'HTML 자유 위젯',
    scope: 'universal',
    description: '자유 HTML — sanitize 후 inline DOM. <a> / <img> / <ul> 등 일부 허용.',
    defaultProps: { content: '', title: '' },
    propsSchema: [
      { key: 'title', label: '제목 (선택)', type: 'text' },
      { key: 'content', label: 'HTML 본문', type: 'textarea', placeholder: '<a href="https://...">링크</a>' },
    ],
  },
  'ad-slot': {
    type: 'ad-slot',
    label: '광고 슬롯',
    scope: 'universal',
    description: 'AdSense 광고 단위 ID. CMS settings 의 publisher ID 자동 활용.',
    defaultProps: { slotId: '' },
    propsSchema: [
      { key: 'slotId', label: '슬롯 ID', type: 'text', placeholder: '1234567890', description: 'AdSense 광고 단위 ID' },
    ],
  },
  'rss-subscribe': {
    type: 'rss-subscribe',
    label: 'RSS 구독',
    scope: 'universal',
    description: 'RSS feed.xml 링크. 사이트 글로벌 또는 페이지 컨텍스트의 project feed.',
    defaultProps: { title: '구독' },
    propsSchema: [
      { key: 'title', label: '제목', type: 'text', placeholder: '구독' },
    ],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** 영역에서 사용 가능한 widget 만 반환 — scope 매칭. 어드민 UI 의 "+ 위젯 추가" 드롭다운에서 사용. */
export function widgetsForArea(area: WidgetArea): WidgetMeta[] {
  return Object.values(WIDGET_CATALOG).filter(w => isWidgetAllowed(w.scope, area));
}

/** Widget scope 가 영역에서 허용되는지. */
export function isWidgetAllowed(scope: WidgetScope, area: WidgetArea): boolean {
  if (scope === 'universal') return true;
  if (scope === 'header-only') return area === 'header';
  if (scope === 'sidebar-only') return area === 'sidebar';
  if (scope === 'footer-only') return area === 'footer';
  if (scope === 'header-footer') return area === 'header' || area === 'footer';
  return false;
}

/** Slot 의 effective props — catalog defaultProps + slot props 머지. */
export function resolveSlotProps(slot: WidgetSlot): Record<string, unknown> {
  const meta = WIDGET_CATALOG[slot.type];
  const defaults = meta?.defaultProps ?? {};
  return { ...defaults, ...(slot.props ?? {}) };
}

/** Visibility CSS class — desktop-only 면 hidden sm:block, mobile-only 면 sm:hidden, all 이면 ''. */
export function visibilityClass(visibility: WidgetSlot['visibility']): string {
  if (visibility === 'desktop') return 'hidden sm:block';
  if (visibility === 'mobile') return 'sm:hidden';
  return '';
}
