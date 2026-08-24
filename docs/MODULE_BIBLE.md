# FIREBAT MODULE BIBLE — 불가지론적 모듈 작성 수칙

> 최종 개정: 2026-08-16 (`params` = 이름 목록 · `required`/액션 `aliases` · `[액션]` 태그가 선택을 말한다 · 세 방향 감사 · 사용자 모듈도 같은 계단)

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

### 봉투 계약 (v2 명문화, 2026-08-17)

stdin JSON 입력 → **stdout 마지막 줄이 봉투** (로그는 stderr 로):

```jsonc
{"success": true,  "data": {…}}
{"success": false, "error": "무엇이·다음 수"}
{"success": false, "errorKey": "error.x", "errorParams": {…}}   // i18n (제6장)
```

경계 동작(`ca0c1ca2`): exit 0 인데 **stdout 이 비었거나 마지막 줄이 JSON 이 아니면** 프레임워크가
계약을 말하는 실패로 돌려준다(원문 보존, `target=module_envelope` WARN) — 조용한 성공 둔갑 없음.
봉투 필드 없는 유효 JSON 값 = data 그 자체로 수용. 봉투를 찍고 비정상 종료한 경우 = 메시지 보존
(upbit 404 교훈). 수명주기 = enabled→검증→게이트→주입→실행→봉투→auto-cache→timeseries, 전송 무관.

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

### 선언이 원본이다 — 상주하는 생성 단계는 없다 (2026-08-16 사용자 확정)

모듈은 **`config.json` + `actions.json` + 코드**다. 프레임워크는 그 둘을 읽고 실행한다.
그 사이에 서 있는 중간물도, 그걸 굴리는 절차도 두지 않는다.

```
system/modules/<name>/
├── config.json            # 액션 enum · 입력 스키마 · 선언 블록
├── actions.json           # 액션마다 name·description·params·required·_call   (많을 때)
└── index.mjs              # 코드
```

한투·키움은 벤더가 수백 엔드포인트를 문서로 발행하는 유일한 경우라 **한때 `_apis.json` +
생성기 셋**을 들고 있었다. 그 구조가 만든 대가:

- **정정이 살 집이 없었다.** 벤더 시트 오타를 고칠 자리가 없어 `_apis.json` 을 고쳤고, 그건 다음
  수입이 덮는다. 그래서 "재생성을 견디는 자리"로 `actions-overrides.json` 이 생겼고, 무엇을 어디에
  적을지를 매번 판단해야 했다.
- **장착 방식이 모듈마다 달랐다.** `dart`(82액션)는 선언 하나로 붙는데 `korea-invest`(283)는
  중간물 1.45MB + 생성기 3 + 런타임 표 62KB 를 거쳤다.

지금은 **마지막으로 한 번 생성한 결과가 원본**이고, 벤더가 새 릴리스를 내면 저자가 **그때** 도구를
돌려 선언 파일에 직접 쓴다(중간물 없음). 상시 존재하는 절차 = 0.

운영 룰:
- **Firebat 영역 안에 sysmod-specific 코드를 두지 마라** — `infra/data/<sysmod>-*.json`,
  `core/src/<sysmod>` 등 전부 모듈 안으로.
- 벤더 명세 원문(xlsx 등) = gitignore. **원본이 아니라 수입 경로다** — 그걸 원본이라 부르는 순간
  "저장소에 없으니 고칠 수 없다"가 결론으로 나온다.
- 액션이 몇 개뿐이면 `actions.json` 도 필요 없다 — 선언이 없으면 프레임워크가 `input` 스키마에서
  카탈로그를 **파생**한다(`derive_entries_from_input`).

### `_call` — 액션의 엔드포인트는 선언에, 표는 어디에도 없다

`actions.json` 엔트리의 **`_call`** 은 그 액션 하나를 발행하는 데 필요한 것이다. 디스패치가
호출 중인 액션의 행만 모듈 입력에 `_call` 로 실어 준다.

```jsonc
{ "id": "국내주식-164", "name": "…", "params": { … },
  "_call": { "id": "국내주식-164", "method": "GET", "path": "/uapi/…", "trIdReal": "…", "trIdMock": "…" } }
```

- **밑줄이 경계다.** 카탈로그 로더는 밑줄 필드를 `get_action_schema` 에 싣지 않는다 — `path` 나
  `trId` 는 모델이 읽고 결코 타이핑하지 않을 것들이고, 그 표면은 턴마다 크기를 잰다.
- **프레임워크는 안을 읽지 않는다.** `trId` 가 뭔지 core 가 아는 순간 새 venue 마다 core 배포가 된다.
- **한 행이 여러 API 면 갈래로 선언한다** — 벤더 시트가 매수·매도를 한 줄에 적었거나(`"(매도) …
  (매수) …"`), 중립 이름 하나가 시장·간격에 따라 갈릴 때. 어느 갈래인지는 **방언이 정하고**,
  갈래의 내용은 선언이 든다.
  ```jsonc
  "_call": { "kr_buy": {…}, "kr_sell": {…}, "us_buy": {…}, "us_sell": {…} }
  ```
  갈래를 고르는 인자는 `params`·`required` 에도 선언한다 — 그래야 `fill` 이 **미리** 말한다.
- **선언하면 전부 선언한다.** 일부만 선언하면 방언이 두 경로를 다 살려야 하고, 행이 없는 쪽은
  아무도 안 써 본 액션에서만 터진다. `core/tests/module_config_audit.rs` 가 막는다.
