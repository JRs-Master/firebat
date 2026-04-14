# FIREBAT AI GUIDELINES — 요원 작업 지침서

이 문서는 AI 에이전트가 Firebat OS 환경에서 작업할 때 반드시 따라야 할 실무 지침이다.
(시스템 기능이 추가될 때마다 업데이트된다.)

> 최종 개정: 2026-04-14 (v0.1)

---

## 1. 핵심 철학: 유기적 동작 원칙

AI는 개별 테스트 케이스를 위해 하드코딩된 동작을 하면 안 된다. 모든 판단은 **시스템 인프라와 모듈 명세(module.json)** 를 기반으로 유기적으로 이루어져야 한다.

- **프롬프트 패치 금지**: 특정 상황에 맞춘 임시 규칙을 추가하는 대신, 모듈/인프라 설계를 개선한다.
- **선언 기반 동작**: `module.json`의 `packages`가 의존성을 선언하면, Sandbox가 알아서 설치하고 실행한다. AI가 의존성 설치 명령을 직접 실행할 필요 없다.
- **스펙 기반 호출**: 모듈을 쓰기 전 반드시 `module.json`을 읽어 `input`/`output` 계약을 확인한다.

---

## 2. 작업 공간 (Sandboxed Workspace)

AI가 파일을 생성/수정할 수 있는 구역은 다음뿐이다.

| 구역 | 용도 |
|---|---|
| `user/modules/[module-name]/` | UI 없는 백엔드 모듈 |

**절대 금지**: `core/`, `infra/`, `system/`, `app/admin/`, `app/api/`, `app/(user)/` 등 시스템 구역 수정 시도 → Infra Storage 계층에서 `[Kernel Block]`으로 즉시 차단.

> **참고**: `app/(user)/` 경로에 직접 page.tsx를 작성하지 않는다. 웹 페이지는 반드시 `SAVE_PAGE` 액션으로 DB에 저장한다.

---

## 3. 웹 페이지/앱 생성 (PageSpec 시스템)

### 2단계 앱 생성 — 설계 먼저, 확인 후 구현

1. 사용자 요청 수신 → **Plan 수립** (thoughts + actions 목록)
2. 확인이 필요한 액션(SAVE_PAGE, DELETE_PAGE 등)은 사용자 확인 후 실행
3. 자동 실행 가능 액션(WRITE_FILE, TEST_RUN 등)은 즉시 실행

### 페이지 생성 — `SAVE_PAGE` 액션 사용

AI가 웹 앱이나 페이지를 만들 때는 **반드시 `SAVE_PAGE` 액션**으로 PageSpec JSON을 DB에 저장한다.

```json
{
  "type": "SAVE_PAGE",
  "slug": "bmi-계산기",
  "spec": {
    "slug": "bmi-계산기",
    "status": "published",
    "project": "bmi-project",
    "head": {
      "title": "BMI 계산기 - Firebat",
      "description": "키와 몸무게로 비만도를 계산합니다.",
      "keywords": ["BMI", "비만도", "계산기"],
      "og": { "title": "BMI 계산기", "description": "비만도 즉시 계산", "image": "", "type": "website" }
    },
    "body": [
      { "type": "Header", "props": { "text": "BMI 계산기", "level": 1 } },
      { "type": "Form", "props": {
        "bindModule": "bmi-backend",
        "inputs": [
          { "name": "height", "label": "키(cm)", "type": "number", "required": true },
          { "name": "weight", "label": "몸무게(kg)", "type": "number", "required": true }
        ],
        "submitText": "계산하기"
      }},
      { "type": "ResultDisplay", "props": { "bindModule": "bmi-backend" } },
      { "type": "Text", "props": { "content": "BMI 18.5 이하=저체중, 18.5~24.9=정상, 25 이상=과체중" } }
    ]
  }
}
```

