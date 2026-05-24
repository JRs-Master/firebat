# FIREBAT MODULE BIBLE — 불가지론적 모듈 작성 수칙

> 최종 개정: 2026-05-06 (Phase B-4 cutover — 모듈 규격 영향 0)

## 전문(前文)

본 문서는 Firebat에서 사용되는 모든 '모듈(Module)'의 설계 규격을 정의한다.
Firebat은 어떤 언어로 작성되었건(불가지론적) 동일한 방식으로 모듈을 통제한다.

**🔥 Phase B-4 cutover 후 영향 없음** — sandbox 격리 + config.json + stdin/stdout 통신 + Vault 시크릿 주입 패턴 모두 동일. 차이: backend sandbox 실행자가 옛 Node `child_process` → Rust `tokio::process::Command` (ProcessSandboxAdapter @ `infra/src/adapters/sandbox.rs`). 모듈 작성자 측 변화 0.

모듈은 두 종류로 나뉜다:
1. **어댑터 모듈** (`type: "adapter"`): Core 포트의 구현체. Infra가 부팅 시 로드.
2. **유틸리티 모듈** (`type: "utility"`): AI 또는 시스템이 호출하는 도구. stdin/stdout 통신.

---

## 제1장: 언어 중립성 (Universal Execution)

모듈은 JS, Python, PHP, Rust, WASM, Bash 등 어떤 언어로든 작성 가능하다.
어떤 언어로 작동하건 오직 **표준 입출력(`stdin/stdout`)**으로 시스템과 통신한다.

### Entry point 규약

각 runtime 별 entry 파일명 표준 (모듈 디렉토리 root 에 위치):

| runtime | entry 파일 |
|---|---|
| `node` | `index.mjs` (또는 `index.js`) |
| `python` | `main.py` |
| `php` | `index.php` |
| `bash` | `index.sh` |

`config.json` 의 `entry` 필드로 override 가능 (예: `"entry": "run.py"`).
명시 안 하면 prompt-builder 가 위 표준에 따라 path 결정.

### Multi-file 모듈

entry 파일이 같은 디렉토리의 다른 파일들을 자유 import 가능 — 언어 표준 module
resolution 따름. sandbox 는 entry 만 spawn, 내부 import 는 간섭 X.

```
system/modules/<name>/
├── config.json
├── main.py             # entry (Python)
├── helpers.py          # main.py 가 `from helpers import foo` 로 import
└── utils/
    ├── __init__.py
    └── calc.py         # main.py 가 `from utils.calc import bar` 로 import
```

```
system/modules/<name>/
├── config.json
├── index.mjs           # entry (Node)
├── helpers.mjs         # index.mjs 가 `import { foo } from './helpers.mjs'`
└── utils/
    └── calc.mjs        # `import { bar } from './utils/calc.mjs'`
```

Python: `sys.path[0]` = entry 의 디렉토리 (자동) — 절대/상대 import 모두 OK.
Node ESM: `./` 또는 `../` 명시 상대 경로 사용 (예: `./helpers.mjs`).

### 모듈 자체 codegen (선택)

외부 API 명세 (예: 한투 / 키움 OPEN API 안 100+ REST 엔드포인트) 가 거대하거나 자주
변경되는 경우 = 모듈 자체 안 `scripts/` 디렉토리에서 codegen 사용. Firebat 영역
안에 sysmod-specific 코드를 두지 마라 — 단일 책임 위반.

```
system/modules/<name>/
├── config.json            # codegen 결과 (또는 수동 작성)
├── index.mjs              # codegen 결과 (또는 수동 작성)
├── _apis.json             # codegen input — 명세 메타데이터 (선택)
└── scripts/
    ├── extract-apis.mjs   # 외부 명세 파일 (xlsx / OpenAPI / 등) → _apis.json
    └── gen.mjs            # _apis.json → config.json + index.mjs
```

사용:
```sh
cd system/modules/<name>
node scripts/extract-apis.mjs    # 명세 → _apis.json
node scripts/gen.mjs             # _apis.json → config + index
```

