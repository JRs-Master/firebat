# FIREBAT MODULE BIBLE — 불가지론적 모듈 작성 수칙

> 최종 개정: 2026-07-22 (pageBinding `actions` 다액션 확장 + secrets `vaultKey` 시스템 키 재사용 + 라이브 차트 fresh 시드)

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
3. **타임아웃**: 60초 초과 시 강제 종료 (`DEFAULT_TIMEOUT_MS = 60_000`, 호출별 override 가능).

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

### 선언형 인프라 필드 (선택 — 코드 0줄, config 데이터만)

인프라 choke-point 가 config 선언을 읽어 처리하는 opt-in 필드들. 모듈 코드는 아무것도 import 하지 않는다 (모듈 dumb 원칙). 미선언 = 기존 동작 그대로.

#### `requiresApproval` — 실행 승인 게이트 (2026-07-05)
```json
{ "requiresApproval": true }                        // 모듈 전체
{ "requiresApproval": ["kt10000", "kt10001"] }      // 특정 액션만
```
- 선언된 액션을 AI 가 호출하면 **디스패치 계층**(FC=ai.rs + MCP=SysmodHandler — 코드가 거부, 프롬프트 아님)이 즉시 실행 대신:
  채팅 = 승인 카드(`PendingActionArgs::RunModule`, 승인 시 재생 + **턴 즉시 종료** = 카드 1장 보장) / cron = **스케줄 승인 = 잡에 담긴 매매 승인** → 실행 허용(인터랙티브 run_task 우회만 차단) / hub = 차단.
- 대상: 실주문·비가역·real-money 액션 (키움 주문 12 / 토스 6 — 주문 3+조건주문 3 / 한투 7 선언 예시). 새 매매/파괴 모듈 = config 한 줄로 자동 포함.

#### `grounding` — 불투명 식별자 날조 차단 (Fact-Provenance L1, 2026-06-30)
```json
{
  "grounding": {
    "stk_cd": {
      "pattern": "^Q?[0-9]{6}$",
      "exemptActions": ["ka10100"],
      "resolveHint": "코드는 lookup 으로 resolve 하라는 AI 안내문 (영어)"
    }
  }
}
```
- 선언된 param 값이 **세션 provenance corpus**(사용자 입력 ∪ 이전 도구 결과)에 없으면 디스패치 계층(MCP + FC 양쪽)이 실행 거부 + `resolveHint` 반환 → AI 가 resolve(예: dart lookup) 후 재시도.
- `pattern` = 값-shape 필터(예: 6자리 종목코드만 gate, 4자리 지수코드는 통과 — 한투 FID_INPUT_ISCD 오버로딩 대응). 닫힌 enum 값은 기존 input schema 타입체크가 이미 막으므로 **열린 값(종목코드류)만** 선언.

#### `ws` — WebSocket 전용 API (스냅샷 + 상시 감시, 2026-07-05)
```json
{
  "ws": {
    "argsField": "params",
    "endpoint": "wss://api.kiwoom.com:10000/api/dostk/websocket",
    "endpointMock": "wss://mockapi.kiwoom.com:10000/api/dostk/websocket",
    "matchField": "trnm",
    "echoValues": ["PING"],
    "errorMsgField": "return_msg",
    "login": {
      "frame": { "trnm": "LOGIN", "token": "{TOKEN}" },
      "match": "LOGIN",
      "successWhen": { "field": "return_code", "equals": 0 },
      "tokenSecret": "KIWOOM_ACCESS_TOKEN"
    },
    "actions": {
      "ka10172": {
        "preFrames": [ { "frame": { "trnm": "CNSRLST" }, "match": "CNSRLST", "successWhen": { "field": "return_code", "equals": 0 } } ],
        "frame": { "trnm": "CNSRREQ", "seq": "{seq}", "search_type": "{search_type:0}" },
        "match": "CNSRREQ",
        "successWhen": { "field": "return_code", "equals": 0 }
      }
    },
    "streams": {
      "condition": { "subscribe": { "...": "..." }, "unsubscribe": { "...": "..." }, "realtimeMatch": "REAL" }
    },
    "unsupportedActions": ["ka10173", "ka10174"]
  }
}
```
- `ws.actions` 에 선언된 액션은 sandbox 대신 **`IWsApiPort`**(스냅샷 요청/응답)로 라우팅된다. 프레임은 전부 데이터 — 필드가 틀려도 config 수정 + git pull 로 fix(재빌드 0).
- 템플릿 치환: `"{param}"` = input 값 / `"{param:default}"` = 기본값 / `"{TOKEN}"` = 인프라가 `tokenSecret` 토큰 주입.
- `argsField` = 모듈의 인자 컨테이너 규약(예: 키움 `{action, params:{...}}` 중첩)을 루트에 overlay — flat 모듈은 미선언.
- `preFrames` = 본 요청 전 같은 세션에서 선행 왕복해야 하는 프레임(키움: CNSRLST 를 먼저 보내야 CNSRREQ 응답).
- `ws.streams` = **`IWsStreamPort`** 상시 감시 선언(`stream_watch_start/stop/list` AI 도구) — 편입/이탈·시세 REAL 프레임이 이벤트 버스(SSE topic) + telegram 으로 fan-out, vault 영속으로 재부팅 자동 복원.
- `unsupportedActions` = WS 로도 REST 로도 아직 못 하는 액션에 명확한 에러 메시지(추측 호출 방지).
- 응답 auto-cache 는 sandbox 와 **같은 choke-point 공유** — 수백 종목 스냅샷도 캐시 + 프리뷰로 처리.

