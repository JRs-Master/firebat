/**
 * CMS Layout — header / footer / sidebar 데이터 구조 + 파싱.
 *
 * Phase 4: 사용자 페이지의 layout shell. design-tokens.ts 의 토큰 적용 + CMS settings
 * 편집 가능. 페이지 본문 (render_* 컴포넌트 배열) 위에 header/footer 자연 등장.
 *
 * 향후 sidebar 5종 layout (full / right / left / both / boxed) 도 이 파일에서 정의.
 */

export interface NavLink {
  label: string;
  href: string;
}

export interface HeaderConfig {
  /** 표시 여부 — false 면 헤더 미렌더 */
  show: boolean;
  /** 텍스트 로고 — siteTitle 비어있으면 CMS settings.siteTitle 폴백 */
  siteName: string;
  /** 이미지 로고 URL (선택). 박혀있으면 텍스트 로고 옆에 표시. */
  logoUrl: string;
  /** 네비 링크 목록 */
  navLinks: NavLink[];
  /** Sticky 헤더 — 스크롤 시에도 상단 유지. position: sticky + z-index. 기본 false. */
  sticky: boolean;
  /** Transparent on top — 페이지 최상단(0px)일 때 배경 투명, 스크롤 시 배경색 채움.
   *  sticky=true 와 함께 사용 권장. hero 위에 헤더 떠있는 모던 사이트 패턴. 기본 false. */
  transparentOnTop: boolean;
  /** 모바일 햄버거 drawer — 모바일(sm 미만)에서 nav 링크 → 햄버거 버튼 + slide-in drawer.
   *  데스크톱은 그대로 horizontal nav. 기본 false (현재처럼 wrap). */
  mobileDrawer: boolean;
}

export interface FooterColumn {
  /** 컬럼 제목 — 비우면 헤딩 미표시 */
  heading: string;
  /** 컬럼 본문 (HTML 허용 — sanitize 후 inline DOM). 링크·연락처·문장 자유 입력. */
  content: string;
}

export interface FooterConfig {
  /** 표시 여부 — false 면 푸터 미렌더 */
  show: boolean;
  /** 푸터 메인 텍스트 (HTML 허용 — sanitize 후 inline DOM). 저작권·법적 고지 등. 컬럼 위에 표시. */
  text: string;
  /** 4 컬럼 widget — 각 컬럼별 heading + content. 모두 비우면 columns 미표시 (text 만 노출). */
  columns: FooterColumn[];
}

/** Sidebar 위치 모드 — GP/Astra 식 5종.
 *  full: sidebar 없음 (본문 풀폭)
 *  right-sidebar: 본문 좌, sidebar 우
 *  left-sidebar: sidebar 좌, 본문 우
 *  both-sidebar: 좌 sidebar + 본문 + 우 sidebar (양쪽 같은 SidebarConfig 사용)
 *  boxed: sidebar 없음 + 본문 boxed (좁은 max-width + 테두리·그림자)
 *  모바일 (<1024px) 에서는 자동 stacked — sidebar 가 본문 아래로. */
export type LayoutMode = 'full' | 'right-sidebar' | 'left-sidebar' | 'both-sidebar' | 'boxed';

export interface SidebarConfig {
  /** 검색 박스 위젯 — /search 로 GET. */
  showSearchBox: boolean;
  /** 최근 글 위젯 표시 (default true 단 layoutMode 가 sidebar 일 때만 효과) */
  showRecentPosts: boolean;
  /** 최근 글 표시 개수 */
  recentPostsCount: number;
  /** 카테고리(project) 목록 위젯 — published+public 페이지의 project 합집합 + 글 수. */
  showCategoryList: boolean;
  /** 태그 cloud 위젯 — head.keywords 합집합 + 빈도수, top N. */
  showTagCloud: boolean;
  /** 태그 cloud 표시 개수 (top N) */
  tagCloudLimit: number;
  /** 구독 안내 위젯 — RSS feed.xml 링크 + 텔레그램 채널 (옵션). */
  showSubscribe: boolean;
  /** 자유 HTML 위젯 — 광고·연락처·소개 등. sanitize 후 inline DOM. */
  htmlWidget: string;
}

/** Page card 변형 — 홈·projectRoot·tag 페이지의 글 list 표시 방식. */
export type PageCardVariant = 'list' | 'grid' | 'compact';

export interface PageListConfig {
  /** 글 list 카드 변형 — list / grid / compact. 기본 list. */
  cardVariant: PageCardVariant;
  /** 페이지당 표시 개수 — 페이지네이션. 기본 20. */
  perPage: number;
}

export interface LayoutConfig {
  header: HeaderConfig;
  footer: FooterConfig;
  /** 관련 글 추천 — 콘텐츠 페이지 본문 끝에 head.keywords 매칭 페이지 표시. */
  showRelatedPosts: boolean;
  /** 관련 글 표시 개수 (기본 5) */
  relatedPostsCount: number;
  /** 읽기 진행도 표시 — 페이지 상단 가로 progress bar (CSS var --cms-accent 색). 기본 false. */
  showReadingProgress: boolean;
  /** 본문 + sidebar 배치 모드. 기본 'full' (사이드바 없음). */
  mode: LayoutMode;
  sidebar: SidebarConfig;
  /** 글 list 표시 (홈·projectRoot·tag) */
  pageList: PageListConfig;
}

/** "label | href" 줄별 형식 → NavLink[] 파싱.
 *  예: "홈 | /\n블로그 | /stock-blog\n소개 | /about" */
export function parseNavLinks(raw: string | undefined | null): NavLink[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [label, href] = line.split('|').map(s => s.trim());
      if (!label || !href) return null;
      return { label, href };
    })
    .filter((x): x is NavLink => x !== null);
}

/** 기본 layout — 사용자 미설정 시 적용. 헤더·푸터 둘 다 표시, 단순 텍스트 로고. */
export const DEFAULT_LAYOUT: LayoutConfig = {
  header: {
    show: true,
    siteName: 'Firebat',
    logoUrl: '',
    navLinks: [],
    sticky: false,
    transparentOnTop: false,
    mobileDrawer: false,
  },
  footer: {
    show: true,
    text: '',
    columns: [
      { heading: '', content: '' },
      { heading: '', content: '' },
      { heading: '', content: '' },
      { heading: '', content: '' },
    ],
  },
  showRelatedPosts: true,
  relatedPostsCount: 5,
  showReadingProgress: false,
  mode: 'full',
  sidebar: {
    showSearchBox: false,
    showRecentPosts: true,
    recentPostsCount: 5,
    showCategoryList: false,
    showTagCloud: false,
    tagCloudLimit: 20,
    showSubscribe: false,
    htmlWidget: '',
  },
  pageList: {
    cardVariant: 'list',
    perPage: 20,
  },
};