- 엔드포인트가 **규칙**인 모듈은 선언하지 않는다 — `dart` 는 액션 이름이 곧 `/api/<name>.json` 이다.

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

> **v2 (2026-08-17): 선언은 자기 축에 산다.** 액션의 속성은 **카탈로그 행**에(`approval`·`uiOnly`·
> `unsupported`·`needs`·`_call`), 인자의 속성은 **`input.properties` 의 그 칸**에(`source`·
> `cacheInput`). 액션 id 를 키로 한 top-level 목록(requiresApproval·uiOnly)은 폐지 — 카탈로그 행이
> 있는 모듈에서 감사가 거부한다. 리더는 이행기 동안 듀얼 홈(행∨목록·스펙∨맵) OR. 예외 = 브로커
> 와이어 어휘(stk_cd 등 input 미선언 인자)는 모듈 수준 인자 맵이 곧 그들의 축이라 유지.

#### `approval` — 실행 승인 게이트 (행 선언, v2)
```jsonc
// actions.json 행 (또는 inline actionCatalog 행)
{ "id": "kt10000", "approval": true, ... }
```
- 선언된 액션을 AI 가 호출하면 **디스패치 계층**(FC=ai.rs + MCP=SysmodHandler — 코드가 거부, 프롬프트 아님)이 즉시 실행 대신:
  채팅 = 승인 카드(`PendingActionArgs::RunModule`, 승인 시 재생 + **턴 즉시 종료** = 카드 1장 보장) / cron = **스케줄 승인 = 잡에 담긴 매매 승인** → 실행 허용(인터랙티브 run_task 우회만 차단) / hub = 차단.
- 판정은 한 함수(`pending_tools::approval_gated` — 행∨옛목록). `uiOnly: true` 도 같은 자리·같은 규칙
  (화면 전용 — 승인 카드조차 안 만들고 설정 화면을 가리킴).
- 대상: 실주문·비가역·real-money 액션 (키움 18 / 한투 19 / 토스 6 / autotrade 8 — 전부 행 선언). 새 매매/파괴 모듈 = 행 한 필드로 자동 포함.

#### `needs` — 선행 절차 게이트 (행 선언, v3. grounding 기계 대체 2026-08-17)
```jsonc
// actions.json 행 — 이 액션 전에 저 모듈이 이 대화에서 성공 실행돼야 한다
{ "id": "financial", "needs": ["stock-lookup"], ... }
```
- 디스패치 직전 판정은 한 질문뿐: **"선언된 모듈이 이 대화(30분 슬라이딩 창)에서 성공 실행됐나."**
  계단 게이트와 같은 저장소(`conversation_scope`)·같은 창·같은 철학(절차는 구조로, 판단은 흐름에).
  거부문은 선언에서 파생. cron 은 면제(운영자가 인자를 작성한 실행).
- 통지는 세 계단에서 같은 선언이 말한다 — search 행 `needs` · 스키마 `first`(조립된 선행 호출체 + why) ·
  디스패치 거부(바닥). 잔여 방어("거치고 딴 값")는 모듈 관례 **identity echo** — 식별자를 받은 성공 응답
  맨 앞에 `identity: "005930 = 삼성전자"` 를 **응답 자신에서 읽어** 되울린다(테이블 금지, 이름 없는 응답은 침묵).
- core 는 값의 모양(6자리·KRX 접두 등)을 **아무것도 모른다** — 옛 grounding 기계(코퍼스·패턴·
  벤더 장식 스트립)는 개별 모듈 사정이 core 에 스민 것이라 은퇴했다. 새 브로커 = 행 선언만.
- resolver 성 액션(lookup 류)은 자기 `needs` 를 선언하지 않으면 된다 — 면제 목록이 따로 없다.
- **액션 알갱이도 된다** (2026-08-18): `"needs": ["sing:scores"]` — 같은 모듈의 선행 액션(보관함 조회 등)도 게이트할 수 있다. 성공 실행 기록이 모듈·`모듈:액션` 두 벌로 남아 어느 알갱이 선언이든 맞는다.

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
- `ws.streams` = **`IWsStreamPort`** 상시 감시 선언(`stream_watch_start/stop/list` AI 도구) — 편입/이탈·시세 REAL 프레임이 이벤트 버스(SSE topic)로 fan-out 되고, `notify:"module:<name>"` 이면 그 모듈이 프레임 배치를 받는다. vault 영속으로 재부팅 자동 복원.
- `webhook` = **인바운드 웹훅 선언** — `POST /api/hooks/<module>` 이 그 모듈 것이 된다. `secret`(선언 시크릿명 — 첫 실행 때 기계 발급·env 주입)·`secretHeader`(벤더가 토큰을 싣는 헤더)·`parseAction`(payload → `{proceed, prompt, replyArgs}`)·`replyAction`/`replyTextParam`/`replyMaxChars`. 프레임워크 = 수신·시크릿 대조·AI 왕복만, 벤더 모양·권한 판정은 모듈 액션 몫 (v3-R4 — 옛 TelegramService gRPC 은퇴, telegram 이 첫 소비자).
- `vendorKey`(컴포넌트, `system/components.json`) = 렌더러가 **브라우저에서** 쓰는 벤더 키 선언 — `GetComponentVendorKeys` 가 선언된 키만 vault 에서 읽어 `window.__VENDOR_KEYS` 로 싣는다. 선언 = 브라우저 노출 가능 표식(폐쇄 집합, 임의 vault 읽기 불가).
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