#### `timeseries` — 시계열 영구 store (range-coverage 캐시, 2026-07-06)
```json
{
  "timeseries": {
    "history": {
      "startParam": "start", "endParam": "end",
      "idParams": ["symbol", "interval"],
      "dateField": "date",
      "rows": ["$", "_cache.records", "records"]
    }
  }
}
```
- 선언된 액션의 응답 rows 가 **영구 store**(`data/timeseries.db`) 에 흡수되고, 이후 요청은 커버 구간을 계산해 **미커버 구간만** fetch(완전 커버 = 모듈 spawn 0). 소급 값 변경(배당/분할 조정) 감지 시 시계열 무효화·재수집.
- 키 = `(module, action, idParams 정규화)`. 미선언/limit 호출/범위 비명시 = bypass(기존 auto-cache 만).
- **전제 = 표준 OHLCV 필드**: 캔들 rows 는 `{date, open, high, low, close, volume}` 으로 정규화해 반환한다(kiwoom/korea-invest/toss 는 모듈 내부에서 rename — stock_chart `dataCacheKey` 주입·cache_grep 과 한 어휘).

#### `actionCatalog` / `tags` — 4단 도구 계단: 발견 → 상세 → 호출 → 검증 (모든 모듈, 2026-07-09)
```json
{
  "tags": ["헌법", "법률", "명령", "조례", "규칙", "판례"],
  "actionCatalog": {
    "file": "actions.json",
    "envelope": "{ \"action\": \"<id>\", \"params\": { <params> } }"
  }
}
```
**모든 sysmod·usermod 는 동일한 4단 절차로 호출된다** — 큰 모듈이든 작은 모듈이든: ① 도구 설명·`tags` 로 모듈 선택 → ② `search_module_actions(query)` 로 액션 발견 → ③ `get_action_schema(module, action)` 으로 정확한 파라미터·봉투 획득 → ④ 호출(`module.rs` 가 input 스키마로 검증, 틀리면 힌트 재전송 = i18n `input_validation_failed_catalog`). **도구 설명엔 파라미터가 없다** — `dynamic_tools.rs`/`mcp_server.rs` 가 sysmod 도구 `parameters` 를 얇게(`{additionalProperties:true}` + "발견하라" 안내) 등록해 직접호출 우회를 구조로 차단한다(판단은 모델, 절차는 프레임워크 — "빨간불이면 차단봉").
- **액션 카탈로그 소스 = 3단 폴백** (하드코딩 0, `action_catalog.rs`):
  1. `actionCatalog`(위 예시, file/inline) → rich per-action(한투 275·키움 208·toss 28).
  2. 없으면 **`input` 스키마에서 자동 파생** — `input.properties.action.enum` 의 값마다 엔트리(설명 = `action.description` blob 조각, params = 나머지 input properties). **작은 모듈·usermod 는 별도 authoring 0** — 이미 있는 input 스키마가 곧 카탈로그.
  3. action enum 도 없으면(단일 목적 모듈) → 모듈 1엔트리(`get_action_schema` = input 스키마 통째).
