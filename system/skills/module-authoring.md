---
name: module-authoring
kind: procedure
description: 사용자 모듈 제작 매뉴얼 — 태그: 모듈 만들기, user module, config.json, 액션 선언, secrets, entry, _call 엔드포인트, 승인 게이트, 방언 선언, needs, source, 재사용 5규칙. 모듈을 새로 만들거나 고치기 전 반드시 get_skill 로 본문을 읽을 것 (I/O 계약·선언 표면 위반 = 조용한 실패). 쓰지 말 것 — 이미 있는 sysmod 를 호출만 할 때(search_module_actions → get_action_schema), 파이프라인 스텝 작성(schedule_task 의 pipeline 파라미터 설명), 스킬 작성(skill-authoring).
---

# Module authoring — a module declares, Firebat reads and runs

A module is `config.json` + code. Nothing stands between them and the framework: no build, no
registration call, no generated file. Write the two, and the module is discovered, validated,
gated and runnable. **If it does not work, it has to be fixable in the module** — when it is not,
the declaration surface is missing something and that is a Firebat bug, not yours.

## The contract

- **I/O** — stdin JSON in, the **last line of stdout** is the envelope. No argv.
  Python writes `True/False/None`, not `true/false/null`.

  ```jsonc
  {"success": true,  "data": {…}}                       // success
  {"success": false, "error": "what and the next move"}  // failure, plain
  {"success": false, "errorKey": "error.x", "errorParams": {…}}  // failure, i18n (lang/*.json)
  ```

  Logs go to **stderr** — anything on stdout after the envelope line breaks the parse. The
  framework enforces this at the boundary: empty stdout or a non-JSON last line on exit 0 comes
  back as a failure that STATES this contract (never as a silent success). A valid JSON value
  without envelope fields is accepted as the `data` itself. A non-zero exit that still printed
  an envelope keeps its message — say why you died, then die.
- **Entry** — `node`→`index.mjs`, `python`→`main.py`, `php`→`index.php`, `bash`→`index.sh`.
  Override with `entry`.
- **config.json** — only `name`, `runtime` and `input` are needed. `description`, `tags`,
  `packages`, `output`, `secrets` and everything below are optional and add capability.
- **Packages install on the module's first run**, so the first call is slow. That is normal.
  `packages` follows the declared runtime: pip specs for python (`"numpy"`, `"requests==2.34.2"`),
  npm specs for node (`"@napi-rs/canvas@1.0.8"` — installed into the module's own
  `node_modules/`, so a bare `import` in index.mjs just resolves).

## Declaring actions — the ladder is free

A caller reaches an action through `search_module_actions` → `get_action_schema` →
`run_module_action`. You get all three by declaring the enum:

```jsonc
"input": {
  "type": "object", "required": ["action"], "additionalProperties": false,
  "properties": {
    "action": { "type": "string", "enum": ["echo", "quote"],
                "description": "echo = … / quote = …" },
    "text":   { "type": "string", "description": "[echo] 돌려받을 문장" },
    "symbol": { "type": "string", "description": "[quote] 심볼" }
  }
}
```

- **`input` is where an argument's truth lives** — its type, its enum, whether it is required.
- **`[action]` tags say which action takes which param.** No tag = the whole module. The loader
  splits on any character that is not alphanumeric/`-`/`_`/`*`, so `[list-*]` and
  `[keyword-tool withBid]` both resolve.
- With no `actionCatalog`, the catalog is **derived from `input`** — every action is searchable
  with zero extra authoring. Declare one only when a row needs its own name, description, tags
  or aliases.

## actionCatalog — the discovery original

```jsonc
"actionCatalog": [
  { "id": "quote", "name": "…", "description": "무엇을 하는가. 한 줄",
    "params": ["symbol"], "required": ["symbol"], "tags": ["시세"], "aliases": ["ticker"] }
]
```

- **`params` is a list of names, never a name→prose map.** The wording comes from `input` —
  restating it there is how the two drift apart. `params: []` states the action takes none,
  which is different from saying nothing.
