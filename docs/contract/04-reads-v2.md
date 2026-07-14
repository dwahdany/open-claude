# 04 — v2 READ routes (`/api/*`) consumed by the TUI DataProvider

Pinned client: **opencode v1.17.19** (`vendor/opencode` at that tag). All citations are repo-relative `file:line`.

Scope: every v2 (`/api/*`) **GET** route the stock TUI touches, with exact request/response contracts, verbatim source types, minimal shim JSON, traced client usage, and traps. Write routes (`POST/DELETE` under `/api/*`) and the SSE event routes are other documents' areas; they are mentioned only where they interact with reads.

---

## 0. TL;DR for the shim implementer

The TUI's `DataProvider` (`vendor/opencode/packages/tui/src/context/data.tsx`) fires **eight one-shot GETs on mount** (data.tsx:551-565, wrapped in `Promise.allSettled`, failures only `console.error`ed):

| Order | Route | data.tsx call site |
|---|---|---|
| 1 | `GET /api/location` | data.tsx:469 |
| 2 | `GET /api/agent` | data.tsx:480 |
| 3 | `GET /api/integration` | data.tsx:500 |
| 4 | `GET /api/model` | data.tsx:513 |
| 5 | `GET /api/provider` | data.tsx:523 |
| 6 | `GET /api/reference` | data.tsx:533 |
| 7 | `GET /api/command` | data.tsx:490 |
| 8 | `GET /api/skill` | data.tsx:543 |

**Nothing is polled.** Re-fetches happen only when the server emits specific events (data.tsx:124-403):
- `catalog.updated` → re-GET `/api/model` + `/api/provider` (data.tsx:126-131)
- `reference.updated` → re-GET `/api/reference` (data.tsx:392-394)
- `integration.updated` → re-GET `/api/integration` + `/api/model` + `/api/provider` (data.tsx:395-401)

The session-scoped v2 reads (`/api/session/{id}`, `/api/session/{id}/message`, `/api/session/{id}/permission`, `/api/session/{id}/question`, `/api/permission/saved`) exist in `DataProvider` (data.tsx:416-463) but **have no caller anywhere in the v1.17.19 TUI** — the entire visible UI (session view, session list dialog, model picker, agent picker) is driven by the **v1** routes via `SyncProvider` (`vendor/opencode/packages/tui/src/context/sync.tsx:452-463,517-528,596-599`). Verified by grep: the only `useData()` consumer outside data.tsx is the prompt autocomplete (`vendor/opencode/packages/tui/src/component/prompt/autocomplete.tsx:90`), which reads only `data.location.reference.list()` (autocomplete.tsx:280).

Therefore a shim can return **empty-but-valid** bodies for all eight mount-time routes and the TUI works. The only hard requirements are:
1. Return `Content-Type: application/json` (a `text/html` response makes the client throw — see §1.4).
2. Every location-scoped list response must include a `location` envelope object whose `directory` **byte-matches** the `directory` returned by `GET /api/location` (see §1.3 and Trap T1).

---

## 1. Transport conventions (apply to every route below)

### 1.1 Client stack

The TUI creates one hey-api client via `createOpencodeClient` from `@opencode-ai/sdk/v2` (`vendor/opencode/packages/tui/src/context/sdk.tsx:1,23-31`), passing `baseUrl` (the attach URL), optional `directory` (only set when `opencode attach --dir …` was given — `vendor/opencode/packages/opencode/src/cli/cmd/attach.ts:70-79,143`), and optional basic-auth `headers`. All v2 calls go through `sdk.client.v2.*` (generated namespace: `vendor/opencode/packages/sdk/js/src/v2/gen/sdk.gen.ts:6990-7076`, wired at 7215-7218).

### 1.2 Directory/workspace scoping — the header→query rewrite

`createOpencodeClient` sets default headers when configured (`vendor/opencode/packages/sdk/js/src/v2/client.ts:63-75`):

```ts
// client.ts:63-75
if (config?.directory) {
  config.headers = { ...config.headers, "x-opencode-directory": encodeURIComponent(config.directory) }
}
if (config?.experimental_workspaceID) {
  config.headers = { ...config.headers, "x-opencode-workspace": config.experimental_workspaceID }
}
```

A request interceptor then **rewrites those headers into query params for GET/HEAD** (`vendor/opencode/packages/sdk/js/src/v2/client.ts:18-48`):

```ts
// client.ts:18-48 (verbatim)
function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-opencode-directory", "directory"],
    ["x-opencode-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}
```

Consequences for the shim:
- **GET `/api/*` requests never carry `x-opencode-directory`/`x-opencode-workspace` headers.** If the TUI was attached with `--dir`, the directory arrives as **both** `?directory=<dir>` and `?location[directory]=<dir>` (bracket key, percent-encoded on the wire as `location%5Bdirectory%5D`). The `pick()` helper (client.ts:10-16) un-encodes the header value back to the raw directory before it is put in the query, so the query param value is the plain (URL-encoded-by-URLSearchParams) path.
- **Non-GET `/api/*` requests keep the headers** (`x-opencode-directory` value is `encodeURIComponent`-encoded).
- When `DataProvider` explicitly passes a location (only on event-triggered refreshes where the event carried a `location`), the generated client serializes the `location` object parameter in **deepObject style**: `?location[directory]=…&location[workspace]=…` (serializer: `vendor/opencode/packages/sdk/js/src/v2/gen/client/utils.gen.ts:34-38,273`; parameter mapping e.g. sdk.gen.ts:5053 `{ in: "query", key: "location" }`).
- On the plain mount-time fetches with no `--dir`, there are **no location params at all**; the reference server falls back to its own `process.cwd()`.

Reference server resolution (authoritative) — `vendor/opencode/packages/server/src/location.ts:29-47`:

```ts
// location.ts:29-39 (verbatim)
function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-opencode-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  return Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined })
}
```

Note it reads **only** `location[directory]`/`location[workspace]` (not the plain `directory` param — that one exists for v1 routes).

### 1.3 The `location` response envelope

Location-scoped list routes wrap their payload with the resolved location (`vendor/opencode/packages/server/src/location.ts:15-27`; schema `vendor/opencode/packages/schema/src/location.ts:23-25`):

```ts
// schema/src/location.ts:14-25 (verbatim)
export class Info extends Schema.Class<Info>("Location.Info")({
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceID),
  project: Schema.Struct({
    id: ProjectID,
    directory: AbsolutePath,
  }),
}) {}

export function response<S extends Schema.Top>(data: S) {
  return Schema.Struct({ location: Info, data })
}
```

