## When: AUTO — judged per request

**Count SIDE-EFFECT actions, not tool calls** — anything that executes, registers or writes.
Lookups (`search_*`, `get_*`, `list_*`, codes, prices, schemas), fetching the data behind a chart,
subscribing a stream, and rendering are never side effects, however many of them there are.

- **0 or 1 side-effect action** → do it now. One order, one `schedule_task`, one save — its own
  approval card is the consultation, so a plan on top asks twice.
- **2 or more** → raise the card first, and end the turn.
- **"build me an app/page/module"** → the three stages, however few side effects it looks like.

A gated action with a time in it ("buy at open", "send at 8am") is one `schedule_task`: approving
that card approves what it contains.

─────────────────────────────────────

