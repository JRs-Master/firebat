---
name: tool-discovery
kind: procedure
description: 도구·액션 발견 절차 매뉴얼 — 태그: search_module_actions, get_action_schema, 파라미터 추측 금지, 검색이 안 잡힐 때, 실시간 구독(stream), 페이지네이션 커서, 되묻기(suggest) 기준. 검색을 반복했는데 원하는 액션이 안 나올 때 · 검증 실패가 반복될 때 · 사용자에게 물어볼지 판단할 때 읽을 것. 쓰지 말 것 — 컴포넌트 찾기(search_components/get_component_schema), 스케줄 등록(scheduling 스킬).
---

# Tool discovery — the ladder, and what goes wrong on it

The resident prompt carries the rules in one line each. This is the same material with the
reasoning and the measured failure behind each rule — read it when a search is not returning what
you expect, when validation keeps failing, or when you are deciding whether to ask the user.

## The ladder is uniform

**Every sysmod tool: pick by tags, then discover — never guess params.** A sysmod tool's
description shows only WHAT the module is (+ selection tags); its parameters are deliberately NOT
listed. To use ANY module, follow the same 4 steps regardless of module size: (1) pick the module
from its description/tags → (2) `search_module_actions(query)` — describe what you need in natural
language — to find the action → (3) `get_action_schema(module, action)` for the exact params +
call envelope → (4) call the tool with those params. This one procedure is uniform: a small
5-action module and a 278-action module are used exactly the same way. A validation error means a
param was wrong or missing — go back to `get_action_schema`, not trial-and-error.

**Batch when independent**: one `search_module_actions` is cross-module, so gather several needs
at once, then issue multiple `get_action_schema` / calls in a single turn (in parallel) rather
than one round each.

**Exception — single-purpose resolver tools**: when a tool's own description states its exact
usage (a one-arg utility, e.g. "call with {\"query\": ...}"), call it directly with that arg — the
discovery ladder is for multi-action modules, and searching for such a tool wastes the discovery
budget.

**Call envelope.** Send the discovered params at the TOP level of the call (plus `action` when the
module uses one). Do not invent a wrapper: a `params` / `args` / `input` object is not part of the
contract unless `get_action_schema` shows it, and wrapping a flat schema hides your arguments from
validation and from cache-key expansion.

## When the search does not return what you want

**A modifier is a parameter, not an action — stop searching for it.** Qualifiers such as a
market/exchange, a period, a unit, or a sort order are usually *parameters* of an action, so
`search_module_actions` will never return a result named after them. Repeating the search with the
qualifier in the query finds nothing because nothing of that name exists. Read the module's
description/tags for its vocabulary, pick the action for the underlying *thing* you want, then set
the qualifier through the params from `get_action_schema`. If a term in the request is unfamiliar,
it is far more likely a qualifier of that module's domain than an entity you should go hunting for
elsewhere.

**A subject's name is a parameter too — never put it in an action-search query.** Actions are
*capabilities* (daily chart, order book, weather forecast); a company/stock/region/person named in
the request is the *subject* those capabilities operate on. Searching the action catalog for
"<subject name> chart" just re-ranks the same capability rows and wastes the search budget — query
with the capability only. To turn a subject's name into its opaque identifier (stock code, region
code), call a lookup/list action of the relevant module family — that is a *data* call, not an
action search. And a capability that no module provides (e.g. predicting a future price) will
never appear no matter how the query is rephrased: if one search returns nothing that matches, the
capability does not exist — compose the answer from the data actions that DO exist instead of
searching again.

## Realtime is a different shape

**Live/realtime data is a subscription, not a query.** A REST action can only return a snapshot of
the past; it can never produce live data, no matter how short its interval. When the user asks for
something live/realtime/streaming, look for a `kind: "stream"` row in `search_module_actions`
results: subscribe with `stream_watch_start({module, stream, args})`, then render the returned
topic with a live component (`live_chart` line / `live_stock_chart` candles / `live_feed` events).
Live components also work on PUBLISHED pages: put the block (with its topic) in the page spec —
the published page streams that topic through a topic-scoped public relay (no admin endpoint
involved). Never relabel a snapshot as "realtime" — if no stream exists for what was asked, say so
plainly instead of substituting a static chart. Stop a subscription with `stream_watch_stop`.

## Arguments that look harmless and are not

**Pagination cursors: omit on the first call.** Optional params like `until` / `before` / `cursor`
/ `next_key` exist only to fetch the NEXT page — leave them out on the first call (the API starts
from the latest) and fill them only from the previous response's cursor field (`nextUntil` /
`nextBefore` / `nextCursor`). Never invent a date or cursor value yourself: your training-era sense
of "today" is stale — the actual current date is in System status, and fabricating an `until` date
silently shifts the whole result window into the past.

**Label data by what the tool resolved, not by what the user said.** When presenting data about a
looked-up subject (a chart, table, metric), put the canonical name/identifier **returned by the
tool** in the title and labels (e.g. the instrument's full name + code + market from the
response), never just echo the user's phrasing. If your lookup resolved the wrong subject, an
honest label lets the user catch it instantly; echoing their words back hides the misresolution
behind a confident-looking answer. **And keep internal plumbing out of labels**: a title/label
carries the subject and what the data is (name, code, market, period, unit) — never the
module/broker that served it or internal codes (a chart titled "… (kiwoom)" or a feed labeled
"(kiwoom 0B)" is noise; the UI already shows tool badges for provenance).

## Whether to ask the user

**Ambiguous opaque identifier → ask, don't pick.** When a name could map to several records and
you need an opaque identifier (a stock code, region code, corp id, etc.), do not choose one
yourself — present the candidates via suggest and let the user decide. When the match is
unambiguous, resolve it silently and proceed.

**Ambiguous request → clarify once, don't guess.** When the request itself is ambiguous enough
that the answer genuinely forks (unclear subject, scope, or target), ask once via suggest instead
of running with a guess. But when the intent is clear enough to act, act — do not re-ask what is
already answerable from context, and never stack clarifying questions across consecutive turns.

**Interpreted parameter on a side-effect action → confirm the reading.** This applies doubly to
actions that execute, register, or delete rather than just answer: if a concrete parameter you are
about to commit (a datetime, a target, a quantity) was filled by *interpreting* an expression that
maps to more than one plausible value, present the readings via suggest once instead of silently
picking one. A wrong guess there executes — it doesn't just misanswer.

**Ask only for user-owned choices — never for discoverable values.** A required parameter whose
value can be obtained with a tool (an account list, a lookup, a search) or that already appeared
earlier in this conversation (e.g. in a previous tool result) is NOT a question for the user —
fetch or reuse it and proceed. Asking the user for a value the system can look up stalls the task
and reads as incompetence.

**When you do ask, ask through suggest — never a bare text question.** Candidates known → string
chips (one per option). Free-form value → an input-type suggest item with a clear placeholder. A
plain-text question with no suggest gives the user nothing to tap and usually means a lookup was
skipped.

**Asking ends the turn.** If you emit suggest to ask the user something, stop there: end the turn
with at most one short sentence and wait for the answer. Emitting suggest and then continuing to
call tools answers your own question — the chips become dead UI and the user never got to choose.
