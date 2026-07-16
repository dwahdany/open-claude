# 01 — TUI Attach / Bootstrap Contract (opencode v1.17.19)

Everything the shim server must implement so that `opencode attach http://localhost:PORT`
(stock TUI, v1.17.19) reaches an interactive home screen. Extracted from the vendored
source at `vendor/opencode` (tag v1.17.19) and the published SDK
`node_modules/@opencode-ai/sdk` (identical to `vendor/opencode/packages/sdk/js/src/v2`).
All paths below are repo-relative. **Server source wins over the OpenAPI spec.**

---

## 1. What `opencode attach <url>` does before the TUI starts

Source: `vendor/opencode/packages/opencode/src/cli/cmd/attach.ts:62-147`

1. `--dir <d>`: tries `process.chdir(d)`; if that fails (remote attach) the raw string is
   passed through (`attach.ts:70-79`). If `--dir` is **not** given, `directory` is
   `undefined` — this is the common case and means **no** `x-opencode-directory` header /
   `?directory=` query is ever sent.
2. Builds basic-auth headers via `ServerAuth.headers({password, username})`
   (`attach.ts:114`). Source `vendor/opencode/packages/opencode/src/server/auth.ts:36-48`:
   only if a password exists (flag `--password`/`-p` or env `OPENCODE_SERVER_PASSWORD`)
   does it send `Authorization: Basic base64(username:password)`; username defaults to
   `"opencode"`. **No password → no Authorization header → the shim must not require auth
   by default.**
3. Loads local TUI config (`TuiConfig.get()`, `attach.ts:115`) — purely local file reads
   (`vendor/opencode/packages/opencode/src/config/tui.ts`), **no server call**.
4. `validateSession` (`attach.ts:117-128`,
   `vendor/opencode/packages/opencode/src/cli/tui/validate-session.ts:7-29`):
   - **No-op unless `--session <id>` was passed.**
   - Decodes the id against `SessionID` schema — must start with `"ses"`
     (`vendor/opencode/packages/opencode/src/schema/../../schema/src/session-id.ts:5-15`,
     actual file `vendor/opencode/packages/schema/src/session-id.ts`).
   - Then `client.session.get({ sessionID }, { throwOnError: true })` →
     **`GET /session/{sessionID}` must return 200 + Session JSON** or attach aborts with
     the error message printed.
5. Starts the TUI via `run(...)` (`attach.ts:130-146`) passing `url`, `directory`,
   `headers`, and args `{continue, sessionID, fork}`.

There is **no** `/global/health` or version handshake during attach. The first HTTP
traffic (without `--session`) comes from the TUI itself.

URL normalization: the SDK strips a single trailing `/` from `baseUrl`
(`vendor/opencode/packages/sdk/js/src/v2/gen/client/utils.gen.ts:159-162`); routes are
appended verbatim (`http://host:port` + `/config/providers`). No `/api` prefix for any
bootstrap route.

---

## 2. Transport conventions (SDK v2 client)

Source: `vendor/opencode/packages/sdk/js/src/v2/client.ts` and
`vendor/opencode/packages/sdk/js/src/v2/gen/client/client.gen.ts`.

### 2.1 Client construction

`createOpencodeClient({ baseUrl, directory?, headers?, signal, fetch? })`
(`client.ts:50-93`):

- Default fetch sets `req.timeout = false` (Bun-specific; disables idle timeout —
  matters for long-lived SSE) (`client.ts:52-61`).
- If `directory` is set: adds header `x-opencode-directory: encodeURIComponent(directory)`
  to **every** request (`client.ts:63-68`).
- Request interceptor `rewrite()` (`client.ts:18-48`): for **GET/HEAD only**, moves
  `x-opencode-directory` / `x-opencode-workspace` headers into query params
  `?directory=...&workspace=...` (also `location[directory]` for `/api/*` paths) and
  deletes the headers.

  > CORRECTED: the wire query value is **single-encoded**, not double-encoded. The
  > `pick()` helper (`client.ts:10-16`) compares the header value against
  > `encodeURIComponent(config.directory)` and, on match (always true in the TUI attach
  > path, since both derive from the same `config.directory`), returns the **raw decoded**
  > directory; `URLSearchParams.set` then encodes it once. Double-encoding only occurs if
  > a caller sets the header manually without also passing `directory` to
  > `createOpencodeClient`. The real server is tolerant of both: URL parsing decodes once
  > (`workspace-routing.ts:86-88`), then a **guarded** `decodeURIComponent` (try/catch
  > falling back to the raw value) runs in
  > `middleware/instance-context.ts:13-19,29` — a no-op for ordinary paths.
  > **Shim rule: on GET, take `directory` from the parsed query and apply a
  > try/catch-guarded `decodeURIComponent`; on non-GET read the `x-opencode-directory`
  > header and `decodeURIComponent` it (header IS single-encoded). When absent, fall back
  > to the shim process cwd** (real server:
  > `url.searchParams.get("directory") || request.headers["x-opencode-directory"] || process.cwd()`,
  > `middleware/workspace-routing.ts:86-88`).
- Response interceptor (`client.ts:84-90`): **if `content-type === "text/html"` (exact
  string match) the client throws** "Request is not supported by this version of
  OpenCode Server". → The shim must NEVER answer any route the TUI touches with
  `text/html`. Use JSON for 404s too (a text/plain 404 also survives, but JSON is what
  the real server does).
- Error interceptor `wrapClientError`
  (`vendor/opencode/packages/sdk/js/src/error-interceptor.ts`): only active with
  `throwOnError: true`; extracts message from `error.data.message` → `error.message` →
  `error.name`. The TUI's own `errorMessage()` (`vendor/opencode/packages/tui/src/app.tsx:154-167`)
  also reads `error.data.message`. **Error body convention:**
  `{"name":"SomeError","data":{"message":"human readable"}}` with an appropriate 4xx.
  Effect-generated 400s look like `{"name":"BadRequest","data":{"message":"...","kind":"Query"|...}}`
  (SDK `types.gen.ts:7084-7090`).