### slug 규칙
- **한글 허용**: `bmi-계산기`, `날씨-알리미`, `영어-단어장` 등
- **영어도 가능**: `bmi-calculator`, `weather-alert`
- **형식**: 하이픈으로 단어 구분, 공백 금지, 특수문자 금지

### 페이지 삭제 — `DELETE_PAGE`
```json
{ "type": "DELETE_PAGE", "slug": "bmi-계산기" }
```

### 페이지 목록 — `LIST_PAGES`
```json
{ "type": "LIST_PAGES" }
```

---

## 4. 프로젝트 묶기

페이지와 모듈을 프로젝트 단위로 관리할 수 있다.

### 연결 방법
- PageSpec의 `project` 필드와 module.json의 `project` 필드에 **동일한 프로젝트명**을 설정한다.
- 한 프로젝트에 **여러 페이지**를 만들 수 있다.

### 예시
```
SAVE_PAGE { slug: "bmi-입력",  spec: { project: "bmi-project", ... } }
SAVE_PAGE { slug: "bmi-결과",  spec: { project: "bmi-project", ... } }
WRITE_FILE { path: "user/modules/bmi-backend/module.json",
             content: { "project": "bmi-project", ... } }
```

### 프로젝트 삭제
관리자가 사이드바에서 프로젝트를 삭제하면 해당 프로젝트의 **모든 페이지(DB) + 모든 모듈(파일)** 이 일괄 삭제된다.

---

## 5. 컴포넌트 타입 목록 (22개)

PageSpec의 `body` 배열에 사용할 수 있는 컴포넌트 타입:

| 컴포넌트 | 역할 | 핵심 props |
|---|---|---|
| `Header` | 제목 | `text`, `level` (1~6) |
| `Text` | 본문 텍스트 (마크다운 지원) | `content` |
| `Image` | 이미지 | `src`, `alt`, `width?`, `height?` |
| `Form` | 폼 → 모듈 바인딩 | `bindModule`, `inputs[]`, `submitText` |
| `ResultDisplay` | 모듈 실행 결과 | `bindModule` (Form과 동일 값) |
| `Button` | 링크/액션 | `text`, `href?`, `variant?` (primary/secondary/outline) |
| `Divider` | 구분선 | — |
| `Table` | 데이터 테이블 | `headers[]`, `rows[][]` |
| `Card` | 카드 컨테이너 | `children[]` (중첩 컴포넌트) |
| `Grid` | 그리드 레이아웃 | `columns` (1~4), `children[]` (중첩 컴포넌트) |
| `AdSlot` | 광고 슬롯 | `slotId`, `format?` |
| `Html` | 사용자 정의 HTML (iframe sandbox) | `content` (HTML+CSS+JS 자유, 외부 CDN 사용 가능) |
| `Slider` | 슬라이더 입력 | `min`, `max`, `step?`, `label?` |
| `Tabs` | 탭 UI | `tabs[]` (중첩 컴포넌트) |
| `Accordion` | 아코디언 | `items[]` (중첩 컴포넌트) |
| `Progress` | 진행률 바 | `value`, `max?`, `label?` |
| `Badge` | 뱃지 | `text`, `variant?` |
| `Alert` | 알림/경고 메시지 | `message`, `type?` (info/success/warning/error) |
| `List` | 순서형/비순서형 목록 | `items[]`, `ordered?` |
| `Carousel` | 슬라이드 캐러셀 | `slides[]` (중첩 컴포넌트) |
| `Countdown` | 카운트다운 타이머 | `targetDate`, `label?` |
| `Chart` | 차트 | `chartType` (bar/line/pie/doughnut), `data`, `options?` |

### Html 컴포넌트 상세
- **iframe sandbox="allow-scripts"** 안에서 실행 (allow-same-origin 없음)
- HTML + CSS + JavaScript 자유롭게 사용 가능
- 외부 CDN 사용 가능 (Google Fonts, Chart.js, Three.js, Tailwind CDN 등)
- `<style>` 태그로 CSS, `<script>` 태그로 JS 작성
- **vw 단위 사용 금지** — iframe 안이라 뷰포트 크기와 다름. `%`, `rem`, `px` 사용
- Html 단독 페이지(body에 Html 하나만)는 전체 화면으로 렌더링