- `actions.json` 엔트리 = `{ id, name, description, domain?, params?: {이름: 설명}, example? }` — `file`(모듈 dir 상대) 또는 inline `actions`. `requiresApproval` 은 재선언 안 함(로더가 config 선언에서 join). `envelope` = 호출 봉투 형태(flat vs `params` 중첩 — 모듈 방언). API 명세가 `_apis.json` 류면 `scripts/gen-actions.mjs` 로 생성 — **desc 보강은 `actions-overrides.json` 병합**(regen 생존, 생성 파일 직접 수정 금지).
- **`tags`** (선택, string 배열) = 모듈 선택 신호. 도구 설명에 append 되어 모델이 L1(모듈 선택)에서 고른다.
- **description = 트리거만** ("인덱스 = 트리거"): 검색 결과에 파라미터 나열 금지(모델이 get 건너뛰고 추측). 무엇 한 줄 + 태그. 행동 재료(정확 파라미터·제약)는 `params`/`example` = get 계층.
- **usermod authoring**: input 스키마에 `action` enum + 각 액션 설명을 넣으면 → 등록 즉시 search_module_actions 로 발견(파생). per-action 정밀 params 를 원하면 `actionCatalog` + `actions.json` 선언. 둘 다 없어도 단일 엔트리로 발견은 된다.

#### `pageBinding` — 페이지↔모듈 바인딩 (발행 bake · 방문 SSR · rebake 크론 · shortcode, 2026-07-18)
```json
{
  "pageBinding": {
    "alias": "kstock",
    "action": "ka10081",
    "args": { "upd_stkpc_tp": "1" },
    "blocks": [
      { "type": "stock_chart",
        "props": { "symbol": "{stk_cd}", "title": "{title}", "data": "$.stk_dt_pole_chart_qry" } }
    ],
    "actions": {
      "ka10080": {
        "args": { "upd_stkpc_tp": "1", "tic_scope": "1" },
        "blocks": [
          { "type": "stock_chart",
            "props": { "symbol": "{stk_cd}", "title": "{title}", "data": "$.stk_min_pole_chart_qry" } }
        ]
      }
    }
  }
}
```
발행 페이지가 모듈 데이터를 소비하는 표준 규약. PageSpec 의 `module` 블록(`{type:"module", props:{module, action?, args?, when, cacheTtl?}}`)이 이 선언을 참조한다 — **선언한 모듈의 선언된 액션 하나만** 페이지 표면에서 실행 가능(폐쇄 opt-in 집합 = "페이지 저장으로 임의 sysmod 실행" 원천 차단).
- **블록 소스 2갈래 — 선언형이 기본**: config `blocks` 템플릿을 쓰면 **모듈 코드 0**으로 기존 액션을 그대로 페이지에 붙인다(프레임워크가 매핑을 추측하지 않는 이유 = 템플릿이 어느 응답 필드가 어느 컴포넌트로 가는지 말해주기 때문). 치환 규칙 = `"$.a.b"`(문자열 전체) → 모듈 응답 `data` 의 그 경로 / `"{name}"` → 블록 args(+config `args` 기본값). 해결 안 된 prop = 그 prop 만 제거 / `$.` 데이터가 없는 블록 = 통째 skip. **계산·가공이 필요한 모듈만**(등락률 산출, 단위 변환 등) `blocks` 없이 전용 액션을 만들어 `data.blocks` 를 직접 반환(탈출구 — yfinance `page_blocks`).
- **액션 계약**: `{success, data:{blocks:[{type,props},...]}}` 반환 — **모듈이 렌더를 소유**한다(프레임워크가 결과→컴포넌트 매핑을 추측하지 않음). 레퍼런스 = yfinance `page_blocks`.
- **when 축**: `publish`(기본) = 저장 경로가 서버에서 실행해 `_baked` 병기(바인딩은 산 채 유지 → `rebake:<slug>` 크론이 표준 정기 페이지) / `request` = 발행 SSR 이 방문 시 resolve(TTL 캐시 + single-flight, 실패 = `_baked` 폴백. 신규 공개 endpoint 0 — RSC 내부).
- **`actions`** (선택, 2026-07-22) = 폐쇄 집합을 **여러 액션으로 확장**. `action → {args?, blocks?}` — 각 액션이 자기 고정 args·blocks 템플릿을 갖고, 없으면 최상위 것을 상속. 같은 모듈이 페이지 표면에 안전하게 낼 수 있는 read 액션이 둘 이상일 때(예: 일봉 `ka10081` + 분봉 `ka10080` — 라이브 차트의 분봉 fresh 시드). **미선언 액션은 그대로 거부**(폐쇄성 불변).
- **라이브 차트 fresh 시드**: `live_stock_chart` 등 라이브 블록이 `seed:{module,action,args}` 를 선언하면 발행 SSR 이 **방문마다** 그 바인딩을 resolve 해 시드 캔들을 최신으로 교체한다(라이브 틱은 그 위에서 이어짐). 라이브 봉 자체는 client 상태(비영속)라 저장하지 않는다 — 갭의 해법은 "저장"이 아니라 "방문 시 시드 재fetch".
- **보안**: `requiresApproval` 액션은 선언해도 전면 거부(page-form 게이트 미러) / hub-scope 저장 = bake skip(inert 저장) / `_baked` 캡 = 블록 50 · 256KB · 스펙당 바인딩 20. 게이트 로직 = Rust `page_binding.rs` ↔ TS `lib/page-binding-gate.ts` 미러(단일 정책).
- **`alias`** (선택) = 템플릿 텍스트 sugar — text 블록의 `{stock symbol="005930.KS"}` 가 `get_template` 시 module 블록으로 컴파일(등록 alias 만, 미등록 `{word}` = 리터럴 유지).