### 2.2 Response parsing (result-tuple vs throw)

`client.gen.ts:124-232`:

- 2xx: body parsed by content-type (json default). Empty body / 204 / `Content-Length: 0`
  → `data = {}` (`client.gen.ts:133-158, 168-174`).
- non-2xx: body text is JSON.parse'd if possible and returned as `result.error` (calls
  *without* `throwOnError` resolve normally with `{error, response}`) or thrown (with
  `throwOnError: true`).
- **Network failure or an interceptor throw rejects the promise even without
  `throwOnError`** — this is what makes "non-blocking" bootstrap calls able to break
  things (see §4.3).

### 2.3 SSE client

`vendor/opencode/packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts:95-234`:

- Plain `fetch` GET; expects standard SSE framing. Parser: normalizes CRLF, splits on
  `\n\n`, reads `data:`/`event:`/`id:`/`retry:` lines. Multiple `data:` lines are joined
  with `\n` and `JSON.parse`d (falls back to raw string). Events without a `data:` line
  are not yielded. The `event:` name is ignored by consumers.
- Sends `Last-Event-ID` header on reconnect if the server ever sent `id:` lines (real
  server sends `id: undefined` → no id line — see §6).
- non-`response.ok` → treated as error; TUI calls with `sseMaxRetryAttempts: 0`
  (`vendor/opencode/packages/tui/src/context/sdk.tsx:91-94`), so the SDK-level retry is
  disabled and the TUI's own loop reconnects with 1s→30s exponential backoff
  (`sdk.tsx:108-115`). SSE failing does **not** block bootstrap or the home screen; it
  just kills live updates.

---

## 3. TUI provider mounting order and gating

Source: `vendor/opencode/packages/tui/src/app.tsx:186-363` (`run`), `:281-345` (tree).

```
TuiInput = { url, args, config, onSnapshot?, directory?, fetch?, headers?, events?, pluginHost }   // app.tsx:142-152
```

Mount order (outer→inner):
`... → RouteProvider → TuiConfigProvider → PluginRuntimeProvider → SDKProvider →
PermissionProvider → ProjectProvider → SyncProvider → DataProvider → ThemeProvider →
LocalProvider → ... → App` (`app.tsx:286-335`).

- `SDKProvider` (`context/sdk.tsx:11-151`) creates the client and, `onMount`, starts the
  SSE loop against **`GET /global/event`** (`sdk.tsx:82-132`; `sdk.global.event()` →
  `sdk.gen.ts:1336-1341`, url `/global/event`).
- `ProjectProvider` (`context/project.tsx`) holds path/project state; its `sync()` is
  *called by* SyncProvider's bootstrap, not on mount.
- `SyncProvider` (`context/sync.tsx:54-666`) runs `bootstrap()` `onMount`
  (`sync.tsx:548-550`). **Bootstrap failure of the blocking set calls `exit(e)` — the TUI
  quits and prints the error** (`sync.tsx:534-545`).
- Route defaults to `{type:"home"}` (`context/route.tsx:27-46`); with `--continue` the
  initial route is `{type:"session", sessionID:"dummy"}` (`app.tsx:286-295`) until the
  session list arrives.
- Home screen (`routes/home.tsx`) renders logo + prompt; it needs no additional endpoints
  beyond what sync/local provide.

`sync.ready` = `status !== "loading"` (`sync.tsx:558-561`) — i.e. reaching **"partial"**
(blocking set done) is enough for an interactive home screen.

Empty-provider trap: when `sync.status === "complete"` **and** `provider.length === 0`,
the TUI force-opens the "connect a provider" dialog over home
(`app.tsx:540-549`). → **the shim must return ≥ 1 provider.**

`useConnected()` (`component/use-connected.tsx:4-12`): true iff any provider has
`id !== "opencode"` (or an `opencode` provider with a paid model). With a single
`anthropic` provider → connected. This drives the "Connect provider" suggestion and the
model dialog layout.

---

## 4. The bootstrap request set (sync.tsx bootstrap())

Source: `vendor/opencode/packages/tui/src/context/sync.tsx:445-546`.

### 4.1 Blocking, `throwOnError: true` — 200 JSON or the TUI exits

| # | SDK call | Route |
|---|----------|-------|
| 1 | `config.providers({workspace}, {throwOnError:true})` (`sync.tsx:452`) | `GET /config/providers` |
| 2 | `provider.list({workspace}, {throwOnError:true})` (`sync.tsx:453`) | `GET /provider` |
| 3 | `app.agents({workspace}, {throwOnError:true})` (`sync.tsx:462`) | `GET /agent` |
| 4 | `config.get({workspace}, {throwOnError:true})` (`sync.tsx:463`) | `GET /config` |

(`workspace` is `undefined` unless experimental workspaces are active — the param is
simply omitted.)

### 4.2 Blocking but failure-tolerant

| SDK call | Route | Tolerance |
|----------|-------|-----------|
| `experimental.capabilities.get(...)` `.catch(() => undefined)` (`sync.tsx:454-457`) | `GET /experimental/capabilities` | any rejection swallowed |
| `experimental.console.get(...)` `.catch(() => emptyConsoleState)` (`sync.tsx:458-461`) | `GET /experimental/console` | any rejection swallowed |
| `project.sync()` (`sync.tsx:448`, impl `context/project.tsx:38-53`) | `GET /path`, `GET /project/current`, then `GET /project/{projectID}/directories` (only if `current` returned an `id`) | **no throwOnError** → an HTTP-error JSON response resolves as `{error}` and falls back to defaults; but a network failure or the text/html interceptor throw **rejects → fatal exit**. Serve these properly. |
| `session.list({start: now-30d, ...})` (`sync.tsx:449,464-472`) | `GET /session` | in the blocking set **only with `--continue`**; otherwise non-blocking |

