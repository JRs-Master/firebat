# PAGESPEC BIBLE — 페이지 및 채팅 렌더링 규약

> 최종 개정: 2026-07-18 (`module` 블록 — 페이지↔모듈 바인딩: publish bake · request SSR · rebake 크론 · 템플릿 shortcode)
>
> Firebat의 모든 **선언적 UI 렌더링**을 다룬다. AI는 React/TSX를 직접 작성하지 않고, PageSpec JSON 혹은 채팅 블록으로 UI를 선언한다.
>
> **🔥 Phase B-4 cutover 후 영향 없음** — PageSpec JSON schema + 42 빌트인 컴포넌트 + Frontend (`app/(user)/[...slug]/components.tsx`) 모두 동일. 차이: 페이지 저장 backend 가 옛 TS PageManager → Rust `core/src/managers/page.rs`. JSON shape (head/body/seo) 100% 호환.

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

### 제1-1항. Page-level layout override (v0.1, 2026-05-03)

`head` 안에 layout override 옵션 추가 가능 — 글로벌 CMS 설정 무시하고 이 페이지만 다른 모드:

```json
{
  "head": {
    "title": "히어로 풀폭 페이지",
    "layoutMode": "full",       // 'full' | 'right-sidebar' | 'left-sidebar' | 'both-sidebar' | 'boxed'
    "contentMaxWidth": "none"    // CSS 값 ('800px', '90rem', 'none' 등)
  }
}
```

- `layoutMode`: 글로벌 CMS layout 모드 무시. 사용 예 — 글로벌 right-sidebar 인데 hero 페이지만 'full', 단일 글만 'boxed'.
- `contentMaxWidth`: 글로벌 max-width 무시. 페이지별 다른 폭 (XSS 가드 — `;{}<>` 차단 + 64자 한도).

middleware (`proxy.ts`) 가 `x-firebat-pathname` header 추가 → `(user)/layout.tsx` 가 spec.head 조회 후 자동 적용.

### 제1-2항. `module` 블록 — 페이지↔모듈 바인딩 (PageSpec 전용, 2026-07-18)

페이지가 모듈 데이터를 소비하는 표준 블록. **components.json 미등록** — 채팅 fence 대상이 아니고, AI 는 save_page spec 저작으로만 사용한다.

```json
{ "type": "module", "props": {
    "module": "yfinance", "action": "page_blocks", "args": { "symbol": "005930.KS" },
    "when": "publish",            // "publish"(기본, 저장 시 bake) | "request"(방문 시 SSR resolve)
    "cacheTtl": 300,              // request 모드 TTL(초, clamp 60~3600)
    "_baked": [ { "type": "stock_chart", "props": { } } ],   // 서버 산출물 — 바인딩 옆 병기(치환 아님)
    "_bakedAt": 1789000000000
} }
```

- **게이트**: 모듈 config 가 `pageBinding: {alias?, action}` 을 선언한 경우 + **그 선언 액션만** 실행(폐쇄 opt-in). requiresApproval 액션 = 전면 거부. hub-scope 저장 = bake skip. 상세 = MODULE_BIBLE `pageBinding` 절.
- **바인딩이 산 채 유지**되므로 `rebake:<slug>` 크론(schedule_task targetPath)이 표준 정기 페이지가 된다 — 발행 시점 데이터 고정(`dataCacheKey` bake)과 달리 갱신 가능.
- **렌더**: 프론트 `Module` 컴포넌트가 `_baked` 블록 배열을 그대로 렌더(재귀 ComponentRenderer). `_baked` 없으면 빈 렌더(공백) — request 모드는 SSR 이 채움.
- **텍스트 sugar**: 템플릿 text 블록의 `{alias k="v"}` (모듈 config 의 `pageBinding.alias`, 등록된 것만) 가 `get_template` 시 이 블록으로 컴파일된다. 미등록 `{word}` = 리터럴 유지(`{date}` 원리).