#### 모듈 내장 이미지 — `assets/` 디렉토리 (2026-07-18)
모듈 디렉토리의 `assets/` 에 둔 이미지는 `/module-assets/<module>/<file>` 로 공개 서빙된다(system·user 공통, Rust axum route → next.config rewrite). 확장자 allowlist(png/jpg/jpeg/webp/gif/svg/ico) + 세그먼트 charset 가드 + CSP/nosniff(svg XSS 완화) + `Cache-Control: public,max-age=3600`. 페이지·render 블록에서 안정 URL 로 참조 — base64 인라인·외부 URL 의존이 필요 없어진다.

> 위 필드들의 공통 원리 = **"모듈은 dumb, 인프라가 config 로 처리"** (auto-cache · secrets env 주입 · 토큰 생명주기와 동일 계열). 새 provider 방언이 config 데이터로 안 되면(한투 approval_key+AES 등) 그때만 infra 에 dialect 조각 추가 — 모듈 코드에 넣지 않는다.

#### 선언형 필드 요약 표

| 필드 | 기능 | 처리 계층 |
|---|---|---|
| `packages` | 런타임 의존성 자동 설치 | sandbox |
| `secrets` | Vault → env 주입 | sandbox |
| `secrets[].oauth` | 토큰 발급·선제갱신·재발급 (`OAuthTokenProvider`) | infra TokenProvider |
| `requiresApproval` | 실주문 등 승인 게이트 (카드/차단) | 디스패치 (FC + MCP) |
| `grounding` | 불투명 식별자 날조 차단 (L1) | 디스패치 (FC + MCP) |
| `ws` | WebSocket 스냅샷·상시 감시 라우팅 | ModuleManager.run → IWsApiPort/IWsStreamPort |
| `timeseries` | 시계열 영구 store (증분 fetch) | sandbox choke-point |
| `actionCatalog` | 액션 시맨틱 검색·스키마 (`search_module_actions`, 없으면 input 스키마에서 자동 파생) | AI 도구 (E5 카탈로그) |
| `tags` | 모듈 선택 신호 (얇은 도구 설명에 append) | 도구 등록 (dynamic_tools/mcp_server) |
| `pageBinding` | 페이지↔모듈 바인딩 opt-in (발행 bake · 방문 SSR · rebake 크론 · shortcode alias) | 저장 경로 bake (`page_binding.rs`) + 발행 SSR (`page-binding-gate.ts`) |
| `assets/` (디렉토리) | 모듈 내장 이미지 공개 서빙 (`/module-assets/<m>/<file>`) | Rust axum route + next rewrite |

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
| `name` | env 변수명 = Vault 키 이름 (필수). 기본 조회 경로 = `user:<name>` |
| `type` | `"key"` — 사용자 입력 / `"token"` — 자동 발급 (OAuth · API token cache 등) |
| `lifetimeSec` | token 만료 (초). 자동 갱신 cron 의 trigger 시점 결정 (lifetime × 0.8 도달 시 refresh) |
| `refreshFrom` | refresh_token 의 vault 키 이름 — access 만료 시 본 키로 갱신 (kakao OAuth refresh 패턴) |
| `vaultKey` | **Vault 키 전체 경로 오버라이드** (2026-07-22) — 이미 등록된 시스템 공급자 키를 재사용한다. 예: `{"name":"UPSTAGE_API_KEY","vaultKey":"system:upstage:api-key"}` → 설정>AI 에서 등록한 Upstage 키가 그대로 env 로 주입되고, **모듈 설정에서 같은 키를 다시 입력받지 않는다**(중복 입력 제거). 모듈별 하드코드 0 — 어느 모듈이든 어느 시스템 키든 선언으로 참조. |