### 4.3 Non-blocking (after "partial"; all must eventually resolve for status → "complete")

`sync.tsx:513-533`:

| SDK call | Route | Result stored as |
|----------|-------|------------------|
| `session.list(...)` (if not `--continue`) | `GET /session` | `session` |
| `command.list({workspace})` | `GET /command` | `command` (`x.data ?? []`) |
| `lsp.status({workspace})` | `GET /lsp` | `lsp` |
| `mcp.status({workspace})` | `GET /mcp` | `mcp` (`?? {}`) |
| `experimental.resource.list({workspace})` | `GET /experimental/resource` | `mcp_resource` (`?? {}`) |
| `formatter.status({workspace})` | `GET /formatter` | `formatter` |
| `session.status({workspace})` | `GET /session/status` | `session_status` (`?? {}`) |
| `provider.auth({workspace})` | `GET /provider/auth` | `provider_auth` (`?? {}`) |
| `vcs.get({workspace})` | `GET /vcs` | `vcs` |
| `project.workspace.sync()` | `GET /experimental/workspace`, `GET /experimental/workspace/status` | wrapped in `.catch(() => undefined)` (`project.tsx:55-68`) |

These use the result-tuple style: an HTTP 4xx **JSON** response is harmless
(`x.data` undefined → fallback). But a rejection (network / text-html interceptor)
prevents `setStore("status","complete")`, which permanently suppresses the
empty-provider dialog, `--session --fork`, and `console.org` commands. **Implement all
of them; empty JSON responses are fine.**

### 4.4 Pre-TUI (only with `--session`)

`GET /session/{sessionID}` → 200 Session JSON (see §5.8).

### 4.5 SSE

`GET /global/event` — see §6.

---

## 5. Endpoint contracts

Conventions for every route below:
- Accept and ignore `directory` and `workspace` query params (the client appends them to
  **every** GET when `--dir` was used — including `/global/event`, which declares no
  query in the real API, `groups/global.ts:85-93`). Never 400 on them.
- Content-Type `application/json` (SSE excepted).
- The server groups declare query via `WorkspaceRoutingQueryFields = { directory?, workspace? }`
  (`middleware/workspace-routing.ts:22-27`).

### 5.1 `GET /config/providers`

Server impl:
`vendor/opencode/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts:38-47`
(route), `handlers/config.ts:24-30` (handler):

```ts
const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
  const providers = yield* providerSvc.list()
  return {
    providers: Object.values(providers).map(Provider.toPublicInfo),
    default: Provider.defaultModelIDs(providers),
  }
})
```

Response type (SDK `types.gen.ts:7478-7488`):

```ts
export type ConfigProvidersResponses = {
  200: {
    providers: Array<Provider>
    default: { [key: string]: string }   // providerID -> default modelID
  }
}
```

Server-side Effect schemas — **verbatim**,
`vendor/opencode/packages/opencode/src/provider/provider.ts:963-1070`:

```ts
const ProviderApiInfo = Schema.Struct({ id: Schema.String, url: Schema.String, npm: Schema.String })
const ProviderModalities = Schema.Struct({ text: Schema.Boolean, audio: Schema.Boolean, image: Schema.Boolean, video: Schema.Boolean, pdf: Schema.Boolean })
const ProviderInterleaved = Schema.Union([Schema.Boolean, Schema.Struct({ field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]) })])
const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean, reasoning: Schema.Boolean, attachment: Schema.Boolean, toolcall: Schema.Boolean,
  input: ProviderModalities, output: ProviderModalities, interleaved: ProviderInterleaved,
})
const ProviderCacheCost = Schema.Struct({ read: Schema.Finite, write: Schema.Finite })
const ProviderCost = Schema.Struct({
  input: Schema.Finite, output: Schema.Finite, cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(Schema.Struct({ input: Schema.Finite, output: Schema.Finite, cache: ProviderCacheCost })),
})
const ProviderLimit = Schema.Struct({ context: Schema.Finite, input: optional(Schema.Finite), output: Schema.Finite })

export const Model = Schema.Struct({
  id: ModelV2.ID, providerID: ProviderV2.ID, api: ProviderApiInfo, name: Schema.String,
  family: optional(Schema.String), capabilities: ProviderCapabilities, cost: ProviderCost,
  limit: ProviderLimit, status: ModelStatus, // "alpha" | "beta" | "deprecated" | "active"
  options: Schema.Record(Schema.String, Schema.Any), headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String, variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })

export const Info = Schema.Struct({
  id: ProviderV2.ID, name: Schema.String, source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String), key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any), models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
```

SDK wire type (identical, `types.gen.ts:2027-2122`): `Model` requires `id, providerID,
api{id,url,npm}, name, capabilities{...}, cost{input,output,cache{read,write}},
limit{context,output}, status, options{}, headers{}, release_date`. `Provider` requires
`id, name, source, env[], options{}, models{}`.

**Traced TUI reads (what actually matters):**
- `provider.id`, `provider.name` (`local.tsx:267-273`, `dialog-model.tsx:41,64-65,80`)
- `provider.models` map — keys used as model IDs (`dialog-model.tsx:69-74`,
  `local.tsx:66,227`)
- `model.id`, `model.name` (`dialog-model.tsx:39-40,74-75`; `util/model.ts:27`)
- `model.release_date` — sort key, string compare desc (`dialog-model.tsx:76,186-197`)
- `model.status` — `"deprecated"` filtered out of the picker (`dialog-model.tsx:71`)
- `model.cost?.input` — `=== 0` + provider `opencode` → "Free" badge; also feeds
  `useConnected` (`dialog-model.tsx:44,82`, `use-connected.tsx:8-10`)
