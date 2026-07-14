# Contract 02 — Events: `GET /global/event` SSE stream

Target client: **stock opencode TUI v1.17.19** (`opencode attach http://localhost:PORT`).
All citations are repo-relative to `vendor/opencode` unless prefixed otherwise.
`sdk:` = `node_modules/@opencode-ai/sdk` (identical generated code to `packages/sdk/js`).

This document covers: the route, the exact wire framing, the envelope, the complete
event vocabulary, what the TUI does with each event, and which events a shim MUST emit
for streaming text to render.

---

## 1. Routes

| Method | Path | Used by TUI? | Envelope on wire |
|---|---|---|---|
| GET | `/global/event` | **YES — the only event stream the TUI opens** | `{directory, project?, workspace?, payload:{id,type,properties}}` |
| GET | `/event` | no (legacy/instance-scoped) | bare `{id,type,properties}`, filtered per instance directory/workspace |
| GET | `/api/event` | no (v2 experimental) | V2Event shape |

- TUI subscription: `packages/tui/src/context/sdk.tsx:91` — `sdk.global.event({ signal, sseMaxRetryAttempts: 0 })`.
- SDK route: `packages/sdk/js/src/v2/gen/sdk.gen.ts:1335-1341`:

```ts
public event<ThrowOnError extends boolean = false>(options?: Options<never, ThrowOnError>) {
  return (options?.client ?? this.client).sse.get<GlobalEventResponses, GlobalEventErrors, ThrowOnError>({
    url: "/global/event",
    ...options,
  })
}
```

- Server route definition: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:66-71` (`GlobalPaths.event = "/global/event"`) and `:85-93` (`HttpApiEndpoint.get("event", ...)`, success schema `GlobalEventSchema`).
- Server handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:33-66` (`eventResponse()`), registered with `.handleRaw("event", event)` at `:150`.
- The `/global/event` route has **no instance/workspace middleware** — only root-level `SchemaErrorMiddleware` and `Authorization` (`packages/opencode/src/server/routes/instance/httpapi/api.ts:55-59`). Any `?directory=` query param is accepted and ignored by the handler; the stream is global (all instances, unfiltered).

### Request the TUI actually sends

- `GET {baseUrl}/global/event` with optional `?directory=<dir>` query param.
  - `createOpencodeClient({directory})` sets header `x-opencode-directory: encodeURIComponent(directory)` (`packages/sdk/js/src/v2/client.ts:63-68`); a request interceptor then, for GET/HEAD, moves it into `?directory=` and deletes the header (`packages/sdk/js/src/v2/client.ts:18-48`). The SSE path applies the same interceptors via `onRequest` (`packages/sdk/js/src/v2/gen/client/client.gen.ts:237-256`).
  - `opencode attach` only passes `directory` if `--dir` was given (`packages/opencode/src/cli/cmd/attach.ts:70-79`); otherwise **no directory param at all**.
- `Authorization: Basic base64(user:pass)` only when a server password is configured (`packages/opencode/src/server/auth.ts:36-48`, TUI side `packages/opencode/src/cli/cmd/attach.ts:114`). With no `OPENCODE_SERVER_PASSWORD`, auth is not required (`packages/opencode/src/server/auth.ts:24-26`).
- `Last-Event-ID` header would be sent on reconnect **only if the server ever sent `id:` lines** (`sdk gen/core/serverSentEvents.gen.ts:110-112`). The real server never sends `id:` lines → header never sent. Ignore it.

---

## 2. Wire framing (SERVER source of truth)

From `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:33-66`:

```ts
function eventData(data: unknown): Sse.Event {
  return { _tag: "Event", event: "message", id: undefined, data: JSON.stringify(data) }
}
// ...
return HttpServerResponse.stream(
  Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
    Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
    Stream.map(eventData),
    Stream.pipeThroughChannel(Sse.encode()),
    Stream.encodeText,
    ...
  ),
  {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  },
)
```

The effect SSE encoder (verified from published `effect@4.0.0-beta.83`, `src/unstable/encoding/Sse.ts:572-586`) omits the `id:` line when `id === undefined` and omits the `event:` line when the event name is `"message"`. The server always uses `event: "message"`, `id: undefined`, so **every frame on the wire is exactly**:

```
data: {"directory":"...","payload":{...}}\n
\n
```

i.e. one `data:` line with single-line JSON, terminated by a blank line. **No `event:` lines, no `id:` lines, no `retry:` lines, no SSE comments (`:`) ever.**

