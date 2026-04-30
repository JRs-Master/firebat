/**
 * Component Registry — render() 디스패처가 사용하는 컴포넌트 카탈로그
 *
 * AI는 search_components(query) 로 관련 컴포넌트를 찾고,
 * render(name, props) 로 실제 렌더링을 요청한다.
 *
 * 개별 render_* 도구를 매 요청마다 노출하는 대신, 13개 정의를 이 레지스트리에만
 * 담아 토큰 절감 + 스케일 대비. 컴포넌트가 수백/수천 개로 늘어도 토큰 비용은 고정.
 *
 * 유지되는 직접 도구 (토큰 비용 수용):
 *   - render_alert, render_callout: 안전망·보편 UX
 *   - render_iframe: iframe CDN 로직 특수 (sandbox srcDoc + dependencies 자동 합성)
 *   - suggest: 사용자 선택 UI
 */
import type { JsonSchemaProperty } from '../../core/ports';

export interface ComponentDef {
  /** render(name, ...) 에서 쓰는 이름 */
  name: string;
  /** 프론트엔드 ComponentRenderer가 기대하는 타입명 */
  componentType: string;
  /** AI에게 보여주는 도구 설명 */
  description: string;
  /** 벡터 임베딩 입력 — 키워드 나열 (길수록 의미 확장) */
  semanticText: string;
  /** JSON Schema — AI가 props 조립에 사용 */
  propsSchema: JsonSchemaProperty;
}

// ── 재사용 schema 조각 ─────────────────────────────────────────────────────
const ohlcvItem: JsonSchemaProperty = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD 또는 YYYYMMDD' },
    open: { type: 'number' },
    high: { type: 'number' },
    low: { type: 'number' },
    close: { type: 'number' },
    volume: { type: 'number' },
  },
  required: ['date', 'open', 'high', 'low', 'close', 'volume'],
  additionalProperties: false,
};
const pricePoint: JsonSchemaProperty = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    price: { type: 'number' },
    note: { type: ['string', 'null'] },
  },
  required: ['label', 'price', 'note'],
  additionalProperties: false,
};
const nestedChild: JsonSchemaProperty = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    props: { type: 'object', additionalProperties: true },
  },
  required: ['type', 'props'],
};

