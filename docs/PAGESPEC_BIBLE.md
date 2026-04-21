# PAGESPEC BIBLE — 페이지 및 채팅 렌더링 규약

> Firebat의 모든 **선언적 UI 렌더링**을 다룬다. AI는 React/TSX를 직접 작성하지 않고, PageSpec JSON 혹은 채팅 블록으로 UI를 선언한다.

## 제1장: PageSpec 스키마

### 제1항. 구조

```json
{
  "slug": "bmi-계산기",
  "project": "health-tools",
  "status": "published",
  "head": {
    "title": "BMI 계산기",
    "description": "키와 몸무게로 체질량지수 계산",
    "keywords": "BMI, 건강, 계산기",
    "og": { "image": "/og-image.png" }
  },
  "body": [
    { "type": "Header", "props": { "text": "BMI 계산기", "level": 1 } },
    { "type": "Form", "props": { ... } }
  ]
}
```

- `slug`: URL 경로 (한글 허용)
- `project`: 논리적 묶음
- `status`: "published" | "draft"
- `head`: SEO/OG 메타
- `body`: Component 배열 (순차 렌더)

### 제2항. slug 규칙
- 한글/영문/숫자/하이픈 허용
- 공백/특수문자 금지
- 예: `/bmi-계산기`, `/portfolio-2026`

---

## 제2장: Page Component 목록 (27종)

페이지용 컴포넌트. `save_page`로 DB에 저장 → `app/(user)/[slug]/page.tsx`가 렌더.
채팅에서는 `render_<name>` 도구로도 직접 렌더 가능.

### 기본 UI
| Component | 역할 | 주요 Props |
|---|---|---|
| `Header` | 제목 | text, level(1~6) |
| `Text` | 본문 (마크다운) | content |
| `Divider` | 구분선 | — |
| `List` | 목록 | items[], ordered |
| `Image` | 이미지 | src, alt, width, height |
| `Button` | 링크 버튼 | text, href, variant |

### 레이아웃
| Component | 역할 | 주요 Props |
|---|---|---|
| `Card` | 카드 컨테이너 | children[] |
| `Grid` | 그리드 | columns, children[] |
| `Tabs` | 탭 | tabs[{label, children[]}] |
| `Accordion` | 아코디언 | items[{title, children[]}] |
| `Carousel` | 슬라이드 | children[], autoPlay, interval |

### 상태/알림
| Component | 역할 | 주요 Props |
|---|---|---|
| `Progress` | 진행률 | value, max, label, color |
| `Badge` | 뱃지 | text, color |
| `Alert` | 경고/알림 | message, type(info/warn/error/success), title |
| `Countdown` | 카운트다운 | targetDate, label |

### 데이터 입출력
| Component | 역할 | 주요 Props |
|---|---|---|
| `Form` | 입력 폼 (모듈 바인딩) | bindModule, inputs[], submitText |
| `ResultDisplay` | 실행 결과 | — |
| `Slider` | 슬라이더 | label, min, max, step, defaultValue, unit |
| `Table` | 테이블 | headers[], rows[][] |

### 시각화
| Component | 역할 | 주요 Props |
|---|---|---|
| `Chart` | 단순 차트 (색상/팔레트 커스텀) | type(bar/line/pie/doughnut), data, labels, title, color, palette, subtitle, unit, showValues |
| `Html` | 사용자 HTML (iframe sandbox) | content |
| `AdSlot` | 광고 슬롯 | slotId, format |

### 카드·요약 (v0.1, 2026-04-19 추가)
| Component | 역할 | 주요 Props |
|---|---|---|
| `Metric` | KPI 카드 (값 + 변화량 + 아이콘) | label, value, delta, unit, icon, trend(up/down) |
| `Timeline` | 세로 타임라인 | items[{title, date, description, status}] |
| `Compare` | 2열 비교 카드 | left{title, points[]}, right{title, points[]}, title |
| `KeyValue` | 키-값 리스트 | entries[{label, value, highlight?}] |
| `StatusBadge` | 상태 배지 그룹 | items[{label, status(ok/warn/error/info)}] |

### 알림 확장 (v0.1, 2026-04-18)
| Component | 역할 | 주요 Props |
|---|---|---|
| `Callout` | 정보 강조 박스 | type(info/success/tip/accent/highlight/neutral), title, content |

---

## 제3장: 채팅 블록 시스템

채팅은 PageSpec과 다른 구조. **block 배열**로 텍스트/시각화를 순서대로 표시.

### 제1항. Block 타입

```typescript
type Block =
  | { type: 'text'; text: string }                    // 마크다운 텍스트
  | { type: 'html'; htmlContent: string; htmlHeight?: string }  // iframe HTML
  | { type: 'component'; name: string; props: object }          // React 컴포넌트
```

### 제2항. 채팅 전용 컴포넌트

PageSpec 컴포넌트와 별도로, 채팅에서만 쓰는 특수 컴포넌트.

#### `StockChart` (주식 차트)
파일: `app/admin/chat-components/StockChart.tsx`
도구: `render_stock_chart`

**Props:**
```typescript
{
  symbol: string;        // "005930"
  title?: string;        // "삼성전자 일봉"
  data: Array<{
    date: string;        // "YYYY-MM-DD" 또는 "YYYYMMDD"
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  indicators?: Array<'MA5' | 'MA10' | 'MA20' | 'MA60'>;  // 기본 [MA5, MA20]
  buyPoints?: Array<{ label: string; price: number; note?: string }>;
  sellPoints?: Array<{ label: string; price: number; note?: string }>;
}
```