### 제2항. slug 규칙
- 한글/영문/숫자/하이픈 허용
- 공백/특수문자 금지
- 예: `/bmi-계산기`, `/portfolio-2026`

---

## 제2장: 컴포넌트 목록 (레지스트리 42종)

페이지용 컴포넌트. `save_page`로 DB에 저장 → `app/(user)/[slug]/page.tsx`가 렌더.
채팅에서는 본문 안 ` ```firebat-render ` fence(제3장 제3항)로 직접 렌더.

> 채팅 render 레지스트리(`core/src/managers/ai/components.json`) 기준 **42 컴포넌트**:
> - 기본·시각화 27: stock_chart · chart · table · badge · callout · progress · header · text · list · divider · countdown · image · card · grid · metric · timeline · compare · key_value · plan_card · status_badge · diagram · math · code · slideshow · lottie · network · map
> - 퀴즈 2: quiz · quiz_group
> - 인터랙티브 6 (2026-06-16): form(모듈 바인딩) · button · slider · tabs · accordion · carousel (children/items = grid 미러 `{type,props}`)
> - 학습 5 (2026-06-19~20): sentence(구문독해 S/V/O·직독직해) · vocab(인출·Leitner·니모닉) · passage · concept · listening(LC 플레이어·받아쓰기·노래방 정렬)
> - 라이브 2 (2026-07-05, WS 2b): live_feed · live_chart — `stream_watch_start` 의 SSE topic 구독. **수명 = 뷰포트 가시성**(보일 때만 live, 벗어나면 마지막 값+타임스탬프 동결, 영속 = 생성 시점 스냅샷)
> (아래 표의 Alert / ResultDisplay / Html / AdSlot 은 PageSpec 페이지 전용.)

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
| `Chart` | 단순 차트 (색상/팔레트 커스텀) | chartType(bar/line/pie/doughnut, `donut` alias→doughnut), data/series, labels, title, color, palette, subtitle, unit, showValues |
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

### 인터랙티브 · 고급 시각화
| Component | 역할 | 주요 Props |
|---|---|---|
| `Quiz` | 단일 퀴즈 (객관식 채점) | question, choices[], answer(1-based)/answerIndex(0-based), explanation |
| `QuizGroup` | 퀴즈 묶음 | quizzes[] |
| `Math` | 수식 (KaTeX) | content, display(block/inline) |
| `Code` | 코드 블록 (syntax highlight) | code, language |
| `Diagram` | 다이어그램 (Mermaid 등) | content/definition |
| `Slideshow` | 슬라이드쇼 | slides[] |
| `Lottie` | Lottie 애니메이션 | src/data, loop, autoplay |
| `Network` | 노드-엣지 네트워크 그래프 | nodes[], edges[] |
| `Map` | 지도 (MapLibre / 카카오 자동 전환) | lat, lng, zoom, markers[] |
| `PlanCard` | 실행 계획 카드 (propose_plan) | steps[], summary, planId |

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

### 제1-1항. 렌더 채널 = `firebat-render` fence (2026-06-17 도입, 2026-07-02 구조 강제 — 주 경로)

채팅 시각화의 **주 채널은 도구가 아니라 본문 텍스트 안 fence** — "콘텐츠 = fence / 액션 = 도구" 원칙(FIREBAT_BIBLE 제6장 제4항). 모델이 도구호출 인자 안에서 한국어를 생성하면 깨지는(옳→옵) 상류 한계 + content 단일 소스가 메모리·회상을 공짜로 얻는 구조 우위.

- 형식: 본문 안 ` ```firebat-render\n[{type, props}, ...]\n``` ` (JSON blocks 배열). 산문 사이 인라인 배치 가능.
- 서버(`render_exec::mask_and_sanitize_fences`)가 fence 를 마스킹 → `render_blocks` 로 sanitize·schema 검증 → 검증된 JSON 을 fence 에 되써넣음. 프론트(`lib/util/md.ts splitFirebatRender`)가 fence = ComponentRenderer / 나머지 = 마크다운으로 split 렌더 (admin·발행·공유 3 surface 공통).
- **관대 파서** (2026-07-07): JSON 안 `//`·`/* */` 주석 + trailing comma 를 문자열-인식 스캐너로 제거 후 재파싱(strict 우선) — 모델 방언 수용. 저장분도 프론트에서 소급 렌더.
- **큰 데이터 = `dataCacheKey` 참조** (2026-07-06): 캔들 수백 봉 등은 값 대신 sysmod 캐시 키를 fence props 에 적으면 서버(`FenceDataResolver`)가 캐시 전체 records 를 `props.data` 로 주입 — AI 손 복사·truncation·날조 차단. `dataRange:{from,to}` / `dataLimit:N` 으로 기간·개수 슬라이스.
- raw kind: ` ```firebat-html/code/math/diagram ` 류 body-verbatim fence(JSON escape 0) — 큰 HTML/LaTeX 용 (staged).

### 제2항. 채팅 전용 컴포넌트

PageSpec 컴포넌트와 별도로, 채팅에서만 쓰는 특수 컴포넌트.

#### `StockChart` (주식 차트)
파일: `app/admin/chat-components/StockChart.tsx`
호출: fence `stock_chart` 블록 (데이터는 `dataCacheKey` 참조 권장 — 서버가 캐시 전체 주입)

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
- 모바일 터치: 드래그=스크롤 / 롱프레스=툴팁 (MTS 표준)
- 오래된→최신 자동 정렬 / 보이는 구간 동적 Y축 / 커서 앵커 줌
- close-only 데이터 감지 시 종가 라인 모드 (거래량 pane 숨김 — flat-doji 방지)
- 표준 OHLCV 필드(`{date,open,high,low,close,volume}`) — 브로커 3사·yfinance 모듈이 이 어휘로 정규화해 반환

---

## 제4장: 추가 컴포넌트 가이드

### 제1항. 언제 PageSpec Component vs 채팅 블록?

| 상황 | 방식 |
|---|---|
| 독립 페이지 (SEO 필요) | `save_page` → PageSpec Component |
| 채팅 답변 내 시각화 | 통합 `render`(`{blocks:[{type, props}]}`) / `render_stock_chart` / `render_iframe` |
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

## 제5장: AI 렌더 채널 매핑 (2026-07 현행)

| 채널 | 용도 |
|---|---|
| ` ```firebat-render ` **fence** (본문 텍스트) | 채팅 시각화 **주 경로** — 42 컴포넌트 전부 (제3장 제1-1항) |
| `render` 도구 | **code / math / diagram 전용** — 그 외 컴포넌트는 코드가 거부(`tool_mode` 게이트, 2026-07-02) + "fence 로 쓰라" 에러. 큰 raw 코드·LaTeX 의 hand-escape 리스크 회피용 |
| `render_iframe` | html — 한 섹션 iframe 위젯 (CDN 라이브러리 시각화, 자유 HTML 최후 수단) |
| `save_page` | PageSpec 페이지 DB 저장 (승인 카드 경유) |