export const COMPONENTS: ComponentDef[] = [
  {
    name: 'stock_chart',
    componentType: 'StockChart',
    description: '주식 캔들 차트 (OHLCV 일봉·분봉). 주가 시세 시각화 시 사용. 매수/매도 포인트, 이동평균선 표시 가능.',
    semanticText: '주식 종목 시세 주가 캔들 일봉 분봉 차트 OHLCV 이동평균 MA 골든크로스 데드크로스 거래량 저항 지지 매수 매도 포인트 005930 삼성전자 코스피 코스닥 투자 분석',
    propsSchema: {
      type: 'object',
      required: ['symbol', 'title', 'data', 'indicators', 'buyPoints', 'sellPoints'],
      additionalProperties: false,
      properties: {
        symbol: { type: 'string', description: '종목 코드 (예: "005930")' },
        title: { type: 'string', description: '종목 한글명 (예: "삼성전자") — 심볼 코드 금지' },
        data: { type: 'array', items: ohlcvItem, description: 'OHLCV 배열 — 오래된 → 최신 순서. 최소 10일 이상 권장' },
        indicators: { type: 'array', items: { type: 'string', enum: ['MA5', 'MA10', 'MA20', 'MA60'] }, description: '이동평균선. 기본 ["MA5","MA20"]. 불필요하면 []' },
        buyPoints: { type: 'array', items: pricePoint, description: '매수 구간. 없으면 []' },
        sellPoints: { type: 'array', items: pricePoint, description: '매도 구간. 없으면 []' },
      },
    },
  },
  {
    name: 'chart',
    componentType: 'Chart',
    description: '일반 차트 (막대/선/원형/도넛). 수치 비교·추이·분포 시각화. 주식 시세는 stock_chart 사용.',
    semanticText: '차트 그래프 막대 바 선 라인 원형 파이 도넛 시각화 비교 추이 분포 퍼센트 비율 통계 수치 데이터',
    propsSchema: {
      type: 'object',
      required: ['chartType', 'labels', 'data', 'title'],
      additionalProperties: false,
      properties: {
        chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
        labels: { type: 'array', items: { type: 'string' } },
        data: { type: 'array', items: { type: 'number' } },
        title: { type: ['string', 'null'] },
      },
    },
  },
  {
    name: 'table',
    componentType: 'Table',
    description: '표/테이블. 수치 3개 이상 나열·비교 시 필수. 마크다운 |---| 금지. 열 많을 때 stickyCol=true 로 첫 열 고정. 행 많을 때 striped=true 로 zebra (가독성 ↑), stickyHeader=true 로 헤더 고정 (긴 표 스크롤 시).',
    semanticText: '표 테이블 grid 행 열 헤더 나열 비교 정리 스프레드시트 데이터 목록 항목 필드 매출 지표 순위 리스트',
    propsSchema: {
      type: 'object',
      required: ['headers', 'rows', 'stickyCol'],
      additionalProperties: false,
      properties: {
        headers: { type: 'array', items: { type: 'string' }, description: '열 헤더' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '행 데이터 (각 행은 문자열 배열)' },
        stickyCol: { type: ['boolean', 'null'], description: 'true면 첫 열 고정. 기본 false.' },
        striped: { type: ['boolean', 'null'], description: 'true면 짝수 행 배경 살짝 어둡게 (zebra). 기본 false.' },
        stickyHeader: { type: ['boolean', 'null'], description: 'true면 헤더 행 sticky (긴 표 세로 스크롤 시 헤더 고정). 기본 false.' },
      },
    },
  },
  {
    name: 'badge',
    componentType: 'Badge',
    description: '작은 태그/뱃지. 상태·카테고리·라벨 표시.',
    semanticText: '뱃지 배지 태그 레이블 라벨 상태 카테고리 표시 마크 chip pill',
    propsSchema: {
      type: 'object',
      required: ['text', 'color'],
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        color: { type: 'string', description: '색상 (blue, red, green, amber, slate 등)' },
      },
    },
  },
  {
    name: 'progress',
    componentType: 'Progress',
    description: '진행률 바. 0~100% 표시. 태스크 완료율, 로딩, 예산 사용률 등.',
    semanticText: '프로그래스 진행률 진행도 완료율 퍼센트 비율 로딩 바 progress bar 달성률',
    propsSchema: {
      type: 'object',
      required: ['value', 'max', 'label', 'color'],
      additionalProperties: false,
      properties: {
        value: { type: 'number' },
        max: { type: 'number', description: '기본 100' },
        label: { type: ['string', 'null'] },
        color: { type: ['string', 'null'] },
      },
    },
  },
  {
    name: 'header',
    componentType: 'Header',
    description: '섹션 제목 (h1~h6). 구조적 타이틀.',
    semanticText: '제목 헤더 타이틀 섹션 h1 h2 h3 h4 h5 h6 구분 heading title 챕터',
    propsSchema: {
      type: 'object',
      required: ['text', 'level'],
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        level: { type: 'integer', enum: [1, 2, 3, 4, 5, 6], description: '기본 2' },
      },
    },
  },
  {
    name: 'text',
    componentType: 'Text',
    description: '본문 텍스트 블록. 명시 구조가 필요할 때만. 일반 답변은 그냥 텍스트.',
    semanticText: '텍스트 본문 문단 paragraph 내용 글 설명 description',
    propsSchema: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: { type: 'string' },
      },
    },
  },
  {
    name: 'list',
    componentType: 'List',
    description: '목록 (3개 이상 권장). 순서있는 번호 리스트 또는 글머리 리스트.',
    semanticText: '리스트 목록 항목 나열 bullet ordered unordered 번호 1 2 3 체크 체크리스트 todo',
    propsSchema: {
      type: 'object',
      required: ['items', 'ordered'],
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        ordered: { type: 'boolean', description: '번호 매기기 (true) 또는 글머리 (false)' },
      },
    },
  },
  {
    name: 'divider',
    componentType: 'Divider',
    description: '섹션 구분선.',
    semanticText: '구분선 경계선 divider hr 수평선 separator 분리',
    propsSchema: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'countdown',
    componentType: 'Countdown',
    description: '특정 시각까지 카운트다운 타이머.',
    semanticText: '카운트다운 타이머 시간 제한 남은시간 디데이 D-DAY deadline 마감 timer',
    propsSchema: {
      type: 'object',
      required: ['targetDate', 'label'],
      additionalProperties: false,
      properties: {
        targetDate: { type: 'string', description: 'ISO 8601 (예: "2026-12-31T23:59:59")' },
        label: { type: ['string', 'null'] },
      },
    },
  },
  {
    name: 'image',
    componentType: 'Image',
    description: '이미지. src URL과 alt 필수.',
    semanticText: '이미지 그림 사진 picture photo img 썸네일 thumbnail',
    propsSchema: {
      type: 'object',
      required: ['src', 'alt', 'width', 'height'],
      additionalProperties: false,
      properties: {
        src: { type: 'string' },
        alt: { type: ['string', 'null'] },
        width: { type: ['integer', 'null'] },
        height: { type: ['integer', 'null'] },
      },
    },
  },
  {
    name: 'card',
    componentType: 'Card',
    description: '카드 (children에 다른 컴포넌트 배치). 제목+내용+이미지 그룹. image 박으면 상단 hero 이미지, footer 박으면 하단 메타 텍스트, link 박으면 카드 전체 클릭.',
    semanticText: '카드 card 블록 박스 그룹 container wrapper 요약 summary 프리뷰 썸네일 이미지 hero',
    propsSchema: {
      type: 'object',
      required: ['children'],
      properties: {
        children: { type: 'array', items: nestedChild },
        image: {
          type: ['object', 'null'],
          description: '카드 상단 hero 이미지 (선택).',
          properties: {
            src: { type: 'string', description: '이미지 URL — /user/media/... 또는 https://...' },
            alt: { type: 'string', description: '대체 텍스트 (SEO·접근성)' },
          },
        },
        footer: { type: ['string', 'null'], description: '카드 하단 메타 텍스트 (작성일·읽는시간 등)' },
        link: {
          type: ['object', 'null'],
          description: '카드 전체 클릭 시 이동 (선택).',
          properties: {
            href: { type: 'string', description: '이동 URL' },
          },
        },
      },
    },
  },
  {
    name: 'grid',
    componentType: 'Grid',
    description: '그리드 레이아웃 (n열로 children 배치).',
    semanticText: '그리드 격자 레이아웃 2열 3열 4열 columns 나열 배치 layout',
    propsSchema: {
      type: 'object',
      required: ['columns', 'children'],
      properties: {
        columns: { type: 'integer', description: '열 수 (2, 3, 4)' },
        children: { type: 'array', items: nestedChild },
      },
    },
  },
  {
    name: 'metric',
    componentType: 'Metric',
    description: '단일 지표 카드 (라벨 + 값 + 증감 화살표 + 아이콘). KPI 대시보드 구성 시 Grid 안에 여러 개 배치. link 박으면 카드 전체 클릭 가능 (CTA).',
    semanticText: '지표 수치 카드 KPI 대시보드 현재가 PER PBR 보유율 달성률 점수 변동 증감 상승 하락 메트릭 스탯 stat metric 통계',
    propsSchema: {
      type: 'object',
      required: ['label', 'value'],
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: '지표명' },
        value: { type: ['string', 'number'], description: '대표 수치' },
        unit: { type: ['string', 'null'], description: '단위 (원/%/배 등)' },
        delta: { type: ['string', 'number', 'null'], description: '증감치' },
        deltaType: { type: ['string', 'null'], enum: ['up', 'down', 'neutral'], description: 'up=빨강, down=파랑, neutral=회색 (생략 가능)' },
        subLabel: { type: ['string', 'null'], description: '보조 설명' },
        icon: { type: ['string', 'null'], description: '이모지 아이콘' },
        link: {
          type: ['object', 'null'],
          description: '카드 전체 클릭 시 이동 (선택). 박으면 카드가 anchor 로 wrap + label 텍스트 하단 표시.',
          properties: {
            label: { type: 'string', description: '카드 하단 CTA 텍스트 (예: "자세히 보기")' },
            href: { type: 'string', description: '이동 URL' },
          },
        },
      },
    },
  },
  {
    name: 'timeline',
    componentType: 'Timeline',
    description: '연대기 / 이벤트 타임라인. 날짜 + 제목 + 설명 세로 배치.',
    semanticText: '타임라인 연대기 이벤트 이력 히스토리 history timeline 일정 단계 progress steps',
    propsSchema: {
      type: 'object',
      required: ['items'],
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['date', 'title'],
            properties: {
              date: { type: 'string' },
              title: { type: 'string' },
              description: { type: ['string', 'null'] },
              type: { type: ['string', 'null'], enum: ['default', 'success', 'warning', 'error'], description: '점 색상 구분 (생략 가능)' },
              href: { type: ['string', 'null'], description: '항목 전체 클릭 시 이동 URL (선택). 박으면 항목이 anchor 로 wrap.' },
            },
          },
        },
      },
    },
  },
  {
    name: 'compare',
    componentType: 'Compare',
    description: 'A vs B 대조. 두 대상의 속성별 비교를 표 형태로.',
    semanticText: '비교 대조 vs AB 선택 옵션 compare versus 장단점 대비',
    propsSchema: {
      type: 'object',
      required: ['left', 'right'],
      properties: {
        title: { type: ['string', 'null'] },
        left: {
          type: 'object',
          required: ['label', 'items'],
          properties: {
            label: { type: 'string' },
            items: { type: 'array', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } },
          },
        },
        right: {
          type: 'object',
          required: ['label', 'items'],
          properties: {
            label: { type: 'string' },
            items: { type: 'array', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } },
          },
        },
      },
    },
  },
  {
    name: 'key_value',
    componentType: 'KeyValue',
    description: '라벨:값 구조적 나열. 종목 스펙·제품 정보·재무 지표 등.',
    semanticText: '키밸류 라벨 값 속성 정보 스펙 spec 정보 info 필드',
    propsSchema: {
      type: 'object',
      required: ['items'],
      properties: {
        title: { type: ['string', 'null'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'value'],
            properties: {
              key: { type: 'string' },
              value: { type: ['string', 'number'] },
              highlight: { type: ['boolean', 'null'] },
              href: { type: ['string', 'null'], description: '항목 클릭 시 이동 URL (선택). 박으면 row 가 anchor 로 wrap.' },
            },
          },
        },
        columns: { type: ['integer', 'null'], description: '1/2/3 (기본 2)' },
      },
    },
  },
  {
    name: 'plan_card',
    componentType: 'PlanCard',
    description: '복잡 다단계 작업 실행 전 사용자 승인용 플랜 카드. 제목 + 단계 체크리스트 + 예상 시간 + 리스크. AI 가 5개+ 도구 호출 예상될 때 이걸 먼저 제시 → suggest 로 ["실행","수정","취소"] 받아 진행.',
    semanticText: '플랜 계획 로드맵 단계 step 체크리스트 todo 예정 로드맵 plan approve execute workflow 승인',
    propsSchema: {
      type: 'object',
      required: ['title', 'steps'],
      properties: {
        title: { type: 'string', description: '플랜 제목 (간결히)' },
        steps: {
          type: 'array',
          description: '실행 단계 순서',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', description: '단계 제목' },
              description: { type: ['string', 'null'], description: '간단 설명 (선택)' },
              tool: { type: ['string', 'null'], description: '사용할 주요 도구명 (참고용)' },
            },
          },
        },
        estimatedTime: { type: ['string', 'null'], description: '예상 소요. 예: "2~3분"' },
        risks: {
          type: ['array', 'null'],
          description: '주의사항·리스크',
          items: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'status_badge',
    componentType: 'StatusBadge',
    description: '의미 기반 상태 뱃지 세트. 여러 상태를 한 줄에. 예: "정배열"(positive), "과열"(warning).',
    semanticText: '상태 뱃지 배지 태그 지표 정배열 과열 중립 positive negative warning info label tag chip',
    propsSchema: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'status'],
            properties: {
              label: { type: 'string' },
              status: { type: 'string', enum: ['positive', 'negative', 'neutral', 'warning', 'info'] },
            },
          },
        },
      },
    },
  },
  {
    name: 'diagram',
    componentType: 'Diagram',
    description: 'Mermaid 다이어그램 — flowchart / sequence / gantt / classDiagram / stateDiagram / mindmap / timeline / pie. text DSL 만 박으면 자동 렌더. iframe + inline JS 보다 token 절감 + 안정.',
    semanticText: '다이어그램 diagram mermaid flowchart sequence gantt class state mindmap pie 워크플로우 의사결정 트리',
    propsSchema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'Mermaid DSL (예: "flowchart TD\\n  A-->B"). 공식 문서 https://mermaid.js.org/' },
        theme: { type: ['string', 'null'], description: 'default / dark / forest / neutral (기본 default)' },
      },
    },
  },
  {
    name: 'math',
    componentType: 'Math',
    description: 'KaTeX 수식 — LaTeX 문자열 inline 또는 block. 수학·통계·재무 공식 표시. iframe 보다 단순.',
    semanticText: '수식 math 수학 LaTeX katex 공식 수학식 통계 재무 적분 미분 시그마',
    propsSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: { type: 'string', description: 'LaTeX 수식 (예: "\\\\frac{a}{b}", "\\\\int_0^1 x^2 dx")' },
        block: { type: ['boolean', 'null'], description: 'true=block (centered, large), false=inline. 기본 true' },
      },
    },
  },
  {
    name: 'code',
    componentType: 'Code',
    description: '코드 스니펫 — highlight.js syntax highlight 자동. language 명시 시 정확. 블로그·문서·README 자주.',
    semanticText: '코드 code 스니펫 snippet syntax highlight 프로그래밍 javascript python typescript SQL hljs',
    propsSchema: {
      type: 'object',
      required: ['code', 'language'],
      properties: {
        code: { type: 'string', description: '코드 내용 (multi-line OK)' },
        language: { type: 'string', description: 'javascript / typescript / python / sql / json / bash / html / css 등 hljs 지원 언어' },
        showLineNumbers: { type: ['boolean', 'null'], description: '줄 번호 표시 (기본 true)' },
        title: { type: ['string', 'null'], description: '코드 블록 위 제목 (예: "main.py")' },
      },
    },
  },
  {
    name: 'slideshow',
    componentType: 'Slideshow',
    description: 'Swiper 이미지 슬라이드쇼 — 가로 슬라이드 + 페이지네이션 + 자동재생 옵션. 마케팅·갤러리·히어로 페이지. (children 기반 카드 캐러셀은 render_carousel 별도)',
    semanticText: '슬라이드 slide 슬라이드쇼 slideshow swiper 갤러리 gallery 이미지 슬라이더 hero 마케팅',
    propsSchema: {
      type: 'object',
      required: ['images'],
      properties: {
        images: {
          type: 'array',
          items: {
            type: 'object',
            required: ['src'],
            properties: {
              src: { type: 'string', description: '이미지 URL — /user/media/... 또는 https://...' },
              alt: { type: ['string', 'null'] },
              caption: { type: ['string', 'null'], description: '이미지 위 캡션 (선택)' },
            },
          },
        },
        autoplay: { type: ['boolean', 'null'], description: '자동재생 (기본 false)' },
        autoplayDelay: { type: ['integer', 'null'], description: '자동재생 간격 ms (기본 3000)' },
        height: { type: ['string', 'null'], description: '슬라이드 높이 (예: "400px"). 기본 400px' },
      },
    },
  },
  {
    name: 'lottie',
    componentType: 'Lottie',
    description: 'Lottie JSON 애니메이션 — Adobe After Effects 의 lottie-web 형식. JSON URL 박으면 자동 재생. 마케팅·온보딩·일러스트.',
    semanticText: 'Lottie 애니메이션 animation 일러스트 illustration JSON 모션 motion graphic AE',
    propsSchema: {
      type: 'object',
      required: ['src'],
      properties: {
        src: { type: 'string', description: 'Lottie JSON 파일 URL (lottiefiles.com 또는 자체 호스팅)' },
        loop: { type: ['boolean', 'null'], description: '루프 재생 (기본 true)' },
        autoplay: { type: ['boolean', 'null'], description: '자동재생 (기본 true)' },
        height: { type: ['string', 'null'], description: '높이 (예: "300px"). 기본 300px' },
      },
    },
  },
  {
    name: 'network',
    componentType: 'Network',
    description: 'Cytoscape 네트워크 그래프 — 노드 + 간선 시각화. 관계도·조직도·데이터 흐름·시스템 아키텍처.',
    semanticText: '네트워크 network 그래프 graph cytoscape 노드 node 간선 edge 관계도 조직도 의존성 시스템',
    propsSchema: {
      type: 'object',
      required: ['nodes', 'edges'],
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'label'],
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              color: { type: ['string', 'null'], description: '노드 색 (red / blue / green / orange / purple)' },
            },
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            required: ['source', 'target'],
            properties: {
              source: { type: 'string', description: 'nodes 의 id' },
              target: { type: 'string', description: 'nodes 의 id' },
              label: { type: ['string', 'null'], description: '간선 라벨 (선택)' },
            },
          },
        },
        layout: { type: ['string', 'null'], description: 'cose (기본, 자동 배치) / circle / grid / breadthfirst' },
        height: { type: ['string', 'null'], description: '높이 (기본 400px)' },
      },
    },
  },
  {
    name: 'map',
    componentType: 'Map',
    description: '지도 + 마커. 부동산 거래·날씨·매장 위치 등 지리 데이터 시각화. **provider 자동 분기**: South Korea 좌표 (위도 33-38.7, 경도 124.5-132) + 카카오 JS 키 박혀있으면 카카오맵, **South Korea 외 지역은 Leaflet+OSM** (CDN 무료, 카카오는 한국만 정밀). 카카오 키 미설정 시 South Korea 좌표도 Leaflet 폴백. **좌표 환각 절대 금지** — markers/center 의 lat·lon 은 반드시 sysmod_kakao-map (action: geocoding · search-keyword · search-address) 결과 또는 sysmod 도구 호출 결과로만 채울 것. AI 학습 기억으로 좌표 박지 마라 — 옆건물·옆동네 표시 위험. **좌표 못 얻으면 render_map 호출 자체 금지** — render_iframe·render_chart scatter 등으로 "좌표 비례 표시" 같은 fake 지도 만들지 마라. 진짜 지도 외 표현은 시도 자체 안 함. 좌표 부재 시 텍스트로만 결과 보고. South Korea 외 지역은 다른 geocoding sysmod 또는 사용자가 명시한 좌표만 사용.',
    semanticText: '지도 맵 map 마커 marker 위치 location 좌표 latlng 카카오 kakao leaflet osm 부동산 시세 날씨 매장 South Korea',
    propsSchema: {
      type: 'object',
      required: ['markers'],
      properties: {
        markers: {
          type: 'array',
          description: '마커 배열. 좌표가 South Korea → 카카오 (정밀, JS 키 필요), South Korea 외 → Leaflet+OSM (자동)',
          items: {
            type: 'object',
            required: ['lat', 'lon', 'label'],
            properties: {
              lat: { type: 'number', description: '위도 — sysmod geocoding 결과만 사용. AI 기억으로 박지 마라.' },
              lon: { type: 'number', description: '경도 — sysmod geocoding 결과만 사용. AI 기억으로 박지 마라.' },
              label: { type: 'string', description: '마커 위 짧은 라벨' },
              popup: { type: ['string', 'null'], description: '마커 클릭 시 popup 텍스트 (HTML 일부 허용)' },
              color: { type: ['string', 'null'], description: 'red / blue / green / orange / purple (기본 red). Leaflet 만 색상 반영 — 카카오는 기본 핀' },
              type: { type: ['string', 'null'], description: '카테고리 분류 — real-estate / weather / poi 등 (UI 그룹화 용)' },
            },
          },
        },
        center: {
          type: ['object', 'null'],
          description: '지도 중심 좌표. 미지정 시 markers 평균 자동',
          properties: {
            lat: { type: 'number' },
            lon: { type: 'number' },
          },
        },
        zoom: { type: ['integer', 'null'], description: '줌 레벨. Leaflet 1-18 / 카카오 level 1-14. 기본 12' },
        height: { type: ['string', 'null'], description: '지도 높이 (예: "400px"). 기본 400px' },
        provider: { type: ['string', 'null'], description: 'auto (기본 — South Korea→카카오/South Korea 외→Leaflet) / leaflet (South Korea 외 전용 또는 강제) / kakao (South Korea 강제)' },
      },
    },
  },
];

/** name → ComponentDef 맵 (render 디스패처에서 사용) */
export const COMPONENTS_BY_NAME: Map<string, ComponentDef> = new Map(COMPONENTS.map(c => [c.name, c]));