- **`required`** feeds `get_action_schema`'s `fill` — what the call is refused without. Say it
  here and the caller fills it first; leave it out and they learn from a rejection.
- **`aliases`** are searched but not published as separate rows — the place to say "this name is
  accepted on purpose", so an audit can tell it from an omission.
- Descriptions say **what a thing is, never what to do about it.** Instructions belong in the
  response at the moment they apply.
- **Where does the action SET live? Exactly one place, and the enum decides which.** No enum in
  `input` = the rows are the original (a full catalog; the runtime derives the validation enum
  from them). Enum present = the enum stays the original and the rows are **annotations** on ids
  it already names — the audit rejects a row id outside the enum as dead. Annotation rows are
  how a derived module takes a gate without adopting a whole catalog:
  `"actionCatalog": [{ "id": "send", "approval": true }]` — one line, everything else stays
  derived.
- **`"hidden": true`** on a row registers the action for dispatch, gates and the derived enum
  but keeps it out of search and schema — for a vendor-word alias that must stay callable but
  has nothing to advertise (binance `klines`).
- A declared catalog that cannot be read **refuses every call of the module** (fail closed) —
  the approval gates live on those rows, and an unreadable file must not read as "no gates".

## The run, in order

Every call takes the same road, whichever transport it arrived on — this order IS the runtime
standard, and each step speaks for itself when it refuses:

```
enabled? → validate(input) → gates (needs · approval card · uiOnly)
        → inject (_call · account · _recall · cache-key expansion · env)
        → run (sandbox | ws) → envelope parse → auto-cache (_cacheKey) → timeseries absorb
```

Your module runs as a **fresh process per call** — nothing in memory survives to the next one.
State lives in your `data/` files; everything situational arrives injected.

## What the framework hands you (do not fetch it yourself)

| arrives as | what it is |
|---|---|
| `_call` | the endpoint row for the action being run — see below |
| `account` | the resolved account alias, when the module declares `accounts` |
| `_cacheKey` / `_cacheMeta` | auto-cache of the main array/string in your reply |
| `_recall` | facts and lessons, when the module declares `recall` |
| `FIREBAT_TZ` env | the operator's timezone |
| `FIREBAT_UNATTENDED=1` env | nobody is waiting — a scheduled run, not a chat |

**`_call` — declare an endpoint once, receive one row per call.** Only for modules whose
endpoints are a table rather than a rule; a module whose path follows from the action name just
builds it.

```jsonc
{ "id": "quote", "_call": { "id": "quote", "method": "GET",
                            "base": "https://api.example.com", "path": "/v3/price" } }
```

Dispatch puts that row on the input as `_call`; the module reads it and never carries a table of
everyone else's endpoints. **Nothing in Firebat reads inside it** — the shape is whatever your
module needs, and core learning what a field means would make every new venue a core release.
**The leading underscore is the boundary**: the catalog loader keeps underscored fields out of
what the model reads, and a path is something it would read and never type. If one action covers
several endpoints, name the axis and let the module pick:

```jsonc
"_call": { "by": "side", "buy": { …ID_A… }, "sell": { …ID_B… } }
```

Declare the axis in `input` and in `required`, or the caller cannot know it exists. **Declare
`_call` for every runnable action or none** — a half migration fails only for the actions nobody
exercised.

## What you hand BACK (the same underscore boundary, outbound)

Your reply is `{success, data}`. The three keys below are addressed to the framework: it consumes
them and they never reach the model. **Only these three.** An underscore you invent yourself is
just a key with an underscore in it and the model reads it like any other — the framework's own
`_cacheKey`/`_cacheMeta` are visible on purpose, for the same reason.

| declare in `data` | the framework then |
|---|---|
| `_mediaImport: {path, contentType, filenameHint?, source?}` | carries the file into the media store and leaves `data.media` (url, slug, bytes). An ARRAY imports several in order, and `data.media` comes back in that order. `source` names the product kind for the media panel's sub-groups (`"clipart"` splits the image tab); leave it out for ordinary output |
| `_render: {component, props}` | draws that component in the answer — see below |
| `_prepare: {service, …, into}` | performs the service (e.g. `tts`), fills that input field and re-runs your action once |