> **원본 하나 (2026-08-25)** — 카탈로그를 선언한 모듈은 **행이 액션 집합의 원본**이다.
> `input.properties.action.enum` 은 런타임이 행에서 파생하므로 **config 에 적지 않는다**(감사가
> 사본으로 거부). 행 `params` 는 **이름 목록**(`["symbol", …]`) — 문구는 `input` 이 원본이고
> 스키마 응답이 거기서 실어 온다(행에 문구를 다시 적으면 감사가 거부). 행 `"hidden": true` =
> 디스패치·게이트·파생 enum 에는 서되 검색·스키마에는 안 실리는 액션(벤더 낱말 별칭 — binance
> `klines`). 카탈로그를 선언했는데 행을 못 읽으면 그 모듈의 **모든 호출이 닫힘으로 거부**된다
> — 승인 게이트가 행에 사니, 안 읽힘이 "게이트 없음"으로 읽히면 안 된다.
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
     - **받는 형태 두 가지**: `{"actions": [...]}` 또는 **배열 그 자체** `[...]`. 둘은 같은 뜻이다.
     - ⚠️ **선언이 0개를 내면 깨진 선언으로 보고 input 파생으로 폴백 + 모듈 이름을 대며 WARN.**
       (2026-08-10: 배열로 선언했더니 `actions` 키가 없어 0개 산출인데, 키 존재만으로 폴백을
       건너뛰어 **모듈이 발견에서 통째로 사라졌다** — 실행·설정은 멀쩡해서 아무도 안 찾아볼 0.)
  2. 없으면 **`input` 스키마에서 자동 파생** — `input.properties.action.enum` 의 값마다 엔트리(설명 = `action.description` blob 조각, params = 나머지 input properties). **작은 모듈·usermod 는 별도 authoring 0** — 이미 있는 input 스키마가 곧 카탈로그.
  3. action enum 도 없으면(단일 목적 모듈) → 모듈 1엔트리(`get_action_schema` = input 스키마 통째).
- `actions.json` 엔트리 = `{ id, name, description, domain?, tags?: [...], aliases?: [...], params?: [이름], required?: [이름], approval?: true, uiOnly?: true, unsupported?: true|"이유", _call?: {...}, example? }` — `file`(모듈 dir 상대) 또는 inline `actions`. **행이 자기 게이트를 가진다**(v2). ~~gen 스크립트·overrides 병합~~ 폐기(2026-08-17 — 선언이 원본, 상주 생성 절차 0. 수입 도구는 1회 돌리고 결과를 원본으로 승격).
  - ⚠️ **`params` 는 이름 **목록**이지 설명 맵이 아니다** (2026-08-16). 맵이던 시절 선택을 적으려면 스키마에 이미 있는 문장을 또 써야 했고 — **형식이 사본을 강제했다** — 그 사본이 어긋나 daum-search `sort` 가 실제 enum `["accuracy","recency","latest"]` 옆에서 "newest-first" 를 광고했다. 게다가 한 줄 더 쓰기 싫으니 **선택이 짧아졌다**(naver-ads 46개 중 33개만). 지금은 목록이라 설명을 넣을 자리가 없고, 문구는 항상 `input.properties.<param>.description` 에서 온다.
  - **인자를 안 받는 액션은 `"params": []`** — 생략과 다르다. 생략 = "스키마에서 파생", 빈 목록 = "없음". 빈 목록이 없으면 태그 필터가 *전부* 를 돌려주는 폴백에 걸려 `fa/selftest` 가 `ratios` 의 11개를 광고했다(2026-08-16).
  - **`required`** = 그 액션이 없으면 거부되는 인자. `get_action_schema` 의 `fill` 이 여기서 나온다. 벤더 시트의 `required:true` 를 생성기가 **한국어 `(필수)` 문구로만** 적던 시절엔 `fill` 이 늘 비어 있었다 — 구조는 구조로 남긴다.
  - **`aliases`** = 실행기는 받지만 발행하지 않을 다른 이름(binance `klines` = `get_candles`). 로더가 검색어로도 쓰고, **감사가 "enum 에 있는데 카탈로그에 없는 액션"을 빌드 실패로 잡을 때 의도적 생략을 구분하는 근거**가 된다.
  - ⚠️ **`envelope` 은 폐기** (2026-08-15). 호출 봉투를 산문으로 적던 자리인데, `get_action_schema` 가 **조립된 `call`**(도구명 + `action` 채움 + `fill` = 없으면 거부되는 값 이름)을 내주므로 문장에서 모양을 유추할 이유가 없어졌다.

- **⭐ 액션이 여럿이면 카탈로그를 쓴다 (신규 모듈 필수)**. 파생 폴백은 authoring 0 이 목적이지 품질 목표가 아니다 — 파생은 액션별 설명이 없어서 **`action.description` 덩어리에서 조각을 긁고**, 못 찾으면 모듈 설명을 쓰고, 거기에 파라미터 enum 값을 덧붙인다. 액션이 많을수록 문서가 서로 닮아 **검색이 못 가른다**(2026-08-06 upbit: 캔들 일/주/월 세 액션이 같은 문서가 됐다). 2026-08-15 실측 = 35모듈 중 **18개가 카탈로그 없음**, 그중 dart 82액션·upbit-trade 33·kma-weather 28.
  - 이미 `action.description` 에 `이름=설명 / 이름=설명` 형식으로 적어 뒀다면 그걸 **쪼개서** `actions.json` 으로 옮기면 된다(dart 는 82개 전부가 그 형식이라 커버리지 100%).

