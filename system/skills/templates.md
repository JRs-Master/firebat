---
name: templates
kind: procedure
description: 템플릿 매뉴얼 — 태그: 템플릿, 저장된 형식, 같은 형식으로 발행, 일간 리포트, 시황 브리프, list_templates, get_template, save_template, _fill, 날짜 플레이스홀더. 사용자가 "○○ 템플릿으로" 또는 "늘 이 형식으로" 라고 할 때, 같은 형식을 반복 발행할 때, 템플릿을 새로 만들 때 읽을 것. 쓰지 말 것 — 일회성 페이지 발행(save_page 직접), 컴포넌트 프롭(get_component_schema).
---

# Templates — a saved block layout, reusable on two surfaces

A template is a saved **block layout** — the same component array a page body and a chat
`firebat-render` fence use. So it serves two surfaces:

- **published page** — use the resulting `spec.body` as the `save_page` body.
- **chat answer** — when the user wants a reply in a fixed shape ("answer with the ○○ template",
  "always report stocks in this format"), fetch it and **render the filled blocks as a
  `firebat-render` fence in your reply**. Nothing is published; the reply just takes that shape.
  (`spec.head` is page metadata — ignore it on the chat surface.)

  On the **page** surface `spec.head` is worth keeping: it carries the page's declaration, not just
  its SEO. A template whose head sets `kind`, `layout`, `contentMaxWidth` or an app's `needs` moves
  the shell along with the body, so "publish it in the ○○ format" means the same chrome and the same
  capabilities every time — not the same blocks in a different frame. Placeholders are substituted
  in `head` too, so a title can carry `{date}`.

For pages published repeatedly in the same format (daily reports, market briefs, etc.), use
templates.

## Using one

- **`list_templates`** — call first to check if a matching template exists (judge by
  slug·name·description).
- **`get_template(slug)`** — fetch the template spec. Placeholders
  `{date}`/`{time}`/`{datetime}`/`{year}`/`{month}`/`{day}` are **returned already substituted with
  current values**.
  - **Follow the template structure faithfully** — keep its blocks, their order, and layout
    exactly. Do NOT improvise a different structure or drop/add sections; only fill content into
    the given blocks. (A "comprehensive analysis" template applied to a single subject still
    produces every section the template defines, scoped to that one subject.)
  - **`_fill` hints** — a block's props may carry a `_fill` field = a per-section instruction (what
    data to collect, how to write that block). When present: collect that data via the right tools,
    write the result into the block's real prop (content/data/etc.), then **remove the `_fill` field
    before save_page** (it is an instruction, never published or displayed). A block with neither
    `_fill` nor a placeholder is static — keep it verbatim.
  - Use the resulting `spec.body` as the `save_page` body — or, on the chat surface, as the blocks
    of your reply's render fence.

## Creating one

- **`save_template(slug, config)`** — create when the user asks "make a ○○ template".
  config = `{name, description, tags, spec:{head, body}}`. `spec.body` is the same component array
  as save_page.
  - Time-varying values (dates) → `{date}`/`{time}` placeholders (substituted at publish time).
  - Content that must be **freshly collected/written each publish** (figures, prices, analysis) →
    leave the prop empty and add a `_fill` instruction on that block, e.g.
    `{"type":"text","props":{"content":"","_fill":"Gather the latest figures for this section via
    the right tool and write a short summary"}}`. This makes every publish gather fresh data
    instead of reusing baked-in text.

## Placeholder formats

Shorthand `{date}`(YYYY-MM-DD)·`{time}`·`{year}`·`{month}`·`{day}`, plus the free format
`{date:FORMAT}` (tokens YYYY·YY·MM·M·DD·D·HH·mm). e.g. `{date:YYYY년 M월 D일}` → `2026년 6월 7일`,
`{date:M/D}` → `6/7`.

If no matching template exists, just create the page directly with `save_page`.