### 제1항. 우선순위
1. **정형 데이터·시각화 전반** (표/차트/카드/지도/주식차트/학습/라이브) → `firebat-render` fence
2. **코드/수식/다이어그램** → fence 또는 `render` 도구 (둘 다 허용 — 도구는 이 3종만 통과)
3. **CDN 라이브러리·자유 HTML** → `render_iframe` (한 섹션, 페이지 본문 통째 아님)

### 제2항. 금지사항
- 페이지 본문 전체를 `render_iframe` 1개 블록으로 만드는 것 — iframe 안에서 AdSense 광고·SEO 인덱싱 모두 차단됨
- fence 없는 bare-JSON 덤프 (fence 마커 없는 JSON 은 strip 됨)
- 캔들·시계열 큰 배열을 fence 에 손으로 복사하는 것 — `dataCacheKey` 참조가 정공 (손 복사 = truncation·날조 관측됨)

---

## 제6장: LLM 응답 sanitize 레이어 (v0.1, 2026-04-21)

모든 LLM (Gemini/Claude/Codex/GPT — API·CLI 공통) 응답이 `AiManager.processWithTools` 한 지점을 통과하므로 정제도 이 지점에서만 수행. 프론트 컴포넌트는 받은 값을 그대로 렌더.

- **파일**: `core/src/utils/sanitize.rs`
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

