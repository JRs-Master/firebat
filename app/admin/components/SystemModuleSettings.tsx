'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Blocks, Save, Loader2, CheckCircle2, LinkIcon, Unlink, RefreshCw, Copy, Check, Globe, Terminal, Server, Image, Code, Settings2, ExternalLink, ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { TelegramWebhookSection } from './TelegramWebhookSection';
import { confirmDialog } from './Dialog';
import { COLOR_PRESETS } from '../../../lib/design-tokens';

// ── 모듈별 설정 스키마 정의 ──────────────────────────────────────────────────
type FieldType = 'text' | 'number' | 'toggle' | 'textarea' | 'oauth' | 'secret' | 'verifications' | 'color-presets' | 'select';
interface SelectOption { value: string; label: string }
interface SettingField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  description?: string;
  defaultValue?: any;
  tab?: string;              // 탭 그룹 (없으면 기본 탭)
  oauthUrl?: string;        // oauth 타입 전용: 인증 시작 URL
  oauthSecrets?: string[];  // oauth 타입 전용: 연동 상태 확인용 시크릿 키
  secretName?: string;      // secret 타입 전용: Vault에 저장할 시크릿 키 이름
  options?: SelectOption[]; // select 타입 전용: dropdown 옵션
}

// 탭 정의 (아이콘 + 라벨)
const TAB_META: Record<string, { label: string; icon: typeof Globe }> = {
  '일반': { label: '일반', icon: Settings2 },
  '레이아웃': { label: '레이아웃', icon: Server },
  '테마': { label: '테마', icon: Blocks },
  '광고': { label: '광고', icon: ExternalLink },
  'SEO': { label: 'SEO', icon: Globe },
  '이미지': { label: '이미지', icon: Image },
  'OG': { label: 'OG 이미지', icon: Image },
  '스크립트': { label: '스크립트', icon: Code },
};

/**
 * 특수 설정이 필요한 모듈만 등록 (oauth, 커스텀 필드 등)
 * 일반 secret 필드는 config.json의 secrets 배열에서 자동 생성됨
 */