---

## 6. 모듈 생성 규약

### 순수 모듈 (`user/modules/`)
```
user/modules/[module-name]/
  ├── main.py (또는 index.js, main.php 등)
  └── module.json  ← 필수
```

### module.json 필수 포함
```json
{
  "name": "module-name",
  "version": "1.0.0",
  "description": "모듈 역할 설명",
  "runtime": "python",
  "project": "project-name",
  "packages": ["requests", "beautifulsoup4"],
  "secrets": ["API_KEY", "SECRET_TOKEN"],
  "input": {
    "query": "string (required) — 검색어"
  },
  "output": {
    "results": "array<{title, url, summary}>"
  }
}
```

- `packages`: 선언된 의존성은 Sandbox가 실행 전 자동 설치한다. `requirements.txt`나 별도 설치 명령 불필요.
- `secrets`: 모듈이 필요로 하는 API 키 목록. 설정 → API 키 탭에 자동 목록화되며, 미등록 시 사용자에게 안내한다.
- `runtime`: `python`, `node`, `php` 등 실행 환경.

### 시크릿 접근
모듈 코드에서 시크릿은 **환경변수**로 접근한다:
```python
# Python
api_key = os.environ["API_KEY"]
```
```javascript
// Node.js
const apiKey = process.env["API_KEY"];
```

---

## 7. 모듈 I/O 프로토콜

### stdin 읽기
```python
# Python
import sys, json
payload = json.loads(sys.stdin.buffer.read())
data = payload["data"]
query = data["query"]
```
```javascript
// Node.js
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const { data } = JSON.parse(d);
});
```

### stdout 출력 (마지막 줄 단일 JSON)
```python
print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
```

**주의**:
- `print("debug message")` 같은 일반 출력은 파싱 에러를 유발한다. 디버그는 `sys.stderr`로.
- Python은 `True`/`False`/`None` 사용 (JSON의 `true`/`false`/`null` 아님).

---

## 8. 시스템 모듈 활용

Firebat이 미리 만들어둔 시스템 모듈(`system/modules/`)을 우선 활용한다. 직접 구현하기 전에 반드시 탐색한다.

### 탐색 순서
1. `LIST_DIR system/modules/` → 사용 가능한 모듈 목록 확인
2. `READ_FILE system/modules/[name]/module.json` → `description`, `input`, `output` 스펙 확인
3. 스펙에 맞게 `TEST_RUN` 호출

### 현재 제공 시스템 모듈

| 모듈 | 타입 | capability | 설명 |
|---|---|---|---|
| `browser-scrape` | local | web-scrape | Playwright 기반 JS 렌더링 웹 스크래퍼 |
| `jina-reader` | api | web-scrape | Jina Reader API 기반 웹 스크래퍼 (가볍고 빠름) |
| `kakao-talk` | api | notification | 카카오톡 나에게 보내기 (text/feed/list 메시지) |

---

## 9. 파이프라인 원칙

UI에 결과를 보여줄 때 프론트엔드를 직접 하드코딩하지 않는다.

**올바른 흐름**:
1. 백엔드 모듈 작성 (`user/modules/`)
2. `TEST_RUN`으로 검증
3. `SAVE_PAGE`로 PageSpec 저장 (Form 컴포넌트에서 `bindModule`로 모듈 연결)

---

## 10. 파일명 규칙

| 대상 | 규칙 | 예시 |
|---|---|---|
| 모듈 폴더/파일명 | 영어 kebab-case 강제 | `user/modules/bmi-backend/` |
| 페이지 slug | 한글 허용 | `bmi-계산기`, `weather-alert` |
| UI 텍스트 | 한국어 유지 | 버튼, 라벨, 안내문 |
| 프로젝트명 | 모듈 폴더명 = 페이지 slug 통일 권장 | `weather-app` |

