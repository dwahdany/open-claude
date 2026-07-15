# 06 — Stub Endpoints, Error Contract, Auth, CORS

Scope: every **non-blocking** endpoint the stock opencode TUI (v1.17.19, `opencode attach <url>`) calls, plus lazy/user-action endpoints that must not crash the client, the error-shape contract, the `text/html` trap, unknown-route 404 behavior, basic-auth, CORS, and the WebSocket question.

All paths are repo-relative to `/Users/dariush/git/personal/open-claude`. `TUI` = `vendor/opencode/packages/tui`, `SDK` = `vendor/opencode/packages/sdk/js`, `SRV` = `vendor/opencode/packages/opencode/src/server`.

Companion docs: blocking bootstrap endpoints (`/config/providers`, `/provider`, `/agent`, `/config`, `/path`, `/project/current`) and the SSE event stream are covered elsewhere; they are only referenced here for sequencing.

---

## 1. Client mechanics you must understand before stubbing

### 1.1 Two call modes — tuple vs throwOnError

The generated hey-api client (`SDK/src/v2/gen/client/client.gen.ts`) has two result styles:

- **Tuple mode (default)**: non-2xx does NOT throw. The response body is read as text, `JSON.parse`d if possible, and returned as `{ error, request, response }` (client.gen.ts:202-232). Callers do `x.data ?? []` or check `result.error`. **A JSON 404/500 body is harmless in this mode.**
- **`{ throwOnError: true }`**: the parsed error body is thrown after passing through the error interceptor `wrapClientError` (client.gen.ts:222-224, SDK/src/error-interceptor.ts:13). `wrapClientError` builds a real `Error` whose message is extracted in this priority order (error-interceptor.ts:26-32):
  1. `body.data.message` (NamedError shape)
  2. `body.message` (`_tag` shape)
  3. `body.name`
  4. fallback `"METHOD URL → STATUS STATUSTEXT"`
  The original body and status live at `error.cause = { body, status }`.

### 1.2 The `text/html` trap (exact source)

`SDK/src/v2/client.ts:84-90` — a **response** interceptor that runs on EVERY response regardless of call mode:

```ts
client.interceptors.response.use((response) => {
  const contentType = response.headers.get("content-type")
  if (contentType === "text/html")
    throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

  return response
})
```

(Identical in the published package: `node_modules/@opencode-ai/sdk/dist/v2/client.js:74-75`.)

Key facts:
- The comparison is **strict equality** with `"text/html"`. `"text/html; charset=utf-8"` would NOT trigger it — but do not rely on that; just never serve HTML on API paths.
- The interceptor throw happens **outside** the fetch try/catch (client.gen.ts:118-122), so it rejects the request promise **even in tuple mode**. A single HTML response to any of the non-blocking bootstrap calls rejects the whole `Promise.all` in sync.tsx (see §2.3) with **no `.catch`** → unhandled rejection + `sync.status` stuck at `"partial"`.
- Why it exists: the real server's final route is a `/*` catch-all that serves the opencode web UI (`SRV/routes/instance/httpapi/server.ts:194-203`, `SRV/shared/ui.ts:80-108`) — unknown API paths on old servers returned `index.html`. Your shim must instead return JSON 404s (see §5.5).

### 1.3 Empty-body parsing gotcha

client.gen.ts:133-158: on `204` or `Content-Length: 0`, JSON `data` becomes `{}` — an **empty object, not an array**. `x.data ?? []` then yields `{}` and array ops break downstream. **Never return 204 / empty body for list endpoints — return `200` with literal `[]`/`{}` JSON.** (200 with a truly empty body is safe — client.gen.ts:168-173 parses `""` → `{}` — but again wrong for arrays.)

Also set `content-type: application/json`; parse mode is derived from Content-Type (client.gen.ts:130-131) with a `json` fallback if the header is missing.

### 1.4 Directory / workspace propagation