### Response headers (verbatim)

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
X-Content-Type-Options: nosniff
```

(chunked / streamed body; compression middleware explicitly skips `/event` and `/global/event` — `packages/opencode/src/server/routes/instance/httpapi/middleware/compression.ts:11`. Do **not** gzip this response.)

### Connection sequence

1. Immediately on connect: a `server.connected` event — **note: no `directory` field on this envelope** (handlers/global.ts:49):
   ```
   data: {"payload":{"id":"evt_...","type":"server.connected","properties":{}}}
   ```
2. Then real events as they occur.
3. Heartbeat every 10 seconds, first one ~10s after connect (`Stream.tick("10 seconds").pipe(Stream.drop(1))`, handlers/global.ts:43-46; `Stream.tick` emits immediately then per-interval — effect `src/Stream.ts:570-582` — so `drop(1)` removes the t=0 tick):
   ```
   data: {"payload":{"id":"evt_...","type":"server.heartbeat","properties":{}}}
   ```
   `server.heartbeat` is **not in any published schema/type union** and the TUI ignores it entirely (no handler exists). Its only purpose is keeping the connection alive through proxies. A shim SHOULD emit it (same cadence) but the TUI works without it on localhost.
4. Stream stays open until client disconnect.

### Client parsing (what the shim's output must survive)

`sdk gen/core/serverSentEvents.gen.ts:135-218` — fetch + `ReadableStream` + `TextDecoderStream` (NOT `EventSource`, NOT NDJSON):

- Buffer split on `\n\n` (after normalizing `\r\n`/`\r` → `\n`).
- Per chunk, lines parsed by prefix: `data:` (strip `/^data:\s*/`, multiple data lines joined with `\n`), `event:`, `id:` (sets `lastEventId` → future `Last-Event-ID` header), `retry:`.
- `JSON.parse` attempted on the joined data; on failure the raw string is yielded (would break the TUI — always send valid JSON).
- Only frames with at least one `data:` line are yielded. Frames without data (e.g. comment-only keepalives like `: ping`) are silently skipped by this parser BUT the loop still calls `onSseEvent` — safe either way. A pure-comment keepalive (`: ...\n\n`) is also acceptable to this parser (no `data:` → not yielded).
- No response validation/transformation is configured for `global.event()` → unknown fields and unknown event types pass through harmlessly.

### Client reconnect behavior

`packages/tui/src/context/sdk.tsx:82-117`: the TUI disables SDK-internal retry (`sseMaxRetryAttempts: 0`) and runs its own outer loop: when the stream ends (server close, network error), it reconnects with exponential backoff `min(1000 * 2^(attempt-1), 30000)` ms. It does **not** re-bootstrap state on reconnect — state resync only happens on a `server.instance.disposed` event (see §5). If your shim restarts, emit `server.instance.disposed` after the client reconnects to force a full TUI re-bootstrap.

Events are queued and flushed to handlers in ≤16ms batches (`sdk.tsx:48-80`) — ordering within the stream is preserved.

---

## 3. Envelope

### 3.1 Generated client type (verbatim head; full union in §6)

`packages/sdk/js/src/v2/gen/types.gen.ts:730-734`:

```ts
export type GlobalEvent = {
  directory: string
  project?: string
  workspace?: string
  payload:
    | { id: string; type: "..."; properties: {...} }   // ~80 variants, §6
    | EventServerInstanceDisposed                      // {id, type:"server.instance.disposed", properties:{directory}}
    | SyncEventSessionCreated | ... /* 34 SyncEvent* variants, type:"sync" — §7 */
}
```

### 3.2 Server-side envelope (source of truth)

`packages/opencode/src/bus/global.ts` (entire file):

```ts
export type GlobalEvent = {
  directory?: string      // <-- OPTIONAL on the server side, required in the SDK type
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{ event: [GlobalEvent] }> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}
```

- The real server ships `server.connected`, `server.heartbeat`, and `global.disposed`/`installation.*` (emitted with `directory: "global"`, `packages/opencode/src/cli/upgrade.ts:16-22`, `packages/opencode/src/server/global-lifecycle.ts:6-14`) — i.e. `directory` is sometimes missing or the literal string `"global"`. The TUI never validates it (see §4).
- Instance-scoped events are bridged onto GlobalBus by `packages/opencode/src/event-v2-bridge.ts:35-62`:

```ts
GlobalBus.emit("event", {
  directory: event.location?.directory ?? ctx?.directory,   // absolute path of the instance dir
  project: ctx?.project.id,                                 // e.g. "prj_..." — TUI never reads this
  workspace: workspaceID,                                   // undefined unless experimental workspaces
  payload: { id: event.id, type: event.type, properties: event.data },
})
// plus, for durable events only, a second emit with payload {type:"sync", syncEvent:{...}} (§7)
```

### 3.3 `payload.id` — the `evt_` pattern

- Schema: `packages/schema/src/event.ts:9-13` — `Schema.String.check(Schema.isStartsWith("evt_"))`, created as `"evt_" + ascending()`.
- Generator: `packages/schema/src/identifier.ts:14-30` — 26 chars total after the prefix: 12 hex chars encoding `(unixMillis * 0x1000 + counter)` big-endian over 6 bytes, followed by 14 random base62 chars. Example: `evt_19f8a3b2c4d5Ab3xYz9QwErT1`.
- Any monotonically-increasing string starting with `evt_` works; the TUI never parses event ids. (It DOES binary-search-sort **session/message/part** ids, so those must be lexicographically ascending in creation order — but that's contract 03's problem.)

### 3.4 Minimal envelope the shim should emit

```json
{
  "directory": "/Users/me/project",
  "payload": {
    "id": "evt_00000000000000000000000001",
    "type": "message.part.delta",
    "properties": { "sessionID": "ses_x", "messageID": "msg_x", "partID": "prt_x", "field": "text", "delta": "Hello" }
  }
}
```

`project` and `workspace` can be omitted entirely. **Leave `workspace` unset** — see trap T2.

---

## 4. How the TUI consumes the stream

Pipeline: `sdk.tsx` (SSE loop, batching) → `event.ts` → per-context handlers.

`packages/tui/src/context/event.ts:12-30` (entire relevant logic):

```ts
function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
  return sdk.event.on("event", (event) => {
    if (event.payload.type === "sync") return                    // sync twins dropped
    handler(event.payload, { directory: event.directory, workspace: event.workspace })
  })
}
```

- **No directory filtering anywhere.** The TUI processes every payload regardless of `directory`.
- `metadata.workspace` is compared against `project.workspace.current()` (undefined unless experimental workspaces) by the `tui.*`, `session.error`, and `vcs.branch.updated` handlers — `undefined === undefined` passes.
- `metadata.directory` is passed back to the server in the permission auto-reply (`sync.tsx:193-198`) and used as `location.directory` for `data.tsx` refreshes.

Subscriber inventory (complete for v1.17.19):

| File | Events handled |
|---|---|
| `packages/tui/src/context/sync.tsx:170-440` | server.instance.disposed, permission.asked/replied, question.asked/replied/rejected, todo.updated, session.diff, session.deleted/updated, session.next.moved, session.status, message.updated/removed, message.part.updated/delta/removed, lsp.updated, vcs.branch.updated |
| `packages/tui/src/context/data.tsx:124-414` | catalog.updated, integration.updated, reference.updated, session.next.* (agent/model.switched, prompted, prompt.admitted, context.updated, synthetic, shell.*, step.*, text.*, reasoning.*, tool.input.*, tool.called/progress/success/failed, retried, compaction.*) |
| `packages/tui/src/context/project.tsx:70-74` | workspace.status |
| `packages/tui/src/app.tsx:985-1060` | tui.command.execute, tui.toast.show, tui.session.select, session.deleted, session.error, installation.update-available |
| `packages/tui/src/context/local.tsx:469-471` | session.deleted |
| `packages/tui/src/component/dialog-session-list.tsx:96-99` | session.deleted |
| `packages/tui/src/component/prompt/index.tsx:237-246` | tui.prompt.append |
| `packages/tui/src/routes/session/index.tsx:320,350` | message.part.updated (plan_enter/plan_exit agent auto-switch), session.status (retry-action dialog) |
| `packages/tui/src/feature-plugins/system/notifications.ts:35-86` | question.asked/replied/rejected, permission.asked/replied, session.status, session.error (OS notifications/sounds) |

**Critical rendering fact:** the session view renders messages from the `sync.tsx` store (`sync.data.message` / `sync.data.part`, `packages/tui/src/routes/session/index.tsx:213`), which is fed **only by the legacy `message.*` events**. The `data.tsx` store fed by `session.next.*` is consumed only by prompt autocomplete's reference list (`packages/tui/src/component/prompt/autocomplete.tsx:90,280`) — **the entire `session.next.*` family is invisible in the stock TUI's transcript**. This drastically shrinks the required event surface (§5).

---

## 5. Requirement tiers

### TIER 0 — REQUIRED for streaming text to render

| Event | Why |
|---|---|
| `message.updated` | inserts/updates messages in the transcript store (sync.tsx:315-354). Without it nothing renders. |
| `message.part.updated` | inserts/replaces a part (sync.tsx:370-390). Must arrive **before** any delta for that part. |
| `message.part.delta` | appends `delta` to `part[field]` — but ONLY if the part already exists in the store, else silently dropped (sync.tsx:392-409: `if (!parts) break; if (!result.found) break`). Alternative: re-send `message.part.updated` with accumulated full text per chunk (works, more bytes, causes full `reconcile`). |
| `session.status` (`{type:"busy"}` / `{type:"idle"}`) | drives the spinner and the interrupt-enabled state (`prompt/index.tsx:163,396,1512`; store seeded from `GET /session/status` at bootstrap, sync.tsx:524-526). |
| `session.updated` | keeps the session list/title/token-usage current; also the ONLY event that inserts a session into `sync.data.session` (there is **no** `session.created` handler in sync.tsx — sync.tsx:279-292). Emit it after create and after title/token changes. |

Ordering constraint per assistant turn (mirrors the real server, `packages/opencode/src/session/processor.ts`):

> CORRECTED: in the stock server the user message (and its parts) and the assistant
> message are created and published by `prompt.ts` **before** `processor.process()` sets
> `session.status busy` at LLM-stream start (`processor.ts:639` runs inside the stream
> setup, after `prompt.ts:656-670` user-message creation and `prompt.ts:1186-1200`
> assistant-message creation). The canonical order is:
> `message.updated(user)` → `message.part.updated(user parts)` →
> `message.updated(assistant)` → `session.status{busy}` → `step-start` → …
> The TUI is insensitive to the relative order of these first four events, but the
> corrected order below is what the real server emits.

```
message.updated {info: user message}                      (session.ts:633, from prompt.ts:656-670)
message.updated {info: assistant msg, time:{created}}     (prompt.ts:1186-1200)
session.status {busy}                                     (processor.ts:639)
message.part.updated {part: step-start}                   (processor.ts:424-433)
message.part.updated {part: text, text:"", time:{start}}  (text-start, processor.ts:483-497)
message.part.delta   {field:"text", delta:"..."} × N      (text-delta, processor.ts:499-510)
message.part.updated {part: text, full text, time:{start,end}}  (text-end, processor.ts:513-532)
[tool parts: message.part.updated with state pending→running→completed/error]
message.part.updated {part: step-finish, tokens, cost}    (processor.ts:435-456)
message.updated {info: assistant msg, time:{completed}}   (processor.ts:594-596)
session.updated {info with tokens/cost}                   
session.status {idle}  (+ deprecated session.idle)        (processor.ts:612/624, status.ts:40-47)
```

### TIER 1 — required for interactive features (permissions/questions/errors)

`permission.asked`, `permission.replied`, `question.asked`, `question.replied`, `question.rejected`, `session.error`, `todo.updated`, `session.diff`, `session.deleted`.

### TIER 2 — polish / optional

`server.heartbeat` (keepalive), `server.connected` (nothing reads it), `server.instance.disposed` (forces TUI re-bootstrap — useful after shim restart), `tui.toast.show` / `tui.prompt.append` / `tui.command.execute` / `tui.session.select` (server→TUI remote control), `installation.update-available`, `vcs.branch.updated`, `lsp.updated`, `workspace.status`, `session.next.moved`.

### TIER 3 — consumed but invisible in stock TUI (safe to skip)

Entire `session.next.*` family, `catalog.updated`, `integration.updated`, `reference.updated` (these only trigger REST refreshes of autocomplete data).

### NOT consumed at all by the TUI (safe to never emit)

`server.connected`, `server.heartbeat`, `session.created`, `session.idle`, `session.compacted`, `file.edited`, `file.watcher.updated`, `installation.updated`, `models-dev.refreshed`, `integration.connection.updated`, `permission.v2.*`, `question.v2.*`, `pty.*`, `mcp.tools.changed`, `mcp.browser.open.failed`, `plugin.added`, `project.updated`, `project.directories.updated`, `command.executed`, `workspace.ready/failed`, `worktree.*`, `global.disposed`, all `type:"sync"` twins.

---

## 6. Event catalog

Schemas are **verbatim** from `packages/sdk/js/src/v2/gen/types.gen.ts:730-1639` (the `GlobalEvent.payload` union; identical in `node_modules/@opencode-ai/sdk`). Supporting types in §8. Sample JSON shows the full wire envelope. "TUI:" = traced behavior.

### 6.1 Session lifecycle

#### `session.created` — types.gen.ts:763-770
```ts
{ id: string; type: "session.created"; properties: { sessionID: string; info: Session } }
```
TUI: **no handler** (sync.tsx only handles updated/deleted). Emit for parity; harmless.

#### `session.updated` — types.gen.ts:771-778 — **TIER 0**
```ts
{ id: string; type: "session.updated"; properties: { sessionID: string; info: Session } }
```
TUI: binary-search insert-or-reconcile into `sync.data.session` (sync.tsx:279-292).
```json
{"directory":"/w","payload":{"id":"evt_1","type":"session.updated","properties":{"sessionID":"ses_a","info":{"id":"ses_a","slug":"quiet-fox","projectID":"prj_1","directory":"/w","title":"Fix the bug","version":"1.17.19","time":{"created":1770000000000,"updated":1770000001000}}}}}
```

#### `session.deleted` — types.gen.ts:779-786
```ts
{ id: string; type: "session.deleted"; properties: { sessionID: string; info: Session } }
```
TUI: removes from session list (sync.tsx:267-278); navigates home + toast if it's the open session (app.tsx:1008-1016); prunes pinned (local.tsx:469); hides in session dialog (dialog-session-list.tsx:96). Reads `properties.info.id` (not `sessionID`).

#### `session.status` — types.gen.ts:1493-1500 — **TIER 0**
```ts
{ id: string; type: "session.status"; properties: { sessionID: string; status: SessionStatus } }
```
`SessionStatus` (types.gen.ts:673-696, schema `packages/schema/src/session-status-event.ts:8-30`):
```ts
export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string }
      next: number }
  | { type: "busy" }