**Hand back no address the caller cannot open.** AI file access is confined to `user/`, so a
workspace path in your `data` — `data/<you>/out.flac`, a scratch `.lrc`, a temp `.mid` — is an
address the caller is refused at. It does not fail loudly: the model tries the file tool, gets
turned away, and goes looking for another way in. Measured 8/19: one action led with such a path
and the turn burned seventeen calls before the model gave up and rewrote the content by hand. So
send the **content** in the field (a few lines of lyrics are cheaper than the detour), or send the
file through `_mediaImport` and let the url come back. Your own paths stay in stderr and in this
process's stdout, which is where a readout wants them anyway.

**`_render` — say what your output IS.** A file is bytes; only your module knows that a backing
track plus its synced lyric file is a karaoke stage, or that these rows are a candle chart. Say it
and the card appears; stay silent and the answer is a link the reader has to open.

```jsonc
"_render": { "component": "karaoke",
             "props": { "title": "아로하",
                        "audioUrl": { "$media": 0 },   // the file you imported first
                        "lrcUrl":   { "$media": 1 } } }
```

Addresses are not yours to know — the store decides them after you return — so point at your own
imports BY POSITION with `{"$media": N}`; an index with no file resolves to null rather than to a
broken address. Pick the component name from `search_components` and match its `propsSchema`
(`get_component_schema`); an unknown name simply draws nothing.

## When the model misuses your module — declare the fix, never work around it

A caller LLM will sometimes speak a dialect: pick the wrong action, guess a parameter, invent an
identifier, skip the id lookup. **Every dialect has a declaration slot, and the framework speaks
your declaration at the exact moment of refusal.** Fixing a dialect means editing your module's
files — never prompt text, never framework code.

**One field, one meaning, said once.** A description that offers two readings — two scales
("Leaflet 1-18 / Kakao 1-14"), two units, two id formats — makes the model pick one, validly.
The value passes the schema, so no gate refuses it and no dialect ledger records it: a
valid-but-misread value is invisible to every net, and only an unambiguous description
prevents it (measured 2026-08-18 — zoom:4 meant "level 4, close" and rendered "zoom 4, wide").