- `model.capabilities?.reasoning` (`local.tsx:272`)
- `model.limit.context` — token % in the prompt footer (`component/prompt/index.tsx:275`,
  `routes/session/subagent-footer.tsx:43`, `feature-plugins/sidebar/context.tsx:33`)
- `model.variants` — keys become the variant list (`local.tsx:375-382`)
- `default[providerID]` — fallback model selection (`local.tsx:226`)
- Model-fallback order (`local.tsx:197-234`): `--model` arg → `config.model` →
  persisted recents → `provider_default[provider[0].id]` → first key of
  `provider[0].models`.

**Minimal sufficient JSON for the shim** (single `anthropic` provider; reuse the same
`models` object for `GET /provider`):

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "source": "env",
      "env": ["ANTHROPIC_API_KEY"],
      "options": {},
      "models": {
        "claude-opus-4-8": {
          "id": "claude-opus-4-8",
          "providerID": "anthropic",
          "api": { "id": "anthropic", "url": "https://api.anthropic.com/v1", "npm": "@ai-sdk/anthropic" },
          "name": "Claude Opus 4.8",
          "capabilities": {
            "temperature": true, "reasoning": true, "attachment": true, "toolcall": true,
            "input":  { "text": true, "audio": false, "image": true, "video": false, "pdf": true },
            "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
            "interleaved": true
          },
          "cost": { "input": 5, "output": 25, "cache": { "read": 0.5, "write": 6.25 } },
          "limit": { "context": 200000, "output": 64000 },
          "status": "active",
          "options": {},
          "headers": {},
          "release_date": "2026-05-01",
          "variants": { "high": {}, "max": {} }
        },
        "claude-sonnet-5": {
          "id": "claude-sonnet-5",
          "providerID": "anthropic",
          "api": { "id": "anthropic", "url": "https://api.anthropic.com/v1", "npm": "@ai-sdk/anthropic" },
          "name": "Claude Sonnet 5",
          "capabilities": {
            "temperature": true, "reasoning": true, "attachment": true, "toolcall": true,
            "input":  { "text": true, "audio": false, "image": true, "video": false, "pdf": true },
            "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
            "interleaved": true
          },
          "cost": { "input": 3, "output": 15, "cache": { "read": 0.3, "write": 3.75 } },
          "limit": { "context": 1000000, "output": 64000 },
          "status": "active",
          "options": {},
          "headers": {},
          "release_date": "2026-02-01",
          "variants": {}
        },
        "claude-haiku-4-5-20251001": {
          "id": "claude-haiku-4-5-20251001",
          "providerID": "anthropic",
          "api": { "id": "anthropic", "url": "https://api.anthropic.com/v1", "npm": "@ai-sdk/anthropic" },
          "name": "Claude Haiku 4.5",
          "capabilities": {
            "temperature": true, "reasoning": true, "attachment": true, "toolcall": true,
            "input":  { "text": true, "audio": false, "image": true, "video": false, "pdf": true },
            "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
            "interleaved": true
          },
          "cost": { "input": 1, "output": 5, "cache": { "read": 0.1, "write": 1.25 } },
          "limit": { "context": 200000, "output": 64000 },
          "status": "active",
          "options": {},
          "headers": {},
          "release_date": "2025-10-01",
          "variants": {}
        }
      }
    }
  ],
  "default": { "anthropic": "claude-sonnet-5" }
}
```

Notes: `api`, `env`, `headers`, `options`, `source`, `family` are not dereferenced by the
TUI at bootstrap but are required by the schema — keep them present. `variants` keys
surface in the `/variants` dialog and the variant cycle keybind; map them to Claude
"thinking" levels or return `{}` to disable. `cost`/`limit` must be present (schema
non-optional) even though most TUI reads are defensive.

### 5.2 `GET /provider`

Server impl: `handlers/provider.ts:40-59` — merges the models.dev catalog with connected
providers:

```ts
return {
  all: Object.values(providers).map(Provider.toPublicInfo),
  default: Provider.defaultModelIDs(providers),
  connected: Object.keys(connected),
}
```

Response type (SDK `types.gen.ts:9315-9326`):

```ts
export type ProviderListResponses = {
  200: { all: Array<Provider>; default: { [key: string]: string }; connected: Array<string> }
}
```

Traced usage: stored as `provider_next` (`sync.tsx:502`); read by the provider-connect
dialog (`component/dialog-provider.tsx:118,136,407`) to list connectable providers and
mark connected ones. In the real server `all` contains the *entire* models.dev catalog
(hundreds); the shim can return just the `anthropic` provider.

Minimal JSON:

```json
{ "all": [ /* same anthropic Provider object as §5.1 */ ], "default": { "anthropic": "claude-sonnet-5" }, "connected": ["anthropic"] }
```

### 5.3 `GET /agent`

Server impl: `handlers/instance.ts:80-82` (`agent.list()`); route
`groups/instance.ts:149-158` (OpenAPI id `app.agents`).

Schema — verbatim `vendor/opencode/packages/opencode/src/agent/agent.ts:35-55`:

```ts
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,          // Array<{permission,pattern,action:"allow"|"deny"|"ask"}>
  model: Schema.optional(Schema.Struct({ modelID: ModelV2.ID, providerID: ProviderV2.ID })),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