```
TUI: `setStore("session_status", sessionID, status)` (sync.tsx:310-313) → spinner/interrupt UI; notifications plugin fires "Session done" on busy→idle (notifications.ts:59-78); retry status opens dialogs (routes/session/index.tsx:350-366).
```json
{"directory":"/w","payload":{"id":"evt_2","type":"session.status","properties":{"sessionID":"ses_a","status":{"type":"busy"}}}}
```
Real-server semantics: `busy` at stream start, `idle` at end/error/abort; on `idle` the server also emits the deprecated `session.idle` (`packages/opencode/src/session/status.ts:40-47`) — TUI ignores `session.idle`.

#### `session.idle` — types.gen.ts:1501-1507 — deprecated, **not consumed**
```ts
{ id: string; type: "session.idle"; properties: { sessionID: string } }
```

#### `session.error` — types.gen.ts:1212-1227 — TIER 1
```ts
{ id: string; type: "session.error"; properties: {
    sessionID?: string
    error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
          | StructuredOutputError | ContextOverflowError | ContentFilterError | ApiError } }
```
TUI: error toast unless `error.name === "MessageAbortedError"` (app.tsx:1018-1030); notification sound (notifications.ts:80-86). Error shapes in §8.3.
```json
{"directory":"/w","payload":{"id":"evt_3","type":"session.error","properties":{"sessionID":"ses_a","error":{"name":"UnknownError","data":{"message":"boom"}}}}}
```

#### `session.diff` — types.gen.ts:1204-1211 — TIER 1
```ts
{ id: string; type: "session.diff"; properties: { sessionID: string; diff: Array<SnapshotFileDiff> } }
```
TUI: `setStore("session_diff", sessionID, diff)` (sync.tsx:263-265) → file-change summary UI. `SnapshotFileDiff` in §8.4.

#### `session.compacted` — types.gen.ts:1538-1544 — **not consumed**
```ts
{ id: string; type: "session.compacted"; properties: { sessionID: string } }
```

### 6.2 Message / part streaming (THE core of rendering)

#### `message.updated` — types.gen.ts:787-794 — **TIER 0**
```ts
{ id: string; type: "message.updated"; properties: { sessionID: string; info: Message } }
```
`Message = UserMessage | AssistantMessage` (§8.2). TUI: insert-or-reconcile into `sync.data.message[sessionID]` sorted by `id`; **caps at 100 messages per session** — inserting the 101st evicts the oldest and deletes its parts (sync.tsx:315-354).
```json
{"directory":"/w","payload":{"id":"evt_4","type":"message.updated","properties":{"sessionID":"ses_a","info":{"id":"msg_b","sessionID":"ses_a","role":"assistant","time":{"created":1770000002000},"parentID":"msg_a","modelID":"claude-sonnet-4-5","providerID":"anthropic","mode":"build","agent":"build","path":{"cwd":"/w","root":"/w"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}}}}
```

#### `message.removed` — types.gen.ts:795-802
```ts
{ id: string; type: "message.removed"; properties: { sessionID: string; messageID: string } }
```
TUI: removes the message (sync.tsx:355-369). Emitted by real server on revert (`packages/opencode/src/session/session.ts:859`).

#### `message.part.updated` — types.gen.ts:803-811 — **TIER 0**
```ts
{ id: string; type: "message.part.updated"; properties: { sessionID: string; part: Part; time: number } }
```
`Part` union in §8.2. Note the extra `time: number` field (epoch ms; TUI ignores it but schema requires it — real server sends it, `packages/schema/src/v1/session.ts:612-620`). TUI: insert-or-reconcile into `sync.data.part[part.messageID]` sorted by `part.id` (sync.tsx:370-390). Also: a completed `tool` part named `plan_exit`/`plan_enter` auto-switches the agent (routes/session/index.tsx:320-334).
```json
{"directory":"/w","payload":{"id":"evt_5","type":"message.part.updated","properties":{"sessionID":"ses_a","time":1770000002100,"part":{"id":"prt_1","sessionID":"ses_a","messageID":"msg_b","type":"text","text":"","time":{"start":1770000002100}}}}}
```

#### `message.part.delta` — types.gen.ts:1193-1203 — **TIER 0** (or resend full parts)
```ts
{ id: string; type: "message.part.delta"; properties: {
    sessionID: string; messageID: string; partID: string; field: string; delta: string } }
```
TUI (sync.tsx:392-409): `part[field] = (part[field] ?? "") + delta` — **dropped silently if the part is not already in the store**. Real server only ever sends `field: "text"` (for text and reasoning parts; `packages/opencode/src/session/processor.ts:299-306,503-510`).
```json
{"directory":"/w","payload":{"id":"evt_6","type":"message.part.delta","properties":{"sessionID":"ses_a","messageID":"msg_b","partID":"prt_1","field":"text","delta":"Hello, "}}}
```

#### `message.part.removed` — types.gen.ts:812-820
```ts
{ id: string; type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
```
TUI: removes the part (sync.tsx:411-425).

### 6.3 Permissions & questions (legacy family — this is what the TUI uses)

#### `permission.asked` — types.gen.ts:1376-1393 — TIER 1
```ts
{ id: string; type: "permission.asked"; properties: {
    id: string; sessionID: string; permission: string; patterns: Array<string>
    metadata: { [key: string]: unknown }; always: Array<string>
    tool?: { messageID: string; callID: string } } }
```
TUI (sync.tsx:190-219): if permission mode is `auto` (`--auto` flag), immediately POSTs `permission.reply {requestID: id, reply:"once", directory, workspace}` using the envelope's `directory`/`workspace`; otherwise inserts into `sync.data.permission[sessionID]` (sorted by `id`) which renders the permission prompt UI (routes/session/footer.tsx:18, routes/session/index.tsx:229,1850 — `tool.callID` links the dialog to the tool part). Notification sound (notifications.ts:49-53). `always` is the list of "allow always" pattern options shown.
```json
{"directory":"/w","payload":{"id":"evt_7","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_a","permission":"bash","patterns":["rm -rf *"],"metadata":{},"always":["rm *"],"tool":{"messageID":"msg_b","callID":"call_1"}}}}
```

#### `permission.replied` — types.gen.ts:1394-1402 — TIER 1
```ts
{ id: string; type: "permission.replied"; properties: {
    sessionID: string; requestID: string; reply: "once" | "always" | "reject" } }
```
TUI: removes request `requestID` from the pending list (sync.tsx:175-188). **Must be emitted after the client's POST reply** (and to all other listeners) or the dialog never dismisses.

#### `question.asked` — types.gen.ts:1508-1520 — TIER 1
```ts
{ id: string; type: "question.asked"; properties: {
    id: string; sessionID: string; questions: Array<QuestionInfo>; tool?: QuestionTool } }
```
`QuestionInfo`/`QuestionOption`/`QuestionTool` (types.gen.ts:692-727):
```ts
export type QuestionOption = { label: string; description: string }
export type QuestionInfo = { question: string; header: string; options: Array<QuestionOption>; multiple?: boolean; custom?: boolean }
export type QuestionTool = { messageID: string; callID: string }
export type QuestionAnswer = Array<string>
```
TUI: inserts into `sync.data.question[sessionID]` (sync.tsx:237-257) → question dialog; notification (notifications.ts:35-39).

#### `question.replied` — types.gen.ts:1521-1529 / `question.rejected` — types.gen.ts:1530-1537 — TIER 1
```ts
{ id: string; type: "question.replied";  properties: { sessionID: string; requestID: string; answers: Array<QuestionAnswer> } }
{ id: string; type: "question.rejected"; properties: { sessionID: string; requestID: string } }
```
TUI: both remove the pending request (sync.tsx:221-235).

(`permission.v2.asked/replied`, `question.v2.asked/replied/rejected` exist in the union — types.gen.ts:1256-1279, 1331-1360 — but the TUI has **zero** handlers for them.)

### 6.4 Todos

#### `todo.updated` — types.gen.ts:1361-1368 — TIER 1
```ts
{ id: string; type: "todo.updated"; properties: { sessionID: string; todos: Array<Todo> } }
```
`Todo` (types.gen.ts:658-671): `{ content: string; status: string; priority: string }` (status: pending|in_progress|completed|cancelled; priority: high|medium|low — doc-comment only, plain strings on the wire). TUI: replaces the whole list (sync.tsx:259-261).
```json
{"directory":"/w","payload":{"id":"evt_8","type":"todo.updated","properties":{"sessionID":"ses_a","todos":[{"content":"Fix bug","status":"in_progress","priority":"high"}]}}}
```

### 6.5 Server / control events

#### `server.connected` — types.gen.ts:1589-1595
`{ id: string; type: "server.connected"; properties: { [key: string]: unknown } }`
Emitted as the first frame, **without `directory`** (handlers/global.ts:49). TUI: no handler.

#### `server.heartbeat` — NOT IN ANY SCHEMA
`{ payload: { id, type: "server.heartbeat", properties: {} } }` every 10s (handlers/global.ts:43-46). TUI: no handler.

#### `server.instance.disposed` — types.gen.ts:3181-3187 — TIER 2 (useful!)
```ts
export type EventServerInstanceDisposed = {
  id: string
  type: "server.instance.disposed"
  properties: { directory: string }
}
```
TUI: `void bootstrap()` — full state re-sync of providers/agents/config/sessions (sync.tsx:172-174). Real server emits when an instance is disposed/reloaded (`packages/opencode/src/project/instance-store.ts:80-92`). Shim use: emit after your server restarts or after config changes to force the TUI to re-fetch everything.

#### `global.disposed` — types.gen.ts:1596-1602 — not consumed
`{ id, type: "global.disposed", properties: {} }`, envelope `directory: "global"` (global-lifecycle.ts:6-14).

#### `installation.update-available` — types.gen.ts:1235-1241 — TIER 2
`{ id, type: "installation.update-available", properties: { version: string } }`, envelope `directory:"global"` (upgrade.ts:31-38). TUI: upgrade dialog (app.tsx:1031+). **Do not emit from the shim** unless you want the TUI to try `POST /global/upgrade`.

#### `installation.updated` — types.gen.ts:1228-1234 — not consumed by TUI.

### 6.6 TUI remote-control events (server→client commands)

All gated on `workspace === project.workspace.current()` (undefined==undefined passes).

#### `tui.prompt.append` — types.gen.ts:1403-1409
`{ id, type: "tui.prompt.append", properties: { text: string } }` → inserts text into the prompt input (prompt/index.tsx:237-246).

#### `tui.command.execute` — types.gen.ts:1410-1433
`{ id, type: "tui.command.execute", properties: { command: "session.list" | "session.new" | ... | string } }` → dispatches a TUI keymap command (app.tsx:985-988).

#### `tui.toast.show` — types.gen.ts:1434-1443
`{ id, type: "tui.toast.show", properties: { title?: string; message: string; variant: "info"|"success"|"warning"|"error"; duration?: number } }` → shows a toast (app.tsx:990-998). Handy for shim diagnostics.

#### `tui.session.select` — types.gen.ts:1444-1453
`{ id, type: "tui.session.select", properties: { sessionID: string } }` → navigates to session (app.tsx:1000-1006).

### 6.7 Misc consumed events

#### `lsp.updated` — types.gen.ts:1369-1375
`{ id, type: "lsp.updated", properties: { [key: string]: unknown } }` → TUI re-fetches `GET /lsp/status` (sync.tsx:427-431). Skip unless you implement LSP.

#### `vcs.branch.updated` — types.gen.ts:1545-1551
`{ id, type: "vcs.branch.updated", properties: { branch?: string } }` → footer branch display (sync.tsx:433-438; workspace-gated).

#### `workspace.status` — types.gen.ts:1566-1573
`{ id, type: "workspace.status", properties: { workspaceID: string; status: "connected"|"connecting"|"disconnected"|"error" } }` → workspace indicator (project.tsx:70-74). Experimental-workspaces only.

#### `session.next.moved` — types.gen.ts:841-850 — the only session.next.* handled in sync.tsx
```ts
{ id: string; type: "session.next.moved"; properties: {
    timestamp: number; sessionID: string; location: LocationRef; subdirectory?: string } }
```
TUI: patches `session.directory/path/workspaceID/time.updated` in place (sync.tsx:294-308). Only needed if you implement session-move.

### 6.8 `session.next.*` family — full schemas (TIER 3: handled by data.tsx, invisible in stock TUI)

All verbatim from types.gen.ts (line refs inline). All carry `timestamp: number` (epoch ms). data.tsx handling noted where non-trivial; **none of it affects the transcript the user sees**.

```ts
// types.gen.ts:821-830
{ id, type: "session.next.agent.switched", properties: { timestamp, sessionID, messageID, agent: string } }
// :831-840
{ id, type: "session.next.model.switched", properties: { timestamp, sessionID, messageID, model: ModelRef } }
// :851-861   delivery: "steer" | "queue"
{ id, type: "session.next.prompted", properties: { timestamp, sessionID, messageID, prompt: Prompt, delivery } }
// :862-872   (data.tsx: no-op, data.tsx:165-166)
{ id, type: "session.next.prompt.admitted", properties: { timestamp, sessionID, messageID, prompt: Prompt, delivery } }
// :873-882
{ id, type: "session.next.context.updated", properties: { timestamp, sessionID, messageID, text: string } }
// :883-892
{ id, type: "session.next.synthetic", properties: { timestamp, sessionID, messageID, text: string } }
// :893-903
{ id, type: "session.next.shell.started", properties: { timestamp, sessionID, messageID, callID, command: string } }
// :904-913
{ id, type: "session.next.shell.ended", properties: { timestamp, sessionID, callID, output: string } }
// :914-925
{ id, type: "session.next.step.started", properties: { timestamp, sessionID, assistantMessageID, agent: string, model: ModelRef, snapshot?: string } }
// :926-947
{ id, type: "session.next.step.ended", properties: { timestamp, sessionID, assistantMessageID, finish: string, cost: number,
    tokens: { input: number, output: number, reasoning: number, cache: { read: number, write: number } },
    snapshot?: string, files?: Array<string> } }
// :948-957
{ id, type: "session.next.step.failed", properties: { timestamp, sessionID, assistantMessageID, error: SessionErrorUnknown } }
// :958-967
{ id, type: "session.next.text.started", properties: { timestamp, sessionID, assistantMessageID, textID: string } }
// :968-978
{ id, type: "session.next.text.delta", properties: { timestamp, sessionID, assistantMessageID, textID, delta: string } }
// :979-989
{ id, type: "session.next.text.ended", properties: { timestamp, sessionID, assistantMessageID, textID, text: string } }
// :990-1000
{ id, type: "session.next.reasoning.started", properties: { timestamp, sessionID, assistantMessageID, reasoningID: string, providerMetadata?: LlmProviderMetadata } }
// :1001-1011
{ id, type: "session.next.reasoning.delta", properties: { timestamp, sessionID, assistantMessageID, reasoningID, delta: string } }
// :1012-1023
{ id, type: "session.next.reasoning.ended", properties: { timestamp, sessionID, assistantMessageID, reasoningID, text: string, providerMetadata?: LlmProviderMetadata } }
// :1024-1034
{ id, type: "session.next.tool.input.started", properties: { timestamp, sessionID, assistantMessageID, callID: string, name: string } }
// :1035-1045
{ id, type: "session.next.tool.input.delta", properties: { timestamp, sessionID, assistantMessageID, callID, delta: string } }
// :1046-1056
{ id, type: "session.next.tool.input.ended", properties: { timestamp, sessionID, assistantMessageID, callID, text: string } }
// :1057-1074
{ id, type: "session.next.tool.called", properties: { timestamp, sessionID, assistantMessageID, callID, tool: string,
    input: { [key: string]: unknown }, provider: { executed: boolean, metadata?: LlmProviderMetadata } } }
// :1075-1088
{ id, type: "session.next.tool.progress", properties: { timestamp, sessionID, assistantMessageID, callID,
    structured: { [key: string]: unknown }, content: Array<LlmToolContent> } }
// :1089-1108
{ id, type: "session.next.tool.success", properties: { timestamp, sessionID, assistantMessageID, callID,
    structured: { [key: string]: unknown }, content: Array<LlmToolContent>, outputPaths?: Array<string>,
    result?: unknown, provider: { executed: boolean, metadata?: LlmProviderMetadata } } }
// :1109-1124
{ id, type: "session.next.tool.failed", properties: { timestamp, sessionID, assistantMessageID, callID,
    error: SessionErrorUnknown, result?: unknown, provider: { executed: boolean, metadata?: LlmProviderMetadata } } }
// :1125-1134
{ id, type: "session.next.retried", properties: { timestamp, sessionID, attempt: number, error: SessionNextRetryError } }
// :1135-1144   reason: "auto" | "manual"
{ id, type: "session.next.compaction.started", properties: { timestamp, sessionID, messageID, reason } }
// :1145-1154   (data.tsx: no-op)
{ id, type: "session.next.compaction.delta", properties: { timestamp, sessionID, messageID, text: string } }
// :1155-1166
{ id, type: "session.next.compaction.ended", properties: { timestamp, sessionID, messageID, reason, text: string, recent: string } }
// :1167-1175
{ id, type: "session.next.revert.staged", properties: { timestamp, sessionID, revert: RevertState } }
// :1176-1183
{ id, type: "session.next.revert.cleared", properties: { timestamp, sessionID } }
// :1184-1192
{ id, type: "session.next.revert.committed", properties: { timestamp, sessionID, messageID } }
```

### 6.9 Remaining union members (never consumed; listed for completeness)

```ts
// types.gen.ts:735-762
{ id, type: "models-dev.refreshed",            properties: { [key: string]: unknown } }
{ id, type: "integration.updated",             properties: { [key: string]: unknown } }   // data.tsx refresh only
{ id, type: "integration.connection.updated",  properties: { integrationID: string } }
{ id, type: "catalog.updated",                 properties: { [key: string]: unknown } }   // data.tsx refresh only
// :1242-1255
{ id, type: "file.edited",        properties: { file: string } }
{ id, type: "reference.updated",  properties: { [key: string]: unknown } }                // data.tsx refresh only
// :1256-1286
{ id, type: "permission.v2.asked",   properties: { id, sessionID, action: string, resources: string[], save?: string[], metadata?: {...}, source?: PermissionV2Source } }
{ id, type: "permission.v2.replied", properties: { sessionID, requestID, reply: PermissionV2Reply } }
{ id, type: "plugin.added",          properties: { id: string } }
// :1287-1330
{ id, type: "project.directories.updated", properties: { projectID: string } }
{ id, type: "file.watcher.updated",         properties: { file: string; event: "add"|"change"|"unlink" } }
{ id, type: "pty.created"|"pty.updated",    properties: { info: Pty } }
{ id, type: "pty.exited",                   properties: { id: string; exitCode: number } }
{ id, type: "pty.deleted",                  properties: { id: string } }
// :1331-1360
{ id, type: "question.v2.asked",    properties: { id, sessionID, questions: QuestionV2Info[], tool?: QuestionV2Tool } }
{ id, type: "question.v2.replied",  properties: { sessionID, requestID, answers: QuestionV2Answer[] } }
{ id, type: "question.v2.rejected", properties: { sessionID, requestID } }
// :1454-1492
{ id, type: "mcp.tools.changed",       properties: { server: string } }
{ id, type: "mcp.browser.open.failed", properties: { mcpName: string; url: string } }
{ id, type: "command.executed",        properties: { name, sessionID, arguments: string, messageID } }
{ id, type: "project.updated",         properties: { id, worktree, vcs?, name?, icon?, commands?, time, sandboxes: string[] } }
// :1552-1588
{ id, type: "workspace.ready",  properties: { name: string } }
{ id, type: "workspace.failed", properties: { message: string } }
{ id, type: "worktree.ready",   properties: { name: string; branch?: string } }
{ id, type: "worktree.failed",  properties: { message: string } }
```

---

## 7. `type: "sync"` twin events (skip in the shim)

For every **durable** event (session/message/part legacy family — `packages/schema/src/v1/session.ts:502-507`; most non-delta `session.next.*` — `packages/schema/src/session-event.ts:38-49`), the real server emits a SECOND GlobalBus event (`packages/opencode/src/event-v2-bridge.ts:45-60`):

```ts
{ directory, project, workspace, payload: {
    type: "sync",
    syncEvent: { id: "evt_...", type: "message.updated.1",  // versionedType = `${type}.${version}`
                 seq: number, aggregateID: sessionID, data: {…same as properties…} } } }
```

Generated types: `SyncEvent*` in types.gen.ts:3189-3822 (34 variants, e.g. `SyncEventMessagePartUpdated` :3264-3278 with `type: "message.part.updated.1"`). Deltas (`text.delta`, `reasoning.delta`, `tool.input.delta`, `compaction.delta`, `message.part.delta`) are NOT durable → no sync twin.

The TUI drops all of them at the front door (`event.ts:14`: `if (event.payload.type === "sync") return`). They are only pulled via `sdk.sync.start()` under the `OPENCODE_EXPERIMENTAL_WORKSPACES` flag (sdk.tsx:96-100). **A shim should not emit them.**

---

## 8. Supporting types (verbatim from types.gen.ts)

### 8.1 Session — types.gen.ts:170-221

```ts
export type Session = {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<SnapshotFileDiff> }
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  share?: { url: string }
  title: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  metadata?: { [key: string]: unknown }
  time: { created: number; updated: number; compacting?: number; archived?: number }
  permission?: PermissionRuleset
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}
```

### 8.2 Message & Part — types.gen.ts:239-262, 333-376, 378-639

```ts
export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?: OutputFormat
  summary?: { title?: string; body?: string; diffs: Array<SnapshotFileDiff> }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
  tools?: { [key: string]: boolean }
}

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
        | StructuredOutputError | ContextOverflowError | ContentFilterError | ApiError
  parentID: string          // id of the triggering user message — REQUIRED
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  structured?: unknown
  variant?: string
  finish?: string
}

