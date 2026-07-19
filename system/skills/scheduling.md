---
name: scheduling
kind: procedure
description: 스케줄(cron) 등록 매뉴얼 — 태그: 예약, 스케줄, 반복 실행, cron, 매일, 알림 주기, executionMode, runWhen, retry, notify. 등록 전 반드시 get_skill 로 본문을 읽을 것 (모드 선택·표준 옵션에 함정 다수).
---

# Scheduling — job registration manual (schedule_task)

## Execution mode selection (executionMode) — decide at registration

The axis is **fixed vs adaptive**, not simple vs complex. Prefer `pipeline` whenever the procedure is fixed.

- **Fixed** → **`pipeline`** (step array in `pipeline`). Every trigger runs the *same procedure*: collect the same sources → process/format the same way → output. Use it **even when the task is elaborate**. Cost: **zero LLM** for pure data→output (`EXECUTE`/`MCP_CALL`/`NETWORK_REQUEST`/`CONDITION`/`SAVE_PAGE`), or **one LLM call** when prose synthesis is needed — add a single **`LLM_TRANSFORM`** step (its `instruction` + prior steps' data pulled in via `inputMap`). Anything expressible as a threshold/rule belongs in a `CONDITION` step.
- **Adaptive** → **`agent`** (natural-language `agentPrompt`). Reserve for triggers that need *runtime judgment*: deciding which tools to call based on what the data shows, branching on findings, open-ended investigation that can't be fixed in advance.
- **Page data refresh** → **`targetPath: "rebake:<slug>"`** (no pipeline, no agentPrompt). When a saved page's spec contains `module` blocks (pageBinding), this re-runs ONLY those bindings and re-saves the page — the cheapest periodic-page job (zero LLM, no steps to author). Prefer this over a pipeline that re-publishes the whole spec.
- **Session-window anchor ping** (subscription CLI models): the provider's 5-hour usage window opens at the FIRST call — a scheduled minimal ping anchors the window so the reset lands just before a protected job or usage peak. Recipe = a `pipeline` job with ONE lean step: `{"type":"LLM_TRANSFORM","instruction":"Reply with exactly: pong"}` (LLM_TRANSFORM = bare text call, no tools/system prompt = minimal quota). Schedule it ≈5h before the protected time plus a small margin (e.g. `cronTime: "55 16 * * *"` → window resets ≈21:55, fresh for a 22:00 job). Never use `executionMode: "agent"` for pings — the full agent prompt wastes the very quota being protected.
- **Multiple times of day = ONE job, not N jobs**: same minute → cron field list (`0 8,20 * * *` = 08:00 & 20:00); different minutes → join full expressions with `|` (`0 2 * * * | 55 16 * * *` = 02:00 & 16:55). Only split into separate jobs when the *work* differs, never just the time.

**Why prefer pipeline**: `agent` re-runs the whole LLM loop on every trigger (multiple calls, non-deterministic, costly); a fixed pipeline does the deterministic work with 0 LLM and at most one synthesis call. A task that *produces a report/summary on a fixed schedule from fixed sources* is **fixed → pipeline + one `LLM_TRANSFORM`**, not agent. Choose `agent` only when runtime adaptation is genuinely required.

**`LLM_TRANSFORM` has no auto-context** — it is a lean text transform; it does NOT inherit memory, skills, the system prompt, or retrieval the way a chat turn does. So bake any required output format / structure / style **explicitly into its `instruction`** at registration time.

## Cron standard mechanisms — use infra options instead of AI-judgment workarounds

**For holiday / guard-like cases, instead of enumerating holidays**, generalize with `runWhen`:

```
schedule_task({
  cronTime: "0 9 * * *",
  runWhen: { check: { sysmod: "<module>", action: "<action>", inputData: { ... } }, field: "$prev.output[0].<field>", op: "==", value: "<expected>" },
  ...
})
```
The `sysmod` field in `runWhen` is the module name — use whichever sysmod + action returns the condition you need to check. If runWhen is unsatisfied, the trigger itself is skipped (not a failure). No hardcoding of holiday arrays.

**Transient failures (network timeout / rate limit / 503)** are auto-recovered by `retry`:
```
retry: { count: 3, delayMs: 30000 }   // up to 3 times, 30s interval
```
Retry only idempotent tools — side-effecting tools like buy orders must not retry.

**Result notification** is separated by `notify` (do not place a notify step inside the pipeline steps):
```
notify: {
  onSuccess: { sysmod: "telegram", template: "Done: {title} ({durationMs}ms)" },
  onError:   { sysmod: "telegram", template: "Failed: {title} — {error}" }
}
```

**Agent-mode discipline (unattended runs)**: a side-effecting action (send / order / publish) runs **once, last, after verification** — never re-send an "improved version" after a success.

For pipeline step authoring details (step types, the EXECUTE inputData envelope, $prev references), read `get_skill("pipeline-authoring")`.
