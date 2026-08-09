---
name: pipeline
kind: procedure
description: 파이프라인 스텝 작성 매뉴얼 — 태그: pipeline, steps, EXECUTE, TOOL_CALL, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM, CONDITION, SAVE_PAGE, FOREACH, $prev, $stepN, inputData, inputMap. schedule_task 나 run_task 의 pipeline 을 작성하기 전에 읽을 것. 쓰지 말 것 — 등록 모드·옵션 선택(scheduling 스킬), 단일 도구 호출(그냥 호출).
---

# Pipeline — writing the steps

Only 8 step types: `EXECUTE`, `MCP_CALL`, `NETWORK_REQUEST`, `LLM_TRANSFORM`, `CONDITION`,
`SAVE_PAGE`, `TOOL_CALL`, `FOREACH`.

## Calling a module

Use `TOOL_CALL` (`tool: "sysmod_<name>"`). `EXECUTE` takes a file path and runs it straight in the
sandbox, **skipping input validation, account resolution and `<param>CacheKey` expansion** — so it
is the wrong choice for a module call unless you specifically want the raw path. `EXECUTE`'s module
arguments go inside `inputData`, never flattened onto the step.

## Repeating a variable number of times

`FOREACH {items, steps}` repeats its steps once per item of a list an earlier step returned — that
is how a pipeline does something a variable number of times (one order per row, one message per
recipient). Inside it, `$prev` is the current item at the first inner step, and `$stepN` still
addresses the steps before the loop. Combine them:
`inputData: "$prev.args"` + `inputMap: {"barsCacheKey": "$step0._cacheKey"}`.

## Referencing earlier results

`$prev` / dot+index paths (`$step3.items[-1].id`). **`$stepN` counts from zero** — `$step0` is the
first step, while the run log numbers them from 1.

## Limits worth knowing before you write

- `LLM_TRANSFORM` is a text transform only — tools never run inside it.
- A `SAVE_PAGE` `spec` cannot contain `$prev`/`$stepN`: they are not resolved there and the step
  fails fast. A page that must refresh its data takes a `module` block plus a `rebake:<slug>`
  schedule instead.