export type Message = UserMessage | AssistantMessage

export type Part =
  | TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart
  | StepStartPart | StepFinishPart | SnapshotPart | PatchPart
  | AgentPart | RetryPart | CompactionPart

export type TextPart = {
  id: string; sessionID: string; messageID: string
  type: "text"; text: string
  synthetic?: boolean; ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: { [key: string]: unknown }
}

export type ReasoningPart = {
  id: string; sessionID: string; messageID: string
  type: "reasoning"; text: string
  metadata?: { [key: string]: unknown }
  time: { start: number; end?: number }        // REQUIRED (unlike TextPart)
}

export type ToolPart = {
  id: string; sessionID: string; messageID: string
  type: "tool"; callID: string; tool: string
  state: ToolState
  metadata?: { [key: string]: unknown }
}
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
export type ToolStatePending   = { status: "pending"; input: { [k: string]: unknown }; raw: string }
export type ToolStateRunning   = { status: "running"; input: { [k: string]: unknown }; title?: string
                                   metadata?: { [k: string]: unknown }; time: { start: number } }
export type ToolStateCompleted = { status: "completed"; input: { [k: string]: unknown }; output: string; title: string
                                   metadata: { [k: string]: unknown }
                                   time: { start: number; end: number; compacted?: number }
                                   attachments?: Array<FilePart> }