---

## 11. 에러 처리

| 에러 종류 | 대응 |
|---|---|
| `[Kernel Block]` | 즉시 중단. `actions: []`로 권한 제한 안내 |
| `[Runtime Missing]` | 시스템 런타임 미설치 안내. 사용자가 재시도 요청 시 즉시 재시도 |
| `TEST_RUN` 실패 | 에러 내용 분석 후 코드 수정, 최대 3회 자가 치유 |
| `[TIMEOUT]` | 로직 최적화 또는 waitFor 조정 후 재시도 |
| `SAVE_PAGE 실패` | JSON 구조 검증 후 수정하여 재시도 |
| API 키 미설정 | `REQUEST_SECRET` 액션으로 사용자에게 키 입력 요청 |

---

## 12. 크론/스케줄링

### 스케줄 등록 — `SCHEDULE_TASK`
```json
{
  "type": "SCHEDULE_TASK",
  "jobId": "daily-stock-check",
  "targetPath": "user/modules/stock-checker/main.py",
  "cronTime": "0 10 * * *"
}
```

### 3가지 스케줄 모드
| 모드 | 필드 | 설명 |
|---|---|---|
| 반복 | `cronTime` | cron 표현식 (예: `"0 10 * * *"` = 매일 10시) |
| 1회 예약 | `runAt` | ISO 날짜 (예: `"2026-04-15T10:00:00"`) |
| N초 후 1회 | `delaySec` | 초 단위 (예: `60` = 1분 후) |

### 기간 한정 반복
`startAt`/`endAt` 필드로 반복 기간을 제한할 수 있다. 만료 시 자동 해제.

### 파이프라인 스케줄링
복합 작업은 `pipeline` 배열로 단계별 실행:
```json
{
  "type": "SCHEDULE_TASK",
  "jobId": "news-summary",
  "cronTime": "0 9 * * *",
  "pipeline": [
    { "type": "MCP_CALL", "server": "jina", "tool": "read", "inputMap": { "url": "https://news.site" } },
    { "type": "LLM_TRANSFORM", "instruction": "위 뉴스를 3줄로 요약해줘" },
    { "type": "TEST_RUN", "path": "user/modules/kakao-sender/main.py", "inputMap": { "message": "$prev" } }
  ]
}
```
- `$prev`: 이전 단계 결과를 자동 전달
- 파이프라인 단계: `TEST_RUN`, `MCP_CALL`, `NETWORK_REQUEST`, `LLM_TRANSFORM`

### 스케줄 해제 — `CANCEL_TASK`
```json
{ "type": "CANCEL_TASK", "jobId": "daily-stock-check" }
```
`LIST_TASKS` 없이 바로 실행 (1단계).

### 스케줄 목록 — `LIST_TASKS`
```json
{ "type": "LIST_TASKS" }
```

---

## 13. 시크릿/API 키 관리

### AI가 키 값을 아는 것은 금지
AI는 시크릿의 **이름**만 알고, **값**은 절대 모른다. 키는 브라우저 → Vault → Sandbox로 AI를 우회한다.

### 키 입력 요청 — `REQUEST_SECRET`
모듈이 API 키를 필요로 할 때:
```json
{ "type": "REQUEST_SECRET", "key": "OPENAI_API_KEY", "description": "OpenAI API 키를 입력해주세요." }
```
→ 프론트엔드에 SecretInput 컴포넌트가 표시되어 사용자가 직접 입력.

### 시스템 설정용 — `SET_SECRET`
비밀번호류가 아닌 설정값 저장용:
```json
{ "type": "SET_SECRET", "key": "PREFERRED_LANGUAGE", "value": "ko" }
```

---

## 14. MCP 외부 도구 활용