- **어떤 인자가 어느 액션 것인지는 `input` 이 말한다** (2026-08-16) — 파라미터 설명 앞의 `[액션]` 태그:
  `"[stats] Split by pcMblTp=PC/mobile"` · `"[list-*] Results per page"` · `"[make_*] render-block IR"`.
  로더가 `tag_tokens`/`param_applies` 로 읽어 액션별로 좁힌다. 토큰 구분자는 영숫자·`-`·`_`·`*` 가 아닌
  **모든 문자**라 `[estimate:performance]`·`[keyword-tool withBid]` 도 그 액션으로 잡힌다. 와일드카드는
  접두사 매칭(`list-*`). **태그가 없으면 모듈 전체 인자**로 취급된다.
  ⚠️ 이게 있어서 카탈로그가 `params` 목록을 안 적어도 된다. 안 적으면 태그가 정한다.

- **감사가 CI 에서 돈다** (`core/tests/module_config_audit.rs`. ⚠️ 2026-08-17 까지 `--lib` 만 걸려
  **한 번도 CI 에서 안 돌았다** — `3c020e49` 에서 `--tests` 로 수리). 선언은 **오류가 아니라 침묵**으로
  틀리기 때문에:
  ① **선언 → 존재**: `needs`·`pageBinding`·카탈로그가 가리키는 모듈·액션·파일이 있나
  ② **존재 → 발견**: `input.properties.action.enum` 의 액션이 카탈로그 id 나 `aliases` 에 있나
     (없으면 그 액션은 실행되는데 검색으로는 못 찾는다)
  ③ **선언 → 구현**: 스키마가 선언한 인자를 **모듈 소스가 이름으로라도 쓰나**. 전수 783개 중 10개가
     허구였다 — browser-scrape 가 스크린샷·뷰포트·헤더·JS 토글을 광고했는데 114줄 구현이 하나도 안 읽었다.
     `<param>CacheKey/Limit/Range` 면제(검증 전 확장) · **`_call.by` 축 면제**(방언이 `data[call.by]` 로
     간접 읽음 — 이름이 코드에 안 나온다).
  ④ **`_call` 완결성** + **축 규율**: 선언하면 전 실행 액션에 / 카탈로그 행이 있는 모듈의 top-level
     `requiresApproval`·`uiOnly` 는 거부(행으로 — 규칙이지 이행 명단이 아니다).

- **`tags` 는 두 층이고 뜻이 다르다** (둘 다 **string 배열**, 둘 다 임베딩에 들어간다 — 2026-08-15)
  - **모듈 `tags` = 뭐라고 불리는가** — `한투`·`한국투자`·`한국투자증권`·`kis`. 그 모듈의 모든 액션이 공유하므로 **모듈을 통째로** 질의 쪽으로 끌어당기고, 모듈 안에서는 아무것도 가르지 않는다.
  - **액션 `tags` = 무엇을 하는가** — `국내주식주문`·`한국주식주문`·`주식주문`. 사용자가 실제로 쓸 말로 적는다. **질의를 한 행에 꽂는 유일한 재료**이고 모듈 태그가 못 하는 절반이다.
  - **배열이어야 한다** — 문자열로 적으면 `core/utils/module_tags.rs` 가 WARN 을 남기고 무시한다. `upstage-ie` 가 공백 구분 문자열로 선언해 태그가 통째로 사라진 채 오래 돌았다(2026-07-31).
  - **하는 일을 다 적어야 한다** — `technical-analysis` 는 태그 32개가 전부 파동·피보나치라 "백테스트"가 config 어디에도 없었고, 그 요청이 모듈을 못 찾아 모델이 손계산했다(2026-07-30).
  - ⚠️ **일반어는 넣지 않는다** — `조회`·`검색` 같은 낱말은 그 모듈의 모든 액션을 아무 질의로나 끌어올린다. 태그는 변별이 목적이지 개수가 목적이 아니다.

- **description = 임베딩되는 문서 그 자체** (2026-08-15). 액션의 `description` + 그 액션·모듈의 태그 + 이름, 이 셋만 벡터가 된다. **파라미터 설명은 임베딩에서 빠졌다** — 옛 색인은 `id+name+domain+description+파라미터 설명 전부`라 전 카탈로그 208,285자를 임베딩해 설명 64,146자를 담았고(한투 한 액션 1,471자 중 1,431자가 파라미터 산문), **길이가 벡터를 흐린다**(602자 문서가 389자 문서에 짐, 같은 날 실측).
  - 그러니 **짧고 능력 밀도 높게**. 운용 지식(페이징 캡·정렬 어휘·벤더 함정)은 `params` 설명에 적는다 — `get_action_schema` 응답에 그대로 실려 **읽어야 할 시점에** 닿는다.
  - 검색 결과 행에 파라미터를 나열하지 않는 원칙은 그대로다(모델이 get 을 건너뛰고 추측한다).
- **usermod authoring**: input 스키마에 `action` enum + 각 액션 설명을 넣으면 → 등록 즉시 search_module_actions 로 발견(파생). per-action 정밀 params 를 원하면 `actionCatalog` + `actions.json` 선언. 둘 다 없어도 단일 엔트리로 발견은 된다.

