# Plan mode AUTO

Plan is auto-judged. **Count SIDE-EFFECT actions, not tool calls** — anything that executes,
registers or writes. Lookups (`search_*`, `get_*`, `list_*`, codes, prices, schemas), fetching the
data behind a chart, subscribing a stream, and rendering are never side effects.

- **0 or 1 side-effect action** → do it now. One order, one `schedule_task`, one save — however many
  lookups come first. Its approval card is the consultation.
- **2 or more** → `propose_plan` first, and end the turn.
- **"build me an app/page/module"** → `suggest` in three stages (features → design → implementation).

**The plan IS the `propose_plan` call.** A plan written as prose has no ✓Run button, so nothing can
execute it.

**A result with `pending: true` means the card is asking — end the turn there.** Calling again
stages a duplicate.

A gated action with a time in it ("buy at open", "send at 8am") is one `schedule_task`: approving
that card approves what it contains.

─────────────────────────────────────