### 제2항. type 별 동작 차이

- **`type: "key"`** — 어드민 UI 의 설정 모달에 **입력 필드 노출**. 사용자가 직접 등록.
- **`type: "token"`** — 어드민 UI 안 입력 필드 **숨김** (사용자가 직접 입력하면 안 되는 자동 관리 영역). OAuth 콜백 / sysmod 의 `__updateSecrets` envelope 으로 자동 발급. 상태는 OAuth 연동 indicator 또는 시크릿 목록 (`/api/vault/secrets`) 에서만 확인.

`settings_fields` 안 `type: "oauth"` 항목의 `oauthSecrets` 배열에 들어있는 secret 이름도 동일하게 입력 필드 자동 숨김 — type 명시가 없어도 OAuth 관리 대상으로 추론.

### 제3항. `__updateSecrets` envelope — sysmod 자동 vault 저장

sysmod 가 stdout 에 다음 envelope 를 출력하면 sandbox 가 자동으로 vault 에 저장:

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

옛 한투 / 키움 모듈은 `tokenCache: { secretName, ttlHours }` 를 사용함 — 기능은 위 제1항 `{ type: "token", lifetimeSec }` 와 동등. 새 모듈은 `secrets` 안 object 형태 사용 권장.

### 제5항. 자동 갱신 cron (선택 — 트리거 도달 시 도입)

~~`lifetimeSec` 명시된 token 에 대해 system cron 이 만료 80% 도달 시점 refresh trigger~~ → **superseded (2026-06, 인프라 TokenProvider)**: 토큰 생명주기는 이제 **`OAuthTokenProvider`**(infra) 가 secrets 항목의 선언형 `oauth` 블록으로 처리한다 — 모듈 토큰 코드 0줄.

```json
{
  "name": "KIWOOM_ACCESS_TOKEN", "type": "token", "lifetimeSec": 85800,
  "oauth": {
    "base": "https://api.kiwoom.com", "path": "/oauth2/token", "method": "POST",
    "body": { "grant_type": "client_credentials", "appkey": "${KIWOOM_APP_KEY}", "secretkey": "${KIWOOM_APP_SECRET}" },
    "tokenField": "token",
    "invalidWhen": { "match": "any", "conditions": [ { "field": "return_code", "equals": 3 } ] }
  }
}
```

- **proactive**: 호출 전 `ensure_fresh` — `lifetimeSec` 기준 만료 임박이면 선제 재발급 → Vault 영속(`{t,iat}`) → env 주입.
- **reactive**: 응답이 `invalidWhen` 에 매치되면 force 재발급 + 재시도 1회.
- sandbox(REST) · ws_api · ws_stream 이 **한 provider 인스턴스 공유**(per-secret 락 = thundering herd 방지). 적용: korea-invest / kiwoom (실측 통과) / kakao (코드만, HTTPS 전환 대기). `refreshFrom` = refresh_token 회전(kakao OAuth 패턴).

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

## 제9장: Capability-Provider 패턴

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
Core에 빌트인 capability 목록을 정의한다 (`core/src/capabilities.rs`).

> ⚠️ 아래는 옛 TS 시절 예시 — 현재 코어는 Rust (`core/src/capabilities.rs`). 개념 참고용.

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

## 제10장: 금기 사항

1. **화면 렌더링 금지**: 모듈 내부에서 DOM 조작이나 HTML 하드코딩 금지.
2. **직접 파일 접근 금지**: 모듈은 stdin/stdout 통신만 사용. 파일 시스템 직접 접근 불가.
3. **모듈은 데이터 가공만 담당**: 결과는 Core → Infra 파이프라인을 타고 UI Component가 렌더링.