export type ToolStateError     = { status: "error"; input: { [k: string]: unknown }; error: string
                                   metadata?: { [k: string]: unknown }; time: { start: number; end: number } }

export type StepStartPart  = { id; sessionID; messageID; type: "step-start"; snapshot?: string }
export type StepFinishPart = { id; sessionID; messageID; type: "step-finish"; reason: string; snapshot?: string
                               cost: number
                               tokens: { total?: number; input: number; output: number; reasoning: number
                                         cache: { read: number; write: number } } }
export type FilePart    = { id; sessionID; messageID; type: "file"; mime: string; filename?: string; url: string; source?: FilePartSource }
export type SubtaskPart = { id; sessionID; messageID; type: "subtask"; prompt: string; description: string; agent: string
                            model?: { providerID: string; modelID: string }; command?: string }
export type SnapshotPart = { id; sessionID; messageID; type: "snapshot"; snapshot: string }
export type PatchPart    = { id; sessionID; messageID; type: "patch"; hash: string; files: Array<string> }
export type AgentPart    = { id; sessionID; messageID; type: "agent"; name: string; source?: { value: string; start: number; end: number } }
export type RetryPart    = { id; sessionID; messageID; type: "retry"; attempt: number; error: ApiError; time: { created: number } }
export type CompactionPart = { id; sessionID; messageID; type: "compaction"; auto: boolean; overflow?: boolean; tail_start_id?: string }
```

### 8.3 Error shapes — types.gen.ts:264-331

```ts
export type ProviderAuthError        = { name: "ProviderAuthError";        data: { providerID: string; message: string } }
export type UnknownError             = { name: "UnknownError";             data: { message: string; ref?: string } }
export type MessageOutputLengthError = { name: "MessageOutputLengthError"; data: { [key: string]: unknown } }
export type MessageAbortedError      = { name: "MessageAbortedError";      data: { message: string } }
export type StructuredOutputError    = { name: "StructuredOutputError";    data: { message: string; retries: number } }
export type ContextOverflowError     = { name: "ContextOverflowError";     data: { message: string; responseBody?: string } }
export type ContentFilterError       = { name: "ContentFilterError";       data: { message: string } }
export type ApiError                 = { name: "APIError"; data: { message: string; statusCode?: number; isRetryable: boolean
                                         responseHeaders?: { [k: string]: string }; responseBody?: string
                                         metadata?: { [k: string]: string } } }