#### `cacheInput` — 캐시 키를 모듈 입력으로 (호출 비용 제거. v2 홈 = 인자 스펙)
```jsonc
// input.properties 의 그 인자 칸에 — 중첩 필드는 자기 자리에서 선언하고 경로는 파생된다
"bars":  { "type": "array", "cacheInput": true }
"sheets": { "items": { "properties": { "rows": { "cacheInput": true } } } }  // = 옛 "sheets.*.rows"
```
- 선언한 **배열 파라미터**를 `<param>CacheKey` 로도 받는다. 호출자가 `barsCacheKey: "<_cacheKey>"` 를 보내면 **스키마 검증 전에** 서버가 캐시를 펼쳐 `bars` 에 넣는다 → `required` 의 뜻이 그대로 살고 모듈 코드는 무변.
- 키 이름은 규약(`bars` → `barsCacheKey`) — 선언을 둘로 나누지 않는다. 인라인 배열을 직접 주면 그쪽이 우선. 만료·판독 불가 키는 **필드명을 담은 에러**(조용히 건너뛰면 "bars is required" 로 되돌아와 진짜 원인이 숨는다).
- **왜**: 큰 결과는 캐시되고 호출자는 키만 받는데, 그 rows 를 먹는 모듈이 키를 못 받으면 600행을 인자로 되돌려 보내야 한다. 그러면 모델은 도구를 부르는 대신 직접 계산한다(수수료·세금·슬리피지 없이) — **도구가 안 쓰는 것보다 비싸면 안 쓴다**(2026-07-31 골든크로스 실측). 렌더 쪽 `dataCacheKey` 의 입력측 대응물.
- **object 파라미터도 된다**: 선언한 파라미터의 input 스키마가 `object`(또는 `["object","null"]`)면 확장이 1-원소 배열 대신 **레코드 자체**를 넣는다. 짝 = 아래 `autoCacheWhole`.

#### `collection` — 설정 보관함 행을 인자 값에 시맨틱 매칭 (인자 축, 2026-08-20)
```jsonc
// input.properties 의 그 인자 칸에
"song": { "type": "string", "collection": "scores" }
```
- 선언한 settings 필드(보관함 rows)를 그 인자의 값과 **로컬 임베더(E5)로 랭킹**해 `_collectionMatches.<param>`(상위 행 + `score`)로 spawn 전에 입력에 주입한다 — `_call`·recall 주입과 같은 자리.
- **왜**: 한↔영 표기·띄어쓰기가 다르면 문자 매칭이 보관함 행을 놓친다("aloha" ↔ "아로하"). 모듈 자신의 정규화 매칭은 바닥으로 유지하고, 시맨틱 랭킹은 프레임워크가 얹는다(모듈에 임베딩 코드 0).
- 구현 = `ModuleManager::inject_collection_matches` (`3b404f86`).

#### `autoCacheWhole` — 다섹션 응답을 한 레코드로 캐시 (2026-08-11)
```json
{ "autoCacheWhole": ["국내주식-187"] }
```
- 선언한 액션의 응답은 auto-cache 가 "가장 큰 배열 하나"를 뜯어 저장하는 대신 **응답 객체 통째를 단일 레코드**로 저장한다(인라인은 무손실 유지 — 선언 대상은 작은 응답). `_cacheMeta.kind = "whole"`.
- **왜**: KIS estimate-perform(output1..output4)처럼 여러 섹션이 한 datum 인 응답에서 옛 규칙은 output3 만 캐시했다 — 키로는 응답을 재현할 수 없어, 그 응답을 as-is 로 받는 소비자(fa `estimates`)에게 모델이 손으로 재타이핑해 나르다 거부당하고 섹션을 통째로 포기했다(2026-08-11 턴 33 실측). 선언 하나로 `estimatesCacheKey` 가 `barsCacheKey` 와 같은 경제가 된다.
- 구현 = `core/utils/cache_inputs.rs`, `ModuleManager::with_sysmod_cache`.

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

#### `pageExport` — 페이지 내보내기 메뉴 선언 (2026-08-18)
```json
{ "pageExport": [ { "action": "make_pptx", "label": "PPTX" },
                  { "action": "make_pdf",  "label": "PDF" } ] }
```
- Sidebar 의 페이지 내보내기 메뉴가 **켜진 모듈들의 이 선언에서 파생**된다(`/api/settings/modules/page-exports` — 손목록 아님). 항목 = 그 모듈의 내보내기 액션 + 표시 라벨. 모듈을 끄면 메뉴에서 사라지고, 새 산출 포맷 = config 한 항목이다. 첫 소비자 = docs(PPTX·XLSX·DOCX·PDF).

#### `_mediaImport` — 모듈 산출 파일의 미디어 반출 (2026-08-10)
```json
{ "success": true, "data": { "_mediaImport": {
    "path": "data/docs/report-a1b2c3.pptx",
    "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "filenameHint": "report" } } }
```
- config 필드가 아니라 **출력 선언** — 모듈이 자기 `data/` 스크래치에 파일을 쓰고 `data._mediaImport` 로 선언하면, 프레임워크가 그 파일을 **업로드와 같은 게이트 저장**(magic byte 검증 포함)으로 미디어 스토리지에 편입하고 선언을 `data.media = {slug, url, bytes, contentType}` 로 치환한다. 모듈은 서빙·URL·갤러리를 모른다.
- 경로 confinement = `data/`·`user/` 아래 상대경로만(단위테스트). 성공 시 `data/` 원본은 삭제(이동이지 복사가 아님), `user/` 는 사용자 것이라 보존. 실패 = 실행은 성공 유지 + `data.mediaExportError` + WARN(조용히 사라지지 않는다).
- 구현 = `ModuleManager::export_declared_media` + `IMediaIntakePort`(`IImageImportPort` 미러 — leaf↔leaf 를 포트로 끊는 선례). 첫 소비자 = docs 모듈(pptx·xlsx·docx 산출).

