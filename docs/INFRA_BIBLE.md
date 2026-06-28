# FIREBAT INFRA BIBLE — 행동 대장 수칙

> 최종 개정: 2026-05-06 (Phase B-4 cutover)

## 전문(前文)

이 문서는 `infra/` 계층의 설계 및 행동 규격을 정의한다.
Infra는 Core의 순수성을 지키기 위해 물리적 세계(파일 시스템, 프로세스, 네트워크)와 직접 맞닿아 궂은일을 수행하는 **유일한 I/O 실행 계층**이다.

**🔥 Phase B-4 cutover 후 코드 위치 (개념·규칙은 그대로)**:
- 옛 TS `infra/*/index.ts` → `infra/src/adapters/*.rs` (운영 어댑터 20개)
- 옛 TS `infra/llm/*` → `infra/src/llm/*.rs` (ConfigDrivenAdapter + 8 format handlers)
- 옛 TS `infra/image/*` → `infra/src/image_gen/*.rs`
- 옛 TS `infra/boot.ts` (싱글톤 조립) → `infra/src/main.rs` (gRPC server entry — `firebat-core` binary 가 시작 시 어댑터 wiring)
- 옛 TS `infra/config.ts` → 폐기. 상수는 각 매니저·어댑터 자체 const 또는 Vault. Frontend 측 BASE_URL / SESSION_MAX_AGE 는 `lib/base-url.ts` + `lib/config.ts`.
- crate 구조: `infra` crate 가 `core` crate 의 trait 만 의존 (단방향 `infra → core`)
- 본 문서의 모든 TS 경로 reference 는 historical. 새 작업 시 위 매핑 따라 Rust 위치 사용.

---

## 제1장: 절대 원칙

1. **독점적 I/O 권한**: `fs`, `child_process`, `fetch`, DB 라이브러리 등을 호출할 수 있는 유일한 계층.
2. **에러 캡슐화**: 모든 에러를 catch하여 `InfraResult` 객체로 Core에 반환. 절대 throw하지 않는다.
3. **Core 의존성 배제**: `core/ports/`의 인터페이스만 참조. Core 내부 로직을 import하지 않는다.
4. **설정 중앙 관리**: 설정 상수는 각 매니저·어댑터 자체 const 또는 Vault / env 로 관리 (환경변수 우선, 기본값 폴백). 옛 `infra/config.ts` 단일 상수 파일은 Rust cutover 시 폐기 — env 접근은 `IConfigPort`(`EnvConfigAdapter`) 로 격리.

---

## 제2장: 20개 어댑터 구현 규격 (2026-06-02 코드 전수 검증)

CORE_BIBLE 제2장의 22개 포트와 짝을 이루는 infra 어댑터. **운영 어댑터 20개**가 22개 포트 중 21개를 구현한다 — `SqliteMemoryAdapter` 1개가 `IEntityPort` + `IEpisodicPort` 둘을 겸하고, 나머지 22번째 `IMemoryFacadePort` 는 infra 어댑터가 아니라 core 매니저(`MemoryFacade`, `core/src/managers/memory_facade.rs`)가 구현한다 (Entity/Episodic wrapper — hexagonal 정공). 모두 `infra/src/adapters/*.rs` (LLM·image_gen 은 `infra/src/llm/` · `infra/src/image_gen/`).

진화 추적:
- v0.1: 10개 어댑터
- 2026-05-04: 메모리/미디어/임베더 확장
- Phase B-4 cutover (2026-05-06): TS → Rust 전면 이식, SysmodCache → core/utils 이동
- Phase B-post (2026-05-06): `ReqwestNetworkAdapter`(INetworkPort) 신설
- 이후 누적: `EnvConfigAdapter`(IConfigPort) / `FileEmbedderCacheAdapter`(IEmbedderCachePort) / `SqliteLibraryAdapter`(ILibraryPort) / `TelegramNotifierAdapter`(INotifierPort) / `SqliteHubAdapter`(IHubPort) 추가 → 20

**운영 어댑터 20개**: storage / log(tracing) / sandbox / llm / network / cron / database / vault / mcp_client / auth / embedder(E5) / media / image_processor(image-rs) / image_gen / memory(Entity+Episodic) / embedder_cache / library / config / notifier(telegram) / hub.

> 운영 외 구현 (개수 제외): stub 5종 (embedder/llm/sandbox/image_gen/image_processor — 테스트·부팅 fallback), 대체구현 2종 (`ArcticLocalEmbedderAdapter` — `FIREBAT_EMBEDDER=arctic` env 시 / `ConsoleLogAdapter` — 옛 단순 로그). `LinuxCgroupsSandboxAdapter` skeleton (`#[cfg(target_os="linux")]`) 은 운영 미사용 — sysmod libuv/encodings/CLONE_NEWNET 차단 이슈로 `FIREBAT_SANDBOX=basic`(ProcessSandbox) 사용.



### 1. Storage Adapter (`infra/src/adapters/storage.rs`)
- `IStoragePort` 구현 (`LocalStorageAdapter`, tokio::fs + base64 + regex + tempfile).
- **경로 탐색 공격 차단** (2026-05-10 갱신): `resolve_safe_path` 가 (a) `Path::is_absolute()` 거부 (b) `..` segment 거부 (c) `workspace_root.join(rel_path)` lexical normalize. **`canonicalize()` 미사용** — symlink 자동 풀어 self-hosted deploy 의 표준 패턴 (system/modules → src symlink) 이 workspace zone 밖 판정해 reject buggy. 옛 TS LocalStorageAdapter 의 `path.resolve + isInsideZone` 1:1 매칭. path traversal 방어 유지 + symlink 호환.
- **쓰기 허용 구역**: `app/(user)/`, `user/`
- **읽기 허용 구역**: `app/(user)/`, `user/`, `docs/`, `system/modules/`, `system/services/`
- `listDir(path)`: `{name, isDirectory}[]` 반환.

