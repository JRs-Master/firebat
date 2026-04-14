# FIREBAT MODULE BIBLE — 불가지론적 모듈 작성 수칙

> 최종 개정: 2026-04-13 (v0.1)

## 전문(前文)

본 문서는 Firebat에서 사용되는 모든 '모듈(Module)'의 설계 규격을 정의한다.
Firebat은 어떤 언어로 작성되었건(불가지론적) 동일한 방식으로 모듈을 통제한다.

모듈은 두 종류로 나뉜다:
1. **어댑터 모듈** (`type: "adapter"`): Core 포트의 구현체. Infra가 부팅 시 로드.
2. **유틸리티 모듈** (`type: "utility"`): AI 또는 시스템이 호출하는 도구. stdin/stdout 통신.

---

## 제1장: 언어 중립성 (Universal Execution)

모듈은 JS, Python, PHP, Rust, WASM, Bash 등 어떤 언어로든 작성 가능하다.
어떤 언어로 작동하건 오직 **표준 입출력(`stdin/stdout`)**으로 시스템과 통신한다.

---

## 제2장: 격리와 안정성 (Isolation)

1. **1회성 생명주기**: 호출 시 자식 프로세스로 실행 → stdout 출력 → 종료.
2. **어드민 무중단**: 모듈 에러는 Sandbox 계층이 잡아내므로 `/admin` 시스템에 영향 없음.
3. **타임아웃**: 30초 초과 시 강제 종료 (`SANDBOX_TIMEOUT_MS`).

---

## 제3장: module.json 규약

모든 모듈 폴더에 `module.json`을 필수 포함한다.

### 공통 필수 필드
```json
{
  "name": "모듈 식별자 (kebab-case)",
  "type": "adapter | utility",
  "version": "1.0.0",
  "description": "모듈 역할 한 줄 설명",
  "runtime": "native | python | node | php | rust | wasm | bash"
}
```

### 유틸리티 모듈 추가 필드
```json
{
  "type": "utility",
  "packages": ["pip_or_npm_패키지명"],
  "project": "프로젝트명 (PageSpec project와 동일 값으로 묶기)",
  "secrets": ["API_KEY_NAME"],
  "input": { "필드명": "타입 설명" },
  "output": { "필드명": "타입 설명" }
}
```

### 어댑터 모듈 추가 필드
```json
{
  "type": "adapter",
  "port": "storage | llm | sandbox | log | network | cron | database | vault | mcpClient",
  "adapter": "./adapter.ts",
  "config": { "설정키": "설정값" }
}
```

---

## 제4장: secrets 규약

- 외부 API 키 등 민감 정보가 필요하면 `secrets` 배열에 Vault 키 이름을 선언한다.
- **모듈은 직접 Vault에 접근하지 못한다.** Sandbox가 실행 시 `secrets` 키를 Vault에서 조회하여 환경변수로 주입한다.
- 모듈 코드에서 접근: `os.environ["KEY_NAME"]` (Python), `process.env["KEY_NAME"]` (Node).
- AI는 키 값을 절대 모른다 — `REQUEST_SECRET` 액션으로 사용자에게 입력을 요청한다.

---

## 제5장: 표준 I/O 프로토콜

### 입력 (System → Module `stdin`)
```json
{
  "correlationId": "req-12345",
  "data": { "키": "값" }
}
```
모듈은 `data` 필드에서 파라미터를 추출한다. `sys.argv`/`process.argv` 등 커맨드라인 인자 사용 금지.

### 출력 (Module → System `stdout`)
마지막 줄에 **단 한 줄**의 JSON만 출력한다.
```json
{ "success": true, "data": { "결과값": 100 } }
```
```json
{ "success": false, "error": "에러 사유" }
```

**주의**: 디버그 로그는 반드시 `stderr`로 전송. `stdout`에 디버그 출력 시 파싱 에러 발생.

---

## 제6장: 시스템 모듈 vs 사용자 모듈

| 구분 | 위치 | 작성자 | AI 쓰기 | 모듈 타입 |
|---|---|---|---|---|
| 시스템 어댑터 | `system/modules/` | 엔지니어 | 불가 (읽기 전용) | `adapter` |
| 시스템 유틸리티 | `system/modules/` | 엔지니어 | 불가 (호출만 가능) | `utility` |
| 사용자 모듈 | `user/modules/` | AI 에이전트 | 가능 | `utility` |

---

## 제7장: 시스템 모듈 설정