### 제2항. render_* ↔ 컴포넌트 단일 매핑 (v0.1, 2026-04-21)

> ⚠️ 아래는 옛 TS 시절 예시 — 현재 코어는 Rust (core/src). 개념 참고용. 28→1 통합 후 채팅 시각화는 단일 `render` 도구가 `core/src/managers/ai/components.json` schema 로 직접 검증하며, 컴포넌트 매핑·정규화도 Rust core 안에서 처리.

`lib/render-map.ts` 가 단일 source. 이전엔 4군데 (ai-manager / cli-gemini / cli-claude-code / cli-codex) 에 동일 매핑 hardcode → 모두 import 통합.

```ts
// lib/render-map.ts
export const RENDER_TOOL_MAP = {
  render_table: 'Table',
  render_chart: 'Chart',
  render_metric: 'Metric',
  // ... 29개
};
export function normalizeRenderName(name: string): string | null;
```

**자동 정규화** (`normalizeRenderName`):
- `render_table` (정확) → `render_table`
- `render-table` (kebab) → `render_table`
- `table` (접두사 누락) → `render_table`
- 매칭 실패 → null

`AiManager.executeToolCall` default case 가 호출 → AI 가 `table` / `render-chart` / `render_챠트` 등 잘못 호출해도 자동 매칭. 새 컴포넌트 추가 시 `lib/render-map.ts` 한 줄만 수정.

### 제3항. 자동 마크다운 변환 (v0.1, 2026-04-21)

AI 가 시스템 프롬프트 무시하고 `|---|` 마크다운 표 / `## 헤더` 그대로 출력하는 케이스 backend 후처리. `core/src/utils/sanitize.rs` 의 `extractMarkdownStructure(reply)`:

- reply 를 line 단위로 walk → segments `[text|header|table]` 순서 분할
- `# ~ ######` 헤더 → `render_header` (level 1~6)
- `|---| 표` (헤더줄 + 구분줄 + 데이터줄 N개) → `render_table`

`AiManager.processWithTools` 가 segments 로 마지막 text 블록을 교체 (순서 보존). 시스템 프롬프트 강제 룰 대신 후처리.

### 제4항. 컴포넌트 정렬 (column 일관) (v0.1, 2026-04-21)

per-cell numeric 자동 right-align 로직 제거 (column 안 정렬 일관 유지). AI 가 `align: ['left', 'right', 'center', ...]` 명시한 것만 사용. 미지정 시:
- 데이터 셀: 좌측
- 헤더: 짧으면(≤20자) center, 길면 좌측 (multi-line 어색 회피)
- ▲▼ 색상 (등락 시각화) 은 유지

Metric 도 동일: `valueIsNumeric` 자동 right 정렬 제거. AI 가 `valueAlign` 명시 안 하면 center.

## 제7장: 향후 계획

- [x] PageSpec 컴포넌트를 채팅에서도 쓸 수 있게 노출 — 통합 `render` → **fence 채널**로 완성 (2026-06-17)
- [x] 실시간 업데이트 블록 — `live_feed` / `live_chart` (WS 2b, 2026-07-05, 뷰포트 가시성 수명)
- [ ] `LineChart`/`BarChart` 채팅 전용 컴포넌트 (StockChart 스타일 — 현재 chart 로 충분)
- [ ] 다국어 라벨 (i18n 통합 시)
- [ ] save_page title+body fence 화 (②단계 — 도구 인자 한글 깨짐의 잔여 표면)