### 2. Log Adapter (`infra/src/adapters/tracing_log.rs` + `log_buffer.rs`)
`TracingLogAdapter` 가 `ILogPort` (info/warn/error/debug 4레벨 + `log_with(category, level, msg)`) 를 `tracing` crate 으로 구현. `init_tracing(log_db_path)` 가 부팅 시 1회 layer 를 fan-out 구성하고 reload handle 을 반환한다 (로그 시스템 sprint, 2026-05-21~05-23).

**layer 구성 (fan-out)** — `reload::Layer<EnvFilter>` (global) → `fmt`(journalctl) + `LogBufferLayer`(sqlite ring). 필터 통과 event 가 journalctl 과 sqlite 둘 다 기록.

- **런타임 레벨 변경 (재빌드 0)**: SIGHUP 시 `data/log-filter.txt` 내용으로 `reload_log_filter` 호출 → EnvFilter 교체. 예: `info,firebat_infra::adapters::sandbox=debug,ai=debug`. admin 로그 탭의 filter 토글도 같은 경로.
- **sqlite ring buffer**: `data/logs.db` 별도 db (app.db / vault.db 와 분리, WAL). 최근 5000건 유지 — writer thread (rusqlite blocking, tokio 비오염) 가 mpsc 수신해 insert, 매 100건마다 ring trim. admin 로그 탭 (LogService.QueryLogs) 이 read-only conn 으로 조회.
- **category**: tracing `target` 은 컴파일 시점 static str 이라 런타임 category 를 못 넣는다. `log_with` 가 category 를 tracing **field** 로 전달 → `MessageVisitor` 가 추출해 `LogRow.target` 으로 승격 → admin 탭 prefix 필터가 매니저 단위 동작. 매니저는 `self.log.*` 그대로 호출하고, main.rs 생성 시점에 `CategoryLogger` wrapper (core) 로 감싸 category 자동 주입 (conversation / media / ai / task / cron).
- **frontend 수집**: 브라우저 logger 가 error/warn 을 `/api/log` 로 POST → firebat-frontend journalctl 에 `[client:<category>]` 출력 (hub visitor 브라우저 에러 가시화).
- 범위 한정 (observability paradox 룰): 조회 / 필터 / 토글만. 대시보드 / 그래프 / 알림 미도입.

### 3. Sandbox Adapter (`infra/src/adapters/sandbox.rs`)
- `ISandboxPort` 구현 (`ProcessSandboxAdapter`, tokio::process + reqwest).
- **경로 검증**: `canExecute` 메서드로 `user/modules/`, `system/modules/` 외 실행 차단.
- **언어 중립**: `.py`, `.js`, `.mjs`, `.php`, `.rs`, `.wasm`, `.sh` 지원.
- **config.json 선제 설치**: `packages` 필드 의존성을 실행 전 자동 설치.
- **시크릿 env 주입**: `secrets` 배열 → Vault에서 값 조회 → 환경변수로 전달.
- **타임아웃**: 30초 (`SANDBOX_TIMEOUT_MS`).
- **stdin/stdout**: `{ correlationId, data }` 주입 → 마지막 줄 단일 JSON 수신.
- **`__updateSecrets` 영속**: 모듈이 stdout JSON에 `__updateSecrets: {키:값}` 필드를 포함하면 sandbox가 Vault(`user:{키}`)에 자동 저장.
  - **엄격 검증**: 키는 대문자/숫자/언더스코어(`^[A-Z0-9_]+$`)만, 값은 string + 8KB 제한, **config.json `secrets` 배열에 선언된 이름만 허용** (오염 방지).
  - `tokenCache` 키와 일치하면 `ttlHours` 기반 `__expires` 자동 기록 (TTL 만료 후 자동 갱신 흐름에 연계).
  - 예: 카카오톡 모듈이 401 → refresh_token으로 갱신 → 새 `KAKAO_ACCESS_TOKEN`(+ rotating `KAKAO_REFRESH_TOKEN`)을 `__updateSecrets`로 반환 → Vault 영속 → 다음 실행 시 재사용.
- **`_cache` envelope + auto-cache 일반화** (2026-05-23): sysmod 응답이 크면 LLM 컨텍스트에 통째로 싣지 않고 SysmodCacheAdapter 에 저장 → AI 는 `_cacheKey` + 작은 preview 만 받고 필요 시 `cache_read` / `cache_grep` / `cache_aggregate` 로 drill-in.
  - **명시 envelope** (모듈 opt-in): 모듈이 `data._cache = {records, sysmod, action, params, ttlSec}` + 풍부한 preview 형제 필드 (예: yfinance 의 `firstDate` / `lastDate`) 를 포함하면 sandbox 가 이를 인식해 cache 저장 + `_cache` 제거 + `_cacheKey` / `_cacheMeta` 주입.
  - **auto-cache fallback** (모듈 변경 0): 명시 envelope 없을 때 sandbox 가 `data` 의 직접 자식 배열 중 가장 큰 것을 자동 추출 — 길이 `AUTO_CACHE_THRESHOLD`(30) 이상이면 cache 저장 + 첫 `AUTO_CACHE_PREVIEW`(5) 개로 in-place truncate + `_cacheKey` / `_cacheMeta {fieldName, totalCount, autoCached:true}` 주입. **배열이 없으면 가장 큰 문자열**(≥8000자)을 줄 단위 `{line,text}` 레코드로 캐시 + 1500자 프리뷰 (firecrawl 등 긴 본문, 02b0e02) — `cache_grep` 으로 키워드 검색. 한 응답당 1개. **admin · hub 공통 경로** (모든 sysmod 자동 혜택 — law-search / naver-search / firecrawl / kiwoom 등).
  - 명시 envelope 처리에서 `_cacheKey` 가 이미 주입된 경우 auto-cache 는 skip — 모듈 의도 우선.