const MODULE_SETTINGS_SCHEMA: Record<string, { title?: string; fields: SettingField[] }> = {
  'browser-scrape': {
    fields: [
      { key: 'timeout', label: '타임아웃 (ms)', type: 'number', placeholder: '30000', description: '페이지 로딩 제한 시간', defaultValue: 30000 },
      { key: 'headless', label: 'Headless 모드', type: 'toggle', description: '브라우저 UI 없이 실행', defaultValue: true },
      { key: 'maxTextLength', label: '최대 텍스트 길이', type: 'number', placeholder: '50000', description: '추출 텍스트 최대 글자 수', defaultValue: 50000 },
    ],
  },
  'kakao-talk': {
    fields: [
      { key: 'kakaoOAuth', label: '카카오 계정 연동', type: 'oauth', oauthUrl: '/api/auth/kakao', oauthSecrets: ['KAKAO_ACCESS_TOKEN'], description: '키 등록 후 연동하면 액세스 토큰이 자동 발급됩니다.' },
      { key: 'defaultType', label: '기본 메시지 타입', type: 'text', placeholder: 'text', description: 'text | feed | list (기본: text)', defaultValue: 'text' },
    ],
  },
  'firecrawl': {
    fields: [
      { key: 'maxTextLength', label: '최대 텍스트 길이', type: 'number', placeholder: '30000', description: '마크다운 결과 최대 글자 수', defaultValue: 30000 },
    ],
  },
  'mcp-server-app': {
    fields: [],  // 커스텀 렌더링 (앱 개발용 — Claude Code, Cursor, VS Code)
  },
  'mcp-server-llm': {
    fields: [],  // 커스텀 렌더링 (LLM 통신용 — OpenAI Responses API, Claude API)
  },
  'cms': {
    fields: [
      { key: 'siteTitle', label: '사이트 제목', type: 'text', tab: '일반', placeholder: 'Firebat', description: 'SEO 기본 사이트 제목 (OG, RSS, Sitemap 등에 사용)' },
      { key: 'siteDescription', label: '사이트 설명', type: 'text', tab: '일반', placeholder: 'Just Imagine. Firebat Runs.', description: 'SEO 기본 사이트 설명' },
      { key: 'siteUrl', label: '사이트 URL', type: 'text', tab: '일반', placeholder: 'https://example.com', description: 'JSON-LD, Sitemap 등에 사용되는 기본 URL. 비워두면 요청 host 자동 감지.' },
      { key: 'jsonLdEnabled', label: 'JSON-LD 구조화 데이터', type: 'toggle', tab: '일반', description: 'WebSite + Organization 스키마 자동 삽입', defaultValue: true },
      { key: 'jsonLdOrganization', label: '조직/브랜드명', type: 'text', tab: '일반', placeholder: 'Firebat', description: 'JSON-LD Organization name' },
      { key: 'jsonLdLogoUrl', label: '로고 URL', type: 'text', tab: '일반', placeholder: 'https://example.com/icon.svg', description: 'JSON-LD Organization 로고 이미지 URL' },
      { key: 'siteLang', label: '사이트 언어', type: 'text', tab: '일반', placeholder: 'ko', description: 'HTML lang 속성 — 검색엔진 언어 인식 + 접근성. 기본 ko (en/ja/zh-CN 등)', defaultValue: 'ko' },
      { key: 'faviconUrl', label: 'Favicon URL', type: 'text', tab: '일반', placeholder: '/user/media/...png 또는 https://...', description: '커스텀 favicon. 갤러리 이미지 URL 또는 외부 URL. 비우면 기본 아이콘.' },
      // ── 레이아웃 — 헤더 / 푸터 (Phase 4). 사용자 페이지 본문 위·아래 자연 등장. ──
      { key: 'layoutShowHeader', label: '헤더 표시', type: 'toggle', tab: '레이아웃', description: '사용자 페이지 상단 헤더 표시 여부. 기본 ON.', defaultValue: true },
      { key: 'layoutSiteName', label: '헤더 — 사이트 이름', type: 'text', tab: '레이아웃', placeholder: '(비우면 일반 탭의 사이트 제목 사용)', description: '헤더 좌측 텍스트 로고. 일반 탭 siteTitle 과 다른 값 박을 때만 입력.' },
      { key: 'layoutLogoUrl', label: '헤더 — 로고 이미지 (선택)', type: 'text', tab: '레이아웃', placeholder: '/user/media/...png 또는 https://...', description: '텍스트 로고 옆에 표시할 이미지 URL. 비우면 텍스트만.' },
      { key: 'layoutNavLinks', label: '헤더 — 네비 링크', type: 'textarea', tab: '레이아웃', placeholder: '홈 | /\n블로그 | /blog\n소개 | /about\n문의 | /contact', description: '한 줄당 "라벨 | 경로" 형식. 헤더 우측에 가로 나열.' },
      { key: 'layoutShowFooter', label: '푸터 표시', type: 'toggle', tab: '레이아웃', description: '사용자 페이지 하단 푸터 표시 여부. 기본 ON.', defaultValue: true },
      { key: 'layoutFooterText', label: '푸터 — 텍스트', type: 'textarea', tab: '레이아웃', placeholder: '© 2026 Firebat. All rights reserved.\n본 사이트는 투자 자문이 아닌 정보 제공 목적입니다.', description: '푸터 텍스트. 저작권 / 법적 고지 / 연락처 등. 줄바꿈 OK. HTML 태그 일부 허용 (<a>, <strong> 등).' },
      { key: 'layoutShowReadingProgress', label: '읽기 진행도 표시', type: 'toggle', tab: '레이아웃', description: '페이지 상단에 스크롤 진행도 가로 바 표시. design tokens 의 accent 색 사용. 기본 OFF.', defaultValue: false },
      // ── Sidebar 레이아웃 ──
      { key: 'layoutMode', label: '본문 + 사이드바 모드', type: 'select', tab: '레이아웃', description: '본문 영역과 사이드바 배치. full = 사이드바 없음 / right = 우측 사이드바 / left = 좌측 사이드바 / boxed = 사이드바 없음 + 본문 boxed (좁은 max-width + 테두리·그림자). 모바일에선 자동 stacked.', defaultValue: 'full', options: [
        { value: 'full', label: 'Full — 사이드바 없음 (기본)' },
        { value: 'right-sidebar', label: 'Right Sidebar — 우측 사이드바' },
        { value: 'left-sidebar', label: 'Left Sidebar — 좌측 사이드바' },
        { value: 'boxed', label: 'Boxed — 사이드바 없음 + 본문 boxed' },
      ] },
      { key: 'sidebarShowRecentPosts', label: '사이드바 — 최근 글 위젯', type: 'toggle', tab: '레이아웃', description: '사이드바에 최근 글 list 표시. 사이드바 모드 (right/left) 에서만 효과.', defaultValue: true },
      { key: 'sidebarRecentPostsCount', label: '사이드바 — 최근 글 개수', type: 'number', tab: '레이아웃', placeholder: '5', description: '사이드바 최근 글 개수.', defaultValue: 5 },
      { key: 'sidebarHtmlWidget', label: '사이드바 — HTML 위젯', type: 'textarea', tab: '레이아웃', placeholder: '<div>광고 코드 / 연락처 / 소개 등</div>', description: '자유 HTML 위젯. sanitize 후 inline DOM. <a> / <strong> / <img> 등 일부 태그 허용. 비우면 미표시.' },
      // ── 글 list 카드 ──
      { key: 'pageListCardVariant', label: '글 카드 변형', type: 'select', tab: '레이아웃', description: '홈·프로젝트·태그 페이지의 글 list 표시 방식. list (세로 카드) / grid (격자 2-3열) / compact (제목+날짜 압축).', defaultValue: 'list', options: [
        { value: 'list', label: 'List — 세로 카드 (기본)' },
        { value: 'grid', label: 'Grid — 격자 2-3열' },
        { value: 'compact', label: 'Compact — 제목+날짜 압축' },
      ] },
      { key: 'pageListPerPage', label: '글 list — 페이지당 개수', type: 'number', tab: '레이아웃', placeholder: '20', description: '한 페이지에 표시할 글 개수. 페이지네이션 (?page=N) 자동.', defaultValue: 20 },
      // ── 광고 — AdSense 수동 슬롯 4개 (Phase 4 Step 6). Auto Ads 는 AdSense 콘솔에서 직접 ON ──
      { key: 'adsensePublisherId', label: 'AdSense Publisher ID', type: 'text', tab: '광고', placeholder: 'ca-pub-1234567890123456', description: 'Google AdSense Publisher ID. 박으면 head 에 AdSense script 자동 inject. Auto Ads 활성화는 AdSense 콘솔 (adsense.google.com → 자동 광고 → 사이트별 ON). Firebat 측에서는 별도 토글 없음 — script 박은 후엔 AdSense 콘솔이 광고 위치·형식 결정.' },
      { key: 'adsenseSlotHeaderBottom', label: '슬롯 — 헤더 아래', type: 'text', tab: '광고', placeholder: '1234567890', description: 'AdSense 광고 단위 ID — 헤더 바로 아래 위치. 비우면 미표시.' },
      { key: 'adsenseSlotPostTop', label: '슬롯 — 본문 위', type: 'text', tab: '광고', placeholder: '1234567890', description: 'AdSense 광고 단위 ID — 본문 시작 위. 비우면 미표시.' },
      { key: 'adsenseSlotPostBottom', label: '슬롯 — 본문 아래', type: 'text', tab: '광고', placeholder: '1234567890', description: 'AdSense 광고 단위 ID — 본문 끝 아래. 비우면 미표시.' },
      { key: 'adsenseSlotFooterTop', label: '슬롯 — 푸터 위', type: 'text', tab: '광고', placeholder: '1234567890', description: 'AdSense 광고 단위 ID — 푸터 바로 위. 비우면 미표시.' },
      // ── 테마 — 색·폰트·layout 토큰. 사용자 변경 즉시 모든 페이지 반영 (CSS var). ──
      { key: 'themePreset', label: '색 프리셋', type: 'color-presets', tab: '테마', description: '클릭 한 번으로 primary/accent/up/down/text/배경/테두리 색 일괄 변경. Light 7 + Dark 3 = 10 프리셋.', defaultValue: 'slate-pro' },
      { key: 'themeFont', label: '폰트 세트', type: 'select', tab: '테마', description: '본문·제목 폰트 통합 변경. Pretendard Variable (한글 최적, 기본) / Noto Sans KR / Inter / Geist / Cal Sans.', defaultValue: 'pretendard', options: [
        { value: 'pretendard', label: 'Pretendard Variable (한글, 기본)' },
        { value: 'noto-sans-kr', label: 'Noto Sans KR' },
        { value: 'inter', label: 'Inter (라틴)' },
        { value: 'geist', label: 'Geist (모노크롬)' },
        { value: 'cal-sans', label: 'Cal Sans (제목 강조)' },
      ] },
      { key: 'themeH1Style', label: 'H1 (제목) 스타일', type: 'select', tab: '테마', description: 'h1 제목 디자인. plain (기본 텍스트) / border-bottom (밑줄) / border-left (좌측 accent 바) / underline / bold-bg (강조 박스) / accent-square (accent 사각형 prefix).', defaultValue: 'plain', options: [
        { value: 'plain', label: 'plain (단순)' },
        { value: 'border-bottom', label: 'border-bottom (밑줄)' },
        { value: 'border-left', label: 'border-left (좌측 accent 바)' },
        { value: 'underline', label: 'underline (텍스트 밑줄)' },
        { value: 'bold-bg', label: 'bold-bg (강조 배경 박스)' },
        { value: 'accent-square', label: 'accent-square (사각형 prefix)' },
      ] },
      { key: 'themeH2Style', label: 'H2 (소제목) 스타일', type: 'select', tab: '테마', description: 'h2 소제목 디자인. 기본 border-left (좌측 accent 바).', defaultValue: 'border-left', options: [
        { value: 'plain', label: 'plain (단순)' },
        { value: 'border-bottom', label: 'border-bottom (밑줄)' },
        { value: 'border-left', label: 'border-left (좌측 accent 바, 기본)' },
        { value: 'underline', label: 'underline (텍스트 밑줄)' },
        { value: 'bold-bg', label: 'bold-bg (강조 배경 박스)' },
        { value: 'accent-square', label: 'accent-square (사각형 prefix)' },
      ] },
      { key: 'themeH3Style', label: 'H3 (소소제목) 스타일', type: 'select', tab: '테마', description: 'h3 소소제목 디자인. 기본 plain.', defaultValue: 'plain', options: [
        { value: 'plain', label: 'plain (단순, 기본)' },
        { value: 'border-bottom', label: 'border-bottom (밑줄)' },
        { value: 'border-left', label: 'border-left (좌측 accent 바)' },
        { value: 'underline', label: 'underline (텍스트 밑줄)' },
        { value: 'bold-bg', label: 'bold-bg (강조 배경 박스)' },
        { value: 'accent-square', label: 'accent-square (사각형 prefix)' },
      ] },
      { key: 'themeContentMaxWidth', label: '본문 최대 폭', type: 'text', tab: '테마', placeholder: '1200px', description: '본문 콘텐츠 영역 폭. px(1200px) / rem(75rem) / 절대값. 기본 1200px (이전 max-w-4xl 56rem ≈ 896px 대비 넓음).', defaultValue: '1200px' },
      { key: 'themePaddingMobile', label: '모바일 좌우 여백', type: 'text', tab: '테마', placeholder: '16px', description: '≤640px 화면 좌우 여백. 기본 16px. 좁히려면 12px / 8px, 넓히려면 20px.', defaultValue: '16px' },
      { key: 'themePaddingTablet', label: '태블릿 좌우 여백', type: 'text', tab: '테마', placeholder: '24px', description: '641~1023px 좌우 여백. 기본 24px.', defaultValue: '24px' },
      { key: 'themePaddingDesktop', label: '데스크톱 좌우 여백', type: 'text', tab: '테마', placeholder: '32px', description: '≥1024px 좌우 여백. 기본 32px.', defaultValue: '32px' },
      { key: 'themeRadius', label: '카드 모서리 둥글기', type: 'text', tab: '테마', placeholder: '8px', description: '카드·버튼·박스 border-radius. 0px (각진 모던) ~ 16px (둥근 친근). 기본 8px.', defaultValue: '8px' },
      { key: 'sitemapEnabled', label: 'Sitemap 생성', type: 'toggle', tab: 'SEO', description: '/sitemap.xml 자동 생성', defaultValue: true },
      { key: 'rssEnabled', label: 'RSS 피드', type: 'toggle', tab: 'SEO', description: '/feed.xml 자동 생성', defaultValue: true },
      { key: 'robotsTxt', label: 'robots.txt', type: 'textarea', tab: 'SEO', placeholder: 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin', description: 'robots.txt 내용', defaultValue: 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin' },
      { key: 'autoCanonical', label: '자동 Canonical URL', type: 'toggle', tab: 'SEO', description: '페이지 head.canonical 미지정 시 siteUrl + slug 으로 자동 생성. 중복 콘텐츠 방지.', defaultValue: true },
      { key: 'twitterCardType', label: 'Twitter Card 타입', type: 'text', tab: 'SEO', placeholder: 'summary_large_image', description: 'summary (작은 카드) 또는 summary_large_image (큰 이미지). 블로그·랜딩은 후자 권장.', defaultValue: 'summary_large_image' },
      { key: 'twitterSite', label: 'Twitter 사이트 계정', type: 'text', tab: 'SEO', placeholder: '@firebat', description: '사이트 자체 트위터 계정 (선택). @로 시작.' },
      { key: 'twitterCreator', label: 'Twitter 작성자 계정', type: 'text', tab: 'SEO', placeholder: '@username', description: '작성자 트위터 계정 (선택). @로 시작.' },
      { key: 'tagAliases', label: '태그 alias (정규화)', type: 'textarea', tab: 'SEO', placeholder: 'AI: ai, 인공지능, artificial-intelligence\n리뷰: review, 후기', description: 'canonical: alias1, alias2 줄별 매핑. /tag/{keyword} URL 매칭 시 case-insensitive normalize — "ai"·"인공지능" 모두 "AI" 페이지로 통합. listAllTags 도 통합 빈도 카운트.' },
      // 이미지 후처리 (sharp + blurhash) — AI 생성 이미지에 자동 적용
      { key: 'imageWebp', label: 'WebP 변환', type: 'toggle', tab: '이미지', description: '대부분 브라우저 지원, 원본 대비 25~35% 작음', defaultValue: true },
      { key: 'imageAvif', label: 'AVIF 변환', type: 'toggle', tab: '이미지', description: '최신 포맷, WebP 대비 20% 더 작음. Safari 16+, Chrome 85+', defaultValue: true },
      { key: 'imageThumbnail', label: '썸네일 생성 (256px)', type: 'toggle', tab: '이미지', description: '갤러리 썸네일 — <slug>-thumb.webp', defaultValue: true },
      { key: 'imageBlurhash', label: 'Blurhash LQIP', type: 'toggle', tab: '이미지', description: '로딩 중 부드러운 블러 플레이스홀더 (LCP 개선, 32자 문자열)', defaultValue: true },
      { key: 'imageVariants', label: '반응형 너비 (CSV)', type: 'text', tab: '이미지', placeholder: '480, 768, 1024', description: '각 너비마다 WebP/AVIF 쌍 생성 — srcset 자동 반영', defaultValue: '480, 768, 1024' },
      { key: 'imageDefaultQuality', label: '기본 품질 (1~100)', type: 'number', tab: '이미지', placeholder: '85', description: 'WebP/AVIF/JPEG 압축 품질. 85 권장', defaultValue: 85 },
      { key: 'imageStripExif', label: 'EXIF 제거', type: 'toggle', tab: '이미지', description: '촬영 위치·장비 등 메타데이터 제거 (프라이버시·용량)', defaultValue: true },
      { key: 'imageProgressive', label: 'Progressive 인코딩', type: 'toggle', tab: '이미지', description: 'JPEG/WebP 점진 표시 — 느린 네트워크에서 UX 개선', defaultValue: true },
      { key: 'imageKeepOriginal', label: '원본 파일 유지', type: 'toggle', tab: '이미지', description: '끄면 variants 만 보관 (용량 절약, 권장: 켜둠)', defaultValue: true },
      { key: 'ogBgColor', label: '배경색', type: 'text', tab: 'OG', placeholder: '#f8fafc', description: 'OG 이미지 배경색 (HEX)' },
      { key: 'ogAccentColor', label: '강조색', type: 'text', tab: 'OG', placeholder: '#2563eb', description: '상단 라인, 로고 테두리 색상' },
      { key: 'ogDomain', label: '도메인 표시', type: 'text', tab: 'OG', placeholder: 'example.com', description: 'OG 이미지 우하단 도메인 텍스트. 비워두면 요청 host 자동 감지.' },
      { key: 'headScripts', label: '<head> 스크립트', type: 'textarea', tab: '스크립트', placeholder: '<!-- Google Analytics 등 -->', description: '모든 페이지 <head>에 삽입할 HTML (SSR 박힘 — crawler 가 인식)' },
      { key: 'bodyScripts', label: '</body> 스크립트', type: 'textarea', tab: '스크립트', placeholder: '<!-- 채팅 위젯 등 -->', description: '모든 페이지 </body> 앞에 삽입할 HTML' },
      { key: 'adsTxt', label: 'ads.txt (legacy — verifications 권장)', type: 'textarea', tab: '스크립트', placeholder: 'google.com, pub-XXXXXXXX, DIRECT, f08c47fec0942fa0', description: '/ads.txt 응답 내용. 이 필드 비워두고 아래 "사이트 인증 파일" 의 ads.txt 항목 사용 권장 (verifications 시스템 통합).' },
      { key: 'verifications', label: '사이트 인증 파일', type: 'verifications', tab: '스크립트', description: 'Google Search Console (google{code}.html), AdSense (ads.txt), Naver Search Advisor (naverabc.html), Bing IndexNow (BingSiteAuth.xml), Yandex (yandex.html) 등 모든 사이트 소유권 인증 파일 통합 관리. (filename, content) 페어로 N개 등록.' },
    ],
  },
};