`SDK/src/v2/client.ts:50-92 (createOpencodeClient)`:
- If constructed with `directory` (the TUI passes `--dir` through `TUI/src/context/sdk.tsx:24-30`), every request carries `x-opencode-directory: encodeURIComponent(directory)` (client.ts:63-68).
- A request interceptor (client.ts:18-48) then, **for GET/HEAD only**, moves that header into query params: `?directory=<value>` (and additionally `?location[directory]=<value>` for paths starting `/api/`), deleting the header. Same for `x-opencode-workspace` → `workspace` / `location[workspace]`.
- **Consequence for the shim**: read `directory` from the query string on GETs, and from the (URI-encoded) `x-opencode-directory` header on POST/PUT/DELETE.
- Query objects are serialized deepObject-exploded: `location[directory]=...&location[workspace]=...` (`SDK/src/v2/gen/core/pathSerializer.gen.ts:123-161`).
- The default fetch sets `req.timeout = false` (client.ts:52-55, Bun-specific — disables Bun's fetch idle timeout).

---

## 2. When the TUI calls what (boot sequence classification)

Bootstrap lives in `TUI/src/context/sync.tsx` (`bootstrap()`, lines 445-546), running on mount (sync.tsx:548-550).

### 2.1 Blocking (NOT this doc's scope — must be fully implemented)

sync.tsx:452-472 — failures call `exit(e)` (sync.tsx:534-545):
- `GET /config/providers` (sync.tsx:452, `throwOnError`)
- `GET /provider` (sync.tsx:453, `throwOnError`)
- `GET /agent` (`app.agents`, sync.tsx:462, `throwOnError`)
- `GET /config` (sync.tsx:463, `throwOnError`)
- `GET /path` + `GET /project/current` (+ `GET /project/{projectID}/directories`) via `project.sync()` (sync.tsx:448 → `TUI/src/context/project.tsx:38-53`)
- `GET /session?...` — **blocking only with `--continue`** (sync.tsx:449,471), otherwise non-blocking (sync.tsx:515).

### 2.2 Blocking-but-caught (stub or omit; errors swallowed)

- `GET /experimental/capabilities` — sync.tsx:454-457, `throwOnError` + `.catch(() => undefined)` → capability flag defaults false (sync.tsx:503).
- `GET /experimental/console` — sync.tsx:458-461, `throwOnError` + `.catch(() => emptyConsoleState)` where `emptyConsoleState = { consoleManagedProviders: [], switchableOrgCount: 0 }` (sync.tsx:36-39).

These tolerate even the text/html throw because of their own `.catch`. Still, stub them (trivial) to avoid log noise.

### 2.3 Non-blocking startup set (THE stub list — must all resolve)

sync.tsx:511-533. Note the structure:

```ts
void Promise.all([
  ...(args.continue ? [] : [sessionListPromise.then(...)]),
  consoleStatePromise.then(...),
  sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
  sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
  sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
  sdk.client.experimental.resource.list({ workspace }).then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
  sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
  sdk.client.session.status({ workspace }).then((x) => { setStore("session_status", reconcile(x.data ?? {})) }),
  sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
  sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
  project.workspace.sync(),
]).then(() => { setStore("status", "complete") })
```

**There is no `.catch`.** These are all tuple-mode calls, so JSON error responses are fine (`x.data` → fallback), but a rejected promise (HTML response, connection reset) permanently blocks `sync.status === "complete"`, which gates:
- `--session --fork` handling (`TUI/src/app.tsx:527-538`)
- the "no providers connected" auto-dialog (`app.tsx:540-549`)

`project.workspace.sync()` (`project.tsx:55-68`) calls `GET /experimental/workspace` and `GET /experimental/workspace/status`, each with `.catch(() => undefined)` — self-protected.

### 2.4 Mount-time v2 (`/api/*`) set — `Promise.allSettled`, failures logged only

`TUI/src/context/data.tsx:551-565` (DataProvider mounts inside the app tree at boot):

```ts
void Promise.allSettled([
  result.location.refresh(),          // GET /api/location
  result.location.agent.refresh(),    // GET /api/agent
  result.location.integration.refresh(), // GET /api/integration
  result.location.model.refresh(),    // GET /api/model
  result.location.provider.refresh(), // GET /api/provider
  result.location.reference.refresh(),// GET /api/reference
  result.location.command.refresh(),  // GET /api/command
  result.location.skill.refresh(),    // GET /api/skill
])
```

All use `throwOnError: true` internally (data.tsx:422-547) but `allSettled` swallows rejections (`console.error("Failed to refresh default location data", ...)` at data.tsx:562-563). Safe to 404 — but stub them (§3.2) to keep stderr clean and enable @-mention/skill/reference features.

### 2.5 Conditional / flag-gated

- `POST /sync/start` — only when env `OPENCODE_EXPERIMENTAL_WORKSPACES` is truthy (`TUI/src/context/sdk.tsx:96-99,124-128`; flag: `vendor/opencode/packages/core/src/flag/flag.ts:50`), `.catch(() => {})`. Response: `200: boolean` (types.gen.ts:10493-10500). Ignore unless you enable that flag.

### 2.6 Attach preflight (before the TUI even renders)

`vendor/opencode/packages/opencode/src/cli/cmd/attach.ts:114-127`:
- Builds Basic-auth headers (attach.ts:114, §7).
- **Only if `--session <id>` was passed**: `GET /session/{sessionID}` with `throwOnError: true` (`cli/tui/validate-session.ts:23-28`). Failure prints `errorMessage(error)` and exits. Plain `opencode attach <url>` performs **no preflight HTTP call at all** — the first requests are the bootstrap batch + `GET /global/event` SSE.

### 2.7 Lazy (on navigation into a session)

`sync.session.sync(sessionID)` (sync.tsx:588-660) fires when a session route is opened:
- `GET /session/{sessionID}` (`throwOnError: true`) — sync.tsx:596
- `GET /session/{sessionID}/message?limit=100` — sync.tsx:597 (tuple)
- `GET /session/{sessionID}/todo` — sync.tsx:598 (tuple)
- `GET /session/{sessionID}/diff` — sync.tsx:599 (tuple)

Also event-driven refetch: on SSE `lsp.updated` → `GET /lsp` again (sync.tsx:427-431).

---

## 3. Stub catalog

For each: method+path, exact response type (verbatim from `SDK/src/v2/gen/types.gen.ts`), minimal stub JSON, and UI degradation when stubbed empty. All are `GET` with optional `?directory=&workspace=` query (`WorkspaceRoutingQuery`, `SRV/routes/instance/httpapi/groups/instance.ts:139-188`) unless noted.

### 3.1 Non-blocking startup set (legacy instance routes)

| # | Route | Caller | Stub | Degradation when empty |
|---|-------|--------|------|------------------------|
| 1 | `GET /command` | sync.tsx:517 | `[]` | No user/MCP/skill slash-commands in palette; built-ins unaffected |
| 2 | `GET /lsp` | sync.tsx:518 (+ on `lsp.updated` event, sync.tsx:429) | `[]` | LSP section of status UI empty. Harmless |
| 3 | `GET /mcp` | sync.tsx:519 (+ `TUI/src/component/dialog-mcp.tsx:59` on dialog open) | `{}` | MCP list dialog empty. Harmless |
| 4 | `GET /experimental/resource` | sync.tsx:520-522 | `{}` | No MCP resources for mentions. Harmless |
| 5 | `GET /formatter` | sync.tsx:523 | `[]` | Formatter status empty. Harmless |
| 6 | `GET /session/status` | sync.tsx:524-526 | `{}` | Spinner state falls back to message-completion heuristic (sync.tsx:578-587). Note `routes/session/index.tsx:611` treats missing status as "not idle" and issues a harmless `POST /session/{id}/abort` before undo |
| 7 | `GET /provider/auth` | sync.tsx:527 | `{}` | Provider-connect dialog offers no OAuth/API-key flows. Fine for a shim that pre-configures Anthropic |
| 8 | `GET /vcs` | sync.tsx:528 (+ SSE `vcs.branch.updated` keeps it fresh, sync.tsx:433-438) | `{"branch":"main"}` or `{}` | No git branch in status bar |
| 9 | `GET /experimental/workspace` | project.tsx:56 (self-caught) | `[]` | Workspace switcher empty |
| 10 | `GET /experimental/workspace/status` | project.tsx:58 (self-caught) | `[]` | No workspace status badges |
| 11 | `GET /session` (no `--continue`) | sync.tsx:164-168,515; query `start=<now-30d>&scope=project` or `path=...` | **no longer a stub** — persistent list with roots/search/start/limit/scope/path filters (09 §3.1, 07 §13) | n/a; with `--continue` this is **blocking** |
| 12 | `GET /experimental/capabilities` | sync.tsx:454 (self-caught) | `{"backgroundSubagents":false}` | `experimentalBackgroundSubagents` false → no background-subagent UI |
| 13 | `GET /experimental/console` | sync.tsx:458, 516 (self-caught) | `{"consoleManagedProviders":[],"switchableOrgCount":0}` | Console/org-switch UI hidden |

Verbatim element types (types.gen.ts):

```ts
// /command — 200: Array<Command>            (types.gen.ts:8300-8307, 2334-2343)
export type Command = {
  name: string
  description?: string
  agent?: string
  model?: string
  source?: "command" | "mcp" | "skill"
  template: string
  subtask?: boolean
  hints: Array<string>
}

// /lsp — 200: Array<LspStatus>              (types.gen.ts:8389-8396, 2367-2372)
export type LspStatus = {
  id: string
  name: string
  root: string
  status: "connected" | "error"
}

// /mcp — 200: { [key: string]: McpStatus }  (types.gen.ts:8445-8454, 2380-2408)
export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

// /experimental/resource — 200: { [key: string]: McpResource } (types.gen.ts:7875-7885, 2244-2250)
export type McpResource = {
  name: string
  uri: string
  description?: string
  mimeType?: string
  client: string
}

// /formatter — 200: Array<FormatterStatus>  (types.gen.ts:8417-8424, 2374-2378)
export type FormatterStatus = {
  name: string
  extensions: Array<string>
  enabled: boolean
}

// /session/status — 200: { [sessionID: string]: SessionStatus } (types.gen.ts:9529-9538, 673-694)
export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string;
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string };
      next: number }
  | { type: "busy" }

// /provider/auth — 200: { [providerID: string]: Array<ProviderAuthMethod> } (types.gen.ts:9349-9358, 2484+)
export type ProviderAuthMethod = { type: "oauth" | "api"; label: string; prompts?: Array<...> }

// /vcs — 200: VcsInfo                       (types.gen.ts:8154-8161, 2306-2309)
export type VcsInfo = {
  branch?: string
  default_branch?: string
}

// /experimental/workspace — 200: Array<Workspace> (types.gen.ts:11051-11059, 2650-2659)
export type Workspace = {
  id: string
  type: string
  name: string
  branch?: string | null
  directory?: string | null
  extra?: unknown | null
  projectID: string
  timeUsed: number | "NaN" | "Infinity" | "-Infinity"
}

// /experimental/workspace/status — 200: Array<WorkspaceEventConnectionStatus> (types.gen.ts:11146-11153)
// consumed as { workspaceID, status } pairs (project.tsx:59)

// /experimental/capabilities — 200: ExperimentalCapabilities (types.gen.ts:7512-7519, 2124-2126)
export type ExperimentalCapabilities = { backgroundSubagents: boolean }

// /experimental/console — 200: ConsoleState (types.gen.ts:7545-7552, 2128-2132)
export type ConsoleState = {
  consoleManagedProviders: Array<string>
  activeOrgName?: string
  switchableOrgCount: number
}
```

### 3.2 Mount-time v2 `/api/*` set (envelope shape!)

Every list response is wrapped: `{ location: LocationInfo, data: [...] }` (e.g. `V2AgentListResponses`, types.gen.ts:11315-11324). The TUI reads BOTH `result.data.location` (to key its store) and `result.data.data` (data.tsx:479-547).

```ts
// types.gen.ts:3857-3864
export type LocationInfo = {
  directory: string
  workspaceID?: string
  project: {
    id: string
    directory: string
  }
}
```

Reusable stub envelope (fill `directory` from the request's `location[directory]`/`directory` query or the server's cwd):

```json
{
  "location": {
    "directory": "/abs/project/dir",
    "project": { "id": "prj_stub", "directory": "/abs/project/dir" }
  },
  "data": []
}
```

| Route | Element type | Notes |
|-------|-------------|-------|
| `GET /api/location` | `200: LocationInfo` (types.gen.ts:11281-11288) — **no envelope** | Return the LocationInfo object directly. On failure the TUI keeps default `{directory: sdk.directory ?? process.cwd()}` (data.tsx:76-78) |
| `GET /api/agent` | `Array<AgentV2Info>` | empty → v2 agent metadata missing; legacy `/agent` powers the agent UI |
| `GET /api/integration` | `Array<IntegrationInfo>` (types.gen.ts:12183-12191) | empty → no integrations UI |
| `GET /api/model` | `Array<ModelV2Info>` (types.gen.ts:12058-12066) | empty → v2 model metadata missing; legacy `/config/providers` powers model dialogs |
| `GET /api/provider` | `Array<ProviderV2Info>` (types.gen.ts:12099-12140) | as above |
| `GET /api/reference` | `Array<ReferenceInfo>` (types.gen.ts:13468-13476) | empty → no `@reference` autocomplete |
| `GET /api/command` | `Array<CommandV2Info>` (types.gen.ts:12914-12943) | |
| `GET /api/skill` | `Array<SkillV2Info>` (types.gen.ts:12951-12988) | empty → no skill mentions |

Query params arrive as `location[directory]=...&location[workspace]=...` (§1.4).

### 3.3 Lazy per-session stubs

| Route | Caller / trigger | Response type | Stub | Degradation |
|-------|-----------------|---------------|------|-------------|
| `GET /session/{sessionID}/todo` | sync.tsx:598 on session open | `200: Array<Todo>` (types.gen.ts:9710-9717; `Todo = { content: string; status: string; priority: string }`, types.gen.ts:658-673) | `[]` | No todo panel (live todos still arrive via `todo.updated` SSE, sync.tsx:259-261) |
| `GET /session/{sessionID}/diff` | sync.tsx:599; diff viewer `mode=last-turn` with `?messageID=` (`TUI/src/feature-plugins/system/diff-viewer.tsx:118-122`, throwOnError) | `200: Array<SnapshotFileDiff>` (types.gen.ts:9741-9748; `SnapshotFileDiff = { file?: string; patch?: string; additions: number; deletions: number; status?: "added"|"deleted"|"modified" }`, types.gen.ts:152-158) | `[]` | No per-session change stats; live values via `session.diff` SSE (sync.tsx:263-265) |
| `GET /vcs/diff?mode=git&context=N` | diff viewer `mode=git` (diff-viewer.tsx:125-128, throwOnError) | `200: Array<VcsFileDiff>` (`{ file: string; patch?: string; additions: number; deletions: number; status?: ... }`, types.gen.ts:2319-2326) | `[]` | Diff view shows "no changes" |
| `GET /vcs/status` | workspace/move dialogs, all `.catch(() => undefined)` (`dialog-workspace-create.tsx:170`, `dialog-move-session.tsx:236`, `prompt/move.tsx:119`) | `200: Array<VcsFileStatus>` (`{ file: string; additions: number; deletions: number; status: "added"|"deleted"|"modified" }`, types.gen.ts:2311-2317) | **no longer a stub** — real porcelain-status + `diff --numstat HEAD` join (08 §3.8, src/vcs.ts); non-git dir → `[]` | non-empty results enable the file-changes dialog and `moveChanges:true` |
| `GET /find/file?query=...` | tag dialog (`TUI/src/component/dialog-tag.tsx:20-24`), tuple mode | `200: Array<string>` (types.gen.ts:7955-7961) | `[]` | Tag file-picker empty |
| `GET /api/fs/find?query=...&limit=20&location[...]` | prompt @-mention autocomplete (`TUI/src/component/prompt/autocomplete.tsx:324-330`), tuple mode, fires per keystroke | `200: { location: LocationInfo; data: Array<FileSystemEntry> }` (types.gen.ts:12877-12885; `FileSystemEntry = { path: string; type: "file" | "directory" }`, types.gen.ts:4997-5000) | envelope + `[]` | @file mentions never suggest anything — **worth implementing for real** (walk cwd) since it's core UX |

### 3.4 User-action mutations that should return benign successes

These are outside the "read" stubs but a bare `true` (their declared success type) prevents error toasts if a user pokes the menus:

- `POST /instance/dispose` → `200: true` — called after auth/org changes (`dialog-provider.tsx:281,332,405`; `dialog-console-org.tsx:106`); the TUI then re-bootstraps itself (also via `server.instance.disposed` SSE, sync.tsx:172-174).
- `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect` → `200: true` (types.gen.ts:8657-8664) — MCP toggle (`TUI/src/context/local.tsx:510-519`).
- `GET /experimental/workspace/sync-list` → `200: boolean`; `.catch`-protected at call sites (`dialog-workspace-create.tsx:81`, `dialog-workspace-list.tsx:91`).
- Everything under `/experimental/workspace` (create/remove/warp), `/api/session/.../projectCopy`, provider OAuth (`/provider/{id}/oauth/*`), `PUT /auth/{providerID}`, `POST /global/upgrade` (app.tsx:1058): user-initiated, error-toast handled. A JSON 404 (§5.5) is acceptable; do not stub `true` for flows you can't actually perform (e.g., workspace create), or the UI will proceed on a lie.
- **No longer stubs**: `/experimental/project/{pid}/copy` (+ `/refresh`, `/generate-name`, DELETE) and `/experimental/control-plane/move-session` are fully implemented per 08-move-session.md (git-worktree copies, real session moves; verified by test/live-move.ts).

### 3.5 Routes that exist in the API but the TUI v1.17.19 never calls

Verified by exhaustive grep of `TUI/src/` for `sdk.client.*` / `api.client.*` (only hits: see §2-3 lists; `find.files` and `v2.fs.find` are the only find/file-family calls; zero `client.pty`/`client.tui`/`client.file` hits):

- `/find` (text search), `/find/symbol`, `/file`, `/file/content`, `/file/status` (defined at `SRV/routes/instance/httpapi/groups/file.ts:96-98`; types: FindText types.gen.ts:7907-7930, FileList 8013-8020 (`Array<FileNode>`), FileRead 8042-8049 (`FileContent`), FileStatus 8070-8077 (`Array<File>`)). Used by web UI/other clients only. Optional.
- `/pty/*` and `/api/pty/*` (list/create/update/remove, `/pty/{ptyID}/connect` WebSocket, `/pty/{ptyID}/connect-token`): **the TUI never opens PTY WebSockets — there is no terminal feature in the solid TUI at this tag.** The only WebSocket in the TUI is the IDE editor-integration socket, which dials OUT to `CLAUDE_CODE_SSE_PORT`/`OPENCODE_EDITOR_SSE_PORT` (an editor's server, not ours — `TUI/src/context/editor.ts:114-123,390-396`). Stub `/pty` list as `[]` if you want desktop/web clients not to error; otherwise JSON 404.
- `/tui/*` control routes (`/tui/control/next`, `/tui/control/response`, `/tui/append-prompt`, `/tui/open-*`, `/tui/submit-prompt`, `/tui/clear-prompt`, `/tui/execute-command`, `/tui/show-toast`, `/tui/publish`, `/tui/select-session`): these are called BY external controllers (plugins, `opencode tui ...` subcommands) to drive a TUI; the real server just republishes them as SSE events (`SRV/routes/instance/httpapi/handlers/tui.ts:27-130`). The attached TUI only *receives* the resulting events. All return `200: true` except `GET /tui/control/next`, which is a long-poll that parks until a control request exists (handlers/tui.ts:107-109) — if you stub it, either park the request forever or return JSON 404; never return an instant `200 {}` in a loop-calling client.
- `/experimental/tool`, `/experimental/tool/ids`, `/log`, `/agent` POST variants, `/session/{id}/permissions/{permissionID}` (legacy), `/auth/{providerID}` GET, `/global/*` except the SSE (`/global/event`) and `/global/health`.

---

## 4. Error contract (server → wire)

The real server emits **two distinct JSON error shapes** depending on route family. Your shim should reproduce them; the safest universal shape for stubs is the NamedError one, because every client extractor understands it (§1.1, §4.4).

### 4.1 NamedError shape — `{ "name": string, "data": { "message": string, ... } }`

- Unexpected 500s (defect boundary): `SRV/routes/instance/httpapi/middleware/error.ts:28-40` returns
  ```json
  { "name": "UnknownError", "data": { "message": "Unexpected server error. Check server logs for details.", "ref": "err_ab12cd34" } }
  ```
  built via `NamedError.Unknown(...).toObject()` (`vendor/opencode/packages/core/src/util/error.ts:55-69`), status 500.
- Config errors surface as 400 with `error.toObject()` (error.ts middleware:19-26) — e.g. `{"name":"ConfigInvalidError","data":{...}}`.
- Schema/validation failures on **legacy (non-`/api`) routes**: 400 `{"name":"BadRequest","data":{"message":<reason ≤1024 chars>,"kind":<kind>}}` (`SRV/routes/instance/httpapi/middleware/schema-error.ts:25-40`).
- Not-found on legacy routes: `ApiNotFoundError` — `{"name":"NotFoundError","data":{"message":...}}`, status 404 (`SRV/routes/instance/httpapi/errors.ts:178-193`; used by e.g. `GET /session/{id}` via `mapStorageNotFound`, `handlers/session-errors.ts:6-8`). Generated client type (types.gen.ts:2538-2543):
  ```ts
  export type NotFoundError = { name: "NotFoundError"; data: { message: string } }
  ```

### 4.2 Tagged shape — `{ "_tag": string, "message": string, ... }`

Effect `Schema.TaggedErrorClass` errors, used by the typed instance API and ALL `/api/*` v2 routes (`SRV/routes/instance/httpapi/errors.ts:3-176`; `vendor/opencode/packages/protocol/src/errors.ts`). Status comes from `httpApiStatus`. Examples (generated mirrors, types.gen.ts):

```ts
export type InvalidRequestError  = { _tag: "InvalidRequestError"; message: string; kind?: string; field?: string } // 400
export type UnauthorizedError    = { _tag: "UnauthorizedError"; message: string }                                  // 401
export type SessionNotFoundError = { _tag: "SessionNotFoundError"; sessionID: string; message: string }            // 404
export type SessionBusyError     = { _tag: "SessionBusyError"; sessionID: string; message: string }                // 409
export type UnknownError1        = { _tag: "UnknownError"; message: string; ref?: string }                         // 500
```

Schema failures on `/api/*` routes: 400 `{"_tag":"InvalidRequestError","message":...,"kind":...}` (`vendor/opencode/packages/server/src/middleware/schema-error.ts:14-20`; the legacy middleware branches on `endpoint.path.startsWith("/api/")`, `SRV/.../middleware/schema-error.ts:27-33`).

### 4.3 Auth failures (see §7)

- Legacy typed routes: `HttpApiError.UnauthorizedNoContent` → **401 with empty body** + `www-authenticate: Basic realm="Secure Area"` header (`SRV/routes/instance/httpapi/middleware/authorization.ts:19-24,48-52`).
- Raw catch-all/doc routes: `HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } })` (authorization.ts:85-99).
- v2 `/api/*` routes: 401 JSON `{"_tag":"UnauthorizedError","message":"Authentication required"}` + same header (`vendor/opencode/packages/server/src/middleware/authorization.ts:38-58`).

### 4.4 How clients surface these (client → user)

- Tuple mode: `result.error` is the parsed body verbatim; TUI code checks `.error` / uses `?? fallback`.
- `throwOnError`: `wrapClientError` (§1.1) — message priority `data.message` → `message` → `name`.
- TUI-side formatters:
  - `TUI/src/app.tsx:154-167 errorMessage()` — reads `error.data.message` if present, else `Error.message`.
  - `TUI/src/util/error.ts:125-145 errorMessage()` — `Error.message` → `.message` → `.data.message` → `String(error)`.
  - `TUI/src/util/error.ts:5-76 cliErrorMessage()` — unwraps `error.cause.body` (the wrapClientError cause) and pattern-matches `_tag`/`name` for `CliError`, `ProviderModelNotFoundError`, `ProviderInitError`, `ConfigJsonError`, `ConfigInvalidError`, `ConfigFrontmatterError`, `ConfigDirectoryTypoError`, `MCPFailed`, `UICancelledError` — this runs on fatal exit (app.tsx:357-362) and attach preflight failure (attach.ts:122-126).

**Both `{name,data:{message}}` and `{_tag,message}` produce a readable message everywhere.** Include a human `message` in every error you emit.

### 4.5 The 404-for-unknown-route your shim should return

```
HTTP/1.1 404 Not Found
content-type: application/json

{"name":"NotFoundError","data":{"message":"route not implemented: GET /whatever"}}
```

Why this exact shape:
- tuple-mode callers get a POJO error and fall back gracefully;
- `throwOnError` callers get `Error("route not implemented: GET /whatever")` via `data.message` extraction;
- it is not `text/html` → never triggers the interceptor throw → never wedges the sync.tsx non-blocking `Promise.all` (§2.3);
- non-empty body → avoids the `(empty response body)` fallback message and the 204→`{}` parsing trap.

Do NOT: serve HTML, redirect to a web UI, return 204, or return a bare string body on API paths.

---

## 5. CORS (for a future browser web UI; irrelevant to the TUI)

The TUI runs in Bun and never sends `Origin`; nothing here affects `opencode attach`.

Real server behavior (`SRV/routes/instance/httpapi/server.ts:121-128`): global `HttpMiddleware.cors` with `maxAge: 86_400` and dynamic origin allow-list `isAllowedCorsOrigin` (`vendor/opencode/packages/server/src/cors.ts:11-20`), verbatim:

```ts
export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true      // /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/
  return opts?.cors?.includes(input) ?? false
}
```

Additional CORS-adjacent behavior to mirror if you serve browsers:
- Echo the allowed origin (not `*`) and add `Vary: Origin` — the real server patches a Vary-merging bug explicitly (`SRV/routes/instance/httpapi/middleware/cors-vary.ts:13-29`).
- Handle `OPTIONS` preflight with `access-control-max-age: 86400`.
- WebSocket upgrades can't be CORS-protected by the browser; the real server checks `Origin`/`Host` per-request for PTY connects via `isAllowedRequestOrigin` (cors.ts:22-26; `SRV/routes/instance/httpapi/handlers/pty.ts:29`).
- Exact `access-control-allow-methods`/`-headers` values come from effect's `HttpMiddleware.cors` defaults (not vendored here); for the shim, reflecting the request's `Access-Control-Request-Method`/`-Headers` is a safe superset.

Shim recommendation: allow `http://localhost:*` + `http://127.0.0.1:*`, echo origin, `Vary: Origin`, support OPTIONS. Skip the rest until a web UI exists.

---

## 6. Basic auth (`OPENCODE_SERVER_PASSWORD`)

Client side (attach):
- `opencode attach --password/-p --username/-u` fall back to env `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` (default username `"opencode"`) — `attach.ts:36-44,114`; `ServerAuth.headers()`/`header()` (`vendor/opencode/packages/opencode/src/server/auth.ts:36-48`):
  ```ts
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  ```
  If no password anywhere → **no Authorization header at all**.
- The headers object is threaded into every TUI request AND the SSE connection (attach.ts:114 → `run({headers})` → `SDKProvider headers` → `createOpencodeClient({headers})`, `TUI/src/context/sdk.tsx:24-30`).

Server side (mirror only if you set a password):
- Config: env `OPENCODE_SERVER_PASSWORD` (option) + `OPENCODE_SERVER_USERNAME` (default `"opencode"`) — auth.ts:17-20. Auth is **disabled entirely when password is unset/empty** (`required()`, auth.ts:24-26).
- Credentials accepted from either `Authorization: Basic <b64>` header or `?auth_token=<b64(user:pass)>` query param (for browser SSE/WS) — `SRV/routes/instance/httpapi/middleware/authorization.ts:12,73-83`.
- Public unauthenticated paths: `GET /site.webmanifest`, `GET /web-app-manifest-{192x192,512x512}.png` (`SRV/shared/public-ui.ts:4-12`).
- Failure responses: §4.3.

Shim recommendation: honor `OPENCODE_SERVER_PASSWORD` with the same header + `auth_token` checks, 401-with-`www-authenticate` on failure. If you skip auth entirely, attach still works (client just may send an Authorization header you ignore).

---

## 7. Does anything require WebSocket at TUI boot? — **No.**

- Boot networking is: the HTTP bootstrap batch (§2) + one **SSE** stream `GET /global/event` (`TUI/src/context/sdk.tsx:82-131`; route: `SDK/src/v2/gen/sdk.gen.ts:1338`). Reconnect loop with exponential backoff 1s→30s, `sseMaxRetryAttempts: 0` per attempt (sdk.tsx:91-94,113-114).
- The only `WebSocket` constructor in the TUI is the editor integration (`TUI/src/context/editor.ts:390-396`) and it connects to `ws://localhost:$CLAUDE_CODE_SSE_PORT` / `$OPENCODE_EDITOR_SSE_PORT` — the *IDE's* socket, never our server; disabled when those env vars are absent (editor.ts:117-121).
- PTY WebSocket endpoints (`/pty/{ptyID}/connect`) exist server-side for the desktop/web clients only; the TUI has zero references (§3.5).

So the shim needs **no WebSocket support at all** for stock TUI attach.

---

## 8. Traps & gotchas checklist

1. **Never emit `content-type: text/html`** on any path a client library might hit; the v2 SDK hard-throws (§1.2). Unknown routes → JSON 404 (§4.5).
2. **Never 204/empty-body a list endpoint** — the client parses it as `{}` not `[]` (§1.3).
3. **Every route in §3.1 must at least resolve with valid JSON** (any status) or `sync.status` never reaches `"complete"` (unguarded `Promise.all`, sync.tsx:514-532), silently breaking `--session --fork` and the provider-empty dialog (§2.3).
4. **`GET /vcs` result is stored unguarded** (`setStore("vcs", reconcile(x.data))`, sync.tsx:528 — no `?? fallback`); return a real JSON object (`{}` is fine), not empty body.
5. **`/api/*` responses are enveloped** `{location, data}` and the TUI dereferences `result.data.data` AND `result.data.location` after `throwOnError` (data.tsx:480-482) — a 200 with `[]` alone will crash those refreshes (caught by `allSettled`, but noisy). Use the envelope.
6. **directory arrives differently per method**: query `?directory=` on GET/HEAD, header `x-opencode-directory` (URI-encoded) otherwise; `/api/*` GETs additionally get `location[directory]` (§1.4).
7. **`GET /session` query**: `start` (epoch ms, now−30d), plus either `scope=project` or `path=<relative dir>` (sync.tsx:154-168). Also `search`/`limit` from the session-list dialog (`dialog-session-list.tsx:64-75`).
8. **`/api/fs/find` fires per keystroke** during @-mentions — make it fast or at least instantly return the empty envelope.
9. **Missing `session_status` entry ⇒ TUI issues `POST /session/{id}/abort`** before undo (routes/session/index.tsx:611); make abort a benign no-op success.
10. `GET /tui/control/next` is a long-poll; never answer it with an immediate generic 200 (§3.5).
11. The wire error `message` matters — it's what users see in toasts/exit output via the extractors in §4.4.
12. `POST /instance/dispose` triggers a full client re-`bootstrap()` afterwards (dialog-provider.tsx:281-283); it must be followed by working bootstrap endpoints, and the `server.instance.disposed` SSE event also re-bootstraps (sync.tsx:172-174).
13. Auth applies to the SSE endpoint too — same headers object; if you add auth, accept it on `GET /global/event`.
14. The attach preflight (`--session` only) throws the raw wrapClientError message; give `GET /session/{id}` a proper 404 `{"name":"NotFoundError","data":{"message":"Session not found: ..."}}` so users see something sane (§2.6, §4.1).
