---
name: pipeline-authoring
kind: procedure
description: 파이프라인 스텝 작성 매뉴얼 — 태그: 파이프라인, 스텝, EXECUTE, MCP_CALL, LLM_TRANSFORM, CONDITION, SAVE_PAGE, TOOL_CALL, $prev, inputData. 스텝을 쓰기 전 반드시 get_skill 로 본문을 읽을 것 (봉투·분할 절대 규칙 있음).
---

# Pipeline — step authoring manual (run_task / schedule_task pipeline)

Only 7 step types allowed: EXECUTE, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM, CONDITION, SAVE_PAGE, TOOL_CALL.

## Step type selection guide
- **EXECUTE** — sandbox module execution. `path` is `system/modules/X/index.mjs` or `user/modules/X/index.mjs`.
- **TOOL_CALL** — direct Function Calling tool invocation. `tool` is the tool name. **Non-module tools** like image_gen / search_history / search_media / render_*.
- **MCP_CALL** — external MCP server tool.
- **NETWORK_REQUEST** — arbitrary HTTP request.
- **LLM_TRANSFORM** — text transformation only (askText). Tool calls not allowed.
- **CONDITION** — conditional branching (a normal stop on false).
- **SAVE_PAGE** — cron auto page publication (bypasses user approval).

## SAVE_PAGE absolute rule — no $prev inside spec
`$prev`/`$stepN` are **NOT resolved inside a SAVE_PAGE spec** — the step fails fast if any remain
(they would otherwise be published as literal strings; large arrays are also auto-cache-truncated,
so piping data into a spec cannot work). **A page that must refresh its data is NOT a pipeline job**:
put a `module` block (`{type:"module", props:{module, args?, when:"publish"}}`, pageBinding-declared
modules only) in the page spec at save_page time, then schedule `targetPath: "rebake:<slug>"` —
zero LLM, no steps to author. SAVE_PAGE in a pipeline is only for specs whose content the earlier
steps do NOT need to fill.

## LLM_TRANSFORM absolute rule — tool calls not allowed
LLM_TRANSFORM is **text transformation only** (askText only). Even if you write a tool workflow in natural language in the instruction, tools will never run.

## EXECUTE argument rule (absolute)
Module execution parameters (action / symbol / text etc.) must go **inside the inputData object**. Do not flatten them onto the step.

Wrong:
```
{"type":"EXECUTE", "path":"system/modules/kiwoom/index.mjs", "action":"ka10001", "stk_cd":"005930"}
```

Right:
```
{"type":"EXECUTE", "path":"system/modules/kiwoom/index.mjs", "inputData":{"action":"ka10001","params":{"stk_cd":"005930"}}}
```

## References & wiring
- Reference previous step results via $prev / $prev.attr / inputMap.
- **path notation**: dot notation + array index supported. Examples: `$prev.output[0].opnd_yn`, `$step3.items[-1].id`.
- **$prev is the previous step's output itself** (envelopes auto-unwrap) — do not invent wrapper fields like `.output[0].data.result[0]` that the actual shape doesn't have; if you already know a value, write it as a literal.
- System modules use EXECUTE(path="system/modules/{name}/index.mjs") — not MCP_CALL.
- When showing results to the user, end with LLM_TRANSFORM.

## Multi-target handling (absolute rule)
If there are N targets, **split into N EXECUTE steps**. Do not bundle into one call.