`DataProvider` keys its store by `JSON.stringify([location.directory, location.workspaceID])` (data.tsx:50-52) computed from the **response's** `location`, and reads with the key from the **`/api/location` response** (`defaultLocation`, data.tsx:76-78,464-474). See Trap T1.

### 1.4 Content type, empty bodies, and errors

- A response interceptor **throws** on `content-type: text/html`: `"Request is not supported by this version of OpenCode Server (Server responded with text/html)"` (`vendor/opencode/packages/sdk/js/src/v2/client.ts:84-90`). Always return `application/json` (exact string; the check is `contentType === "text/html"`).
- `204` or `Content-Length: 0` parses to `{}` client-side (`vendor/opencode/packages/sdk/js/src/v2/gen/client/client.gen.ts:133-157`). A `200` with an empty body also parses to `{}` (client.gen.ts:167-173).
- Non-2xx: body is parsed as JSON if possible, else text (client.gen.ts:200-208). With `throwOnError: true` (all DataProvider calls use it) the error is wrapped in `Error` whose message is taken from `body.data.message` → `body.message` → `body.name` → `"<METHOD> <url> → <status>"` (`vendor/opencode/packages/sdk/js/src/error-interceptor.ts:14-43`).
- v2 error bodies use an **`_tag` discriminator** (unlike v1's `name`/`data`). Verbatim from `vendor/opencode/packages/protocol/src/errors.ts`:

| `_tag` | status | extra fields | errors.ts |
|---|---|---|---|
| `InvalidRequestError` | 400 | `message`, `kind?`, `field?` | :3-11 |
| `UnauthorizedError` | 401 | `message` | :13-17 |
| `ConflictError` | 409 | `message`, `resource?` | :19-26 |
| `ServiceUnavailableError` | 503 | `message`, `service?` | :28-35 |
| `UnknownError` | 500 | `message`, `ref?` | :37-44 |
| `ProviderNotFoundError` | 404 | `providerID`, `message` | :46-53 |
| `SessionNotFoundError` | 404 | `sessionID`, `message` | :55-62 |
| `MessageNotFoundError` | 404 | `sessionID`, `messageID`, `message` | :64-72 |
| `InvalidCursorError` | 400 | `message` | :74-78 |
| `PermissionNotFoundError` | 404 | `requestID`, `message` | :80-87 |
| `QuestionNotFoundError` | 404 | `requestID`, `message` | :89-96 |

Example 404 body: `{"_tag":"SessionNotFoundError","sessionID":"ses_x","message":"Session not found: ses_x"}`.

- Auth: if `attach --password` is used, requests carry basic auth headers (`attach.ts:114`); otherwise no auth. 401 body is `{"_tag":"UnauthorizedError","message":…}`.

### 1.5 Session-location middleware (all `/api/session/{sessionID}/…` routes)

Session-scoped routes ignore location query params; the reference server resolves the location **from the session row** (`vendor/opencode/packages/server/src/middleware/session-location.ts:30-66`):
- `sessionID` path param must decode against `SessionID` = string starting with `"ses"` (`vendor/opencode/packages/schema/src/session-id.ts:5-14`); otherwise **400** `{"_tag":"InvalidRequestError","message":"Invalid session ID","field":"sessionID"}` (session-location.ts:34-42).
- Unknown session → **404** `SessionNotFoundError` (session-location.ts:49-53).

### 1.6 Where these routes live in the reference implementation

- Route/schema definitions: `vendor/opencode/packages/protocol/src/groups/*.ts` (composed in `vendor/opencode/packages/protocol/src/api.ts:37-64`).
- Handlers: `vendor/opencode/packages/server/src/handlers/*.ts` (merged in `vendor/opencode/packages/server/src/handlers.ts:21-40`).
- The real opencode instance server mounts exactly these via `ServerApi = makeApi(...)` (`vendor/opencode/packages/opencode/src/server/routes/instance/httpapi/api.ts:48-52,80-84`) and provides the same `@opencode-ai/server/handlers` (`…/httpapi/server.ts:102,178`).

---

## 2. Route-by-route contract

Legend for “TUI usage”: **mount** = fetched once in `onMount` (data.tsx:551-565); **event:X** = re-fetched when event X arrives; **unused** = generated client + DataProvider method exist but nothing calls them in v1.17.19.

---

### 2.1 `GET /api/location`

- Client: `sdk.client.v2.location.get({ location? })` — sdk.gen.ts:5038-5059 (`url: "/api/location"` at 5055). Query: optional deepObject `location[directory]`, `location[workspace]`.
- Protocol: `vendor/opencode/packages/protocol/src/groups/location.ts:29-42`; handler `vendor/opencode/packages/server/src/handlers/location.ts:6-18` (echoes the middleware-resolved location).
- Response (200) — **bare `LocationInfo`, no `data` envelope** (types.gen.ts:11281-11286):

```ts
// types.gen.ts:3857-3864 (verbatim)
export type LocationInfo = {
  directory: string
  workspaceID?: string
  project: {
    id: string
    directory: string
  }
}
```

- Errors: 400 `InvalidRequestError`, 401 `UnauthorizedError` (types.gen.ts:11268-11277).
- Minimal shim JSON (directory should be the canonical working dir the shim serves):

```json
{ "directory": "/abs/work/dir", "project": { "id": "global", "directory": "/abs/work/dir" } }
```

- TUI usage: **mount** (data.tsx:553 → 468-474). Dereferenced fields: `response.data` itself, then `location.directory` and `location.workspaceID` (data.tsx:470-473) — `directory` missing ⇒ `defaultLocation` becomes `{directory: undefined,…}` and every later `list()` lookup misses (blank data, no crash). `project` is **not** read by the TUI but is required by the reference schema — include it. `projectID`/`project.id` semantics: `"global"` is the reference default project id (`vendor/opencode/packages/schema/src/project-id.ts:4-7`).

---

### 2.2 `GET /api/agent`

- Client: `sdk.client.v2.agent.list({ location? })` — sdk.gen.ts:5061-5083 (`url: "/api/agent"` at 5079).
- Protocol: `vendor/opencode/packages/protocol/src/groups/agent.ts:7-20`; handler `vendor/opencode/packages/server/src/handlers/agent.ts:7-13` (returns all registered agents, wrapped by `response()`).
- Response (200) (types.gen.ts:11315-11322):

```ts
200: { location: LocationInfo; data: Array<AgentV2Info> }
```

```ts
// types.gen.ts:3887-3898 (verbatim)
export type AgentV2Info = {
  id: string
  model?: ModelRef
  request: ProviderRequest      // types.gen.ts:3866-3873: { headers: {[k:string]:string}, body: {[k:string]:unknown} }
  system?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  color?: AgentColor            // types.gen.ts:3875: string | "primary" | ... | "info" (hex "#rrggbb" or named)
  steps?: number
  permissions: PermissionV2Ruleset  // types.gen.ts:3879-3885: Array<{action:string; resource:string; effect:"allow"|"deny"|"ask"}>
}
```

Source Effect schema: `vendor/opencode/packages/schema/src/agent.ts:19-31`.

- Minimal shim JSON:

```json
{ "location": { "directory": "/abs/work/dir", "project": { "id": "global", "directory": "/abs/work/dir" } }, "data": [] }
```

A non-empty realistic entry: `{"id":"build","request":{"headers":{},"body":{}},"mode":"primary","hidden":false,"permissions":[]}`.

- TUI usage: **mount** (data.tsx:554 → 479-483). Dereferenced: `result.data.location` (crash if absent, Trap T2), `result.data.data` (stored). No UI reads `data.location[*].agent` at this pin (agent picker uses v1 `sync` — `vendor/opencode/packages/tui/src/context/sync.tsx:462`).

---

### 2.3 `GET /api/command`

- Client: `sdk.client.v2.command.list({ location? })` — sdk.gen.ts:6501-6524 (`url: "/api/command"` at 6518).
- Protocol: `vendor/opencode/packages/protocol/src/groups/command.ts:7-21`; handler `vendor/opencode/packages/server/src/handlers/command.ts:6-8`.
- Response (200) (types.gen.ts:12914-12922): `{ location: LocationInfo; data: Array<CommandV2Info> }`

```ts
// types.gen.ts:5002-5009 (verbatim)
export type CommandV2Info = {
  name: string
  template: string
  description?: string
  agent?: string
  model?: ModelRef
  subtask?: boolean
}
```

Source schema: `vendor/opencode/packages/schema/src/command.ts:7-15`.

- Minimal shim JSON: same envelope as 2.2 with `"data": []`.
- TUI usage: **mount** (data.tsx:559 → 489-493). Store is never read by UI (command palette uses v1 `sync` — sync.tsx:517).

---

### 2.4 `GET /api/skill`

- Client: `sdk.client.v2.skill.list({ location? })` — sdk.gen.ts:6526-6549 (`url: "/api/skill"` at 6542).
- Protocol: `vendor/opencode/packages/protocol/src/groups/skill.ts:7-21`; handler `vendor/opencode/packages/server/src/handlers/skill.ts:6-8`.
- Response (200) (types.gen.ts:12951-12959): `{ location: LocationInfo; data: Array<SkillV2Info> }`

```ts
// types.gen.ts:5011-5017 (verbatim)
export type SkillV2Info = {
  name: string
  description?: string
  slash?: boolean
  location: string   // AbsolutePath of the skill file — schema/src/skill.ts:20-26
  content: string
}
```

- Minimal shim JSON: envelope + `"data": []`.
- TUI usage: **mount** (data.tsx:560 → 542-546). Store unused by UI at this pin.

---

### 2.5 `GET /api/reference` — **the one location list the TUI actually reads**

- Client: `sdk.client.v2.reference.list({ location? })` — sdk.gen.ts:6850-6873 (`url: "/api/reference"` at 6867).
- Protocol: `vendor/opencode/packages/protocol/src/groups/reference.ts:7-21`; handler `vendor/opencode/packages/server/src/handlers/reference.ts:6-8`.
- Response (200) (types.gen.ts:13468-13476): `{ location: LocationInfo; data: Array<ReferenceInfo> }`

```ts
// types.gen.ts:6137-6143 (verbatim)
export type ReferenceInfo = {
  name: string
  path: string          // AbsolutePath
  description?: string
  hidden?: boolean
  source: ReferenceSource
}
// types.gen.ts:6121-6135
export type ReferenceLocalSource = { type: "local"; path: string; description?: string; hidden?: boolean }
export type ReferenceGitSource   = { type: "git"; repository: string; branch?: string; description?: string; hidden?: boolean }
export type ReferenceSource = ReferenceLocalSource | ReferenceGitSource
```

Source schema: `vendor/opencode/packages/schema/src/reference.ts:11-38`.

- Minimal shim JSON: envelope + `"data": []`.
- TUI usage: **mount** (data.tsx:558 → 532-536) + **event:`reference.updated`** (data.tsx:392-394 — note this refresh is a floating promise, Trap T3). Consumed by autocomplete: `data.location.reference.list() ?? []` then `.find(item => !item.hidden && item.name === alias)` (autocomplete.tsx:280-288) — fields read: **`name`, `hidden`** (plus downstream `path` when a reference matches). Missing store entry is safe (`?? []`).

---

### 2.6 `GET /api/integration`

- Client: `sdk.client.v2.integration.list({ location? })` — sdk.gen.ts:6175-6196 (`url: "/api/integration"` at 6192).
- Protocol: `vendor/opencode/packages/protocol/src/groups/integration.ts:11-24`; handler `vendor/opencode/packages/server/src/handlers/integration.ts:21-28`.
- Response (200) (types.gen.ts:12183-12191): `{ location: LocationInfo; data: Array<IntegrationInfo> }`

```ts
// types.gen.ts:4929-4934 (verbatim)
export type IntegrationInfo = {
  id: string
  name: string
  methods: Array<IntegrationMethod>   // types.gen.ts:3020: IntegrationOAuthMethod | IntegrationKeyMethod | IntegrationEnvMethod
  connections: Array<ConnectionInfo>  // types.gen.ts:4927: ConnectionCredentialInfo | ConnectionEnvInfo
}
// types.gen.ts:4899-4925
export type IntegrationOAuthMethod = { id: string; type: "oauth"; label: string; prompts?: Array<IntegrationTextPrompt | IntegrationSelectPrompt> }
export type IntegrationKeyMethod   = { type: "key"; label?: string }
export type IntegrationEnvMethod   = { type: "env"; names: Array<string> }
export type ConnectionCredentialInfo = { type: "credential"; id: string; label: string }
export type ConnectionEnvInfo        = { type: "env"; name: string }
```

Source schema: `vendor/opencode/packages/schema/src/integration.ts:96-101` (Info), 17-75 (methods/prompts).

- Minimal shim JSON: envelope + `"data": []`.
- TUI usage: **mount** (data.tsx:555 → 499-506) + **event:`integration.updated`** (data.tsx:395-401, floating promise — Trap T3). Store unused by UI at this pin.

---

### 2.7 `GET /api/model`

- Client: `sdk.client.v2.model.list({ location? })` — sdk.gen.ts:5875-5897 (`url: "/api/model"` at 5893).
- Protocol: `vendor/opencode/packages/protocol/src/groups/model.ts:8-23`; handler `vendor/opencode/packages/server/src/handlers/model.ts:7-17` — returns `catalog.model.available()` ("available models ordered by release date").
- Errors: 400/401/**503 `ServiceUnavailableError`** (types.gen.ts:12041-12054 — the reference server 503s while the catalog is warming up).
- Response (200) (types.gen.ts:12058-12066): `{ location: LocationInfo; data: Array<ModelV2Info> }`

```ts
// types.gen.ts:4807-4842 (verbatim)
export type ModelV2Info = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ModelApi
  capabilities: ModelCapabilities
  request: {
    headers: { [key: string]: string }
    body: { [key: string]: unknown }
    variant?: string
  }
  variants: Array<{
    id: string
    headers: { [key: string]: string }
    body: { [key: string]: unknown }
  }>
  time: { released: number }
  cost: Array<ModelCost>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}
// types.gen.ts:4769-4805
export type ModelApi =
  | { id: string; type: "aisdk"; package: string; url?: string; settings?: { [key: string]: unknown } }
  | { id: string; type: "native"; url?: string; settings: { [key: string]: unknown } }
export type ModelCapabilities = { tools: boolean; input: Array<string>; output: Array<string> }
export type ModelCost = {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}
```

Source schema: `vendor/opencode/packages/schema/src/model.ts:59-106`. Note the schema's own `empty()` factory (model.ts:89-105) shows the minimal valid model:

```json
{
  "id": "claude-sonnet-4-5", "providerID": "anthropic", "name": "claude-sonnet-4-5",
  "api": { "id": "claude-sonnet-4-5", "type": "native", "settings": {} },
  "capabilities": { "tools": false, "input": [], "output": [] },
  "request": { "headers": {}, "body": {} },
  "variants": [], "time": { "released": 0 }, "cost": [],
  "status": "active", "enabled": true, "limit": { "context": 0, "output": 0 }
}
```

- Minimal shim JSON: envelope + `"data": []`.
- TUI usage: **mount** (data.tsx:556 → 512-516) + **event:`catalog.updated`** (data.tsx:126-131) + **event:`integration.updated`** (data.tsx:398). **The model picker does NOT read this** — `dialog-model.tsx` uses v1 `sync.data.provider` from `GET /config/providers` (`vendor/opencode/packages/tui/src/component/dialog-model.tsx:10,14,32-62`; populated at sync.tsx:452). So `/api/model` may return `[]` without affecting the picker. Relationship to v1: v1 `/config/providers` returns `{providers: Provider[], default: {...}}` with `provider.models` as a **map**; v2 `/api/model` returns a flat array of `ModelV2Info` with `providerID` back-references — they are parallel surfaces over the same catalog, not derived from each other client-side.

---

### 2.8 `GET /api/provider` and `GET /api/provider/{providerID}`

- Client: `sdk.client.v2.provider.list({ location? })` — sdk.gen.ts:5900-5921 (`url: "/api/provider"` at 5917); `sdk.client.v2.provider.get({ providerID, location? })` — sdk.gen.ts:5923-5956 (`url: "/api/provider/{providerID}"` at 5950).
- Protocol: `vendor/opencode/packages/protocol/src/groups/provider.ts:8-39`; handler `vendor/opencode/packages/server/src/handlers/provider.ts:8-32` (`catalog.provider.available()`; get → 404 `ProviderNotFoundError` when unknown).
- Errors: list 400/401/503 (types.gen.ts:12082-12095); get additionally 404 `ProviderNotFoundError` (types.gen.ts:12125-12144).
- Response (200) list (types.gen.ts:12099-12107): `{ location: LocationInfo; data: Array<ProviderV2Info> }`; get (types.gen.ts:12145-12153): `{ location: LocationInfo; data: ProviderV2Info }`.

```ts
// types.gen.ts:4864-4871 (verbatim)
export type ProviderV2Info = {
  id: string
  integrationID?: string
  name: string
  disabled?: boolean
  api: ProviderApi   // types.gen.ts:4845-4862: {type:"aisdk"; package:string; url?; settings?} | {type:"native"; url?; settings:{...}}
  request: ProviderRequest  // { headers: {...}, body: {...} }
}
```

Source schema: `vendor/opencode/packages/schema/src/provider.ts:52-72`; minimal valid provider per its `empty()` factory (provider.ts:63-71):

```json
{ "id": "anthropic", "name": "anthropic", "api": { "type": "native", "settings": {} }, "request": { "headers": {}, "body": {} } }
```

- Minimal shim JSON (list): envelope + `"data": []`.
- TUI usage: list — **mount** (data.tsx:557 → 522-526) + **event:`catalog.updated`** + **event:`integration.updated`**. `provider.get` — **unused** by the TUI. Model picker uses v1 (see 2.7).

---

### 2.9 `GET /api/session` (list)

- Client: `sdk.client.v2.session.list({...})` — sdk.gen.ts:5430-5468 (`url: "/api/session"` at 5463). Query params (all optional; types.gen.ts:11327-11343): `workspace`, `limit` (number-from-string), `order` (`"asc" | "desc"`), `search`, `directory` (absolute path), `project` (project id), `subpath`, `cursor` (opaque).
- Protocol: `vendor/opencode/packages/protocol/src/groups/session.ts:98-127`; handler `vendor/opencode/packages/server/src/handlers/session.ts:24-66`. Default `limit` = **50** (session.ts handler:16,36). Cursor = base64url of a JSON `{...query, anchor:{id, time, direction:"previous"|"next"}}` (protocol groups/session.ts:55-80; handler 43-63). Invalid cursor → 400 `InvalidCursorError`.
- Response (200) (types.gen.ts:11359-11365 → 2680-2686):

```ts
// types.gen.ts:2680-2686 (verbatim)
export type SessionsResponse = {
  data: Array<SessionV2Info>
  cursor: {
    previous?: string
    next?: string
  }
}
```

Note: **no `location` envelope** here, and `cursor` is a required key (`{}` is fine when empty).

```ts
// types.gen.ts:3900-3927 (verbatim)
export type SessionV2Info = {
  id: string           // must start with "ses" — schema/src/session-id.ts:5
  parentID?: string
  projectID: string
  agent?: string
  model?: ModelRef     // types.gen.ts:3033-3037: { id: string; providerID: string; variant?: string }
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  time: { created: number; updated: number; archived?: number }   // epoch millis — schema/src/schema.ts:25-30 (DateTimeUtcFromMillis)
  title: string
  location: LocationRef   // types.gen.ts:3039-3042: { directory: string; workspaceID?: string }
  subpath?: string
  revert?: RevertState    // types.gen.ts:3109-3115: { messageID: string; partID?: string; snapshot?: string; diff?: string; files?: FileDiff[] }
}
```

Source schema: `vendor/opencode/packages/schema/src/session.ts:18-44`.

- Minimal shim JSON: `{ "data": [], "cursor": {} }`. Minimal session object:

```json
{
  "id": "ses_shim000001", "projectID": "global", "cost": 0,
  "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
  "time": { "created": 1760000000000, "updated": 1760000000000 },
  "title": "New session", "location": { "directory": "/abs/work/dir" }
}
```

- TUI usage: **unused** in v1.17.19 (no caller of `v2.session.list`; the session list dialog uses v1 `sync.data.session` — `vendor/opencode/packages/tui/src/component/dialog-session-list.tsx:80-81`).

### 2.9b `GET /api/session/active`

- Client: `sdk.client.v2.session.active()` — sdk.gen.ts:5506-5519 (`url: "/api/session/active"` at 5515). Handler: session.ts handler:80-89.
- Response (200): `{ data: { [sessionID]: { "type": "running" } } }` (protocol groups/session.ts:83-85,146-156; types.gen.ts:11424-11433).
- Minimal shim JSON: `{ "data": {} }`. TUI usage: **unused**.

---

### 2.10 `GET /api/session/{sessionID}`

- Client: `sdk.client.v2.session.get({ sessionID })` — sdk.gen.ts:5521-5537 (`url: "/api/session/{sessionID}"` at 5533).
- Protocol: groups/session.ts:157-171 (session-location middleware); handler session.ts handler:90-106.
- Response (200) (types.gen.ts:11463-11471): `{ data: SessionV2Info }` (schema as in 2.9). Errors: 400 (bad `ses` prefix), 401, 404 `SessionNotFoundError`.
- Minimal shim JSON: `{ "data": { …SessionV2Info as above… } }`.
- TUI usage: `DataProvider.session.refresh` (data.tsx:421-424) — dereferences `result.data.data` — but **no caller at this pin** (session UI uses v1 `sdk.client.session.get`, sync.tsx:596).

---

### 2.11 `GET /api/session/{sessionID}/message` (list) — the projected-message read

- Client: `sdk.client.v2.session.messages({ sessionID, limit?, order?, cursor? })` — sdk.gen.ts:5826-5858 (`url: "/api/session/{sessionID}/message"` at 5854).
- Protocol: `vendor/opencode/packages/protocol/src/groups/message.ts:7-45`; handler `vendor/opencode/packages/server/src/handlers/message.ts:27-81`.
  - Default `limit` = **50** (handler:8,44); max 200, min 1 (protocol message.ts:8-12).
  - Default `order` = **`"desc"`** (newest first) when neither `order` nor `cursor` given (handler:40).
  - `cursor` + `order` together → 400 `InvalidCursorError` `"Cursor cannot be combined with order"` (handler:34-35).
  - Cursor format (server-defined, opaque to clients): base64url of `{"id":"<messageID>","order":"asc"|"desc","direction":"previous"|"next"}` (handler:10-25). `cursor.previous` anchors at the first returned item, `cursor.next` at the last (handler:69-77).
- Response (200) (types.gen.ts:12020-12025 → 2771-2777):

```ts
// types.gen.ts:2771-2777 (verbatim)
export type SessionMessagesResponse = {
  data: Array<SessionMessage>
  cursor: {
    previous?: string
    next?: string
  }
}
```

**IMPORTANT:** this is *not* the v1 `{info, parts}[]` shape. v2 messages are a flat discriminated union ("projected messages"):

```ts
// types.gen.ts:4150-4158 (verbatim)
export type SessionMessage =
  | SessionMessageAgentSwitched
  | SessionMessageModelSwitched
  | SessionMessageUser
  | SessionMessageSynthetic
  | SessionMessageSystem
  | SessionMessageShell
  | SessionMessageAssistant
  | SessionMessageCompaction
```

All variants share `id`, `metadata?: {[k:string]:unknown}`, `time: {created: number}` plus:

```ts
// types.gen.ts:3944-3966
export type SessionMessageAgentSwitched = { …; type: "agent-switched"; agent: string }
export type SessionMessageModelSwitched = { …; type: "model-switched"; model: ModelRef }
// types.gen.ts:3968-3980
export type SessionMessageUser = { …; type: "user"; text: string; files?: Array<PromptFileAttachment>; agents?: Array<PromptAgentAttachment> }
// types.gen.ts:3982-3993
export type SessionMessageSynthetic = { …; sessionID: string; text: string; type: "synthetic" }
// types.gen.ts:3995-4005
export type SessionMessageSystem = { …; type: "system"; text: string }
// types.gen.ts:4007-4020  (time also has completed?: number)
export type SessionMessageShell = { …; type: "shell"; callID: string; command: string; output: string }
// types.gen.ts:4136-4148
export type SessionMessageCompaction = { type: "compaction"; reason: "auto" | "manual"; summary: string; recent: string; … }

// types.gen.ts:4104-4134 (verbatim)
export type SessionMessageAssistant = {
  id: string
  metadata?: { [key: string]: unknown }
  time: { created: number; completed?: number }
  type: "assistant"
  agent: string
  model: ModelRef
  content: Array<SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool>
  snapshot?: { start?: string; end?: string; files?: Array<string> }
  finish?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: SessionErrorUnknown   // types.gen.ts:3063-3066: { type: "unknown"; message: string }
}

// assistant content items:
// types.gen.ts:4022-4026
export type SessionMessageAssistantText = { type: "text"; id: string; text: string }
// types.gen.ts:4028-4037
export type SessionMessageAssistantReasoning = { type: "reasoning"; id: string; text: string; providerMetadata?: LlmProviderMetadata; time?: { created: number; completed?: number } }
// types.gen.ts:4082-4102
export type SessionMessageAssistantTool = {
  type: "tool"
  id: string        // this is the callID (data.tsx:107-110 matches tool items by item.id === callID)
  name: string
  provider?: { executed: boolean; metadata?: LlmProviderMetadata; resultMetadata?: LlmProviderMetadata }
  state: SessionMessageToolStatePending | SessionMessageToolStateRunning | SessionMessageToolStateCompleted | SessionMessageToolStateError
  time: { created: number; ran?: number; completed?: number; pruned?: number }
}
// tool states — types.gen.ts:4039-4080
export type SessionMessageToolStatePending   = { status: "pending"; input: string }
export type SessionMessageToolStateRunning   = { status: "running"; input: {[k:string]:unknown}; structured: {[k:string]:unknown}; content: Array<LlmToolContent> }
export type SessionMessageToolStateCompleted = { status: "completed"; input: {[k:string]:unknown}; attachments?: Array<PromptFileAttachment>; content: Array<LlmToolContent>; outputPaths?: Array<string>; structured: {[k:string]:unknown}; result?: unknown }
export type SessionMessageToolStateError     = { status: "error"; input: {[k:string]:unknown}; content: Array<LlmToolContent>; structured: {[k:string]:unknown}; error: SessionErrorUnknown; result?: unknown }
// types.gen.ts:3074-3086
export type ToolTextContent = { type: "text"; text: string }
export type ToolFileContent = { type: "file"; uri: string; mime: string; name?: string }
export type LlmToolContent = ToolTextContent | ToolFileContent
// types.gen.ts:3050-3062
export type PromptFileAttachment = { uri: string; mime: string; name?: string; description?: string; source?: PromptSource }  // PromptSource: {start,end,text} types.gen.ts:3044-3048
export type PromptAgentAttachment = { name: string; source?: PromptSource }
```

- Errors: 400 `InvalidCursorError`/`InvalidRequestError`, 401, 404 `SessionNotFoundError`, 500 `UnknownError` (protocol message.ts:36).
- Minimal shim JSON: `{ "data": [], "cursor": {} }`.
- TUI usage: `DataProvider.session.message.refresh` (data.tsx:429-432, no pagination params → server defaults limit=50/order=desc) — **no caller at this pin**. The live message store is instead populated incrementally from `session.next.*` SSE events (data.tsx:132-403), whose reducers mirror this exact shape. The session transcript UI uses v1 `sdk.client.session.messages({limit:100})` (sync.tsx:597).

### 2.11b `GET /api/session/{sessionID}/message/{messageID}`

- Client: `sdk.client.v2.session.message({ sessionID, messageID })` — sdk.gen.ts:5796-5824 (`url` at 5820). Handler session.ts handler:372-383. Response `{ data: SessionMessage }` (types.gen.ts:9906-9914); 404 `MessageNotFoundError` when unknown. TUI usage: **unused**.

---

### 2.12 `GET /api/session/{sessionID}/permission`

- Client: `sdk.client.v2.session.permission.list({ sessionID })` — sdk.gen.ts:5171-5194 (`url: "/api/session/{sessionID}/permission"` at 5189).
- Protocol: `vendor/opencode/packages/protocol/src/groups/permission.ts:88-102`; handler `vendor/opencode/packages/server/src/handlers/permission.ts:52-58` (pending requests owned by the session).
- Response (200) (types.gen.ts:12637-12645): `{ data: Array<PermissionV2Request> }` — **no location envelope**.

```ts
// types.gen.ts:4978-4988 (verbatim)
export type PermissionV2Request = {
  id: string            // starts with "per" — schema/src/permission.ts:10-13
  sessionID: string
  action: string
  resources: Array<string>
  save?: Array<string>
  metadata?: { [key: string]: unknown }
  source?: PermissionV2Source   // types.gen.ts:3117-3121: { type: "tool"; messageID: string; callID: string }
}
```

Source schema: `vendor/opencode/packages/schema/src/permission.ts:25-38`.

- Errors: 400, 401, 404 `SessionNotFoundError`.
- Minimal shim JSON: `{ "data": [] }`.
- TUI usage: `DataProvider.session.permission.refresh` (data.tsx:438-441) — **no caller at this pin** (permission UI is v1, `vendor/opencode/packages/tui/src/context/permission.tsx` / sync.tsx:193).

---

### 2.13 `GET /api/session/{sessionID}/question`

- Client: `sdk.client.v2.session.question.list({ sessionID })` — sdk.gen.ts:5326-5348 (`url: "/api/session/{sessionID}/question"` at 5344).
- Protocol: `vendor/opencode/packages/protocol/src/groups/question.ts:36-50`; handler `vendor/opencode/packages/server/src/handlers/question.ts:32-38` (filters global pending list by sessionID).
- Response (200) (types.gen.ts:13360-13368): `{ data: Array<QuestionV2Request> }` — no location envelope.

```ts
// types.gen.ts:6103-6111 (verbatim)
export type QuestionV2Request = {
  id: string            // starts with "que" — schema/src/question.ts:10-13
  sessionID: string
  questions: Array<QuestionV2Info>
  tool?: QuestionV2Tool // types.gen.ts:3153-3156: { messageID: string; callID: string }
}
// types.gen.ts:3136-3151
export type QuestionV2Info = {
  question: string
  header: string        // "Very short label (max 30 chars)"
  options: Array<QuestionV2Option>   // types.gen.ts:3125-3134: { label: string; description: string }
  multiple?: boolean
  custom?: boolean
}
```

- Errors: 400, 401, 404 `SessionNotFoundError`.
- Minimal shim JSON: `{ "data": [] }`.
- TUI usage: `DataProvider.session.question.refresh` (data.tsx:447-450) — **no caller at this pin**.

---

### 2.14 `GET /api/permission/saved`

- Client: `sdk.client.v2.permission.saved.list({ projectID? })` — sdk.gen.ts:6347-6370 (`url: "/api/permission/saved"` at 6365). Query: optional `?projectID=`.
- Protocol: groups/permission.ts:37-47; handler permission.ts handler:79-89 — **when `projectID` is omitted it defaults to the location-resolved project id** (handler:85: `ctx.query.projectID ?? location.project.id`).
- Response (200) (types.gen.ts:12569-12577): `{ data: Array<PermissionSavedInfo> }`.

```ts
// types.gen.ts:4990-4995 (verbatim)
export type PermissionSavedInfo = {
  id: string          // "psv_…" — schema/src/permission-saved.ts:8-11
  projectID: string
  action: string
  resource: string
}
```

- Minimal shim JSON: `{ "data": [] }`.
- TUI usage: `DataProvider.project.permission.refresh(projectID)` (data.tsx:458-461) — **no caller at this pin**. Companion write: `DELETE /api/permission/saved/{id}` → 204 (sdk.gen.ts:6372-6395, types.gen.ts:12602-12608).

---

### 2.15 `GET /api/fs/find` (used by prompt autocomplete — not DataProvider)

- Client: `sdk.client.v2.fs.find({ query, type?, limit?, location? })` — sdk.gen.ts:6460-6500 (`url: "/api/fs/find"` at 6494). The TUI calls it per keystroke of `@`-mention autocomplete with `limit: "20"` (a string — query params are strings; server decodes NumberFromString) and explicit `location` (autocomplete.tsx:324-333).
- Protocol: `vendor/opencode/packages/protocol/src/groups/fs.ts:13-18,49-62`; handler `vendor/opencode/packages/server/src/handlers/fs.ts:30-37`.
- Response (200) (types.gen.ts:12877-12885): `{ location: LocationInfo; data: Array<FileSystemEntry> }`

```ts
// types.gen.ts:4997-5000 (verbatim)
export type FileSystemEntry = {
  path: string                    // RelativePath to location.directory
  type: "file" | "directory"
}
```

- Minimal shim JSON: envelope + `"data": []`.
- TUI usage: fetched on demand while typing; called **without** `throwOnError` — errors are tolerated (`if (!result.error && result.data)`, autocomplete.tsx:337). **Deref risk:** on success it computes `path.join(result.data.location.directory, item.path)` (autocomplete.tsx:343) — if `location` is missing while `data` is non-empty, autocomplete crashes. Empty `data` with a valid envelope is always safe.
- Siblings (same envelope, **unused by the TUI**): `GET /api/fs/list` (`?path=` relative dir; sdk.gen.ts:6457) and `GET /api/fs/read/*` (raw bytes, `HttpApiSchema.asUint8Array`, path after `/api/fs/read/` prefix — handler fs.ts:12-21 slices `pathname.slice(13)`).

---

### 2.16 Remaining `/api` GETs (schema exists; NOT used by the stock TUI — safe to 404 or stub)

| Route | Client method | Response shape | Source |
|---|---|---|---|
| `GET /api/health` | `v2.health.get()` sdk.gen.ts:5032 | `{ "healthy": true }` | protocol groups/health.ts:4-14; handler handlers/health.ts:5-7; types.gen.ts:11245-11252 |
| `GET /api/permission/request` | `v2.permission.request.list({location?})` sdk.gen.ts:6340 | `{ location, data: PermissionV2Request[] }` | groups/permission.ts:22-35 |
| `GET /api/question/request` | `v2.question.request.list({location?})` sdk.gen.ts:6836 | `{ location, data: QuestionV2Request[] }` | groups/question.ts:19-32 |
| `GET /api/session/{id}/permission/{requestID}` | `v2.session.permission.get` sdk.gen.ts:5276 | `{ data: PermissionV2Request }`, 404 `PermissionNotFoundError` | groups/permission.ts:104-117 |
| `GET /api/session/{id}/context` | (not in DataProvider) | `{ data: SessionMessage[] }` — messages after last compaction | groups/session.ts:291-305; handler session.ts:304-331 |
| `GET /api/session/{id}/history` | `v2.session.history` sdk.gen.ts:5741 | `{ data: SessionDurableEvent[], hasMore: boolean }`, `?limit<=100` default 50, `?after=<seq>` | groups/session.ts:306-325; handler session.ts:332-356; types.gen.ts:2764-2767 |
| `GET /api/session/{id}/event` | `v2.session.events` (SSE) sdk.gen.ts:5752-5775 | `text/event-stream` of `SessionEvent.Durable` after `?after=` | groups/session.ts:326-343 — events doc's area |
| `GET /api/event` | `v2.event.subscribe` (SSE) sdk.gen.ts:6550-6563 | `text/event-stream` of `V2Event` | groups/event.ts — events doc's area |
| `GET /api/pty` (+ pty CRUD) | `v2.pty.*` sdk.gen.ts:6565+ | pty listing | groups/pty.ts — not used by TUI reads |
| `GET /api/integration/{id}`, `/api/integration/attempt/{id}` | `v2.integration.get` / `.attempt.status` | `{ location, data: … }` | groups/integration.ts:26-39; note `integration.get` success schema is `Location.response(Schema.UndefinedOr(Integration.Info))` — `data` may be absent |

The TUI also **never calls `GET /api/health`**; connectivity checks use v1 (`use-connected.tsx` / global SSE).

---

## 3. Traced consumption summary (what actually must not break)

| Route | When fetched | Fields dereferenced by client code | Failure blast radius |
|---|---|---|---|
| `/api/location` | mount, once | `data.directory`, `data.workspaceID` (data.tsx:470-473) | caught by `allSettled`; wrong/missing `directory` silently breaks all `location.*.list()` lookups (key mismatch) |
| `/api/agent` | mount | `data.location` → `locationKey` (data.tsx:481), `data.data` | `data.location` missing ⇒ TypeError inside refresh ⇒ rejected promise (mount: logged; event: unhandled) |
| `/api/command` | mount | same | same |
| `/api/skill` | mount | same | same |
| `/api/integration` | mount + `integration.updated` | same | event-path rejection is a **floating promise** (data.tsx:396-400) |
| `/api/model` | mount + `catalog.updated` + `integration.updated` | same | floating promise on event path (data.tsx:127-130) |
| `/api/provider` | mount + `catalog.updated` + `integration.updated` | same | floating promise on event path |
| `/api/reference` | mount + `reference.updated` | same; then UI reads `item.name`, `item.hidden` (autocomplete.tsx:287-288) | floating promise on event path (data.tsx:393) |
| `/api/fs/find` | per autocomplete keystroke | `data.data[].path/.type`, `data.location.directory` (autocomplete.tsx:340-346) | non-2xx tolerated; malformed 200 crashes autocomplete |
| `/api/session*`, `/api/permission/saved`, session permission/question lists | never at this pin | (`result.data.data`) | n/a today; implement for forward-compat |

---

## 4. Copy-paste minimal shim responses

Assume the shim's canonical directory is `DIR` and it always echoes it. `PROJECT = { "id": "global", "directory": DIR }`, `LOC = { "directory": DIR, "project": PROJECT }`.

```
GET /api/location                              → 200 LOC
GET /api/agent                                 → 200 { "location": LOC, "data": [] }
GET /api/command                               → 200 { "location": LOC, "data": [] }
GET /api/skill                                 → 200 { "location": LOC, "data": [] }
GET /api/reference                             → 200 { "location": LOC, "data": [] }
GET /api/integration                           → 200 { "location": LOC, "data": [] }
GET /api/model                                 → 200 { "location": LOC, "data": [] }
GET /api/provider                              → 200 { "location": LOC, "data": [] }
GET /api/fs/find?query=…                       → 200 { "location": LOC, "data": [] }
GET /api/health                                → 200 { "healthy": true }
GET /api/session                               → 200 { "data": [], "cursor": {} }
GET /api/session/active                        → 200 { "data": {} }
GET /api/session/{sid}                         → 200 { "data": <SessionV2Info> }   | 404 {"_tag":"SessionNotFoundError","sessionID":sid,"message":"Session not found: "+sid}
GET /api/session/{sid}/message                 → 200 { "data": [], "cursor": {} }
GET /api/session/{sid}/permission              → 200 { "data": [] }
GET /api/session/{sid}/question                → 200 { "data": [] }
GET /api/permission/saved                      → 200 { "data": [] }
```

All with `Content-Type: application/json`.

---

## 5. Traps / gotchas

**T1 — locationKey byte-equality.** Store writes key on the *response envelope's* `location` (`locationKey(result.data.location)`, data.tsx:481,491,504,514,524,534,544); store reads key on the `/api/location`-derived `defaultLocation` (data.tsx:477,487 etc. via `locationKey(location ?? defaultLocation())`). `locationKey = JSON.stringify([directory, workspaceID])` (data.tsx:50-52). If `GET /api/location` returns `"/Users/x/proj"` but list envelopes echo `"/Users/x/proj/"` (trailing slash) or a symlink-resolved variant, every `list()` returns `undefined` forever, silently. Emit one canonical string everywhere. `workspaceID` left `undefined` on both sides is safe (`JSON.stringify` turns `undefined` array elements into `null` consistently). Until `/api/location` resolves, `defaultLocation` is `{directory: sdk.directory ?? process.cwd()}` (data.tsx:76-78) — the *TUI's* cwd — so if `/api/location` fails, data fetched under the server's echoed key is unreachable unless those strings coincide.

**T2 — `location` envelope is dereferenced before validation.** The hey-api client does **no** response schema validation; `result.data.location` is fed straight into `locationKey` which reads `.directory`. Omitting `location` in any of the seven list responses throws a `TypeError` inside `refresh()`. On mount it's swallowed by `Promise.allSettled` + `console.error` (data.tsx:552-564); on event-triggered refresh it becomes an **unhandled promise rejection** (see T3).

**T3 — event-triggered refreshes are floating promises.** `void Promise.all([model.refresh, provider.refresh])` on `catalog.updated` (data.tsx:127-130), `void reference.refresh()` on `reference.updated` (data.tsx:393), and the `integration.updated` trio (data.tsx:396-400) have no `.catch`. Every `refresh` uses `{ throwOnError: true }`. **Do not emit `catalog.updated`, `reference.updated`, or `integration.updated` over SSE unless the corresponding GET routes return valid 2xx JSON** — otherwise the TUI process gets unhandled rejections (fatal by default under Bun/Node ≥15).

**T4 — three different success envelopes.** (1) `/api/location` → bare `LocationInfo`; (2) location-scoped lists → `{location, data}`; (3) session-scoped reads → `{data}` (no location); (4) paginated lists (`/api/session`, `/api/session/{id}/message`) → `{data, cursor}` with `cursor` required (may be `{}` — schema marks `previous`/`next` optional, protocol groups/session.ts:113-116, groups/message.ts:31-34). Don't unify them.

**T5 — never return HTML.** The v2 client throws on `content-type === "text/html"` for **every** response (client.ts:84-90) — that's opencode's own "this server is too old" detection. A framework 404 page or SPA fallback will surface as that misleading error.

**T6 — GETs carry scoping in query, writes in headers.** Your route handlers must read `location[directory]`/`location[workspace]` query params on GETs and `x-opencode-directory` (URI-encoded, decode with `decodeURIComponent` guarded by try/catch — server location.ts:41-47) / `x-opencode-workspace` headers on POST/DELETE. The plain `?directory=` param also appears on `/api` GETs (rewrite adds both) but the reference v2 resolver ignores it.

**T7 — session ID validation order.** Reference behavior for `/api/session/{sessionID}/…`: malformed id (not `ses`-prefixed) → 400 `InvalidRequestError` with `field: "sessionID"`; well-formed but unknown → 404 `SessionNotFoundError` (middleware/session-location.ts:34-53). `opencode attach --session <id>` also pre-validates the id shape client-side and calls **v1** `GET /session/{id}` before the TUI even starts (`vendor/opencode/packages/opencode/src/cli/tui/validate-session.ts:23-29`).

**T8 — query params are strings.** `limit`, `after` etc. use `Schema.NumberFromString` (protocol groups/session.ts:27,89-92; groups/message.ts:8-9; groups/fs.ts:17). The TUI even passes `limit: "20"` as a literal string to fs.find (autocomplete.tsx:326). Parse numerics from strings; reject with 400 `InvalidRequestError` (`_tag`, `message`, optional `kind`) on garbage — the reference wraps schema failures via `schemaErrorLayer` into `InvalidRequestError` with a truncated reason (server/src/middleware/schema-error.ts:14-20).

**T9 — timestamps are epoch milliseconds.** All `time.*` fields on sessions/messages encode `DateTimeUtcFromMillis` → plain finite numbers over the wire (schema/src/schema.ts:25-30). Never ISO strings.

**T10 — the model picker illusion.** `/api/model` + `/api/provider` look load-bearing (they're fetched at startup and refreshed on catalog events) but in v1.17.19 **no UI reads them** — the model/provider dialogs read v1 `sync.data.provider` built from `GET /config/providers` + `GET /provider` (sync.tsx:452-453; dialog-model.tsx:32-62). Get the v1 catalog right first; keep v2 valid-but-empty. Same for `/api/agent` (v1 `GET /agent` via `sdk.client.app.agents`, sync.tsx:462) and `/api/command` (v1 `GET /command`, sync.tsx:517).

**T11 — messages list ordering + the store's expectation.** `DataProvider.session.message.refresh` replaces the whole store with the response array (data.tsx:430-431), and every event reducer *prepends* new messages (`message.prepend`, data.tsx:90-93) and searches with `find` from the front — i.e. the in-memory convention is **newest-first**, matching the server default `order=desc`. If you ever serve this route, default to newest-first.

**T12 — assistant tool items are keyed by call ID.** In `SessionMessageAssistantTool`, `id` **is** the tool callID (matching `session.next.tool.*` events' `callID` — data.tsx:106-110,266-343). Don't invent a separate part id.

**T13 — `/api/integration/{id}` may return `data: undefined`.** Protocol declares `Location.response(Schema.UndefinedOr(Integration.Info))` (groups/integration.ts:26-39) — encoded JSON simply omits `data`. The generated type (types.gen.ts:12222-12231) claims `data: IntegrationInfo`, so the *SDK type lies*; server source wins.

**T14 — 204 responses.** Companion writes in these groups (`permission.saved.remove`, question reply/reject, etc.) return true `204 No Content` (`HttpApiSchema.NoContent`); the client synthesizes `{}` as `data` (client.gen.ts:133-157). Don't send a JSON body with 204.
