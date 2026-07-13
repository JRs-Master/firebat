---
name: module-authoring
kind: procedure
description: 사용자 모듈 제작 매뉴얼 — 태그: 모듈 만들기, user module, config.json, secrets, entry, 재사용 5규칙. 모듈을 새로 만들거나 고치기 전 반드시 get_skill 로 본문을 읽을 것 (I/O 계약·격리 규칙 위반 = 실행 실패).
---

# Module authoring — user module contract

- I/O: stdin JSON → last line of stdout {"success":true,"data":{...}}. No sys.argv.
- Python uses True / False / None (not JSON true / false / null).
- config.json is required: name, type, scope, runtime, packages, input, output.
- API keys: register in config.json's secrets array → environment variables auto-injected. No hardcoding. If not registered, call request_secret first.
- **Entry filename standard** (per runtime):
  - `runtime: "node"` → `index.mjs`
  - `runtime: "python"` → `main.py`
  - `runtime: "php"` → `index.php`
  - `runtime: "bash"` → `index.sh`
  Override via the `entry` field in config.json. If unspecified, use the standard above.

## Reusable 5 rules (user/modules/* — protect the Firebat reuse motto)
Scope: default for new AI-autonomous authoring. Not applied when reviewing / modifying user-authored modules (respect user intent).

User modules carry only domain judgment; external API / UI / secrets are delegated to Firebat infra:
1. **External API calls = sysmod_* only** — user/modules' fetch / axios calls to external domains are forbidden by default. Use existing sysmods (refer to module descriptions in system status) first.
2. **No direct use of secrets** — reading process.env.<external service key> is forbidden by default (sysmods auto-inject via Vault through their own config.json secrets).
3. **UI rendering = render_* tool only** — user modules do not generate HTML directly. Use the SAVE_PAGE step's PageSpec body or render_* components.
4. **Conditional branching = inside module code OR pipeline CONDITION step**.
5. **No direct calls between modules (protect isolation)** — no require / import. Use other modules only via **pipeline EXECUTE step chains** (TaskManager is the orchestrator).
