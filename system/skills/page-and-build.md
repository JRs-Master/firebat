---
name: page-and-build
kind: procedure
description: 페이지 발행·앱 빌드 매뉴얼 — 태그: save_page, 페이지 만들어줘, 리포트, 대시보드, start_build, advance_build, cancel_build, 앱·게임·계산기 제작, 기존 페이지 수정, 3단계 공동설계. 페이지를 발행하거나 인터랙티브 산출물을 만들기 시작하기 전에 읽을 것. 쓰지 말 것 — 채팅 안 시각화(firebat-render 펜스면 충분), 반복 형식 발행(templates 스킬), HTML 품질 기준(html-app-quality 스킬).
---

# Pages and builds — which one, and how far

## First: does this even want a page?

Call `save_page` **only when the user explicitly asks for a page / report / document / dashboard**
("make a page", "save as a page", "build a report"). For plain questions / lookups / analysis /
outlook, answer **inside the chat** with render components and do NOT call save_page.

- "tell me the outlook for X" → render chart/analysis in chat, no page.
- "make a page for X's outlook" → save_page.

If a chat answer needs visuals, use components only; whether to persist as a page follows the
user's intent.

## Then: content page, or interactive artifact?

### Branch A — content pages: proceed immediately

Pages that are **data organization / visualization** — analysis, outlook, report, summary,
schedule digest, news, dashboard. These do NOT go through staged co-design:

- collect the data (whichever tools cover it),
- finish with render components + `save_page`,
- do not add a design stage or any other extra stage.

### Branch B — interactive apps / games / tools: 3-stage co-design

Only pages **operated by user input / clicks** (games, calculators, forms/wizards, tools):
**Stage 1 feature selection → Stage 2 design style → Stage 3 implementation**.

**Implementation quality bar (required)**: before writing/saving the HTML, call
`get_skill("html-app-quality")` and satisfy every item (form accessibility, responsive/canvas fit,
`100dvh` viewport layout, multi-panel sizing, delta-time animation). This applies to the build flow
AND to any interactive HTML page saved directly without a build session.

## The build session (`start_build`)

A request to **actually build** an app / tool / dashboard / game / calculator the user can use →
start with `start_build`, regardless of plan mode. Don't finish in one reply — go step by step.

- **Decision rule**: a build is only for a **persistent interactive artifact** the user will open
  and operate. Interaction / multiple screens / repeated use *of such an artifact* → build. A
  single informational page or table → just `save_page`.
- **NOT a build**: fetching data, showing charts/tables in chat, subscribing to a stream, or
  scheduling a recurring message — even combined in one request. Those are direct tool calls;
  never route them through `start_build`. "Data integration" or "repeated use" alone does not make
  a build.
- **Gauge real intent, not keywords.** A feasibility question ("is this possible?", "so I *could*
  make X") is a question to **answer** — reply, then *offer* to build. When in doubt, offer instead
  of starting.
- `start_build(request)` → returns a build session + the step-1 (requirements) instruction
  (`stepPrompt`). Follow it.
- **Modifying an EXISTING published page/app** → `start_build(request, targetSlug=<that page's
  slug>)`. The flow becomes change-scope → apply (2 steps): load the existing spec with `get_page`,
  change ONLY what was selected, `save_page` with the same slug. Never rebuild from blank for a
  modify request.
- On each step completion, call `advance_build(sessionId, output, tier?)` → next step instruction
  (classify tier=T1/T2/T3 in S1). The engine enforces order — don't skip steps.
- If the user declines, redirects, or says "not now" / "I was just asking", call
  `cancel_build(sessionId)`. A lingering session keeps re-presenting the build card on later turns.

## Continuing a plan

When the system prompt carries an "In-progress plan" section you are continuing a previous turn's
plan: enforce stage order 1 → 2 → 3, no skipping. After the last stage, report the result with
visualization components and finish — there is no separate completion tool call.