### 4. LLM Adapter (`infra/src/llm/adapter.rs` + `infra/src/llm/formats/*.rs`)
- `ILlmPort` 구현은 **ConfigDrivenAdapter 단일** (tokio + reqwest + serde_json + rusqlite). 프로바이더별 개별 어댑터 금지 — `config.format` → 등록된 FormatHandler 로 HashMap dispatch.
- **모델 registry** (`system/llm/models.json` + 사용자 `*.json` merge, override 우선): 모델당 1개 항목. 새 LLM 도입 시 JSON 추가만으로 확장.
  - 필수: `id`, `displayName`, `provider`, `format`, `endpoint`, `apiKeyVaultKey`.
  - 선택: `features` (mcpConnector/strictTools/reasoning/thinking/extendedThinking/toolSearch/promptCache 등), `pricing`, `extraHeaders`.
- **포맷 핸들러 7종** (`infra/src/llm/formats/*.rs`) — API 4(reqwest 직접 호출) + CLI 3(자식 프로세스). `openai-chat` 은 2026-05-10 폐기(핸들러 미등록). API 어댑터는 SDK 없이 reqwest 로 각 프로바이더 HTTP API 직접 호출:
  | format | transport / 실행 | 용도 |
  |---|---|---|
  | `openai-responses` | reqwest (`/v1/responses`) | OpenAI Responses API — GPT-5.x (MCP connector, previous_response_id, `reasoning.effort`). 토큰 회계: `usage.input_tokens` + `input_tokens_details.cached_tokens` |
  | `anthropic-messages` | reqwest (`/v1/messages`) | Claude Messages API — MCP connector, extended thinking(`thinking.type:adaptive` + `output_config.effort` — 옛 `budget_tokens` 는 Opus 4.7/4.8/Fable 에서 400, 2026-06-11 전환 `cc0c71a`), **prompt caching 토글** (`VK_LLM_ANTHROPIC_CACHE`, 기본 OFF — 같은 prefix 5분 재호출 시 ON 권장). 토큰: input + cache_creation + cache_read 합산, cached=cache_read |
  | `gemini-native` | reqwest (generativelanguage API) | Gemini AI Studio — 네이티브 functionCall/functionResponse 멀티턴 (rawModelParts 보존), `thinkingConfig`. 토큰: promptTokenCount / candidates+thoughts / cachedContentTokenCount |
  | `vertex-gemini` | reqwest (Vertex AI) | GCP Vertex AI — Service Account JSON + OAuth access token 자동 갱신 (JWT). usage 매핑 gemini-native 와 동일 |
  | `cli-claude-code` | `claude` 자식 프로세스 | Claude Pro/Max 구독. `--print --output-format stream-json --verbose --allowed-tools 'mcp__firebat__*' --mcp-config <json> --effort <level>`. 줄 단위 streaming 파싱 — thinking/tool_use 실시간 emit, `result.usage` 토큰 + `total_cost_usd` |
  | `cli-codex` | `codex exec` 자식 프로세스 | ChatGPT Plus/Pro 구독. 임시 `CODEX_HOME/config.toml` ([mcp_servers.firebat]) + env, `--json --skip-git-repo-check --full-auto -c model_reasoning_effort="<level>"`. 이벤트: `thread.started` / `turn.{started,completed}` / `item.{started,completed}`. `turn.completed.usage` 토큰 |
  | `cli-gemini` | `gemini -p` 자식 프로세스 | Google AI Pro 구독. `workspace/.gemini/settings.json` (프로젝트 로컬 MCP) + `GEMINI.md` + cwd. `--output-format stream-json --approval-mode yolo`. 도구 이름 `mcp_firebat_` 접두사. `result.stats.models[*].tokens` |

- **CLI 모델 유도** (2026-06-12 fix `76f59d5`): `opts.cli_model`(--model 값)은 요청 단계에서 안 채워지므로(프론트 미전송) `ConfigDrivenAdapter.enrich_opts_for_format` 가 `config.id` → provider 모델 문자열 자동 유도 — `cli-claude-code-{X}`→`claude-{X}` / `cli-gemini-{X}`→`gemini-{X}` / `cli-codex-{X}`→`{X}`(이미 gpt-) / `*-auto`→None(CLI 기본 모델). 이전엔 미할당이라 3 CLI 모두 --model 미전송 → CLI 기본 모델로 돌아 "모델 선택이 cosmetic" 이던 버그. 효과: 모델 선택 실동작 + sonnet-4-6/opus-4-6 선택 시 thinking 표시(그 모델 기본 `display:summarized`).
- **CLI 세션 resume** (3사 공통):
  - DB: `conversations` 테이블 `cli_session_id`, `cli_model` 컬럼. 모델 변경 시 자동 무효화.
  - 플래그: Claude `--resume <uuid>`, Codex `exec resume <id>`, Gemini `--resume <uuid>`
  - resume 시 prompt 에 history 중복 주입 금지 (CLI 세션이 이미 보유)