**렌더 구조:**
- 헤더: 종목명 + 심볼 + 기간 | 현재가 + 변동률
- 스탯 카드 4개: 시가 / 고가 / 저가 / 거래량
- 범례: MA 라인 색상 표시
- 메인 차트: 캔들(상승=빨강, 하락=파랑) + 이동평균 라인 + 매수/매도 기준선
- 호버: 크로스헤어 + OHLCV 툴팁
- 거래량 차트: 바 차트 (전일 대비 색상)
- 매수/매도 포인트 테이블

**특징:**
- 순수 SVG (의존성 없음, iframe 없음)
- Pretendard 폰트 자동 적용
- 모바일 터치 tooltip 지원
- 오래된→최신 자동 정렬
- 우측 2일 여백 (차트 관례)

---

## 제4장: 추가 컴포넌트 가이드

### 제1항. 언제 PageSpec Component vs 채팅 블록?

| 상황 | 방식 |
|---|---|
| 독립 페이지 (SEO 필요) | `save_page` → PageSpec Component |
| 채팅 답변 내 시각화 | `render_pagespec`/`render_stock_chart`/`render_html` |
| 1회성 차트/표 | 채팅 블록 |
| 재방문용 대시보드 | PageSpec 페이지 |

### 제2항. 신규 컴포넌트 추가 원칙

1. **용도 구분 명확화** — "페이지용" vs "채팅 전용" 결정
2. **Props 최소화** — 필수만. 스타일/색상은 내부 기본값
3. **모바일 우선** — 반응형 기본, 작은 화면에서 깨지지 않음
4. **Pretendard/Tailwind 일관** — 본문 UI와 동일 스타일
5. **본 BIBLE에 추가** — 신규 컴포넌트는 반드시 문서화

### 제3항. 파일 위치 규약
- PageSpec Component: `app/(user)/[slug]/components.tsx`
- 채팅 전용: `app/admin/chat-components/<Name>.tsx`

---

## 제5장: AI 렌더 도구 매핑

| 도구 | 블록 타입 | 용도 |
|---|---|---|
| `save_page` | — | PageSpec 페이지 DB 저장 |
| `render_stock_chart` | component:StockChart | 주식 시각화 (전용) |
| `render_html` | html | 자유 HTML (iframe, 지도/다이어그램 등) |

### 제1항. 우선순위
1. **주식 관련** → `render_stock_chart`
2. **정형화된 데이터** (표/카드/뱃지/알림) → `render_pagespec` (추후 구현)
3. **지도/다이어그램/애니메이션** → `render_html` + CDN 라이브러리
4. **최후의 수단** → `render_html` 자유 HTML

### 제2항. 금지사항
- 같은 시각화를 `render_html`로 해놓고 전용 도구가 있는 경우 선택 실수
- 코드 블록 ` ```json ` 안에 도구 호출 구조 노출 (서버가 필터링하지만 AI는 애초에 하지 말 것)

---

## 제6장: LLM 응답 sanitize 레이어 (v0.1, 2026-04-21)

모든 LLM (Gemini/Claude/Codex/GPT — API·CLI 공통) 응답이 `AiManager.processWithTools` 한 지점을 통과하므로 정제도 이 지점에서만 수행. 프론트 컴포넌트는 받은 값을 그대로 렌더.

- **파일**: `core/utils/sanitize.ts`
- **진입점**: `AiManager.processWithTools` 최종 return 직전 `sanitizeBlock` / `sanitizeReply` 일괄 적용
- **규칙 (필드명 기반)**:
  - `TEXT_FIELDS` (label/title/message/description/subLabel/unit/…) → HTML 인라인 태그 + 마크다운 마커(`**`, `*`, `` ` ``) 제거
  - `NUMERIC_LIKE_FIELDS` (value/delta) → 숫자·숫자성 문자열은 locale 콤마 포맷 (`1000000` → `"1,000,000"`)
  - `TEXT_ARRAY_FIELDS` (columns/rows/cells/items/steps/indicators/buyPoints/sellPoints) → 배열 원소 재귀 정제. `rows` 는 2차원이라 `insideTextArray` 플래그 전파.
  - `PRESERVE` (Text.content, Html.content/htmlContent) → 원본 유지 (마크다운 렌더러 + iframe 담당)
- **프론트 측**: `app/(user)/[...slug]/components.tsx` 의 `cleanPlainText` 는 `null → ''` 코어션 passthrough 로 단순화. 실제 정제 로직 제거 → 이중 처리 / 스타일별 중복 구현 방지.
- **리플라이 텍스트**: `sanitizeReply` 는 HTML 태그만 마크다운 마커로 치환하고 마커는 유지 (ReactMarkdown 이 렌더).

### 제1항. 추가 원칙

- 새 render_* 컴포넌트의 텍스트 필드명은 `TEXT_FIELDS` set 에 등록 (필드명 기준 자동 인식).
- 배열 필드(예: `sections`) 원소가 텍스트 원시값이면 `TEXT_ARRAY_FIELDS` 에 추가.
- 마크다운/HTML 원본이 의미를 갖는 필드(예: Text.content) 는 `PRESERVE_FIELDS_BY_COMP` 에 컴포넌트별 등록.
- **하드코딩 금지**: 특정 모델·특정 상황 defensive regex 로 덮지 말고 필드명 분류로 해결.

## 제7장: 향후 계획

- [ ] `render_pagespec` 도구 — PageSpec 컴포넌트를 채팅에서도 쓸 수 있게 노출
- [ ] `LineChart`/`BarChart` 채팅 전용 컴포넌트 (StockChart 스타일)
- [ ] 실시간 업데이트 블록 (`component:LiveCard`)
- [ ] 다국어 라벨 (i18n 통합 시)