```
Note `"APIError"` (all caps API) vs type name `ApiError`. On abort, the real server sets `MessageAbortedError` — the TUI specifically suppresses its toast (app.tsx:1021).

### 8.4 Misc — types.gen.ts:152-157, 641-656, 3033-3120

```ts
export type SnapshotFileDiff = { file?: string; patch?: string; additions: number; deletions: number
                                 status?: "added" | "deleted" | "modified" }
export type Prompt = { text: string; files?: Array<PromptFileAttachment>; agents?: Array<PromptAgentAttachment> }
export type ModelRef = { id: string; providerID: string; variant?: string }
export type LocationRef = { directory: string; workspaceID?: string }
export type SessionErrorUnknown = { type: "unknown"; message: string }
export type LlmProviderMetadata = { [key: string]: { [key: string]: unknown } }
export type LlmToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }
export type SessionNextRetryError = { message: string; statusCode?: number; isRetryable: boolean
                                      responseHeaders?: { [k: string]: string }; responseBody?: string
                                      metadata?: { [k: string]: string } }
export type RevertState = { messageID: string; partID?: string; snapshot?: string; diff?: string; files?: Array<FileDiff> }
export type PermissionRequest = { id: string; sessionID: string; permission: string; patterns: Array<string>
                                  metadata: { [k: string]: unknown }; always: Array<string>
                                  tool?: { messageID: string; callID: string } }