- **CLI 통일 패턴** (Claude/Codex/Gemini 모두 동일 — 2026-04-30 daemon 폐기):
  - 매 turn cold spawn (자식 프로세스) + `--resume <session_id>` 로 컨텍스트 유지
  - DB cli_session_id 영속 → 다음 turn 시 CLI 가 이전 컨텍스트 보유
  - 이전 Claude 전용 daemon (LRU 5 + 30분 idle) 폐기 — 메모리 100-500MB + 코드 400줄 + key hash quirk vs spawn 5-10초 절약 trade-off 에서 단순함 우선
  - 매 turn 5-10초 spawn 오버헤드 추가 (LLM 응답 30-60초 → 체감 영향 작음)
- **ConfigDrivenAdapter**: `config.format` → 해당 FormatHandler에 위임. 각 핸들러는 `ask/askText/askWithTools` 시그니처 통일.
- **Lazy 인증**: API Key/Service Account는 resolver 함수로 첫 호출 시 로드. Vault 변경 시 WeakMap 캐시 무효화.
- **인증 분리**: API Key (OpenAI/Gemini/Anthropic) vs Service Account JSON (Vertex).
- **Gemini 공통 스키마 어댑터**: `enum`은 string 배열, `integer`/`number` + `enum` 조합 금지 (Gemini 제약 우회).
- **요청별 모델 오버라이드**: `LlmCallOpts.model`로 호출마다 config 재해석 — 같은 Adapter 인스턴스로 다중 프로바이더 커버.
- **스트리밍**: `onChunk` 콜백으로 thinking/text 청크 실시간 전달. SSE `chunk` 이벤트로 프론트엔드 전파.
- **Firebat 내부 도구 노출**:
  - GPT/Claude (MCP connector 지원): hosted MCP 서버 URL만 전달 → 프로바이더가 Firebat MCP 서버로 직접 접속.
  - Gemini/Vertex: function calling — `functionDeclarations` inline 전달.
- 타임아웃: 60초 (`LLM_TIMEOUT_MS`).

**원칙**: "어떤 LLM 선택해도 동작해야 하고 개별 어댑터를 만들면 안 된다" — 새 모델은 JSON 파일 하나 추가. 새 포맷(새 인증/엔드포인트 체계)만 새 handler 추가.

### 5. Network Adapter (`infra/src/adapters/network.rs`)
- `INetworkPort` 구현 (`ReqwestNetworkAdapter`).
- reqwest 공유 연결풀 래퍼 — HTTP 메서드 파싱·검증, 요청별 타임아웃, 헤더/바디(String·JSON) 처리, 응답 상태·헤더·바디 맵핑(JSON 폴백).

### 6. Cron Adapter (`infra/src/adapters/cron.rs`)
- `ICronPort` 구현 (`TokioCronAdapter`).
- `tokio` + `cron` crate + `chrono-tz` 기반 백그라운드 스케줄러 — cron 표현식 파싱 + 타임존 기준 다음 발화 시각 계산.
- **영속 저장**: `data/cron-jobs.json`(설정) + `data/cron-logs.json`(LRU 200건) + `data/cron-notifications.json`. 프로세스 재시작 시 자동 복원 (delay 모드 제외, endAt 만료·과거 1회 잡 자동 정리).
- **3가지 모드**: `cronTime`(반복), `runAt`(1회 예약), `delaySec`(N초 후 1회).
- **기간 한정**: `startAt`/`endAt`으로 반복 기간 제한, 만료 시 자동 해제.
- **동적 타임존**: Vault `system:timezone` 키로 저장, `setTimezone()`/`getTimezone()` 지원.
- **페이지 URL 스케줄링**: `targetPath.startsWith('/')` → notify 파일 → 클라이언트 폴링 → window.open.

### 7. Database Adapter (`infra/src/adapters/database.rs`)
- `IDatabasePort` 구현 (`SqliteDatabaseAdapter`).
- `rusqlite` 기반 (`data/app.db`) — `Mutex<Connection>` 으로 thread-safe 접근.
- 자동 초기화: `pages` / `conversations` / `conversation_embeddings` / `routing_cache` / `media_usage` / `shared_conversations` / `deleted_conversations` / `page_redirects` / `llm_costs` 테이블 `CREATE TABLE IF NOT EXISTS`.
- CRUD: `savePage`, `getPage`, `listPages`, `deletePage`, `listPagesByProject`, `deletePagesByProject`.
- **LLM cost 통계** (2026-05-10 갱신): `query_llm_cost_stats(filter)` 가 totals (`LlmCostStatsSummary`) + records (`Vec<LlmCostStatsRecord>` per-day / per-model GROUP BY) 둘 다 응답. records SQL: `date(ts/1000, 'unixepoch', 'localtime') AS date, model, COUNT/SUM`. ts ms 단위 (cost.rs `Self::now_ms()`).
- **스키마 관리** (별도 migration runner 없음): 부팅 시 `initialize()` 가 모든 테이블을 inline `CREATE TABLE IF NOT EXISTS` 로 생성하고, 신규 컬럼은 inline `ALTER TABLE ... ADD COLUMN`(에러 무시 = idempotent)으로 추가한다 (`infra/src/adapters/database.rs` + 메모리 테이블은 `infra/src/adapters/memory.rs`). `_db_version` 테이블 / `infra/database/migrations/*.sql` 파일 runner 는 **존재하지 않는다** (옛 TS 시절 설계로 Rust cutover 시 inline 방식으로 통합). 새 컬럼·인덱스 추가 = 해당 어댑터의 `initialize()` 에 `CREATE`/`ALTER` 한 줄 추가.

