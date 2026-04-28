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
}

export interface FooterConfig {
  /** 표시 여부 — false 면 푸터 미렌더 */
  show: boolean;
  /** 푸터 텍스트 (HTML 허용 — sanitize 후 inline DOM). 저작권·법적 고지·연락처 등. */
  text: string;
}

export interface LayoutConfig {
  header: HeaderConfig;
  footer: FooterConfig;
  /** 읽기 진행도 표시 — 페이지 상단 가로 progress bar (CSS var --cms-accent 색). 기본 false. */
  showReadingProgress: boolean;
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
  },
  footer: {
    show: true,
    text: '',
  },
  showReadingProgress: false,
};