시스템 모듈은 Vault에 `system:module:<name>:settings` 키로 설정을 JSON 저장한다.
어드민 UI의 `SystemModuleSettings` 모달에서 편집하며, `MODULE_SETTINGS_SCHEMA`에 모듈별 필드를 등록한다.

현재 등록된 설정 스키마:
| 모듈 | 설정 필드 |
|---|---|
| `seo` | sitemapEnabled, rssEnabled, robotsTxt, headScripts, bodyScripts, siteTitle, siteDescription |
| `browser-scrape` | timeout, headless, maxTextLength |

---

## 제8장: Capability-Provider 패턴

같은 기능을 수행하는 모듈이 여러 개 존재할 수 있다 (예: 웹 스크래핑을 로컬 Playwright와 Jina API 두 가지로 구현).
이를 **Capability(기능) — Provider(제공자)** 패턴으로 관리한다.

### 제1항. capability 필드
유틸리티 모듈의 `module.json`에 `capability` 필드를 선언하여 해당 모듈이 제공하는 기능을 명시한다.
```json
{
  "name": "browser-scrape",
  "type": "utility",
  "capability": "web-scrape",
  "providerType": "local",
  ...
}
```
```json
{
  "name": "jina-reader",
  "type": "utility",
  "capability": "web-scrape",
  "providerType": "api",
  ...
}
```

- `capability`: 이 모듈이 제공하는 기능 ID (kebab-case)
- `providerType`: `"local"` (로컬 실행) | `"api"` (외부 API 호출)

### 제2항. Capability Registry
Core에 빌트인 capability 목록을 정의한다 (`core/capabilities.ts`).
```typescript
export const CAPABILITIES = {
  'web-scrape':   { label: '웹 스크래핑', description: 'URL → 텍스트/링크 추출' },
  'email-send':   { label: '이메일 발송', description: '이메일 전송' },
  'image-gen':    { label: '이미지 생성', description: '텍스트 → 이미지' },
  'translate':    { label: '번역', description: '텍스트 번역' },
  'notification': { label: '알림', description: '슬랙/텔레그램/카톡 알림' },
  'pdf-gen':      { label: 'PDF 생성', description: 'HTML/마크다운 → PDF' },
} as const;
```

- 모듈의 `capability` 값이 registry에 없으면 **자동 등록** + 경고 로그.
- AI 프롬프트에 capability 목록을 노출하여 기존 기능 우선 선택 유도.
- 어드민 UI에서 label/description 편집 가능.

### 제3항. Provider 선택 전략
같은 capability의 provider가 여러 개일 때 실행할 모듈을 결정한다.

설정은 Vault `system:capability:<id>:settings`에 JSON으로 저장:
```json
{
  "mode": "api-first",
  "providers": ["jina-reader", "browser-scrape"]
}
```

| 모드 | 동작 |
|---|---|
| `api-first` | API provider 우선 실행, 실패 시 local 폴백 (기본값) |
| `local-first` | local provider 우선 실행, 실패 시 API 폴백 |
| `api-only` | API provider만 사용 |
| `local-only` | local provider만 사용 |
| `manual` | `providers` 배열 순서대로 시도 |

### 제4항. Core 메서드
| 메서드 | 역할 |
|---|---|
| `listCapabilities()` | 전체 capability 목록 (빌트인 + 자동 등록) |
| `getCapabilityProviders(capId)` | 해당 capability의 provider 모듈 목록 |
| `resolveCapability(capId)` | 설정 기준으로 실행할 provider 선택 |
| `registerCapability(id, label, desc)` | 새 capability 수동 등록 |

### 제5항. API 라우트
`/api/capabilities`:
- `GET` — capability 목록 조회 (각 capability별 provider 수 포함)
- `PATCH` — label/description 편집, 우선순위/모드 변경

### 제6항. 어댑터 모듈의 capability
어댑터 모듈(`type: "adapter"`)도 capability 패턴을 적용할 수 있다.
같은 포트에 대해 여러 어댑터가 존재할 때 (예: Vertex AI vs OpenRouter) 선택 기준을 제공한다.
```json
{
  "name": "openrouter-llm",
  "type": "adapter",
  "port": "llm",
  "capability": "llm",
  "providerType": "api",
  ...
}
```

---

## 제9장: 금기 사항

1. **화면 렌더링 금지**: 모듈 내부에서 DOM 조작이나 HTML 하드코딩 금지.
2. **직접 파일 접근 금지**: 모듈은 stdin/stdout 통신만 사용. 파일 시스템 직접 접근 불가.
3. **모듈은 데이터 가공만 담당**: 결과는 Core → Infra 파이프라인을 타고 UI Component가 렌더링.