#### `_prepare` — 서비스 산출물 선언 (출력 선언, 2026-08-18)
```json
{ "success": true, "data": { "_prepare": { "service": "tts", "text": "…", "into": "vocalWav" } } }
```
- config 필드가 아니라 **출력 선언** — 모듈이 "이 입력 칸을 채우려면 플랫폼 서비스가 필요하다"를 반환으로 선언하면, 프레임워크가 그 서비스(예: `tts`)를 수행하고 산출물을 `into` 칸에 넣어 **같은 액션을 1회 재실행**한다. 이미 채워진 칸을 다시 요청하면 거부(루프 차단).
- `_mediaImport`·`_render` 와 같은 **밑줄 출력 채널**(프레임워크가 소비, 모델에 안 실림). 1호 소비자 = sing 보컬 TTS — 이 선언으로 core 의 sing 전용 브리지 도구가 은퇴했다(브리지에 자라던 악기·스타일 목록 사본 소멸, `d613cc40`).
- 구현 = `ModuleManager.run` 의 `_prepare` 처리 + `IPrepareServicePort`.

#### 모듈 내장 이미지 — `assets/` 디렉토리 (2026-07-18)
모듈 디렉토리의 `assets/` 에 둔 이미지는 `/module-assets/<module>/<file>` 로 공개 서빙된다(system·user 공통, Rust axum route → next.config rewrite). 확장자 allowlist(png/jpg/jpeg/webp/gif/svg/ico) + 세그먼트 charset 가드 + CSP/nosniff(svg XSS 완화) + `Cache-Control: public,max-age=3600`. 페이지·render 블록에서 안정 URL 로 참조 — base64 인라인·외부 URL 의존이 필요 없어진다.

> 위 필드들의 공통 원리 = **"모듈은 dumb, 인프라가 config 로 처리"** (auto-cache · secrets env 주입 · 토큰 생명주기와 동일 계열). 새 provider 방언이 config 데이터로 안 되면(한투 approval_key+AES 등) 그때만 infra 에 dialect 조각 추가 — 모듈 코드에 넣지 않는다.

#### `accounts` — 계좌별 자격증명 (2026-07-31)
```json
{
  "accounts": {
    "modes": ["real", "mock"],
    "markets": ["kr", "us"],
    "listAction": "ka00001"
  }
}
```
- 브로커 앱키는 **계좌 단위 발급**이다(키움 모의 키를 실전 도메인에 쓰면 `8030` 거부, 한투 동일). 키움 주문 body 에 계좌 필드가 없는 것도 같은 이유 — **자격증명이 곧 계좌**.
- 등록 계좌 = `AccountEntry{ id(별칭), label, mode, markets, accountNo }`, 레지스트리 = vault `module-accounts:<모듈>` (`primary` = 별칭 지목). **주계좌도 등록 계좌 중 하나** — 시세·차트처럼 `account` 없이 온 호출이 그 계좌로 돈다.
- 자격증명은 `user:<SECRET>@<별칭>` 에 저장되고 **모듈은 계좌의 존재를 모른다** — sandbox 가 그 계좌의 값을 모듈이 이미 읽는 env 이름에 넣는다. 계좌 추가 = vault 쓰기(코드 0).
- **폴백 없음** — 계좌로 도는 호출은 그 계좌 키만 읽는다(공용 키로 흘러가면 모의 계좌가 실전 키로 도는 걸 아무도 못 본다). 자격증명이 비면 **어느 것이 비었는지 말하는 에러**, 등록 계좌가 0이면 "먼저 등록하라"는 에러 — 브로커 인증 실패로 알게 되지 않는다.
- 별칭 = 계좌 이름(한글 가능, `@`·공백 불가 60바이트). 계좌번호는 **브로커가 보여 주는 그대로**(하이픈 포함) 저장하고 API 로 쓸 땐 `digits()` 로 숫자만 뽑는다.
- 입력할 자격증명 목록 = `secrets` 에서 파생(`type:"token"` = 프레임워크가 발급하는 슬롯, 그 외 = 사람이 넣는 키) — 선언 중복 0.
- 호출 시 `account: "<별칭>"` 으로 고른다. `mock` 은 계좌가 정한다(선언 mode) — 둘이 모순될 수 없다. 미등록 별칭은 등록된 별칭을 열거한 에러.
- 채팅 노출 = `get_action_schema` 의 `account` 파라미터(등록 별칭·계좌번호·모드·시장) + `get_module_config` 의 `accounts.registered`. 계좌 목록은 색인이 아니라 **호출 시점 조회**(vault 쓰기 즉시 반영).
- `listAction` = 브로커에서 계좌번호를 받아 오는 액션(표시용, 인증에 안 씀).