```

SDK type: `types.gen.ts:2345-2365` (`AppAgentsResponses.200: Array<Agent>`,
`types.gen.ts:8328-8335`).

Traced usage: `local.tsx:78-79` filters `mode !== "subagent" && !hidden` for the
selectable list; `agent.current()` = first of that list (`local.tsx:96-98`). **At least
one visible non-subagent agent is required** or `agent.current()` is undefined and the
prompt cannot resolve an agent/model. `agent.color` (optional) drives styling;
`agent.model` (optional) overrides the model; `agent.permission` is passed through to
session creation flows. Real native agents: `build`, `plan` (primary), `general`,
`explore` (subagent) — `agent/agent.ts:140-207`.

Shim behavior — dynamic order (launch-default mode): the TUI **never persists its agent
selection** (`agentStore.current` starts undefined and falls back to `agents().at(0)`),
so list order is the only lever over the boot mode. The shim persists the last
client-sent agent (any prompt/command on a top-level session — the TUI sends its current
agent with every one) to the global `settings.json` (see `store.ts noteDefaults`) and
serves that agent FIRST, reading the file fresh on every GET. Colors are pinned on the
catalog rows (`build`=secondary, `plan`=accent, `auto`=success — exactly what the TUI's
index-based fallback assigned to the fixed order) because `local.tsx color()` is
index-based and a reorder would otherwise rotate the styling between launches.

Minimal JSON:

```json
[
  { "name": "build", "description": "The default agent. Executes tools based on configured permissions.", "mode": "primary", "native": true, "permission": [], "options": {} },
  { "name": "plan",  "description": "Plan mode. Disallows all edit tools.", "mode": "primary", "native": true, "permission": [], "options": {} }
]
```

### 5.4 `GET /config`

Server impl: `handlers/config.ts:14-16` (returns the resolved opencode config); route
`groups/config.ts:16-25`. Response = `Config` (`types.gen.ts:1882-2025`) — a huge object
with **every field optional**.

Traced TUI reads (complete list, grep over `sync.data.config`):
- `config.model` — `"provider/model"` string, wins the default-model fallback
  (`local.tsx:208-216`)
- `config.share` — `"disabled"` hides the share command (`routes/session/index.tsx:464`)
- `config.plugin` — status dialog list (`component/dialog-status.tsx:18`)
- `config.experimental?.disable_paste_summary` (`app.tsx:449`,
  `component/prompt/index.tsx:1208`)

Minimal JSON (perfectly valid): `{}` — or steer the default model explicitly:

```json
{ "model": "anthropic/claude-sonnet-5" }
```

Shim behavior — dynamic `model` (launch-default model): `config.model` sits ABOVE the
TUI's own persisted recent-models list in its fallback chain (`args.model` →
`config.model` → `model.json` recent → provider default, `local.tsx:197-234`), so a
static value here would pin every launch to one model no matter what the user picks.
The shim instead persists the last client-sent model (the picker re-sends its selection
with every prompt/command) to the global
`(XDG_DATA_HOME | ~/.local/share)/open-claude/settings.json` under `defaults.model`,
and serves it here — fresh disk read per GET, invalid refs degrade to
`anthropic/claude-sonnet-5`. Together with §5.3's agent ordering this is what makes the
model+mode pair survive restarts, globally across projects.

### 5.5 `GET /path`

Server impl: `handlers/instance.ts:29-38`:

```ts
return {
  home: Global.Path.home,       // e.g. "/Users/me"
  state: Global.Path.state,     // e.g. "/Users/me/.local/state/opencode"
  config: Global.Path.config,   // e.g. "/Users/me/.config/opencode"
  worktree: ctx.worktree,       // project root (VCS root) for the instance directory
  directory: ctx.directory,     // the instance working directory
}
```

Schema `groups/instance.ts:18-24`; SDK `types.gen.ts:2298-2304`
(`Path = { home, state, config, worktree, directory }` — all required strings);
`PathGetResponses.200: Path` (`types.gen.ts:8126-8133`).

Traced usage — **this is what makes directory scoping work**:
- Stored in `project.data.instance.path` (`project.tsx:48`); fallback when the call
  errors: `{home:"",state:"",config:"",worktree:"",directory:sdk.directory ?? ""}`
  (`project.tsx:14-20`).
- `sync.tsx:154-162 sessionListQuery()`: if `worktree` and `directory` are both
  non-empty → session list is filtered by
  `path = path.relative(resolve(worktree), directory)` (empty string `""` when they are
  equal — the request then carries `path=` with an empty value; treat empty as "root").
  If either is empty → `{scope:"project"}` is sent instead.
- Various path-shortening UI helpers use `home`/`directory`
  (`context/path-format.tsx`).

Minimal JSON (make `worktree === directory` = the shim's working directory):

```json
{
  "home": "/Users/you",
  "state": "/Users/you/.local/state/opencode",
  "config": "/Users/you/.config/opencode",
  "worktree": "/Users/you/project",
  "directory": "/Users/you/project"
}
```

### 5.6 `GET /project/current`

Server impl: `handlers/project.ts:19-21` (returns the instance's project); route
`groups/project.ts:32-41`.

Schema — verbatim `vendor/opencode/packages/schema/src/project.ts:31-41`:

```ts
export const Info = Schema.Struct({
  id: ID,                       // branded string; "global" is the non-VCS fallback id
  worktree: Schema.String,
  vcs: optional(Vcs),           // "git"
  name: optional(Schema.String),
  icon: optional(Icon),
  commands: optional(Commands),
  time: Time,                   // { created, updated, initialized? } epoch ms
  sandboxes: Schema.Array(Schema.String),
}).annotate({ identifier: "Project" })
```

SDK: `types.gen.ts:2419-2428`; `ProjectCurrentResponses.200: Project`
(`types.gen.ts:8747-8754`).

Traced usage (`project.tsx:38-53`): `data?.id` (gates the directories call and is used
as `session.projectID` comparison elsewhere), `data?.worktree`. Keep `id` **stable**
across requests and make it match the `projectID` you put on Session objects.

Minimal JSON:

```json
{ "id": "prj_openclaude", "worktree": "/Users/you/project", "vcs": "git", "time": { "created": 1760000000000, "updated": 1760000000000 }, "sandboxes": [] }
```

### 5.7 `GET /project/{projectID}/directories`

Server impl: `handlers/project.ts:52-54`; route `groups/project.ts:65-75`. Schema —
`vendor/opencode/packages/core/src/project/directories.ts:39-44`:

```ts
export const ListOutput = Schema.Array(
  Schema.Struct({ directory: AbsolutePath, strategy: optional(Schema.String) }),
).annotate({ identifier: "Project.Directories" })
```

Traced usage (`project.tsx:44-51`): `mainDir = data.findLast(item => item.strategy === undefined)?.directory`
(used by the session-move prompt helpers). Called only when `/project/current` returned
an `id`.

Minimal JSON: `[{ "directory": "/Users/you/project" }]` (or `[]`).

### 5.8 `GET /session` and `GET /session/{sessionID}`

Server impl: `handlers/session.ts:64-75` (list), `:85-87` (get). List query schema —
verbatim `groups/session.ts:30-38`:

```ts
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,             // directory?, workspace?
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),        // "true"/"false"
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
```

The TUI always sends `start = Date.now() - 30*24*60*60*1000` plus either `path=<relative>`
(possibly empty string) or `scope=project` (`sync.tsx:164-168, 154-162`). Semantics in the
real server: return sessions updated after `start`, filtered to the instance directory
(or whole project when `scope=project`), `path` filters by session subdirectory.

Session schema — verbatim `vendor/opencode/packages/schema/src/v1/session.ts:543-569`
(wire shape identical to SDK `Session`, `types.gen.ts:170-221`):

```ts
export const SessionInfo = Schema.Struct({
  id: SessionID,                 // must start with "ses"  (schema/src/session-id.ts:5-15)
  slug: Schema.String,
  projectID: Project.ID,
  workspaceID: optional(WorkspaceID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  summary: optional(SessionSummary),          // {additions,deletions,files,diffs?}
  cost: optional(Schema.Finite),
  tokens: optional(SessionTokens),            // {input,output,reasoning,cache:{read,write}}
  share: optional(SessionShare),              // {url}
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(SessionModel),              // {id,providerID,variant?}
  version: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,                  // epoch ms
    updated: NonNegativeInt,
    compacting: optional(NonNegativeInt),
    archived: optional(Schema.Finite),
  }),
  permission: optional(PermissionV1.Ruleset),
  revert: optional(SessionRevert),
}).annotate({ identifier: "Session" })
```

Traced usage at bootstrap: list is re-sorted client-side by `id`
(`sync.tsx:167`); `--continue` picks the newest `time.updated` with
`parentID === undefined` (`app.tsx:502-522`); `parentID === undefined` also defines
"root" sessions for quick slots (`local.tsx:453`); `time.compacting` → status
(`sync.tsx:582`). **Zero sessions: return `[]` — perfectly fine; the home screen renders
and "Switch session" is simply not suggested** (`app.tsx:574`).

Minimal JSON for `GET /session`: `[]`

Minimal Session object (needed for `--session` validation, and as the shape for every
`session.updated` event later):

```json
{
  "id": "ses_0001",
  "slug": "hello-world",
  "projectID": "prj_openclaude",
  "directory": "/Users/you/project",
  "title": "New session",
  "version": "1.17.19",
  "time": { "created": 1760000000000, "updated": 1760000000000 }
}
```

`GET /session/{sessionID}` for an unknown id → 404 JSON, e.g.
`{"name":"NotFoundError","data":{"message":"Session not found"}}` (attach prints
`data.message` and aborts).

### 5.9 `GET /session/status`

Server impl: `handlers/session.ts:77-79` (`Object.fromEntries(statusSvc.list())`).
Response (SDK `types.gen.ts:9529-9536`, status union `types.gen.ts:673-693`):

```ts
200: { [sessionID: string]: SessionStatus }
SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number; action?: {...} }
  | { type: "busy" }