운영 룰:
- **Firebat 영역 안에 sysmod-specific 코드를 두지 마라** — `scripts/`, `infra/data/<sysmod>-*.json`, `core/src/<sysmod>` 등 모두 모듈 자체 안으로
- 외부 명세 파일 (xlsx / etc) = `.gitignore` 처리된 영역 — 사용자 본인 로컬 reference
- 단순 모듈 (수동 작성 가능한 경우) 의 `scripts/` 디렉토리 = 0 (옵션)
- 예시 — `system/modules/kiwoom/scripts/`, `system/modules/korea-invest/scripts/`

---

## 제2장: 격리와 안정성 (Isolation)

1. **1회성 생명주기**: 호출 시 자식 프로세스로 실행 → stdout 출력 → 종료.
2. **어드민 무중단**: 모듈 에러는 Sandbox 계층이 잡아내므로 `/admin` 시스템에 영향 없음.
3. **타임아웃**: 30초 초과 시 강제 종료 (`SANDBOX_TIMEOUT_MS`).

---

## 제3장: config.json 규약

모든 모듈 폴더에 `config.json`을 필수 포함한다.

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
  "capability": "기능 ID (kebab-case, 예: web-scrape)",
  "providerType": "local | api",
  "input": {
    "type": "object",
    "required": ["필수 필드명"],
    "properties": {
      "필드명": {
        "type": "string | number | integer | boolean | array | object",
        "description": "필드 설명"
      }
    },
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "required": ["필수 필드명"],
    "properties": {
      "필드명": {
        "type": "string | number | integer | boolean | array | object",
        "description": "필드 설명"
      }
    },
    "additionalProperties": false
  }
}
```

> **중요**: input/output은 **JSON Schema Draft 2020-12** 형식으로 정의한다. 자연어 기술(`"url": "string (required) — 설명"`) 금지. 모든 property에 `type`과 `description` 필수, `required` 배열과 `additionalProperties: false` 필수. 상세 규격은 `docs/IO_SCHEMA_BIBLE.md` 참조.

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

### 제1항. secrets 항목 schema — string | object union (2026-05-24)

`secrets` 배열의 각 항목은 두 가지 형태 모두 허용:

**옛 호환 (string)** — 사용자 직접 입력 키 (만료 X). `type: "key"` 와 동등:
```json
"secrets": ["TELEGRAM_BOT_TOKEN", "NAVER_AD_API_KEY"]
```

**일반 (object)** — 메타데이터 명시. 자동 발급/갱신 토큰 구분 + lifetime 명시:
```json
"secrets": [
  { "name": "KIS_APP_KEY",       "type": "key" },
  { "name": "KIS_APP_SECRET",    "type": "key" },
  { "name": "KIS_ACCESS_TOKEN",  "type": "token", "lifetimeSec": 82800 },
  { "name": "KAKAO_ACCESS_TOKEN",  "type": "token", "lifetimeSec": 21600,  "refreshFrom": "KAKAO_REFRESH_TOKEN" },
  { "name": "KAKAO_REFRESH_TOKEN", "type": "token", "lifetimeSec": 5184000 }
]
```

| field | 영역 |
|---|---|
| `name` | Vault 키 이름 (필수) |
| `type` | `"key"` — 사용자 입력 / `"token"` — 자동 발급 (OAuth · API token cache 등) |
| `lifetimeSec` | token 만료 (초). 자동 갱신 cron 의 trigger 시점 결정 (lifetime × 0.8 도달 시 refresh) |
| `refreshFrom` | refresh_token 의 vault 키 이름 — access 만료 시 본 키로 갱신 (kakao OAuth refresh 패턴) |

### 제2항. type 별 동작 차이

- **`type: "key"`** — 어드민 UI 의 설정 모달에 **입력 필드 노출**. 사용자가 직접 등록.
- **`type: "token"`** — 어드민 UI 안 입력 필드 **숨김** (사용자가 직접 입력하면 안 되는 자동 관리 영역). OAuth 콜백 / sysmod 의 `__updateSecrets` envelope 으로 자동 발급. 상태는 OAuth 연동 indicator 또는 시크릿 목록 (`/api/vault/secrets`) 에서만 확인.

`settings_fields` 안 `type: "oauth"` 항목의 `oauthSecrets` 배열에 박힌 secret 이름도 동일하게 입력 필드 자동 숨김 — type 명시 안 박혀있어도 OAuth 관리 영역으로 추론.

### 제3항. `__updateSecrets` envelope — sysmod 자동 vault 저장

sysmod 가 stdout 에 다음 envelope 박으면 sandbox 가 자동으로 vault 에 저장:

```json
{
  "success": true,
  "data": { ... },
  "__updateSecrets": {
    "KIS_ACCESS_TOKEN": "eyJhbGciOi..."
  }
}
```

용도:
- OAuth 토큰 발급 결과를 캐시 — 다음 호출 시 sandbox 가 vault → env 로 자동 주입 → 모듈이 cached token 사용
- 한투 / 키움 같은 rate-limited token 발급 차단
- kakao OAuth refresh 결과 캐시

### 제4항. legacy `tokenCache` 필드 (옛 호환)

옛 한투 / 키움 모듈은 `tokenCache: { secretName, ttlHours }` 박혀있음 — 기능은 위 제1항 `{ type: "token", lifetimeSec }` 와 동등. 새 모듈은 `secrets` 안 object 형태 사용 권장.

### 제5항. 자동 갱신 cron (선택 — 트리거 도달 시 도입)

`lifetimeSec` 명시된 token 에 대해 system cron 이 만료 80% 도달 시점 refresh trigger. 현재는 sysmod 가 호출 시점에 만료 감지 → forceNew 재시도 패턴 (한투/키움) 사용 중 — 자동 cron 은 OAuth refresh API 가 있는 사례 (kakao 등) 가 활성 사용될 때 도입. 옛 호환: `lifetimeSec` 없는 항목 = 갱신 cron 등록 X.

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
어드민 UI의 `SystemModuleSettings` 모달에서 편집하며, **모듈 자신의 `config.json` 의 `settings_fields` 배열** 이 schema 정의한다 (옛 frontend 의 `MODULE_SETTINGS_SCHEMA` 하드코딩 영역 폐기, 2026-05-16).

### 제1항. config.json 의 settings_fields

```json
{
  "name": "telegram",
  "settings_fields": [
    {
      "key": "bot_token",
      "type": "secret",
      "secretName": "TELEGRAM_BOT_TOKEN"
    },
    {
      "key": "default_chat_id",
      "type": "text",
      "tab": "기본",
      "group": "수신자"
    }
  ]
}
```

| field | 영역 |
|---|---|
| `key` | settings 객체의 field 이름 |
| `type` | `text` / `number` / `toggle` / `textarea` / `oauth` / `secret` / `select` / `widget-list` / `verifications` / `color-presets` / `color-overrides` |
| `tab` | 탭 그룹 (없으면 기본 탭) |
| `group` | 탭 안 sub-section heading |
| `secretName` | secret type 전용 — Vault 키 이름 |
| `oauthUrl` / `oauthSecrets` | oauth type 전용 |
| `options` | select type 전용 |
| `defaultValue` | 미설정 시 자동 적용 값 |

---

## 제8장: 모듈 i18n — `lang/{lang}.json` separate file 패턴

시스템 서비스 / 모듈의 사용자 노출 텍스트 (label / description / placeholder / 에러 메시지 등) 는 **모듈 폴더 안 `lang/{lang}.json` 파일** 에 두는 것이 정공 (2026-05-16). 옛 `config.json` 의 `settings_fields[].i18n` inline 영역 폐기 — separate file 패턴으로 통합.

### 제1항. 디렉토리 구조

```
system/modules/<name>/
├── config.json              # settings_fields, packages, secrets 등 schema 정의
├── main.py                  # entry
├── lang/
│   ├── ko.json              # 한국어 텍스트
│   └── en.json              # 영어 텍스트
└── ...
```

`system/services/<name>/` 도 동일 구조를 따른다.

### 제2항. lang/{lang}.json 형식

```json
{
  "title": "텔레그램",
  "description": "텔레그램 봇 메시지 발송",
  "settings": {
    "bot_token": {
      "label": "봇 토큰",
      "description": "@BotFather 에서 생성한 봇의 HTTP API 토큰",
      "placeholder": "1234567890:ABC..."
    },
    "default_chat_id": {
      "label": "기본 chat_id",
      "description": "수신자 chat_id (미입력 시 매 호출마다 명시 필요)",
      "group": "수신자"
    }
  },
  "error": {
    "api_key_missing": "텔레그램 봇 토큰이 등록되지 않았습니다.",
    "send_failed": "메시지 발송에 실패했습니다: {{detail}}"
  }
}
```

- **`title` / `description`** — 모듈 설정 모달의 헤더 + 설명
- **`settings.{field_key}`** — `config.json` 의 `settings_fields[].key` 와 매칭 — label / description / placeholder / group / options 항목 정의
- **`error.*`** — 모듈 runtime 에러 메시지 (i18n key `module.<name>.error.<key>` 으로 lookup)
- `select` type 의 options 도 `settings.{field_key}.options` 에 lang 별 배열로 정의 (config.json options 와 같은 길이의 병렬 매핑)

### 제3항. lookup 우선순위

`SystemModuleSettings` 컴포넌트의 `resolveConfigField` 가 매 field 의 사용자 노출 텍스트 결정:

1. **`lang/{active_lang}.json` 의 `settings.{key}.{label|description|...}`** (1순위)
2. **`lang/en.json` → `lang/ko.json`** fallback (활성 lang 에 정의 없는 항목)
3. **`config.json` 의 `settings_fields[].i18n[lang]`** (2순위 옛 호환, cms 보존 영역)
4. **raw `key`** (최종 fallback)

활성 lang = 사용자 SettingsModal 의 언어 토글 (Vault `system:ui-lang` 에 저장).

### 제4항. runtime 에러 메시지 (sysmod stdout envelope)

모듈이 `stdout` envelope 에 i18n key 를 직접 넣을 수 있다:

```json
{ "success": false, "error": "...", "errorKey": "module.telegram.error.api_key_missing" }
```

- `errorKey` field — i18n key (`module.{name}.error.{key}` 형태). `SysmodToolHandler` 가 활성 lang 기준으로 lookup 변환
- `errorParams` field — `{{detail}}` 같은 placeholder 치환용 (optional, JSON object)
- Frontend 의 도구 에러 뱃지에 변환된 사용자 lang 메시지 표시

### 제5항. Rust core 의 GetLang RPC

`ModuleService.GetLang(name, lang)` RPC 가 활성 lang 의 lang 객체 반환:
- any-scope 자동 탐색 (`system/modules/{name}/lang/{lang}.json` → `system/services/{name}/lang/{lang}.json` → `user/modules/{name}/lang/{lang}.json`)
- 활성 lang 에 정의 없는 항목은 fallback chain — en → ko
- 미존재 시 빈 객체

`/api/settings/modules` route 가 호출 — 매 모듈 settings 화면 로드 시점 lang 객체도 동시 fetch.

### 제6항. 새 모듈 작성 시 i18n 추가 (운영 룰)

1. 모듈 디렉토리 안에 `lang/` 디렉토리 생성
2. 최소 2개 file (`ko.json` + `en.json`) — 다른 lang 이 필요해질 때 자연 확장
3. `settings_fields` 의 매 `key` 에 대응하는 `settings.{key}` 항목 정의 (label 필수, description / placeholder 선택)
4. runtime error 메시지가 필요한 경우 `error.{key}` + envelope `errorKey: "module.<name>.error.<key>"` 사용

> 옛 패턴 (`config.json` 의 `settings_fields[].i18n[ko].label`) 도 cms 모듈 쪽에 잔존 — fallback 이 있어 옛 모듈 동작 영향 0. 새 모듈은 `lang/` separate file 패턴 정공.

---

## 제8장: Capability-Provider 패턴

같은 기능을 수행하는 모듈이 여러 개 존재할 수 있다 (예: 웹 스크래핑을 로컬 Playwright와 Jina API 두 가지로 구현).
이를 **Capability(기능) — Provider(제공자)** 패턴으로 관리한다.

### 제1항. capability 필드
유틸리티 모듈의 `config.json`에 `capability` 필드를 선언하여 해당 모듈이 제공하는 기능을 명시한다.
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