#### `schedules` / `schedulesFrom` — 크론 선언·파생 (수명 축, 2026-08-17)
```jsonc
"schedules": ["cron-health.json"],                        // 점검 루프 — 모듈이 켜진 동안 정적 등록
"schedulesFrom": { "setting": "trades", "field": "loop",  // 결정 루프 — 설정 행이 파일을 가리킨다
                   "skipWhen": { "field": "state", "equals": "off" } }
```
- `schedules` = 아무 일이 없어도 돌아야 하는 **점검 루프**(봉캐시·복기)의 정적 선언.
- `schedulesFrom` = 어느 루프가 도는지가 운영자 설정에 달렸을 때 — 둘째 목록을 손으로 들지 않고 **행이 크론 파일을 가리키게** 한다(매매 행 `loop` → `cron-upbit.json`). 행을 켜면 등록, 끄면 회수(`skipWhen`), 멱등은 `_registeredSchedules`. 파일명 규칙을 프레임워크가 짓지 않는다(숨은 대응표 금지) — 가리키는 행이 없는 루프 파일은 잠자는 템플릿일 뿐이다(`7cf1bb02`).

#### 선언형 필드 요약 표

| 필드 | 기능 | 처리 계층 |
|---|---|---|
| `packages` | 런타임 의존성 자동 설치 | sandbox |
| `secrets` | Vault → env 주입 | sandbox |
| `secrets[].oauth` | 토큰 발급·선제갱신·재발급 (`OAuthTokenProvider`) | infra TokenProvider |
| 행 `approval` / `uiOnly` / `unsupported` | 승인 카드 / 화면 전용 거부 / 미지원 안내 — **액션 축**(v2. 옛 top-level 목록은 이행기 OR 로만 읽힘) | 디스패치 전 표면 (`pending_tools::approval_gated`) |
| 행 `needs` / 인자 `source` | 선행 모듈 실행 강제 (대화 30분 창) / 발급처 지목 | 디스패치 (FC + MCP) / 검증 힌트 |
| `ws` | WebSocket 스냅샷·상시 감시 라우팅 | ModuleManager.run → IWsApiPort/IWsStreamPort |
| `timeseries` | 시계열 영구 store (증분 fetch) | sandbox choke-point |
| `actionCatalog` | 액션 시맨틱 검색·스키마 (`search_module_actions`, 없으면 input 스키마에서 자동 파생) | AI 도구 (E5 카탈로그) |
| `tags` | 모듈 선택 신호(얇은 도구 설명에 append) **+ 액션 검색의 게이트 어휘**. 랭커 문서에는 안 들어간다 — 같은 태그를 233행에 이면 액션끼리 흐려진다 | 도구 등록 + `vocab_text` |
| `aliases` | **그 모듈을 사람들이 실제로 부르는 이름**(`한투`·`한국투자증권`·`KIS`). 모듈 이름과 함께 **랭커 문서**에 들어간다 — 거래소를 대는 게 곧 라우팅 신호다. 파생 불가라 선언이 유일한 소스. recall 의 `entity_passage_text`(name+aliases)와 같은 패턴 | 액션 카탈로그 (`module_identity`) |
| `accounts` | 계좌별 앱키 등록·주계좌 지정 (`account` 로 선택, `mock` 은 계좌가 결정) | `ModuleManager.run` + sandbox/WS 시크릿 해석 (`account_secrets.rs`) |
| 인자 `cacheInput: true` | 그 파라미터를 `<param>CacheKey` 로 수용 (검증 전 확장, object 는 레코드 자체. 중첩은 플래그 자리에서 경로 파생 — **인자 축**, v2) | `ModuleManager.run` (`cache_inputs.rs`) |
| `autoCacheWhole` | 선언 액션의 응답을 통째 단일 레코드로 캐시 (다섹션 datum — cacheInputs object 의 짝) | sandbox `apply_auto_cache` (`cache_whole`) |
| `pageBinding` | 페이지↔모듈 바인딩 opt-in (발행 bake · 방문 SSR · rebake 크론 · shortcode alias) | 저장 경로 bake (`page_binding.rs`) + 발행 SSR (`page-binding-gate.ts`) |
| `assets/` (디렉토리) | 모듈 내장 이미지 공개 서빙 (`/module-assets/<m>/<file>`) | Rust axum route + next rewrite |
| `_mediaImport` (출력 선언) | 모듈이 만든 파일을 미디어 스토리지로 반출 (게이트 저장 → `data.media`) | `ModuleManager.run` (`IMediaIntakePort`) |
| `ws.streams.<k>.tick1s` | 실시간 프레임 → 코어 1초 집계 → 시계열 store (`tick1s:<모듈>:<real|mock>:<종목>`, `read_ticks` 로 조회). 선언 = `{items, type:{field,equals}, symbol, values, map:{price,signedVolume,…}}` — `items`/`values` 생략 = 프레임 자체가 아이템(업비트). `signedVolume` = 필드명(부호 내장, 키움) 또는 `{field, negateWhen:{field,equals}}`(무부호 수량 + 매도 플래그, 업비트 `ask_bid:"ASK"`). **`equals` 는 문자열·불리언·숫자 아무 스칼라**(바이낸스 `m: true`) — 예전엔 문자열만 읽어 불리언 venue 에서 절이 통째로 무시되고 **매도가 전부 매수로 집계**됐다(실패 신호 없음). 집계기는 브로커 지식 0 | 이벤트 sink (`tick_agg.rs`) — watch 등록 시 meta 에 해석 |
| `settings_fields[].editorSchema` | structured-list 카드 폼을 config 선언으로 렌더 (`fields[]` = text/number/toggle/select/**ref**/json/rules · `required` = 저장 게이트 · `showWhen` · `summary` · `newItem`). 필드 추가 = config 수정 + pull 로 끝 | 프론트 `StructuredListEditor` (legacy 하드코딩 카드는 스키마 없는 config 의 폴백) |
| `schedules` / `schedulesFrom` | 점검 루프 정적 등록 / 설정 행이 가리키는 결정 루프 파생 (켜면 등록·끄면 회수, 멱등 `_registeredSchedules`) | `ModuleManager`(config 읽기) + ScheduleManager |
| `pageExport` | Sidebar 페이지 내보내기 메뉴를 켜진 모듈 선언에서 파생 (`{action, label}`) | 프론트 (`page-exports` 라우트) |
| `_prepare` (출력 선언) | 플랫폼 서비스 수행 → `into` 칸 주입 → 같은 액션 1회 재실행 (1호 = sing 보컬 TTS) | `ModuleManager.run` (`IPrepareServicePort`) |
| 인자 `collection` | 설정 보관함 rows 를 인자 값과 E5 랭킹해 `_collectionMatches.<param>` 주입 (한↔영 별칭) | `ModuleManager`(`inject_collection_matches`) |
| `settings_fields[].type:"files"` | 복수 파일 보관함 — 참조 목록 `[{url,name,alias,default?}]`, blob 은 미디어 창고 소유, `accept` 확장자 제한 | 설정 화면 + 미디어 창고 |

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