```

Minimal JSON: `{}`

### 5.10 `GET /command`

Server impl: `handlers/instance.ts:76-78`. SDK type `types.gen.ts:2334-2343`:

```ts
export type Command = {
  name: string; description?: string; agent?: string; model?: string
  source?: "command" | "mcp" | "skill"; template: string; subtask?: boolean; hints: Array<string>
}
```

Used for user-defined slash commands. Minimal JSON: `[]`

### 5.11 `GET /lsp`, `GET /formatter`, `GET /mcp`, `GET /experimental/resource`, `GET /vcs`

- `/lsp` → `Array<LspStatus>` (`types.gen.ts:2367-2372`:
  `{id,name,root,status:"connected"|"error"}`). Minimal: `[]`
- `/formatter` → `Array<FormatterStatus>` (`types.gen.ts:2374-2378`:
  `{name,extensions[],enabled}`). Minimal: `[]`
- `/mcp` → `{[name]: McpStatus}` (`types.gen.ts:2380-2407`; variants
  `connected|disabled|failed(error)|needs_auth|needs_client_registration(error)`).
  Minimal: `{}`
- `/experimental/resource` → `{[uri]: McpResource}` (`types.gen.ts:2244-2250`).
  Minimal: `{}`
- `/vcs` → `VcsInfo = { branch?: string; default_branch?: string }`
  (`types.gen.ts:2306-2309`; handler `handlers/instance.ts:40-45`). Minimal: `{}` or
  `{"branch":"main"}` (shown in the footer).

### 5.12 `GET /provider/auth`

Server impl: `handlers/provider.ts:61-63`. Response `types.gen.ts:9349-9356`:
`{[providerID]: Array<ProviderAuthMethod>}` with
`ProviderAuthMethod = { type: "oauth"|"api"; label: string; prompts?: [...] }`
(`types.gen.ts:2484-2516`). Used only by the connect-provider dialog
(`dialog-provider.tsx:148`, has a built-in fallback). Minimal JSON: `{}`

### 5.13 `GET /experimental/capabilities` and `GET /experimental/console`

- Capabilities handler `handlers/experimental.ts:39-41`:
  `{ backgroundSubagents: boolean }` (schema `groups/experimental.ts:28-30`). TUI:
  `sync.data.capabilities.experimentalBackgroundSubagents` gates background-subagent UI
  (`routes/session/index.tsx:215,1502`). Minimal: `{"backgroundSubagents":false}`
- Console: schema `groups/experimental.ts:22-26`:
  `{ consoleManagedProviders: string[]; activeOrgName?: string; switchableOrgCount: number }`.
  TUI default when it fails: `{consoleManagedProviders:[],switchableOrgCount:0}`
  (`sync.tsx:36-39`). Minimal: `{"consoleManagedProviders":[],"switchableOrgCount":0}`
  (or 404 JSON — it's caught).

### 5.14 `GET /experimental/workspace` and `GET /experimental/workspace/status`

Called by `project.workspace.sync()` (`project.tsx:55-68`) wrapped in `.catch()`. Only
matters under `OPENCODE_EXPERIMENTAL_WORKSPACES`. Minimal: `[]` for both (Workspace =
`{id,type,...}` — see `types.gen.ts:11051+`), or 404 JSON.

### 5.15 `GET /global/health` (not in the bootstrap path, but trivial and used by tooling)

`handlers/global.ts:74-76`: `{ "healthy": true, "version": "1.17.19" }`
(`types.gen.ts:7237-7245`). Report the pinned opencode version, not your own — the TUI
compares versions for the update prompt (`app.tsx:1031-1077`, only triggered by an
`installation.update-available` event, which the shim should never emit).

---

## 6. SSE: `GET /global/event`

The TUI's only event source (`sdk.tsx:91-94` → `sdk.gen.ts:1336-1341`). The instance
`GET /event` endpoint also exists (`groups/event.ts:14-23`, handler
`handlers/event.ts:89-99`) with a *different* payload shape (`{id,type,properties}`, no
envelope) but the stock TUI never uses it in attach mode.

Server framing — `handlers/global.ts:16-23, 33-66`:

- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no`, `X-Content-Type-Options: nosniff`.

  > CORRECTED: there is **no `event:` line on the wire**. The handler tags every event
  > `event: "message"`, but the effect SSE encoder (verified against published
  > `effect@4.0.0-beta.83`, `dist/unstable/encoding/Sse.js` `encoder.write`:
  > `if (event.event !== "message") data += \`event: ...\``) **omits** the `event:` line
  > for the name `"message"` and omits `id:` when undefined. Every frame is exactly:
  >
  > ```
  > data: {"...single-line json..."}\n
  > \n
  > ```
  >
  > No `event:`, `id:`, `retry:`, or comment lines, ever. See 02-events.md §2 (which was
  > already correct).