export type QuestionRequest = { id: string; sessionID: string; questions: Array<QuestionInfo>; tool?: QuestionTool }
```

---

## 9. Traps & gotchas

- **T1 — Parts require prior existence for deltas.** `message.part.delta` is dropped unless the part is already in the store (sync.tsx:393-396). Always emit `message.part.updated` (with `text: ""`) first. Same for the message itself: emit `message.updated` before its parts or the transcript won't show them until the message arrives (parts are stored keyed by messageID regardless, but rendering iterates messages).
- **T2 — Never set `workspace` in envelopes.** `tui.toast.show`, `tui.prompt.append`, `tui.command.execute`, `tui.session.select`, and `session.error` handlers require `workspace === project.workspace.current()` (undefined in normal mode). A non-undefined `workspace` makes the TUI **silently drop** these events (app.tsx:986,991,1001,1019; prompt/index.tsx:238).
- **T3 — `session.deleted` reads `properties.info.id`**, not `properties.sessionID` (sync.tsx:268, app.tsx:1009, local.tsx:470). The full `Session` object is required in `info`.
- **T4 — IDs must sort.** Sessions, messages, parts, permissions, questions are kept in arrays ordered by `id` via binary search (sync.tsx:41-52). Emit ids that are lexicographically ascending in creation order for **messages/parts/permissions/questions** (opencode uses prefix + hex(time*0x1000+counter) + base62 random, `packages/opencode/src/id/id.ts:50-69`; prefixes: `ses`/`msg`/`prt`/`per`/`que`/`evt` — id.ts:3-14). Out-of-order part ids scramble part order within a message.
  > CORRECTED: **session ids in stock opencode are DESCENDING-encoded** (`"ses_" + descending()`, `packages/schema/src/session-id.ts:5-14`; bit-inverted timestamp, newest = lexicographically smallest — see 05-data-model.md §1). The previous claim that "descending session ids will scramble the session list" was wrong: every user-visible session ordering sorts by `time.updated` (`dialog-session-list.tsx:191`, `app.tsx:506` for `--continue`), and the id-sorted store is only a binary-search lookup index — any internally consistent scheme works there. One place raw session-id order IS visible: the child-subagent list sorts ascending by id (`routes/session/index.tsx:209-211`), so with descending encoding newest children render first, matching stock. **Use descending `ses_` ids to reproduce stock behavior exactly.**
- **T5 — 100-message cap.** Each `message.updated` insert beyond 100 evicts the oldest message and its parts (sync.tsx:334-352). Sessions are hydrated on open via `GET /session/:id/message?limit=100` (sync.tsx:597), so eviction is invisible if REST works.
- **T6 — `message.part.updated` needs the sibling `time` property** (number, epoch ms) at `properties.time` per the schema (types.gen.ts:809, schema/v1/session.ts:617). The TUI ignores it, but don't omit it if other clients may connect; there is no runtime validation in the TUI.
- **T7 — envelope `directory` is effectively required by the SDK type but unvalidated.** The real server omits it on `server.connected`/`server.heartbeat` and uses `"global"` for install/dispose events. The TUI never checks it, but it IS passed back verbatim as `directory` in permission auto-replies (sync.tsx:193-198) — set it to the session's real directory on `permission.asked` if you support `--auto` mode clients.
- **T8 — `permission.replied` must be broadcast** after handling `POST /permission/reply`, or the permission prompt never leaves the TUI store (only `permission.replied`/`question.replied`/`question.rejected` remove pending requests — sync.tsx:175-188,221-235).
- **T9 — One JSON object per frame, single line.** The TUI parser joins multiple `data:` lines with `\n` before `JSON.parse` — technically multi-line JSON would survive, but the real server always sends single-line `JSON.stringify`. Never send an `event:` name other than none/`message`; the parser yields data regardless of event name, so a custom name is tolerated but pointless.
- **T10 — No SSE ids / retry.** Server sends none; the client's `Last-Event-ID` resume machinery is therefore dormant. Replay-on-reconnect is NOT part of this protocol — after a disconnect the TUI simply reattaches and relies on REST re-fetch (only triggered by `server.instance.disposed` or opening a session). If your shim streams a response while the TUI is disconnected, the transcript catches up via `sync.session.sync()` on next hydration (sync.tsx:588-660), which merges REST state and keeps locally-newer text parts when REST returns empty text (sync.tsx:630-639).
- **T11 — `session.status` store is authoritative for the spinner**, and it's seeded via `GET /session/status` at bootstrap (sync.tsx:524-526). Implement both the event AND the REST endpooint, or a TUI that attaches mid-generation shows idle.
- **T12 — Don't gzip, don't buffer.** Real server marks `Cache-Control: no-cache, no-transform` and skips compression for the SSE paths (compression.ts:11). Bun/Hono: return a streaming Response and flush per event.
- **T13 — heartbeats keep half-open connections alive** but also serve as the only traffic when idle; without them some proxies kill the connection and the TUI reconnects (harmless but noisy: 1s backoff on first drop).
- **T14 — `session.created` alone does not add a session to the TUI list** — sync.tsx has no handler. The real server emits `session.updated` frequently (title generation, time.updated bumps) which is what populates the list; shims should emit `session.updated` right after creation too.

---

## 10. Minimal conformant emitter (pseudo-code)

```ts
// per connection
write(`data: ${JSON.stringify({ payload: { id: evtId(), type: "server.connected", properties: {} } })}\n\n`)
const hb = setInterval(() => write(`data: ${JSON.stringify({ payload: { id: evtId(), type: "server.heartbeat", properties: {} } })}\n\n`), 10_000)

// broadcast helper — one queue per connection, envelope directory = session directory
function emit(type: string, properties: unknown, directory = ROOT) {
  const frame = { directory, payload: { id: evtId(), type, properties } }
  for (const c of connections) c.write(`data: ${JSON.stringify(frame)}\n\n`)
}

// assistant turn
emit("session.status", { sessionID, status: { type: "busy" } })
emit("message.updated", { sessionID, info: userMessage })
emit("message.updated", { sessionID, info: assistantMessage })
emit("message.part.updated", { sessionID, part: textPart({ text: "" }), time: Date.now() })
for (const chunk of llmStream)
  emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta: chunk })
emit("message.part.updated", { sessionID, part: textPart({ text: full, time: { start, end } }), time: Date.now() })
emit("message.updated", { sessionID, info: { ...assistantMessage, time: { ...t, completed: Date.now() } } })
emit("session.updated", { sessionID, info: sessionWithTokens })
emit("session.status", { sessionID, status: { type: "idle" } })
```