**차이는 누가 쓰느냐뿐이다 — 실행 계단은 하나다** (2026-08-16). `ModuleManager.run` 은 원래부터
`user/modules` 를 먼저 찾으므로 `run_module_action({module, action})` 이 사용자 모듈에도 맞고,
`execute({path:"user/modules/<name>"})` 는 **같은 이름으로 resolve 되어 같은 계단**을 탄다.

⚠️ 전에는 `execute` 가 sandbox 직행이라 사용자 모듈만 **`is_enabled`·입력 검증·auto-cache·`timeoutMs`·
timeseries 를 전부 건너뛰었다** — config 에 선언해도 읽는 데가 없었고, MCP 는 그 호출의 모듈을 몰라
(`target_module` = `None`) **선언을 로드조차 안 해 grounding 이 "선언 없음"으로 결론**냈다. 하필 AI 가
직접 쓰는 표면에서 부재가 동의가 된 자리다. 지금은 모듈 디렉터리를 가리키는 경로만 이름으로 풀리고,
**더 깊은 경로(모듈 안 스크립트)는 모듈 호출이 아니라 raw 실행** 그대로다.

> **원칙 — 모듈이 안 돌면 모듈에서 고칠 수 있어야 한다.** 못 고치면 그건 모듈 버그가 아니라 **선언
> 표면의 결손**이다. "모듈 dumb, 인프라가 config 처리" 의 대가로 실패 표면이 프레임워크로 옮겨가기
> 때문에, 증상을 안쪽에서 고치기 전에 **"이건 모듈에서 고칠 수 있나"** 를 먼저 묻는다. 사용자 모듈에선
> 특히 — 코어 fix 는 GHA + FTP + restart 를 기다려야 하고, 그러면 "AI 가 배포 없이 능력을 만든다"는
> 존재 이유가 뒤집힌다.

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
| `type` | `text` / `number` / `toggle` / `textarea` / `oauth` / `secret` / `select` / `widget-list` / `verifications` / `color-presets` / `color-overrides` / `structured-list` / `files` |
| `tab` | 탭 그룹 (없으면 기본 탭). **탭 순서 = 필드 선언 순서** |
| `group` | 탭 안 sub-section heading |
| `secretName` | secret type 전용 — Vault 키 이름 |
| `oauthUrl` / `oauthSecrets` | oauth type 전용 |
| `options` | select type 전용 |
| `defaultValue` | 미설정 시 자동 적용 값 |
| `editor` | structured-list 전용 — 카드 편집기 종류 (`trades` / `strategies`) |

**`structured-list`** (2026-08-06): JSON 배열 설정을 카드 폼 ↔ JSON 이중 뷰로 편집한다
(`StructuredListEditor`). 값 저장 형식은 textarea 와 동일한 JSON 문자열이라 **모듈 쪽 계약은 그대로**
— 화면만 바뀐다. 폼은 자기가 아는 키만 고쳐 쓰고 모르는 키는 보존하며(reconciler 원칙), 깨진 JSON
은 저장 경로에 도달하지 못한다(마지막 유효 상태 유지). 새 카드 종류가 필요하면 `editor` 값과 카드
컴포넌트를 추가한다 — 기존 두 종은 autotrade 의 매매·전략 행.

**`files`** (2026-08-18): 복수 파일 보관함 — 값 = **참조 목록** `[{url, name, alias, default?}]`,
blob 은 미디어 창고 소유(행 삭제 = 참조만 삭제). `accept` 로 확장자를 제한한다(sing `scores` =
`.mid,.mxl,…`). 별칭 매칭은 정규화(대소문자·띄어쓰기 무시, 파일명 겸용)이고 보관함 조회는 **정식
액션**으로 낸다(sing `scores` · docs `masters`, query 필터) — 틀려서 알아내게 하지 않는다. 개수
무관 동일 절차(1개 자동 특례 금지) — 무명 폴백은 `defaultPerKind` 로 **선언한** 대표뿐이다.

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