- **First event, immediately on connect** (`handlers/global.ts:49`):

  ```
  data: {"payload":{"id":"evt_...","type":"server.connected","properties":{}}}
  ```

- **Heartbeat every 10 s** (`handlers/global.ts:43-46`), first one skipped
  (`Stream.drop(1)`):

  ```
  data: {"payload":{"id":"evt_...","type":"server.heartbeat","properties":{}}}
  ```

- All subsequent real events use the GlobalEvent envelope
  (`event-v2-bridge.ts:35-62`, `bus/global.ts:4-9`, schema `groups/global.ts:35-48`,
  SDK `types.gen.ts:730+`):

  ```json
  {
    "directory": "/Users/you/project",
    "project": "prj_openclaude",
    "workspace": null-or-omitted,
    "payload": { "id": "evt_...", "type": "session.updated", "properties": { "info": { /* Session */ } } }
  }
  ```

  `directory` is required by the schema but the connected/heartbeat events omit it and
  the TUI tolerates that (metadata just carries `undefined` —
  `context/event.ts:12-19`).

Client behavior (`sdk.tsx:82-117`, `context/event.ts:12-19`):
- Payloads with `type === "sync"` are dropped.
- Handlers filter on `metadata.workspace !== project.workspace.current()` — both
  `undefined` in the plain attach case, so events pass.
- `payload.type === "server.instance.disposed"` triggers a **full re-bootstrap**
  (`sync.tsx:171-174`) — emit it only if you intentionally want the TUI to reload.
- Event ids: real ones look like `evt_...` (ascending identifier, `bus/global.ts:14-19`);
  the TUI does not parse them.
- Connection closed by server → client reconnects after 1 s (backoff doubling to 30 s).
  Keep the socket open; send heartbeats so intermediaries don't kill it.

Minimal shim behavior: on connect write the `server.connected` frame, then heartbeat
every 10 s, then forward whatever session/message events the Claude-Agent-SDK bridge
produces using the envelope above.

---

## 7. Traps & gotchas (ranked)