### 8. Vault Adapter (`infra/src/adapters/vault.rs`)
- `IVaultPort` 구현 (`SqliteVaultAdapter`).
- `rusqlite` 기반 (`data/vault.db`) — Unix 파일 권한 `0600` 강제 (owner read/write), `Mutex<Connection>`, set_secret 시 whitespace trim.
- API 키, 시크릿 등 민감한 값의 CRUD.
- `user:` 접두사로 사용자 시크릿과 시스템 키 분리.
- `listKeysByPrefix(prefix)`: 특정 접두사의 키 목록 반환.
- 시스템 모듈 설정: `system:module:<name>:settings` 키에 JSON 저장.

### 9. MCP Client Adapter (`infra/src/adapters/mcp_client.rs`)
- `IMcpClientPort` 구현 (`McpClientFileAdapter`, tokio + reqwest + futures_util).
- 외부 MCP 서버(Gmail, Slack 등) 접속 및 도구 호출.
- **전송 방식**: stdio (로컬 프로세스) + Streamable HTTP (원격 서버).
- **영속 저장**: `data/mcp-servers.json`.
- `addServer`/`removeServer`/`listTools`/`callTool`/`listAllTools`/`disconnectAll`.

### 10. Auth Adapter (`infra/src/adapters/auth.rs`)
- `IAuthPort` 구현 (`VaultAuthAdapter` — IVaultPort 위임).
- Vault 기반 세션 저장: `auth:session:{token}` 키에 AuthSession JSON 저장.
- 세션/API 토큰 CRUD: `saveSession`/`getSession`/`deleteSession`/`listSessions`/`deleteSessions`.
- 만료 검사 포함: `getSession()` 호출 시 `expiresAt` 체크, 만료 시 자동 삭제.
- **비번 hash** (2026-05-10 도입): admin password 가 `set_admin_credentials` 호출 시 vault 저장 단계에서 자동 argon2id hash. login + verify_admin_password RPC 가 verify. **plain text 저장 X** — vault.db 유출 시에도 비번 노출 0. SettingsModal 비번 변경의 옛 `timingSafeStringEqual(plain, hash)` 패턴이 항상 mismatch buggy → `verify_admin_password` 신설 fix.

### 11. Embedder Adapter (`infra/src/adapters/embedder/e5_local.rs`)
- `IEmbedderPort` 구현 (`E5LocalEmbedderAdapter`) — multilingual-e5-small 로컬 추론 (`candle_core` + `candle_transformers` BERT + `hf_hub` + `tokenizers`). 한국어·영어 OK.
- `OnceCell` lazy 모델 로드 (첫 호출 시 1회, 이후 Arc 공유). `embed_query`(query: 접두사) / `embed_passage`(passage: 접두사) — 같은 텍스트도 역할별 distinct 임베딩.
- attention mask 가중 mean pooling + L2 normalization → cosine similarity 최적화. `cosine(a,b)` 0~1.
- `E5_VERSION` 상수 — 모델 변경 감지 시 SQLite 임베딩 자동 재인덱싱 트리거.
- 대체구현 `ArcticLocalEmbedderAdapter` (`FIREBAT_EMBEDDER=arctic` env 시) — 운영 default 는 E5.