/** config.json secrets 배열 → SettingField[] 자동 생성 */
function secretsToFields(secrets: string[]): SettingField[] {
  return secrets.map(name => ({
    key: `_secret_${name}`,
    label: name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    type: 'secret' as FieldType,
    secretName: name,
    placeholder: name,
  }));
}

interface Props {
  moduleName: string;
  onClose: () => void;
  onBack?: () => void;
}

export function SystemModuleSettings({ moduleName, onClose, onBack }: Props) {
  // 'seo' 옛 모듈명 → 'cms' fallback (2026-04-28 SEO → CMS rename 호환)
  const manualSchema = MODULE_SETTINGS_SCHEMA[moduleName] ?? (moduleName === 'seo' ? MODULE_SETTINGS_SCHEMA['cms'] : undefined);
  const [schema, setSchema] = useState<{ title: string; fields: SettingField[] } | null>(null);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('');

  // 탭 목록 계산
  const hasTabs = schema?.fields.some(f => f.tab);
  const tabs = hasTabs ? [...new Set(schema!.fields.map(f => f.tab ?? '기본'))] : [];

  // 초기 탭 설정
  useEffect(() => { if (tabs.length > 0 && !activeTab) setActiveTab(tabs[0]); }, [tabs.length]); // eslint-disable-line

  // 초기 로드 — config.json + settings 동시 조회
  useEffect(() => {
    setLoading(true);
    fetch(`/api/settings/modules?name=${encodeURIComponent(moduleName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          // config.json에서 secrets 자동 생성
          const config = data.config as Record<string, unknown> | null;
          const configSecrets = (config?.secrets as string[] | undefined) ?? [];
          const autoFields = secretsToFields(configSecrets);

          // 수동 스키마의 secret 필드 중 config.json secrets에 이미 있는 것은 제외 (자동 생성으로 대체)
          const manualFields = manualSchema?.fields ?? [];
          const autoSecretNames = new Set(configSecrets);
          const filteredManual = manualFields.filter(f => !(f.type === 'secret' && f.secretName && autoSecretNames.has(f.secretName)));

          // 병합: 자동 secret 필드 먼저, 수동 필드 뒤에
          const allFields = [...autoFields, ...filteredManual];
          const title = manualSchema?.title || moduleName;
          setSchema({ title, fields: allFields });

          // 기본값과 저장된 값 병합
          const merged: Record<string, any> = {};
          for (const field of allFields) {
            if (field.defaultValue !== undefined) merged[field.key] = field.defaultValue;
          }
          const savedData = data.settings ?? {};
          for (const [key, val] of Object.entries(savedData)) {
            if (val !== null && val !== undefined) {
              merged[key] = val;
            }
          }
          setSettings(merged);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [moduleName]); // eslint-disable-line

  // OAuth 연동 상태 + 시크릿 값 로드
  const [oauthStatus, setOauthStatus] = useState<Record<string, boolean>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretSaved, setSecretSaved] = useState<Record<string, boolean>>({});
  const [secretSaving, setSecretSaving] = useState<Record<string, boolean>>({});

  const loadSecretsAndOauth = useCallback(async () => {
    if (!schema) return;
    const hasSecretOrOauth = schema.fields.some(f => f.type === 'oauth' || f.type === 'secret');
    if (!hasSecretOrOauth) return;
    try {
      const res = await fetch('/api/vault/secrets');
      const data = await res.json();
      if (!data.success) return;
      const secrets: { name: string; hasValue: boolean }[] = data.secrets ?? [];
      const secretNames = secrets.map(s => s.name);

      // OAuth 상태
      const oStatus: Record<string, boolean> = {};
      for (const field of schema.fields.filter(f => f.type === 'oauth' && f.oauthSecrets)) {
        oStatus[field.key] = (field.oauthSecrets ?? []).every(s => secretNames.includes(s));
      }
      setOauthStatus(oStatus);

      // 시크릿 필드 저장 상태
      const sStatus: Record<string, boolean> = {};
      for (const field of schema.fields.filter(f => f.type === 'secret' && f.secretName)) {
        sStatus[field.key] = secretNames.includes(field.secretName!);
      }
      setSecretSaved(sStatus);
    } catch {}
  }, [schema]);

  useEffect(() => { loadSecretsAndOauth(); }, [loadSecretsAndOauth]);

  const handleSaveSecret = async (field: SettingField) => {
    if (!field.secretName) return;
    const value = secretValues[field.key];
    if (!value?.trim()) return;
    setSecretSaving(prev => ({ ...prev, [field.key]: true }));
    try {
      await fetch('/api/vault/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: field.secretName, value }),
      });
      setSecretSaved(prev => ({ ...prev, [field.key]: true }));
      setSecretValues(prev => ({ ...prev, [field.key]: '' }));
    } catch {}
    finally { setSecretSaving(prev => ({ ...prev, [field.key]: false })); }
  };

  const handleChange = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/modules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: moduleName, settings }),
      });
      const data = await res.json();
      if (data.success) setSaved(true);
    } catch {}
    finally { setSaving(false); }
  };

  // ── MCP 서버 커스텀 상태 ──────────────────────────────────────────────────
  const [mcpTokenInfo, setMcpTokenInfo] = useState<{ exists: boolean; hint: string | null; createdAt: string | null }>({ exists: false, hint: null, createdAt: null });
  const [mcpTokenRaw, setMcpTokenRaw] = useState<string | null>(null);
  const [mcpTokenLoading, setMcpTokenLoading] = useState(false);
  const [mcpTokenCopied, setMcpTokenCopied] = useState(false);
  const [mcpJsonTab, setMcpJsonTab] = useState<'api' | 'stdio'>('api');
  const [mcpJsonCopied, setMcpJsonCopied] = useState(false);

  // 서비스별 엔드포인트 매핑 (app=외부용, llm=내부용)
  const isMcpApp = moduleName === 'mcp-server-app';
  const isMcpLlm = moduleName === 'mcp-server-llm';
  const mcpTokenEndpoint = isMcpLlm ? '/api/mcp-internal/token' : '/api/mcp/tokens';
  const mcpServerPath = isMcpLlm ? '/api/mcp-internal' : '/api/mcp';

  useEffect(() => {
    if (!isMcpApp && !isMcpLlm) return;
    fetch(mcpTokenEndpoint).then(r => r.json()).then(data => {
      if (data.success) {
        if (isMcpLlm) {
          // /api/mcp-internal/token 응답 형식: { token: {hasToken, masked}, createdAt }
          setMcpTokenInfo({ exists: data.token?.hasToken ?? false, hint: data.token?.masked ?? null, createdAt: data.createdAt ?? null });
        } else {
          setMcpTokenInfo({ exists: data.exists, hint: data.hint, createdAt: data.createdAt });
        }
      }
    }).catch(() => {});
  }, [moduleName, isMcpApp, isMcpLlm, mcpTokenEndpoint]);

  const generateMcpToken = async () => {
    if (mcpTokenInfo.exists && !await confirmDialog({ title: '토큰 재생성', message: '기존 토큰이 무효화됩니다. 새 토큰을 생성하시겠습니까?', danger: true, okLabel: '재생성' })) return;
    setMcpTokenLoading(true);
    try {
      const res = await fetch(mcpTokenEndpoint, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMcpTokenRaw(data.token);
        const hint = isMcpLlm
          ? `${(data.token as string).slice(0, 8)}****${(data.token as string).slice(-4)}`
          : data.hint;
        setMcpTokenInfo({ exists: true, hint, createdAt: data.createdAt });
      }
    } catch {} finally { setMcpTokenLoading(false); }
  };

  const revokeMcpToken = async () => {
    if (!await confirmDialog({ title: '토큰 폐기', message: '토큰을 폐기하면 해당 연결이 즉시 차단됩니다. 계속하시겠습니까?', danger: true, okLabel: '폐기' })) return;
    await fetch(mcpTokenEndpoint, { method: 'DELETE' });
    setMcpTokenInfo({ exists: false, hint: null, createdAt: null });
    setMcpTokenRaw(null);
  };

  const copyToClipboard = async (text: string, setCopied: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── MCP 서버 커스텀 렌더링 (앱 개발용 / LLM 통신용 공용) ─────────────────────
  if (isMcpApp || isMcpLlm) {
    const titleText = isMcpLlm ? 'Firebat MCP 서버 (LLM 통신용)' : 'Firebat MCP 서버 (앱 개발용)';
    const descText = isMcpLlm
      ? 'OpenAI Responses API (hosted MCP), Claude API 등 외부 LLM이 Firebat의 전체 도구 세트에 접근할 때 사용합니다.'
      : '외부 AI 도구(Claude Code, Cursor, VS Code 등)에서 이 파이어뱃 서버에 연결할 수 있습니다.';
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
        <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
              {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
              <Server size={18} className={isMcpLlm ? 'text-purple-500' : 'text-emerald-500'} /> {titleText}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
          </div>

          <div className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-scroll flex-1 min-h-0">
            <p className="text-[11px] sm:text-[12px] text-slate-400">{descText}</p>

            {/* JSON 설정 보기 */}
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="flex border-b border-slate-200">
                <button
                  onClick={() => { setMcpJsonTab('api'); setMcpJsonCopied(false); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] sm:text-[12px] font-bold transition-colors ${mcpJsonTab === 'api' ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-500' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <Globe size={12} /> SSE (API)
                </button>
                {isMcpApp && (
                  <button
                    onClick={() => { setMcpJsonTab('stdio'); setMcpJsonCopied(false); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] sm:text-[12px] font-bold transition-colors ${mcpJsonTab === 'stdio' ? 'bg-green-50 text-green-700 border-b-2 border-green-500' : 'text-slate-400 hover:text-slate-600'}`}
                  >
                    <Terminal size={12} /> stdio (SSH)
                  </button>
                )}
              </div>

              {mcpJsonTab === 'api' && (() => {
                const sseUrl = typeof window !== 'undefined' ? `${window.location.origin}${mcpServerPath}` : mcpServerPath;
                const tokenValue = mcpTokenRaw || (mcpTokenInfo.exists ? '<생성된 토큰>' : '<토큰을 먼저 생성하세요>');
                const jsonConfig = isMcpLlm
                  ? JSON.stringify({
                      tools: [{
                        type: 'mcp',
                        server_label: 'firebat-internal',
                        server_url: sseUrl,
                        headers: { Authorization: `Bearer ${tokenValue}` },
                        require_approval: 'never',
                      }],
                    }, null, 2)
                  : JSON.stringify({
                      mcpServers: { firebat: { url: sseUrl, headers: { Authorization: `Bearer ${tokenValue}` } } },
                    }, null, 2);
                return (
                  <div className="p-3 flex flex-col gap-3">
                    {/* 인증 토큰 */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col gap-2 min-h-[60px]">
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] sm:text-[13px] font-bold text-slate-600">인증 토큰</span>
                        <div className="flex items-center gap-1.5">
                          {mcpTokenInfo.exists && (
                            <button onClick={revokeMcpToken} className="text-[10px] sm:text-[11px] px-2 py-0.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors">
                              폐기
                            </button>
                          )}
                          <button
                            onClick={generateMcpToken}
                            disabled={mcpTokenLoading}
                            className="text-[10px] sm:text-[11px] px-2.5 py-1 font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded transition-colors flex items-center gap-1"
                          >
                            {mcpTokenLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                            {mcpTokenInfo.exists ? '재생성' : '토큰 생성'}
                          </button>
                        </div>
                      </div>

                      {mcpTokenRaw && (
                        <div className="bg-amber-50 border border-amber-300 rounded-lg p-2.5 flex flex-col gap-1.5">
                          <p className="text-[10px] sm:text-[11px] font-bold text-amber-700">이 토큰은 다시 볼 수 없습니다. 지금 복사하세요.</p>
                          <div className="flex items-center gap-1.5">
                            <code className="flex-1 text-[11px] sm:text-[12px] font-mono bg-white border border-amber-200 rounded px-2 py-1 text-slate-700 break-all select-all">
                              {mcpTokenRaw}
                            </code>
                            <Tooltip label="복사">
                              <button onClick={() => copyToClipboard(mcpTokenRaw, setMcpTokenCopied)} className="shrink-0 p-1.5 rounded hover:bg-amber-100 transition-colors">
                                {mcpTokenCopied ? <Check size={14} className="text-green-600" /> : <Copy size={14} className="text-amber-600" />}
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      )}

                      {mcpTokenInfo.exists && !mcpTokenRaw && (
                        <div className="flex items-center gap-2 text-[11px] sm:text-[12px] text-slate-500">
                          <code className="font-mono bg-white border border-slate-200 rounded px-2 py-0.5 text-slate-600">{mcpTokenInfo.hint}</code>
                          {mcpTokenInfo.createdAt && (
                            <span className="text-slate-400">생성: {new Date(mcpTokenInfo.createdAt).toLocaleDateString('ko-KR')}</span>
                          )}
                        </div>
                      )}

                      {!mcpTokenInfo.exists && !mcpTokenRaw && (
                        <p className="text-[10px] sm:text-[11px] text-slate-400">토큰이 없습니다. SSE(API) 연결을 사용하려면 토큰을 생성하세요.</p>
                      )}
                    </div>

                    {/* JSON 설정 */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] sm:text-[11px] text-slate-500">{isMcpLlm ? 'OpenAI Responses API의 tools에 아래 설정을 추가하세요 (Claude API도 동일 URL 사용).' : 'VS Code / Cursor MCP 설정에 아래 JSON을 추가하세요.'}</p>
                      <Tooltip label="복사">
                        <button onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors">
                          {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                        </button>
                      </Tooltip>
                    </div>
                    <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 whitespace-pre-wrap break-all leading-relaxed">{jsonConfig}</pre>
                  </div>
                );
              })()}

              {mcpJsonTab === 'stdio' && (() => {
                const jsonConfig = JSON.stringify({
                  mcpServers: { firebat: { command: 'ssh', args: ['-i', '<SSH_KEY_PATH>', '<USER>@<SERVER_IP>', 'cd /path/to/firebat && npx tsx mcp/stdio.ts'] } },
                }, null, 2);
                return (
                  <div className="p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] sm:text-[11px] text-slate-500">SSH를 통해 서버에 직접 접속하여 실행합니다.</p>
                      <Tooltip label="복사">
                        <button onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors">
                          {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                        </button>
                      </Tooltip>
                    </div>
                    <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">{jsonConfig}</pre>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[10px] sm:text-[11px] text-amber-700 flex flex-col gap-1">
                      <p className="font-bold">SSH 키 필수</p>
                      <p>stdio 모드는 서버에 SSH 키가 등록되어 있어야 합니다. 서버 관리자에게 SSH 공개키 등록을 요청하세요.</p>
                      <p className="text-amber-500 mt-0.5">SSH_KEY_PATH, USER, SERVER_IP, firebat 경로를 실제 값으로 변경하세요.</p>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* 하단 */}
          <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex justify-end shrink-0">
            <button onClick={onClose} className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors">
              닫기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 로딩 중이거나 설정 필드가 없는 모듈
  if (!loading && schema && schema.fields.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
        <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
              {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
              <Blocks size={18} className="text-indigo-500" /> {schema.title}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
          </div>
          <div className="p-6 text-center text-slate-500 text-sm flex-1 flex items-center justify-center">
            이 모듈에 대한 설정 항목이 없습니다.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
          <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
            {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
            <Blocks size={18} className="text-indigo-500" /> {schema?.title ?? moduleName}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
        </div>

        {/* 탭 바 — 가로 스크롤 (8 탭 좁은 화면에서도 wrap 안 함) */}
        {hasTabs && (
          <div className="flex border-b border-slate-200 px-3 sm:px-6 shrink-0 bg-white overflow-x-auto whitespace-nowrap" style={{ scrollbarWidth: 'thin' }}>
            {tabs.map(tab => {
              const meta = TAB_META[tab];
              const Icon = meta?.icon;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-[11px] sm:text-[12px] font-bold transition-colors border-b-2 shrink-0 ${activeTab === tab ? 'text-blue-700 border-blue-500' : 'text-slate-400 border-transparent hover:text-slate-600'}`}
                >
                  {Icon && <Icon size={13} />} {meta?.label ?? tab}
                </button>
              );
            })}
          </div>
        )}

        {/* 설정 필드 */}
        <div className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-scroll flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-slate-400" />
            </div>
          ) : (
            <>
            {/* OG 미리보기 */}
            {activeTab === 'OG' && (moduleName === 'cms' || moduleName === 'seo') && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs sm:text-sm font-bold text-slate-700">미리보기</label>
                  <a
                    href="/api/og"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] sm:text-[11px] text-blue-500 hover:text-blue-700 font-bold"
                  >
                    <ExternalLink size={11} /> 원본 보기
                  </a>
                </div>
                <div
                  className="relative rounded-lg border border-slate-200 overflow-hidden shadow-sm"
                  style={{ aspectRatio: '1200/630' }}
                >
                  <img
                    src={`/api/og?_t=${Date.now()}`}
                    alt="OG 미리보기"
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-[10px] text-slate-400">1200×630px · 설정 저장 후 새로고침하면 반영됩니다</p>
              </div>
            )}

            {(hasTabs ? (schema?.fields ?? []).filter(f => (f.tab ?? '기본') === activeTab) : (schema?.fields ?? [])).map(field => (
              <div key={field.key} className="flex flex-col gap-1.5 mb-1">
                {field.type === 'secret' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    {secretSaved[field.key] ? (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex-1">
                          <CheckCircle2 size={15} /> 등록됨
                        </span>
                        <button
                          onClick={() => setSecretSaved(prev => ({ ...prev, [field.key]: false }))}
                          className="px-3 py-2 text-[12px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
                        >
                          변경
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={secretValues[field.key] ?? ''}
                          onChange={e => setSecretValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          className="flex-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                        <button
                          onClick={() => handleSaveSecret(field)}
                          disabled={!secretValues[field.key]?.trim() || secretSaving[field.key]}
                          className="px-3 py-2 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shrink-0"
                        >
                          {secretSaving[field.key] ? <Loader2 size={14} className="animate-spin" /> : '저장'}
                        </button>
                      </div>
                    )}
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </div>
                ) : field.type === 'oauth' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    <div className="flex items-center gap-2">
                      {oauthStatus[field.key] ? (
                        <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex-1">
                          <CheckCircle2 size={15} /> 연동 완료
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-slate-400 text-[13px] font-medium px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg flex-1">
                          <Unlink size={14} /> 미연동
                        </span>
                      )}
                      <button
                        onClick={() => window.open(field.oauthUrl, 'oauth', 'width=500,height=700,left=200,top=100')}
                        className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors shadow-sm shrink-0"
                      >
                        <LinkIcon size={14} /> {oauthStatus[field.key] ? '재연동' : '연동하기'}
                      </button>
                    </div>
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </div>
                ) : field.type === 'verifications' ? (
                  <VerificationsField
                    label={field.label}
                    description={field.description}
                    value={Array.isArray(settings[field.key]) ? settings[field.key] : []}
                    onChange={(v) => handleChange(field.key, v)}
                  />
                ) : field.type === 'color-presets' ? (
                  <ColorPresetField
                    label={field.label}
                    description={field.description}
                    value={settings[field.key] ?? field.defaultValue ?? 'slate-pro'}
                    onChange={(v) => handleChange(field.key, v)}
                  />
                ) : field.type === 'select' ? (
                  <>
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    <select
                      value={settings[field.key] ?? field.defaultValue ?? ''}
                      onChange={e => handleChange(field.key, e.target.value)}
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      {(field.options ?? []).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </>
                ) : field.type === 'toggle' ? (
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</span>
                      {field.description && (
                        <p className="text-[10px] sm:text-xs text-slate-400 font-medium mt-0.5">{field.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleChange(field.key, !settings[field.key])}
                      className={`relative w-11 h-6 rounded-full transition-colors ${settings[field.key] ? 'bg-blue-500' : 'bg-slate-300'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${settings[field.key] ? 'translate-x-5' : ''}`} />
                    </button>
                  </label>
                ) : (
                  <>
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    {field.type === 'textarea' ? (
                      <textarea
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        rows={4}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono resize-y"
                      />
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                        placeholder={field.placeholder}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    )}
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </>
                )}
              </div>
            ))}
            {moduleName === 'telegram' && <TelegramWebhookSection />}
            </>
          )}
        </div>

        {/* 하단 버튼 */}
        {(() => {
          const hasNonSecretFields = schema?.fields.some(f => f.type !== 'secret' && f.type !== 'oauth');
          return (
            <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex items-center justify-between shrink-0">
              <div>
                {saved && (
                  <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold">
                    <CheckCircle2 size={15} /> 저장 완료
                  </span>
                )}
              </div>
              <div className="flex gap-2 sm:gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors"
                >
                  닫기
                </button>
                {hasNonSecretFields && (
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shadow-sm"
                  >
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                    {saving ? '저장 중...' : '저장'}
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ── 색 프리셋 button grid — 클릭 한 번으로 primary/accent/up/down 등 일괄 변경 ──
function ColorPresetField({ label, description, value, onChange }: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label className="text-xs sm:text-sm font-bold text-slate-700">{label}</label>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{description}</p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
        {Object.entries(COLOR_PRESETS).map(([key, preset]) => {
          const active = value === key;
          const c = preset.colors;
          return (
            <button
              key={key}
              onClick={() => onChange(key)}
              className={`relative flex flex-col gap-1.5 p-2 border rounded-lg text-left transition-all overflow-hidden ${
                active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200 hover:border-slate-300'
              }`}
              style={{ background: c.bgCard, color: c.text }}
            >
              {/* 미니 미리보기 — 'Aa' 본문 + accent line + primary 버튼 sample */}
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-extrabold leading-none" style={{ color: c.text, fontFamily: 'serif' }}>Aa</span>
                <span className="h-3 w-0.5 shrink-0" style={{ background: c.accent }} />
                <span className="text-[10px] font-bold leading-none truncate" style={{ color: c.primary }}>{preset.label}</span>
              </div>
              {/* 색 칩 — primary / accent / up / down 4 종 */}
              <div className="flex gap-1 shrink-0">
                <div style={{ background: c.primary, width: 16, height: 12, borderRadius: 2 }} title="primary" />
                <div style={{ background: c.accent, width: 16, height: 12, borderRadius: 2 }} title="accent" />
                <div style={{ background: c.up, width: 16, height: 12, borderRadius: 2 }} title="up" />
                <div style={{ background: c.down, width: 16, height: 12, borderRadius: 2 }} title="down" />
              </div>
              <span className="text-[9px] uppercase tracking-wider font-bold opacity-50">{preset.mode}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ── 사이트 인증 파일 편집 — verifications 배열 (filename, content) UI ─────────
function VerificationsField({ label, description, value, onChange }: {
  label: string;
  description?: string;
  value: Array<{ filename: string; content: string }>;
  onChange: (v: Array<{ filename: string; content: string }>) => void;
}) {
  const addItem = () => onChange([...value, { filename: '', content: '' }]);
  const removeItem = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const updateItem = (i: number, patch: Partial<{ filename: string; content: string }>) => {
    onChange(value.map((item, idx) => idx === i ? { ...item, ...patch } : item));
  };
  return (
    <>
      <label className="text-xs sm:text-sm font-bold text-slate-700">{label}</label>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{description}</p>
      )}
      <div className="flex flex-col gap-2 mt-1">
        {value.length === 0 && (
          <p className="text-xs text-slate-400 italic py-2 text-center bg-slate-50 border border-dashed border-slate-200 rounded-lg">
            등록된 인증 파일이 없습니다.
          </p>
        )}
        {value.map((item, i) => (
          <div key={i} className="flex flex-col gap-1.5 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={item.filename}
                onChange={e => updateItem(i, { filename: e.target.value })}
                placeholder="google1234567.html / naverabc.html / ads.txt 등"
                className="flex-1 px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <Tooltip label="삭제">
                <button
                  onClick={() => removeItem(i)}
                  className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                  aria-label="삭제"
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
            <textarea
              value={item.content}
              onChange={e => updateItem(i, { content: e.target.value })}
              placeholder="파일 내용 (예: ads.txt 표준 라인, Google site-verification meta 등)"
              rows={3}
              className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
            />
          </div>
        ))}
        <button
          onClick={addItem}
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold text-blue-600 hover:bg-blue-50 border border-dashed border-blue-300 rounded-lg transition-colors"
        >
          <Plus size={14} /> 인증 파일 추가
        </button>
      </div>
    </>
  );
}