1. **Never serve `text/html`** on any route the client touches — the response
   interceptor throws (`sdk/js/src/v2/client.ts:84-90`). This includes 404s. (Exact-match
   check on `content-type === "text/html"`, but don't rely on charset suffixes.)
2. **Exactly four endpoints are fatal**: `/config/providers`, `/provider`, `/agent`,
   `/config` (`sync.tsx:452-472`). Any non-2xx or rejection → `exit(e)` and the TUI quits
   printing the error (`sync.tsx:534-545`). `/path` + `/project/current` resolve the
   error-tuple on 4xx JSON but reject (fatal) on connection failure.
3. **Return ≥1 provider** or the connect-provider dialog permanently replaces home once
   status hits "complete" (`app.tsx:540-549`).
4. **Return ≥1 visible agent** (`mode: "primary"|"all"`, not `hidden`) or
   `local.agent.current()` is undefined and prompting breaks (`local.tsx:78-98`).
5. **Accept/ignore `directory` & `workspace` query params on every GET** — the SDK
   appends them to all GET/HEAD requests when `--dir` was used, even `/global/event`
   (`client.ts:18-48`).
   > CORRECTED: the query value is single-encoded (see §2.1 correction). Use the
   > URL-parsed value, optionally followed by a try/catch-guarded `decodeURIComponent`
   > to mirror the server. On non-GET requests the directory arrives as the
   > `x-opencode-directory` header, URI-encoded once — `decodeURIComponent` that.
6. **All the "non-blocking" endpoints must exist** (§4.3) — an HTTP-level rejection
   (network error / html interceptor) on any of them keeps `sync.status` at "partial"
   forever, which breaks the `--session --fork` flow and the provider-empty detection.
   4xx JSON responses are tolerated for those, but just return the empty-value 200s.
7. **Session ids must start with `ses`** (`schema/src/session-id.ts:5`) — attach
   `--session` validates the prefix client-side before any HTTP call; other flows
   generate `ses_<descending>` ids server-side. Use `ses_`-prefixed ids everywhere.
8. **`/path.worktree`+`.directory` drive the session-list filter**: equal non-empty
   values → the TUI sends `path=` (empty string) on `GET /session`; empty values →
   `scope=project`. Handle both (`sync.tsx:154-162`). It also always sends
   `start=<now-30d ms>` — don't 400 on unknown/extra params (real server whitelists them
   via `ListQuery`, `groups/session.ts:30-38`).
9. **`--continue` moves `GET /session` into the blocking set** and then navigates to the
   newest root session; with zero sessions the TUI stays on a "dummy" session route
   (matches real-server behavior). `--session <id>` requires `GET /session/{id}` to
   return 200 *before* the TUI even starts.
10. **Times are epoch milliseconds** (`time.created/updated`), costs are dollars,
    `limit.context/output` are token counts. `release_date` is a `YYYY-MM-DD` string and
    is compared lexically for picker ordering (`dialog-model.tsx:186-197`).
11. **Model picker requirements**: enumerates `Object.entries(provider.models)`, filters
    `status === "deprecated"`, needs `name` + `release_date`; `cost.input === 0` only
    matters for provider id `opencode` ("Free" badge / connected-detection). Don't name
    the provider id `opencode` — use `anthropic` so `useConnected()` is true.
12. **Config `{}` is valid**; if you want to pin the default model, set
    `"model": "anthropic/claude-sonnet-5"` (`provider/model` split on first `/`,
    `local.tsx:27-33`).
13. **204/empty-body responses parse as `{}`** in the client (`client.gen.ts:133-158`) —
    fine for booleans/objects, wrong for arrays. Always send real JSON bodies.
14. **Error bodies**: `{"name":"...","data":{"message":"..."}}` — both the SDK error
    wrapper and the TUI toast reader look for `data.message`
    (`error-interceptor.ts`, `app.tsx:154-167`).
15. **Auth is optional**: implement HTTP Basic only if you set a password; the TUI sends
    `Authorization` on every request (including SSE) when configured
    (`server/auth.ts:36-48`, `attach.ts:114`).
16. **Do not emit** `server.instance.disposed` (re-bootstrap loop) or
    `installation.update-available` (update nag) unless intended.
17. SSE parser quirks: events are split on blank lines, `data:` may repeat (joined with
    `\n`), the `event:` field is ignored, JSON parse failures silently yield raw strings
    (`serverSentEvents.gen.ts:149-213`). Keep each event a single `data:` line of
    compact JSON to stay safe.
18. `GET /doc` serves the OpenAPI spec on the real server (`server.ts:188-192`) — not
    needed by the TUI, but handy to stub for debugging parity.

---

## 8. Quick checklist for the shim

| Route | Status | Body |
|---|---|---|
| `GET /config/providers` | 200 | `{providers:[anthropic], default:{anthropic:"claude-sonnet-5"}}` |
| `GET /provider` | 200 | `{all:[anthropic], default:{...}, connected:["anthropic"]}` |
| `GET /agent` | 200 | `[build, plan]` |
| `GET /config` | 200 | `{}` |
| `GET /path` | 200 | home/state/config/worktree/directory |
| `GET /project/current` | 200 | Project (stable `id`) |
| `GET /project/:id/directories` | 200 | `[{directory}]` |
| `GET /session` | 200 | `[]` (filter by `start`/`path`/`scope` later) |
| `GET /session/:id` | 200/404 | Session / NotFound JSON |
| `GET /session/status` | 200 | `{}` |
| `GET /command` | 200 | `[]` |
| `GET /lsp` | 200 | `[]` |
| `GET /formatter` | 200 | `[]` |
| `GET /mcp` | 200 | `{}` |
| `GET /experimental/resource` | 200 | `{}` |
| `GET /experimental/capabilities` | 200 | `{"backgroundSubagents":false}` |
| `GET /experimental/console` | 200 | `{"consoleManagedProviders":[],"switchableOrgCount":0}` |
| `GET /experimental/workspace` | 200 | `[]` |
| `GET /experimental/workspace/status` | 200 | `[]` |
| `GET /provider/auth` | 200 | `{}` |
| `GET /vcs` | 200 | `{"branch":"main"}` |
| `GET /global/event` | 200 SSE | `server.connected`, 10 s heartbeats, GlobalEvent envelope |
| `GET /global/health` | 200 | `{"healthy":true,"version":"1.17.19"}` |
| anything else | 404 | JSON, never HTML |