**A declaration lives on the thing it is about** — an action's on its catalog row, a parameter's
on its own spec in `input.properties`. (Module-level maps for these are still read during the
migration, and remain the home for wire-vocabulary params that are not declared in `input` —
a broker's `stk_cd` that only exists inside action rows.)

| the model… | declare on |
|---|---|
| picks the wrong action | the row — description, `tags`, `aliases` |
| gets a param's name or type wrong | the param spec — the schema IS the correction; validation errors derive from it |
| omits a required param | `required` (catalog row) — surfaces in `fill` before the first call |
| omits a discriminator | `_call.by` + that axis in `input` and `required` — the refusal lists the choices |
| invents an opaque id from memory | the row: `"needs": ["stock-lookup"]` — the prerequisite must have RUN in this conversation |
| uses an id from the wrong list | the param spec: `"source": "<issuing action>"` — see below |
| fires a dangerous call directly | the row: `"approval": true` |
| calls a screen-only action | the row: `"uiOnly": true` |
| retypes big rows instead of passing a key | the param spec: `"cacheInput": true` (nested fields declare it on themselves; the dotted path is derived) |
| misses a shelf row over spelling (한↔영, spacing) | the param spec: `"collection": "<settings field>"` — the framework ranks that field's rows semantically against the param's value and injects `_collectionMatches.<param>` (top rows + `score`); keep your own character matching as the floor |

**`source` — which action mints which id.** Free text naming the issuing action(s), on the
param's own spec:

```jsonc
"nodeId": { "type": "string", "description": "[bus-arrival] 정류소 id",
            "source": "bus-stop-search or bus-stop-nearby" }
```

When validation refuses a call over that param,
the refusal names the issuer — "`nodeId` is issued by bus-stop-search or bus-stop-nearby". Your
own code may read the same rows out of your `config.json` for the angles only you can see (an
empty result whose ids were all well-formed, say). One declaration, several readers — never keep
a second copy of the table in code.

**Your error responses are part of the surface.** A bare vendor `404` teaches nothing; the caller
retries blind. When your module fails, say the next move in the error — which action to call
first, which param to check, what an empty result does and does not mean. The framework points at
your declarations; only you can point at your data.

**Echo identity.** When an action takes an opaque identifier (a ticker code, a corp id), lead the
successful reply with what the venue says it is — `identity: "005930 = 삼성전자"` — read off the
response itself, never off a table of your own. A value that drifted from the conversation's
lookup then exposes itself exactly where the caller reads. Replies that carry no name stay
silent; the echo is the venue's testimony, not your guess.

## Gates — one line each

- **`"approval": true` on the action's catalog row** — the call produces a user approval card and
  does not run until it is confirmed. Cards for module actions expire in **5 minutes**.
- **`"needs": ["stock-lookup"]` on the action's row** — the named module must have RUN
  successfully in this conversation (30-minute sliding window) before this action dispatches.
  The refusal names the prerequisite; the framework never learns what the value looks like.
  Resolver-type actions simply declare no `needs` of their own.
- **`"uiOnly": true` on the row** — refused from chat; only a screen action may run it.
- Switching the module off removes it from search, schema and dispatch — a disabled module
  answers "this is a setting", not "no such thing".

## When it runs

`"schedules": ["cron-x.json"]` registers a job while the module is enabled. If which loops run
depends on what the operator has configured, do not keep a second list — let the rows point:

```jsonc
"schedulesFrom": { "setting": "trades", "field": "loop",
                   "skipWhen": { "field": "state", "equals": "off" } }
```

## When something outside calls IN (webhook)

```jsonc
"webhook": {
  "secret": "MY_WEBHOOK_SECRET",       // your declared secret that carries the shared token
  "secretHeader": "x-vendor-secret",   // the header the vendor sends it in — vendor dialect, so yours
  "parseAction": "parse-webhook",      // payload → {proceed, prompt?, replyArgs?, note?}
  "replyAction": "send-message",       // omit for a receive-only hook
  "replyTextParam": "text",            // your reply action's parameter that carries the answer
  "replyMaxChars": 4000                // the vendor's message limit is yours to declare
}
```

Declaring this makes `POST /api/hooks/<module>` yours. The framework compares the declared
header against the secret (machine-generated on your module's first run, injected as env like
any declared secret), hands the body to `parseAction` as `payload`, runs the AI on the `prompt`
you distilled, and delivers the answer through `replyAction` with your `replyArgs` spread in.
Everything vendor-shaped — the header name, the payload fields, WHO is authorized — is decided
inside your actions, never by the framework.

## Reusable 5 rules (user/modules/*)

Default for new AI-authored modules. Not applied when modifying a module the user wrote.
A user module carries **domain judgment only**; external API, UI and secrets are the infra's.

1. **External calls go through sysmods** — a user module does not fetch third-party domains
   directly. Look for an existing module first (`search_module_actions`).
2. **No direct secrets** — declare them in `secrets` and they arrive as environment variables.
   Never read a third-party key out of `process.env` by hand; if none is registered, call
   `request_secret`.
3. **UI is rendered by the render tools**, not by HTML a module writes. A domain-specific
   "component" is not a new React primitive — return `blocks` of the existing catalog
   (`search_components` shows the palette) and the page renders them; that path is auto-registered
   like everything else a module declares.
4. **Branching lives in module code or a pipeline `CONDITION` step.**
5. **No module imports another.** Reach one through `run_module_action` — the same rung
   everything else uses, which applies the gates, the validation and the injection above.
   (`execute` by path was the old way round and skipped all three.)