> (옛 #12 `IToolRouterPort` / `llm-router.ts` 어댑터는 폐기 — 도구·컴포넌트 라우팅은 포트가 아니라 core 매니저 `tool_search_index.rs` / `component_search_index.rs` + `IEmbedderCachePort` 조합으로 구현. 어댑터 아님.)

### 12. Media Adapter (`infra/src/adapters/media.rs`)
- `IMediaPort` 구현 (`LocalMediaAdapter`, tokio async file I/O + chrono + rand) — 로컬 파일 저장 (`user/media/`, `system/media/`, 첨부 `user/hub/<id>/`).
- `save` / `list` / `remove` / `save_variant` / `update_meta` / `save_error_record` + 임시 첨부 30일 retention (`cleanup_old_attachments`, mtime 기반).
- slug 생성 `YYYY-MM-DD-<hint>-<rand4>` + UTF-8 정규화. hub_owner path traversal 가드 (영숫자/하이픈/언더스코어만). 메타: `<slug>.meta.json`.

### 13. Image Processor Adapter (`infra/src/adapters/image_processor/image_rs.rs`)
- `IImageProcessorPort` 구현 (`ImageRsProcessorAdapter`) — **`image` + `fast_image_resize` + `blurhash` crate** (옛 sharp Node sidecar 폐기, 순수 Rust CPU·플랫폼 무관).
- `process` — SIMD 가속 resize(`fast_image_resize`) + format convert(Png/Jpeg/Webp, Avif 미포함) + EXIF strip(ImageReader 가 미보존) + focus 크롭(`CropPosition::Focus`, attention/entropy 미지원 시 중앙 fallback).
- `blurhash` (Base83 LQIP). placeholder 생성 시 width/height 1..=4096 clamp (메모리 폭주 방어).

### 14. Image Gen Adapter (`infra/src/image_gen/adapter.rs`)
- `IImageGenPort` 구현 (`ConfigDrivenImageGenAdapter`, tokio + reqwest + image) — config-driven (OpenAI gpt-image / Gemini Image). registry 기반 `ImageFormatHandler` trait 위임.
- 모델 ID 다단계 해석 (직접 매칭 → prefix → default). Vault `system:image:model` override + `system/image/configs/` 사용자 디렉토리 merge. API 키는 Vault lazy resolve.

### 15. Memory Adapter (`infra/src/adapters/memory.rs`) — 메모리 Entity + Episodic
- **단일 어댑터가 `IEntityPort` + `IEpisodicPort` 둘 다 구현** (`SqliteMemoryAdapter`, rusqlite). 옛 BIBLE 의 별도 2어댑터 표기 정정.
- 자동 임베딩 — embedder 주입 시 entity/fact/event 저장 시 passage text → `embed_passage` → BLOB 자동 저장 (미설정/실패 silent).
- cosine 재정렬 — embedder + query 시 후보 embedding 과 cosine 정렬 (fallback substring LIKE). dedup — `dedup_threshold` 활성 시 cosine ≥ threshold 면 skip + 기존 id 반환 (fact: 같은 entity / event: 같은 type + 7일 이내).
- owner-scoped 다중 테넌트 격리 (`UNIQUE(name,type,owner)` + 모든 쿼리 owner filter — admin/hub 분리). TTL — `ttl_days`→`expires_at`, 검색 시 만료 제외 + `cleanup_expired_facts()`.

### 16. Embedder Cache Adapter (`infra/src/adapters/embedder_cache.rs`)
- `IEmbedderCachePort` 구현 (`FileEmbedderCacheAdapter`, std::fs) — component / tool 검색 인덱스 벡터 캐시 영속화 (옛 std::fs 직접 호출을 포트로 격리).
- `FIREBAT_DATA_DIR` 로 캐시 디렉토리 resolve (미설정 시 `data`). `load()` 캐시명 기반 읽기(실패 None) / `save()` JSON 저장 + 자동 디렉토리 생성 (실패 시 warn 로그만, panic 회피).

### 17. Library Adapter (`infra/src/adapters/library.rs`)
- `ILibraryPort` 구현 (`SqliteLibraryAdapter`, rusqlite) — 라이브러리 하이브리드 RAG (Reference / Source / Chunk CRUD).
- dense(E5 BLOB embedding) + sparse(FTS5 trigram BM25) — 가상테이블이 FK cascade 미적용이라 삭제 수동 동기화. 3자 이상 토큰만 FTS5 phrase 질의. `Mutex<Connection>` (write 시 lock).

### 18. Config Adapter (`infra/src/adapters/config.rs`)
- `IConfigPort` 구현 (`EnvConfigAdapter`, std::env) — env / config 접근 추상화 (`FIREBAT_MCP_BASE_URL` 등). `std::env::var` 직접 호출을 포트로 격리 (Ok→Some / Err→None).

### 19. Notifier Adapter (`infra/src/adapters/notifier_telegram.rs`)
- `INotifierPort` 구현 (`TelegramNotifierAdapter`, reqwest) — fire-and-forget 외부 알림.
- Vault `bruteForceAlert` 토글 검사(off/미설정 시 silent skip) + `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` 읽기. `NotifyLevel`→emoji(ℹ/⚠/🚨) Markdown. 10초 타임아웃 — 실패는 warn 로그만, 로그인 latency 차단 없음.

### 20. Hub Adapter (`infra/src/adapters/hub.rs`)
- `IHubPort` 구현 (`SqliteHubAdapter`, rusqlite + uuid) — Hub(외부 위젯·방문자) 인스턴스 / 대화 / 메시지 CRUD.
- 대화 메시지 soft-delete(`deleted_at`, 30일 retention cron) + 인스턴스 삭제 시 conversations/messages FK순 cascade hard-delete. `allowed_references`/`allowed_sysmods`/`allowed_domains` 는 `Vec<String>` ↔ TEXT(JSON) 직렬화.

---

## 제2-A장: DB 스키마 관리 — inline CREATE / ALTER (migration runner 없음)

별도 migration runner / `_db_version` 버전 추적 / `infra/database/migrations/*.sql` 파일은 **존재하지 않는다** (옛 TS 설계로, Rust cutover 시 inline 방식으로 통합). 각 어댑터의 `initialize()` 가 부팅마다 idempotent 하게 스키마를 보장한다.

| 영역 | 위치 | 방식 |
|---|---|---|
| app.db (pages / conversations / conversation_messages / verifications / page_redirects / media_usage / shared_conversations / llm_costs 등) | `infra/src/adapters/database.rs::initialize()` | `CREATE TABLE IF NOT EXISTS` (전 컬럼·인덱스 포함) |
| 메모리 — entities / entity_facts / events / event_entities (m2m) + 인덱스 | `infra/src/adapters/memory.rs::initialize()` | `CREATE TABLE IF NOT EXISTS` |
| 라이브러리 — library_references / library_sources / library_chunks + FTS5 | `infra/src/adapters/memory.rs::initialize()` | `CREATE TABLE IF NOT EXISTS` + `CREATE VIRTUAL TABLE` |
| Hub — hub_instances (위젯 메타) | `infra/src/adapters/hub.rs` | `CREATE TABLE IF NOT EXISTS` |

> **대화 영속 = app.db 단일 store** (2026-06): admin·hub 모두 `conversations`(메타) + `conversation_messages`(행, canonical split/join)로 수렴. owner 컬럼(`admin` / `hub:<inst>:<sid>`)으로 구분, `ConversationManager` 단일 매니저(owner-param). 옛 hub_conversations/hub_messages(memory.db)는 폐기(orphan — 안 읽음·안 씀, 테이블 drop 은 live 마이그 위험이라 미실행). hub_instances 만 memory.db 유지.

새 컬럼·인덱스 추가 절차:
1. **테스트 서버 단계(현재)**: 새 컬럼·인덱스는 어댑터 `initialize()` 의 `CREATE TABLE` 정의에 직접 추가 — DB 리셋으로 fresh schema 가 적용되므로 ALTER 마이그 불필요. 옛 데이터용 1회성 마이그/백필 코드 = throwaway, 작성 금지(forward 로직만 유지).
2. **production live-DB(리셋 불가) 단계**: 기존 DB 보존하며 컬럼 추가 시 `ALTER TABLE ... ADD COLUMN`(에러 무시) + 인덱스는 **반드시 ALTER 뒤에** `CREATE INDEX IF NOT EXISTS` (순서 주의 — 컬럼 부재 시 schema init 전체 crash. 과거 dedup 인덱스 순서로 서버 crash-loop 사고).

---

## 제3장: 부트스트랩

### 제1항. 어댑터 조립 (`infra/src/main.rs`)
`firebat-core` binary 가 시작 시 20개 운영 어댑터를 1회 wiring 하여 매니저·gRPC 서비스에 주입한다.
LLM 어댑터는 resolver 클로저를 받아 lazy 초기화 (API 키 미설정 상태에서도 부팅 가능).
Memory 어댑터(`SqliteMemoryAdapter`)는 SQLite 핸들 + Embedder 받아 같은 DB 위에 entity/episodic 테이블 생성.

### 제2항. 서버 초기화 (frontend)
- `instrumentation.ts`: `NEXT_RUNTIME === 'nodejs'` 조건 하에 `instrumentation.node.ts` 동적 import.
- `instrumentation.node.ts`: **SIGTERM / SIGINT graceful shutdown 만** 담당 (Cost flush + Rust core 작업 완료 대기, systemd `TimeoutStopSec=30s` 호환). 옛 `setupSystemDependencies` (Python/playwright 자동 install) 는 2026-05-17 폐기 — Rust core 의 silent install path 폐기(commit `897a08c`)와 일관, 패키지 누락 시 envelope `errorKey` 반환 + 설정 화면 [설치] 버튼 명시 trigger.

### 제3항. 설정 상수 (Rust 각 어댑터 const / env / Vault)
옛 `infra/config.ts` 단일 상수 파일은 폐기. 현행:

| 상수 | 기본값 | 설명 |
|---|---|---|
| `FIREBAT_DATA_DIR` | `data` | 데이터 저장 경로 (env) |
| (app.db) | `data/app.db` | SQLite DB 경로 (`SqliteDatabaseAdapter` const) |
| `FIREBAT_DEFAULT_MODEL` | `""` (빈 문자열 — main.rs `unwrap_or_default()`) | 기본 LLM 모델 (env, 미설정 시 빈 값) |
| `LLM_TIMEOUT_MS` | `60000` | LLM 타임아웃 (어댑터 const) |
| `SANDBOX_TIMEOUT_MS` | `30000` | 샌드박스 타임아웃 (어댑터 const) |
| `CRON_DEFAULT_TIMEZONE` | `Asia/Seoul` | 기본 타임존 (Vault `system:timezone` override) |
| `BASE_URL` | `http://localhost:3000` | SEO/OG 외부 노출 도메인. frontend `NEXT_PUBLIC_BASE_URL` env 또는 `lib/base-url.ts` `getBaseUrl(req)` 로 요청 host 자동 감지 |

---

## 제4장: Primary Adapter 규약 (app/api/)

1. **직접 I/O 금지**: `app/api/`에서 `fs`, `child_process`, `fetch`, LLM SDK를 직접 호출하지 않는다.
2. **Core Singleton 경유**: `getCore()`를 통해 싱글톤 Core를 획득하고, Core 메서드를 호출한다.
3. **예외**: 인증(`/api/auth`)은 부트스트랩 영역으로 Core 경유 대상에서 제외.
4. **인증 자격증명**: 첫 부팅 시 SetupWizard (`/api/auth/setup`) 가 admin id/password 입력 → Vault 저장. 이후 변경은 `/admin` 설정 모달 경유.

---

## 제5장: 마이그레이션 로드맵 — v1.0 Final (2026-05-03 확정)

옛 v2.0 의 "infra → system/modules 동적 로드" 노선 폐기. 단일 v1.0 Final milestone 으로 통합 — Rust Core 의 단일 binary 안에 20개 운영 어댑터 정적 컴파일.

### v1.0 Final 의 인프라 변환

| 옛 위치 (TS) | 새 위치 (Rust) | 핵심 crate |
|---|---|---|
| `infra/storage/index.ts` | `infra/src/adapters/storage.rs` | `tokio::fs` + path containment |
| `infra/storage/vault-adapter.ts` | `infra/src/adapters/vault.rs` | `rusqlite` (격리 DB) |
| `infra/database/index.ts` | `infra/src/adapters/database.rs` | `rusqlite` (WAL + 트랜잭션) |
| `infra/cron/index.ts` | `infra/src/adapters/cron.rs` | `cron` crate + `tokio::time` |
| `infra/sandbox/index.ts` | `infra/src/adapters/sandbox.rs` | `tokio::process::Command` (sysmod 코드 0 변경) |
| `infra/llm/*` | `infra/src/llm/*` | `reqwest` (API 5종) + `tokio::process` (CLI 3종) |
| `infra/image/*` | `infra/src/image_gen/*` + `infra/src/adapters/image_processor/*` | `image-rs` / `fast_image_resize` / blurhash |
| `infra/mcp-client/index.ts` | `infra/src/adapters/mcp_client.rs` | reqwest + tokio (직접 구현) |
| `infra/auth/index.ts` | `infra/src/adapters/auth.rs` | rusqlite + 세션·API 토큰 통합 |
| `infra/embedder/*` | `infra/src/adapters/embedder/*` | candle + hf-hub + tokenizers (로컬 추론) |
| `infra/log/index.ts` | `infra/src/adapters/tracing_log.rs` + `log_buffer.rs` | `tracing` + sqlite ring buffer |
| `infra/network/index.ts` | `infra/src/adapters/network.rs` | reqwest |

### 변환 핵심 룰 (CLAUDE.md 와 동일)

매 어댑터 변환 시 **1:1 매핑 X**, hardcoding audit 후 일반 로직으로 정리:
- Defensive regex / 도구명 enum / magic number / 개별 sanitize / 모델별 분기 / timezone hardcode / error message 매칭 7가지 패턴
- 옛 TS 의 1년+ polished fix 들의 root cause 식별 → Rust 에서 일반 로직으로 작성

### 어댑터 언어 정책 (영구 룰, 2026-05-03 확정)

BIBLE 제2장 "언어 중립성" 의 Core 어댑터 layer 적용. 영구 진화 가능 backbone.

**룰 1. Rust 무조건 장점 → Rust 강제** (비용 고려 X)

| 영역 | Rust 강점 |
|---|---|
| Database / Vault | 메모리 안전 (시크릿 leak 방지) + μs hot path |
| Auth (세션·토큰) | 보안 영역 메모리 안전 강제 |
| Cron / Schedule | 정밀 ms timing + 영구 실행 안정 |
| Sandbox sysmod spawn | child process lifecycle / signal 정확함 |
| Network / Log | 단일 binary 동시성 안전 |
| MCP server / client | stdio + HTTP protocol 정밀 |
| LLM API / CLI streaming | reqwest 메모리 효율 + stdio chunk 정밀 |
| ToolRouter / Embedder API | hot dispatch 빈도 |

**룰 2. Trade-off → 좋은 라이브러리 활용** (언어 중립)

시점별 best 라이브러리 선택. Rust ecosystem 성숙 시 어댑터 단위로 swap.

| 영역 | 시작 시점 (2026-05) | 진화 trigger |
|---|---|---|
| **Image 처리** (resize / format / blurhash / focus crop) | **image-rs 계열 정착** (`image` + `fast_image_resize` + `blurhash`, 순수 Rust) — 옛 sharp Node bridge 폐기 완료 | attention/entropy crop 정밀도 필요 시 추가 crate 평가 |
| **로컬 임베딩** (BGE-M3 등, 사용 시점에) | onnxruntime-node 또는 ort 평가 후 결정 | 둘 다 충분 — 검증된 동작 우선 |
| **Playwright (browser-scrape)** | **Node spawn 자연** (Rust 등가 0) | fantoccini / headless_chrome 가 playwright 등가 도달 시 |
| **Token 카운팅** | tiktoken-rs (Rust) 또는 tiktoken (Node) | 어느 쪽이든 OK |
| **HTML sanitize** | ammonia (Rust) 또는 isomorphic-dompurify (Node) | 어느 쪽이든 OK |

**룰 3. Hexagonal 보장**

- 어댑터 안 라이브러리 / 언어 변경이 매니저 영향 0
- port interface 안정성 = 영구 진화 가능
- swap 시 dual-run (예: Image 어댑터 swap 시 같은 input 의 픽셀 diff) 검증 후 cutover
- 회귀 위험 어댑터 단위 격리 — 한 어댑터 swap 이 다른 어댑터 영향 0

### 단일 build target

```toml
# infra/Cargo.toml
[[bin]]
name = "firebat-core"
path = "src/main.rs"   # gRPC server + MCP HTTP + stdio MCP — 단일 binary
```

### Sandbox 의 sysmod 호환

Rust Sandbox adapter 가 Node / Python sysmod 을 spawn — sysmod 코드 0 변경:
```rust
tokio::process::Command::new("node").arg(module_entry).spawn()
tokio::process::Command::new("python3").arg(module_entry).spawn()
```

Vultr 호스트에 Node / Python runtime + LLM CLI (Claude Code / Codex / Gemini CLI) 직접 설치.

**Sandbox 운영 결정**: `FIREBAT_SANDBOX=basic` (BasicProcessSandbox) 사용. `tokio::process::Command` + path containment + timeout. stdout/stderr 는 `child.wait()` 와 **동시 드레인**(`tokio::join!`) — 출력이 OS 파이프 버퍼(~64KB)를 넘는 sysmod(거대 firecrawl·law-search·증권 대량)가 자식 write 막혀 무한 hang 되던 deadlock 차단(`7609eb4`). `LinuxCgroupsSandboxAdapter` (cgroups + seccomp + namespace) 는 코드 잔존하지만 sysmod libuv / encodings / CLONE_NEWNET 차단 이슈로 미사용. 향후 multi-tenant / 외부 사용자 격리 필요 시점에 seccomp allow list 확장 + 재활성 검토.

### v1.0 Final 출시 후 (v2.0+)

운영 데이터 위에서 진짜 한계 마찰 도달 시만:
- 시스템 모듈 동적 로드 (`system/modules/` 로 일부 어댑터 이전 — 사용자가 어댑터 갈아끼기)
- 새 인프라 (Webhook / Memory / Metrics — Notification 은 sysmod_telegram 으로 대체됨)