등록된 외부 MCP 서버의 도구를 호출할 수 있다.

### MCP 도구 호출 — `MCP_CALL`
```json
{
  "type": "MCP_CALL",
  "server": "gmail",
  "tool": "send_email",
  "arguments": {
    "to": "user@example.com",
    "subject": "일일 리포트",
    "body": "오늘의 요약..."
  }
}
```

### 사용 전 확인
시스템 프롬프트의 `[MCP 외부 도구]` 목록에서 사용 가능한 도구를 확인한다. 목록에 없는 도구는 호출하지 않는다.

---

## 15. LLM 호출 가이드

AI 에이전트가 모듈 내부에서 LLM을 직접 호출하는 것은 허용하지 않는다. LLM은 오직 Core → Infra LLM Adapter 경로로만 호출된다.

모듈 결과에 LLM 처리가 필요하다면:
- **실시간**: 모듈이 텍스트를 stdout으로 반환 → Core가 결과를 다시 LLM에게 전달 (다단계 파이프라인)
- **크론**: 파이프라인의 `LLM_TRANSFORM` 단계 사용 (미리 컴파일된 단계, AI 전체 재실행 없이 경량 호출)

---

## 16. 시스템 모듈 vs 사용자 모듈

| 구분 | 위치 | 쓰기 권한 |
|---|---|---|
| 시스템 모듈 | `system/modules/` | 읽기 전용 (AI 수정 불가) |
| 사용자 모듈 | `user/modules/` | AI 쓰기/수정 허용 |

`system/modules/` 내 모듈을 사용하려면 `module.json`의 `input`/`output` 스펙을 먼저 읽고, 동일 인터페이스로 호출한다. 복사하거나 수정하지 않는다.

---

## 17. 자동실행 정책

| 확인 필요 (사용자 승인 후 실행) | 자동 실행 |
|---|---|
| `SAVE_PAGE` | `TEST_RUN` |
| `DELETE_PAGE` | `WRITE_FILE`, `APPEND_FILE` |
| `DELETE_FILE` | `READ_FILE`, `LIST_DIR` |
| `SCHEDULE_TASK` | `CANCEL_TASK`, `LIST_TASKS` |
| | `NETWORK_REQUEST` |
| | `MCP_CALL` |
| | `REQUEST_SECRET` |
| | `LIST_PAGES`, `DATABASE_QUERY` |
| | `OPEN_URL`, `SET_SECRET` |

---

## 18. 사용 가능한 액션 타입 전체 목록

| 액션 | 용도 |
|---|---|
| `SAVE_PAGE` | PageSpec JSON을 DB에 저장 (웹 페이지 생성/수정) |
| `DELETE_PAGE` | DB에서 페이지 삭제 |
| `LIST_PAGES` | DB 저장 페이지 목록 조회 |
| `WRITE_FILE` | 파일 생성/수정 (user/modules/ 구역만) |
| `READ_FILE` | 파일 읽기 |
| `LIST_DIR` | 디렉토리 목록 조회 |
| `APPEND_FILE` | 파일 끝에 추가 |
| `DELETE_FILE` | 파일/폴더 삭제 |
| `TEST_RUN` | 모듈 실행 테스트 |
| `DATABASE_QUERY` | SQL 쿼리 실행 |
| `NETWORK_REQUEST` | HTTP 요청 |
| `SCHEDULE_TASK` | 크론 작업 등록 (3모드 + 파이프라인) |
| `CANCEL_TASK` | 크론 작업 해제 |
| `LIST_TASKS` | 등록된 크론 작업 목록 조회 |
| `REQUEST_SECRET` | 사용자에게 API 키 입력 요청 (AI는 값을 모름) |
| `SET_SECRET` | 비밀번호류가 아닌 설정값 저장 |
| `MCP_CALL` | 외부 MCP 서버 도구 호출 |
| `OPEN_URL` | 브라우저에서 URL 열기 (미리보기 버튼) |
