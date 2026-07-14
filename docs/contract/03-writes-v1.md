# 03 — v1 WRITE routes (everything the stock TUI mutates over HTTP)

Target client: **opencode TUI v1.17.19** (`vendor/opencode/packages/tui`), which talks to the server
through the **v2 flavor of the JS SDK** (`@opencode-ai/sdk/v2`) — see
`vendor/opencode/packages/tui/src/context/sdk.tsx:1` (`import { createOpencodeClient } from "@opencode-ai/sdk/v2"`).

"v1" here means the classic top-level routes (`/session/...`, `/permission/...`, `/question/...`), NOT the
`/api/*` "sdk-next" surface (that is `sdk.client.v2.*` inside the TUI and is documented elsewhere; the ones
the TUI uses are almost all reads plus experimental projectCopy writes — see §12).

Authoritative sources used (all paths repo-relative to `vendor/opencode/`):

| What | File |
|---|---|
| Route→URL mapping used by TUI | `packages/sdk/js/src/v2/gen/sdk.gen.ts` |
| Wire types (requests/responses) | `packages/sdk/js/src/v2/gen/types.gen.ts` |
| Server route declarations (schemas) | `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`, `groups/permission.ts`, `groups/question.ts` |
| Server handlers (actual behavior) | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`, `handlers/permission.ts` |
| Prompt/shell/command service | `packages/opencode/src/session/prompt.ts` |
| Permission service semantics | `packages/opencode/src/permission/index.ts` |
| Canonical message schema | `packages/schema/src/v1/session.ts` (re-exported as `SessionV1` via `packages/core/src/v1/session.ts`) |
| Permission schema | `packages/schema/src/v1/permission.ts` |
| Question schema | `packages/schema/src/v1/question.ts` |
| Session schema | `packages/opencode/src/session/session.ts` |
| ID formats | `packages/opencode/src/id/id.ts`, `packages/opencode/src/session/schema.ts` |
| TUI prompt submission | `packages/tui/src/component/prompt/index.tsx` (`submitInner`, lines 946–1146) |

---

## 1. Transport conventions shared by ALL write routes

### 1.1 Directory / workspace scoping

- The TUI creates its SDK client with a `directory` (the cwd, or `--dir`); the client then attaches
  `x-opencode-directory: encodeURIComponent(directory)` as a **header on every request**
  (`packages/sdk/js/src/v2/client.ts:63-68`). A request interceptor rewrites that header into a
  `?directory=` **query param for GET/HEAD only** (`client.ts:18-48`). **So writes carry the directory as a
  URL-encoded header, reads as a query param.**
- Some TUI write calls additionally pass `directory` / `workspace` explicitly — these land in the **query
  string** for any method (`buildClientParams` maps them `{ in: "query" }`, e.g.
  `packages/sdk/js/src/v2/gen/sdk.gen.ts:3145-3155` for `permission.reply`).
- Server resolution order (`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:86-88` and `181-184`):
  1. if the path contains a sessionID, that session's stored `directory` wins;
  2. else `url.searchParams.get("directory")`;
  3. else `request.headers["x-opencode-directory"]`;
  4. else `process.cwd()` of the server.
  The value is `decodeURIComponent`-ed with a try/catch fallback to the raw value
  (`middleware/instance-context.ts:15-21`).
- `?workspace=` selects an experimental workspace; invalid IDs → 400
  `{"_tag":"InvalidRequestError","message":"Invalid workspace query parameter","kind":"Query","field":"workspace"}`
  (`workspace-routing.ts:194-204`). A shim that doesn't implement workspaces can ignore the param when absent
  (the TUI only sends it when the experimental workspaces flag is on, or passes `undefined`).
- `opencode attach <url>` without `--dir` sends **no** directory at all (header omitted) —
  `packages/opencode/src/cli/cmd/attach.ts:70-79`. The shim must have a sane default directory.

### 1.2 Auth

`attach --password/--username` produces a `Authorization: Basic ...` header injected client-wide
(`packages/opencode/src/cli/cmd/attach.ts:114`, `ServerAuth.headers`). If the shim doesn't set a password,
no auth header arrives.

### 1.3 Bodies, empty bodies, Content-Type

- Bodies are `JSON.stringify`-ed; `Content-Type: application/json` is set by the generated SDK methods.
- **Trap:** `buildClientParams` strips empty slots (`packages/sdk/js/src/v2/gen/core/params.gen.ts:97-103`),
  so calls whose optional body fields are all absent send **`Content-Type: application/json` with an empty
  body** (no bytes). This happens for `session.fork({sessionID})` (TUI does this — `packages/tui/src/app.tsx:511`).
  The stock server tolerates it: `createRaw`/`forkRaw` read raw text and treat blank as "no payload"
  (`handlers/session.ts:159-176` and `218-230`). **The shim MUST NOT 400 on an empty JSON body for
  POST /session and POST /session/{sessionID}/fork.**
- Unknown *top-level* keys in the parameters object are silently dropped by the SDK before the request is
  made (no `allowExtra` in generated calls; `params.gen.ts:147-161`). E.g. the TUI's prompt call spreads
  `...selectedModel` (top-level `providerID`/`modelID`) — those never reach the wire; only the nested
  `model` object does (`packages/tui/src/component/prompt/index.tsx:1094-1109`).

### 1.4 Responses & errors

- Success responses are JSON. Several routes return a bare JSON boolean `true` (see per-route notes).
- Error bodies (Effect HttpApi tagged errors, `packages/opencode/src/server/routes/instance/httpapi/errors.ts`):
  - 400 `{"_tag":"BadRequest"}` or `{"_tag":"InvalidRequestError","message":"...","kind"?:"...","field"?:"..."}`
  - 404 `{"name":"NotFoundError","data":{"message":"..."}}` (`ApiNotFoundError`, errors.ts:178-186) —
    note this one is `name`/`data`-shaped, not `_tag`-shaped
  - 404 `{"_tag":"PermissionNotFoundError","requestID":"...","message":"..."}` / same for `QuestionNotFoundError`
  - 409 `{"_tag":"SessionBusyError","sessionID":"...","message":"..."}`
  - 500 `{"_tag":"InternalServerError"}` (share/unshare failures)
- Client-side, the TUI usually reads `result.error` (result-tuple mode) or passes `{throwOnError:true}`;
  in the latter case the SDK wraps the body into an `Error` whose message is picked from
  `.data.message` → `.message` → `.name` in that order (`packages/sdk/js/src/error-interceptor.ts:24-32`).
  So error bodies should carry a human-readable `message` (or `data.message`) if you want good toasts.
- A `text/html` response makes the SDK throw
  `"Request is not supported by this version of OpenCode Server (Server responded with text/html)"`
  (`packages/sdk/js/src/v2/client.ts:84-90`). Never serve HTML on API paths (including 404s).

### 1.5 Rendering model — POST responses vs SSE

The TUI renders conversation state **exclusively from SSE events** (`/global/event`, handled in
`packages/tui/src/context/sync.tsx:170-440`: `message.updated`, `message.part.updated`,
`message.part.delta`, `message.removed`, `session.updated`, `session.deleted`, `session.status`,
`permission.asked/replied`, `question.asked/replied/rejected`, `todo.updated`, ...). Write-POST response
bodies are consumed only where explicitly noted below (create → `id`, fork → `id`, share → `share.url`).
Everything else is fire-and-forget with an error toast. **Consequence for the shim:** a write that doesn't
emit its SSE side effects will appear to "do nothing" in the TUI even when the POST returns 200.

### 1.6 ID formats (server-generated)

`packages/opencode/src/id/id.ts:3-14,51-70`: `<prefix>_<12 hex chars of time><14 base62 chars>`; prefixes:
session `ses`, message `msg`, part `prt`, permission `per`, question `que`. IDs are ascending; the TUI
**sorts and compares IDs lexicographically** (e.g. `a.id.localeCompare(b.id)` in sync.tsx:167;
`message.id > messageID` for redo in `routes/session/index.tsx:652`). The schema only enforces prefixes
(`isStartsWith("msg")` etc., `packages/opencode/src/session/schema.ts:10-24`), but generate monotonically
increasing suffixes or ordering breaks. The client never generates `messageID` for prompts (field is
optional and TUI omits it); server calls `MessageID.ascending()` (`prompt.ts:657`).

---

## 2. POST /session — create session

- SDK: `session.create` → `POST /session` (`v2/gen/sdk.gen.ts:3410-3458`).
- Server: `groups/session.ts:203-214` (payload `Session.CreateInput`, may be NoContent), handler
  `handlers/session.ts:155-176` (`createRaw` tolerates empty body).

Request body (all optional; `packages/opencode/src/session/session.ts:260-271`):

```ts
// SessionCreateData.body — v2/gen/types.gen.ts:9468-9490
{
  parentID?: string
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }   // NOTE: `id`, not `modelID`!
  metadata?: { [key: string]: unknown }
  permission?: PermissionRuleset          // Array<{permission, pattern, action:"allow"|"deny"|"ask"}>
  workspaceID?: string
}
```

Query: `directory?`, `workspace?`.

**Traced TUI call** (`packages/tui/src/component/prompt/index.tsx:999-1008`) — sent when the user submits
the very first prompt from the home screen:

```ts
sdk.client.session.create({
  directory,                 // usually undefined → query param omitted
  workspace: workspaceID,    // usually undefined
  agent: agent.name,         // e.g. "build"
  model: { providerID: selectedModel.providerID, id: selectedModel.modelID, variant },
})
```

Wire example:

```
POST /session HTTP/1.1
x-opencode-directory: %2FUsers%2Fme%2Fproj
Content-Type: application/json

{"agent":"build","model":{"providerID":"anthropic","id":"claude-opus-4-5"}}
```

Response 200: full **Session** object (`Session.Info`, `session.ts:224-245`; wire type
`v2/gen/types.gen.ts:170-221`). Minimal valid JSON the shim can return:

```json
{
  "id": "ses_01a3b5c7d9e1f3a5b7c9d1e3f5",
  "slug": "quiet-lion",
  "projectID": "prj_default",
  "directory": "/Users/me/proj",
  "title": "New session",
  "version": "1.17.19",
  "time": { "created": 1770000000000, "updated": 1770000000000 }
}
```

**What the TUI does afterwards:** reads `res.data.id` and (after 50 ms) navigates to the session route
(`prompt/index.tsx:1022,1134-1142`); then immediately POSTs the prompt to that id. The session must also be
emitted via SSE `session.updated` so it appears in stores/lists. On error it toasts
"Creating a session failed…" (`prompt/index.tsx:1010-1020`).

Errors: 400 `EffectHttpApiErrorBadRequest | InvalidRequestError`.

---

## 3. POST /session/{sessionID}/message — prompt (the big one)

- SDK: `session.prompt` → `POST /session/{sessionID}/message` (`v2/gen/sdk.gen.ts:3742-3795`).
- Server: `groups/session.ts:316-328` (payload `PromptPayload` = `SessionPrompt.PromptInput` minus
  `sessionID`), handler `handlers/session.ts:295-309`.

Request body — verbatim server schema (`packages/opencode/src/session/prompt.ts:1494-1521`):

```ts
const ModelRef = Schema.Struct({ providerID: ProviderV2.ID, modelID: ModelV2.ID })

export const PromptInput = Schema.Struct({
  sessionID: SessionID,                       // path param on the wire, not in body
  messageID: Schema.optional(MessageID),      // client MAY pin the user-message id ("msg..." prefix)
  model: Schema.optional(ModelRef),           // {providerID, modelID} — NOT {id}!
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),   // true → persist user msg, do NOT run the LLM
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)), // deprecated
  format: Schema.optional(SessionV1.Format),  // {type:"text"} | {type:"json_schema",schema,retryCount?}
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(Schema.Union([
    SessionV1.TextPartInput, SessionV1.FilePartInput,
    SessionV1.AgentPartInput, SessionV1.SubtaskPartInput,
  ]).annotate({ discriminator: "type" })),
})
```

Part input schemas — verbatim (`packages/schema/src/v1/session.ts:397-451`; wire twins at
`v2/gen/types.gen.ts:2545-2591`):

```ts
TextPartInput  = { id?: PartID, type: "text", text: string, synthetic?: boolean, ignored?: boolean,
                   time?: { start: number, end?: number }, metadata?: Record<string, unknown> }
FilePartInput  = { id?: PartID, type: "file", mime: string, filename?: string, url: string,
                   source?: FilePartSource }   // url is file://... or data:<mime>;base64,...
AgentPartInput = { id?: PartID, type: "agent", name: string,
                   source?: { value: string, start: number, end: number } }
SubtaskPartInput = { id?: PartID, type: "subtask", prompt: string, description: string, agent: string,
                   model?: { providerID: string, modelID: string }, command?: string }
```

`FilePartSource` (`types.gen.ts:425-464`) = `FileSource {type:"file", path, text:{value,start,end}}` |
`SymbolSource {type:"symbol", path, range, name, kind, text}` | `ResourceSource {type:"resource",
clientName, uri, text}`.

**Traced TUI call** (`packages/tui/src/component/prompt/index.tsx:1092-1118`):

```ts
sdk.client.session.prompt(
  {
    sessionID,
    ...selectedModel,           // dropped by the SDK — never on the wire (see §1.3)
    agent: agent.name,          // ALWAYS present
    model: selectedModel,       // { providerID, modelID } — ALWAYS present
    variant,                    // string | undefined ("high", ... thinking variant)
    parts: [
      ...editorParts,           // optional synthetic text part with metadata.kind === "editor_context"
      { type: "text", text: inputText },
      ...nonTextParts,          // file parts from @-mentions / pasted images
    ],
  },
  { throwOnError: true },
).catch((error) => toast.show({ title: "Failed to send prompt", message: errorMessage(error), variant: "error" }))
```

Wire example:

```
POST /session/ses_01a3.../message HTTP/1.1
x-opencode-directory: %2FUsers%2Fme%2Fproj
Content-Type: application/json

{"agent":"build",
 "model":{"providerID":"anthropic","modelID":"claude-opus-4-5"},
 "parts":[{"type":"text","text":"fix the failing test"},
          {"type":"file","mime":"text/plain","filename":"src/a.ts","url":"file:///Users/me/proj/src/a.ts",
           "source":{"type":"file","path":"src/a.ts","text":{"value":"@src/a.ts","start":0,"end":9}}}]}
```

### Server behavior (stock) — this defines what the shim may/must do

`handlers/session.ts:295-309`: verifies the session exists (404 `NotFoundError` otherwise), then runs
`promptSvc.prompt(...)` **to completion of the entire agentic turn** (`prompt.ts:1052-1071`: creates the
user message, then `loop`s until the model stops calling tools), and only then responds. Response body is
the **final assistant message with parts** — `SessionV1.WithParts` where `info` is an
`AssistantMessage` (or the *user* message if `noReply:true`). It is written via
`HttpServerResponse.stream(Stream.make(JSON.stringify(message))...)` with `contentType: "application/json"`
(`handlers/session.ts:306-308`) — i.e. **chunked transfer encoding, no Content-Length**, single chunk.

**Critical for the shim:** the TUI never reads this response body — it renders everything from SSE and only
cares that the request eventually resolves without an error status (toast otherwise). The TUI's fetch has
timeouts disabled (`req.timeout = false`, `v2/client.ts:52-55`), so blocking for the whole turn is safe and
matches stock behavior. You may respond earlier (e.g. right after persisting the user message) with a valid
`WithParts` JSON — nothing in the TUI breaks — but blocking-until-done is the compatible default, and other
clients (`opencode run`, plugins) DO read the returned assistant message/`structured` field.

Response 200 shape (`SessionPromptResponses`, `types.gen.ts:9829-9837`): `{ info: AssistantMessage, parts: Part[] }`.

`AssistantMessage` verbatim (`packages/schema/src/v1/session.ts:453-485`; wire `types.gen.ts:333-374`):

```ts
{
  id: string, sessionID: string, role: "assistant",
  time: { created: number, completed?: number },
  error?: ProviderAuthError|UnknownError|MessageOutputLengthError|MessageAbortedError|
          StructuredOutputError|ContextOverflowError|ContentFilterError|APIError,  // {name, data:{...}} shapes
  parentID: string,            // id of the user message
  modelID: string, providerID: string,
  mode: string, agent: string, // mode === agent name (legacy field)
  path: { cwd: string, root: string },
  summary?: boolean, cost: number,
  tokens: { total?: number, input: number, output: number, reasoning: number,
            cache: { read: number, write: number } },
  structured?: unknown, variant?: string, finish?: string   // finish e.g. "stop"|"tool-calls"
}
```

Minimal JSON the shim can return for a completed turn:

```json
{
  "info": {
    "id": "msg_01b...", "sessionID": "ses_01a...", "role": "assistant",
    "time": { "created": 1770000001000, "completed": 1770000009000 },
    "parentID": "msg_01a...", "modelID": "claude-opus-4-5", "providerID": "anthropic",
    "mode": "build", "agent": "build",
    "path": { "cwd": "/Users/me/proj", "root": "/Users/me/proj" },
    "cost": 0,
    "tokens": { "input": 10, "output": 20, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
    "finish": "stop"
  },
  "parts": [
    { "id": "prt_01c...", "sessionID": "ses_01a...", "messageID": "msg_01b...",
      "type": "text", "text": "Done." }
  ]
}
```

**Expected SSE side effects while the POST is in flight** (that's what actually paints the screen):
`message.updated` (user msg), `message.part.updated` (user parts), `session.status` busy,
`message.updated` (assistant), `message.part.updated`/`message.part.delta` (streaming parts),
`session.updated` (title/tokens/cost), `session.status` idle. See the events contract doc.

Errors: 400 (any prompt-service failure gets blanket-mapped to `{"_tag":"BadRequest"}` —
`handlers/session.ts:305`), 404 NotFoundError.

Agent semantics: `agent` is the agent **name** (string). Server resolves it (`prompt.ts:635-644`); unknown
agent → publishes a `session.error` SSE event and dies (surfaces as a 400/500 to the caller). If omitted,
default agent is used. `model` optional: fallback order is agent's configured model → the session's stored
model → last user message's model → provider default (`prompt.ts:646`, `614-633`).

---

## 4. POST /session/{sessionID}/prompt_async

- SDK: `session.promptAsync` → `POST /session/{sessionID}/prompt_async` (`v2/gen/sdk.gen.ts:4095-4148`).
- Server: `groups/session.ts:329-342`; handler `handlers/session.ts:311-329`.

Body: **identical schema to prompt** (`PromptPayload`). Behavior: validates session, forks the prompt in
the background, returns immediately with **204 No Content** (`SessionPromptAsyncResponses`,
`types.gen.ts:10176-10181`: `204: void`). Failures inside the background turn are reported via a
`session.error` SSE event (`handlers/session.ts:317-325`), never via HTTP.

**Traced TUI calls** — only from workspace/move flows, always with `noReply: true` and one synthetic text part:
- `packages/tui/src/component/prompt/move.tsx:139-152`:
  `{ sessionID, directory, noReply: true, parts: [{type:"text", text: moveReminderText(directory), synthetic: true}] }`
- `packages/tui/src/component/dialog-workspace-create.tsx:139-153`: same with `workspace` instead of `directory`.
Both `.catch(() => undefined)` — result fully ignored. Shim: accept, persist the synthetic user message,
return 204.

---

## 5. POST /session/{sessionID}/shell

- SDK: `session.shell` (`v2/gen/sdk.gen.ts:4213-4254`). Server: `groups/session.ts:356-368`,
  handler `handlers/session.ts:341-347`, implementation `prompt.ts:451-592` + `1349-1354`.

Body (`ShellInput` minus sessionID, `prompt.ts:1527-1534`; wire `types.gen.ts:10237-10255`):

```ts
{ messageID?: string, agent: string /* REQUIRED */,
  model?: { providerID: string, modelID: string }, command: string }
```

**Traced TUI call** (`prompt/index.tsx:1058-1069`, fired when prompt is in "shell" mode — user typed `!`):

```ts
void sdk.client.session.shell({
  sessionID, agent: agent.name,
  model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID },
  command: inputText,
})
```

Stock behavior: creates a synthetic user message ("The following tool was executed by the user") + an
assistant message containing a single `tool` part with `tool: "bash"` (`ShellID.ToolID = "bash"`,
`packages/opencode/src/tool/shell/id.ts:16`) whose state goes `running` → `completed` with streamed
`metadata.output` updates published as
`message.part.updated` SSE while the command runs; **HTTP response blocks until the command exits** and
returns `{info: <assistant msg>, parts: [<tool part>]}` (200, `SessionShellResponses`,
`types.gen.ts:10274-10284`). The LLM is NOT invoked. TUI ignores the response (void) and renders from SSE.
Errors: 400, 404, **409 SessionBusyError** if a turn is running.

---

## 6. POST /session/{sessionID}/command

- SDK: `session.command` (`v2/gen/sdk.gen.ts:4155-4206`). Server: `groups/session.ts:343-355`,
  handler `handlers/session.ts:331-339`, impl `prompt.ts:1356-1481`.

Body (`CommandInput` minus sessionID, `prompt.ts:1536-1562`; wire `types.gen.ts:10185-10201`):

```ts
{
  messageID?: string,
  agent?: string,
  model?: string,          // NOTE: "provider/model" STRING here, not an object!
  arguments: string,       // required (may be "")
  command: string,         // required, command name without the leading "/"
  variant?: string,
  parts?: Array<{ id?: string, type: "file", mime: string, filename?: string, url: string,
                  source?: FilePartSource }>   // file parts only
}
```

**Traced TUI call** (`prompt/index.tsx:1082-1090`, fired when input starts with `/` and matches a command
from `GET /command`):

```ts
void sdk.client.session.command({
  sessionID, command: command.slice(1), arguments: args,
  agent: agent.name, model: `${selectedModel.providerID}/${selectedModel.modelID}`,
  variant, parts: nonTextParts.filter((x) => x.type === "file"),
})
```

Stock behavior: resolves the command template, substitutes `$1..$n`/`$ARGUMENTS`, executes inline
`` !`...` `` shell blocks, then runs a normal prompt turn; **blocks until turn completion** and returns
`{info: AssistantMessage, parts}` (200, `types.gen.ts:10225-10233`). Unknown command → `session.error` SSE
+ HTTP 400. TUI ignores the response. Also emits a `command.executed` event.

---

## 7. POST /session/{sessionID}/abort

- SDK: `session.abort` (`v2/gen/sdk.gen.ts:3913-3938`). Server: `groups/session.ts:253-264`,
  handler `handlers/session.ts:232-235` (`promptSvc.cancel(sessionID)`).
- No body. Response 200: bare JSON `true` (`SessionAbortResponses`, `types.gen.ts:9975-9980`).
- **Traced TUI calls:** double-Esc interrupt `prompt/index.tsx:413-418`; before undo
  `routes/session/index.tsx:612` (`.catch(() => {})`).
- Afterwards the TUI expects SSE: the in-flight assistant `message.updated` gaining
  `error: {name:"MessageAbortedError", data:{message}}` + `time.completed`, and `session.status` → `{type:"idle"}`.
  The blocked `POST .../message` from §3 still resolves 200 with the aborted assistant message (stock).

---

## 8. Session lifecycle writes

### 8.1 POST /session/{sessionID}/fork

- SDK: `session.fork` (`v2/gen/sdk.gen.ts:3874-3906`). Server: `groups/session.ts:240-252`, handler
  `handlers/session.ts:206-230` (empty body OK).
- Body: `{ messageID?: string }` — fork up to (excluding effects after) that user message; omitted = full copy.
- Response 200: **Session** (the new forked session; new `id`, `parentID` unset — it's a sibling copy).
- **Traced TUI calls:** `app.tsx:511,531` (`--continue --fork` / `--session --fork`);
  `routes/session/dialog-fork-from-timeline.tsx:28,48` (fork from timeline, with `messageID`).
  **TUI reads `result.data.id` and navigates to it** — response must be a real Session JSON; the TUI also
  expects the forked session's messages to be retrievable via `GET /session/{id}/message` right after.

### 8.2 DELETE /session/{sessionID}

- SDK: `session.delete` (`v2/gen/sdk.gen.ts:3495-3520`). Server handler `handlers/session.ts:178-181`.
- Response 200: bare `true`. Errors 400/404.
- **Traced TUI call:** `component/dialog-session-list.tsx:307-309`; checks `result.error` and toasts on
  failure. Expects SSE `session.deleted {sessionID}` to remove it from stores (`sync.tsx:267`).

### 8.3 PATCH /session/{sessionID}

- SDK: `session.update` (`v2/gen/sdk.gen.ts:3559-3601`). Server: `groups/session.ts:49-58` (UpdatePayload),
  handler `handlers/session.ts:183-204`.
- Body: `{ title?: string, metadata?: object, permission?: PermissionRuleset, time?: { archived?: number } }`.
  Note handler semantics: `permission` is **merged** (appended) onto the existing ruleset, not replaced
  (`handlers/session.ts:194-199`).
- Response 200: updated **Session**.
- **Traced TUI call:** rename dialog `component/dialog-session-rename.tsx:22-25` `{sessionID, title}`,
  fire-and-forget → expects `session.updated` SSE to show the new title.

### 8.4 POST /session/{sessionID}/summarize (compaction)

- SDK: `session.summarize` (`v2/gen/sdk.gen.ts:4052-4088`). Server: `groups/session.ts:65-69,303-315`,
  handler `handlers/session.ts:273-293`.
- Body: `{ providerID: string, modelID: string, auto?: boolean }` (providerID/modelID required by server
  schema even though the SDK marks them optional).
- Response 200: bare `true` — returned **after kicking off** compaction (`compactSvc.create` + `loop`); the
  loop itself runs within the request (blocks until the compaction turn completes).
- **Traced TUI call:** `/compact` command, `routes/session/index.tsx:572-576`
  `{sessionID, modelID, providerID}`; fire-and-forget → progress arrives via SSE (`session.updated` with
  `time.compacting`, a user message containing a `compaction` part, then a `summary:true` assistant message).

### 8.5 POST /session/{sessionID}/share and DELETE /session/{sessionID}/share

- SDK: `session.share` / `session.unshare` (`v2/gen/sdk.gen.ts:4020-4045` / `3988-4013`).
  Server handler `handlers/session.ts:259-271`.
- No body. Response 200: **Session** (share: with `share: {url}`; unshare: without).
- **Traced TUI calls:** `routes/session/index.tsx:485-495` — **reads `res.data!.share!.url`** and copies to
  clipboard, so the share response MUST include `share.url`; unshare `routes/session/index.tsx:589-599`
  toasts success/failure. Errors here are 500 `{"_tag":"InternalServerError"}` / 404.

### 8.6 POST /session/{sessionID}/revert and /unrevert

- SDK: `session.revert` / `session.unrevert` (`v2/gen/sdk.gen.ts:4261-4327`).
  Server: `groups/session.ts:369-394`, handlers `handlers/session.ts:349-360`.
- revert body (`RevertPayload` = `SessionRevert.RevertInput` minus sessionID): `{ messageID: string, partID?: string }`.
  unrevert: no body.
- Response 200: updated **Session** — revert sets `session.revert = {messageID, partID?, snapshot?, diff?}`,
  unrevert clears it. Errors: 400/404/**409 SessionBusyError**.
- **Traced TUI calls:** undo `routes/session/index.tsx:616-623` (then scrolls; also pre-fills the prompt with
  the reverted message's text), redo `index.tsx:654-663` (revert to a later message or unrevert), message
  dialog `routes/session/dialog-message.tsx:33-36`. TUI relies on the `session.updated` SSE (with the
  `revert` field) to grey out reverted messages.

### 8.7 POST /session/{sessionID}/init — NOT called by the v1.17.19 TUI

Kept for completeness (other clients/plugins use it): body `{ modelID, providerID, messageID }` (all
required, `groups/session.ts:60-64`), runs the built-in `/init` command to generate AGENTS.md, blocks,
returns bare `true` (`handlers/session.ts:237-252`).

### 8.8 DELETE message / part routes — NOT called by the TUI

`DELETE /session/{sessionID}/message/{messageID}` → `true` (409 if busy);
`DELETE|PATCH /session/{sessionID}/message/{messageID}/part/{partID}` (`groups/session.ts:409-444`).
PATCH part requires body `SessionV1.Part` whose `id/messageID/sessionID` match the path (400 otherwise,
`handlers/session.ts:397-411`).

---

## 9. POST /permission/{requestID}/reply

- SDK: `permission.reply` (`v2/gen/sdk.gen.ts:3121-3155`). Server: `groups/permission.ts:31-43`,
  handler `handlers/permission.ts:16-37`, service `packages/opencode/src/permission/index.ts:109-167`.

**Path confirmed:** `POST /permission/{requestID}/reply` (requestID has `per` prefix).

Body — verbatim (`groups/permission.ts:12-15`, `packages/schema/src/v1/permission.ts:38-44`):

```ts
{ reply: "once" | "always" | "reject", message?: string }
```

Query: `directory?`, `workspace?` (TUI always sends both explicitly — see below).

Response 200: bare `true`. Errors: 400; 404 `{"_tag":"PermissionNotFoundError","requestID","message"}`.

**Does an "always" carry pattern info? NO.** The reply body has no patterns. The *original permission
request* carries an `always: string[]` field (`PermissionV1.Request`, `schema/src/v1/permission.ts:27-36`),
and on `reply:"always"` the server adds `{permission, pattern, action:"allow"}` rules for **those stored
patterns** to an in-memory, instance-scoped approved list ("until OpenCode is restarted"), then
auto-approves any other pending requests in the same session that are now fully allowed
(`permission/index.ts:145-166`). The TUI's "Always allow" confirmation dialog just displays
`props.request.always` (`routes/session/permission.tsx:143-160`).

Other reply semantics (`permission/index.ts:121-142`):
- `reject` + `message` → the tool call fails with a `PermissionCorrectedError` carrying the feedback (the
  agent sees the user's correction); plain `reject` → `PermissionRejectedError`. A reject also **cascades:
  every other pending permission of the same session is auto-rejected** (each with its own
  `permission.replied` event).
- Every reply publishes SSE `permission.replied {sessionID, requestID, reply}` — **the TUI only removes the
  permission dialog when it sees this event** (`sync.tsx:175-188`), not on HTTP success. A shim that
  returns `true` without emitting the event leaves the dialog stuck.

**Traced TUI calls** (`routes/session/permission.tsx`):
- allow once: `{reply:"once", requestID, directory: props.directory, workspace}` (lines 426-431)
- allow always (after confirm): `{reply:"always", requestID, directory, workspace}` (lines 168-173)
- reject (top-level session): `{reply:"reject", requestID, directory, workspace}` (lines 418-423)
- reject with feedback (subagent sessions only): `{reply:"reject", requestID, directory, message, workspace}` (lines 180-186)
- auto-approve mode: `{requestID, reply:"once", directory, workspace}` on every `permission.asked`
  (`context/sync.tsx:192-199`).

### 9.1 Legacy: POST /session/{sessionID}/permissions/{permissionID} (deprecated, NOT used by this TUI)

Server still implements it (`groups/session.ts:395-408`, marked `deprecated: true`); body
`{ response: "once" | "always" | "reject" }` (note **`response`**, not `reply`, and no message field);
returns `true`. Older clients (pre-1.17 TUIs, plugins) use this path — implement it as an alias if you
want broader compatibility.

---

## 10. Question routes

Server: `groups/question.ts`; schema `packages/schema/src/v1/question.ts`.

### 10.1 POST /question/{requestID}/reply

- SDK: `question.reply` (`v2/gen/sdk.gen.ts:3018-3050`). Body:

```ts
{ answers: Array<Array<string>> }  // one array per question, each = selected labels (or one custom string)
```

- Response 200: bare `true`. Errors: 400; 404 `{"_tag":"QuestionNotFoundError",...}`.
- **Traced TUI calls** (`routes/session/question.tsx:48-55,73-79`):
  `{requestID, directory, answers}` — answers built from selected option **labels**; custom typed answers are
  passed as the raw string in the same position. Fire-and-forget.

### 10.2 POST /question/{requestID}/reject

- SDK: `question.reject` (`v2/gen/sdk.gen.ts:3057-3082`). No body. Response 200: `true`.
- **Traced TUI call:** `question.tsx:57-62` `{requestID, directory}`.

After either, the TUI removes the question UI only upon SSE `question.replied {sessionID, requestID,
answers}` / `question.rejected {sessionID, requestID}` (`sync.tsx:221-235`). The pending-question shape the
TUI renders (from `question.asked` SSE or `GET /question`) is `QuestionRequest`
(`types.gen.ts:2447-2455`): `{id:"que...", sessionID, questions: [{question, header, options:
[{label, description}], multiple?, custom?}], tool?: {messageID, callID}}`.

---

## 11. Todos — there is NO write route

The TUI only **reads** `GET /session/{sessionID}/todo` during hydration (`context/sync.tsx:598`) and
otherwise consumes `todo.updated` SSE events (`sync.tsx:259`). Todos are written server-side by the
`todowrite` tool during a turn. Todo shape: `{content: string, status: "pending"|"in_progress"|"completed"|
"cancelled", priority: "high"|"medium"|"low"}` (`types.gen.ts:658-671`; status/priority are plain strings in
the schema). The shim maps Claude-SDK TodoWrite tool calls to `todo.updated` events; no HTTP endpoint needed.

---

## 12. Secondary writes the TUI performs (implement as stubs or fully)

| Route | SDK call | TUI call site | Body | Response | Notes |
|---|---|---|---|---|---|
| `PUT /auth/{providerID}` | `auth.set` (`v2/gen/sdk.gen.ts:477-507`) | `component/dialog-provider.tsx:397` | the `Auth` object **as the whole body** (`{type:"api",key}` \| `{type:"oauth",refresh,access,expires}` \| `{type:"wellknown",key,token}`, `types.gen.ts:109-132`) | `true` | followed by `instance.dispose` |
| `POST /instance/dispose` | `instance.dispose` (`sdk.gen.ts:1940-1955`) | `dialog-provider.tsx:281,332,405`, `dialog-console-org.tsx:106` | none | `true` | TUI then expects global SSE `server.instance.disposed` → triggers full re-bootstrap (`sync.tsx:172`) |
| `POST /provider/{providerID}/oauth/authorize` | `provider.oauth.authorize` (`sdk.gen.ts:3207-3243`) | dialog-provider.tsx | `{method: number, inputs?: Record<string,string>}` | `ProviderAuthAuthorization` (`{url, method, instructions?}`) | |
| `POST /provider/{providerID}/oauth/callback` | `provider.oauth.callback` | dialog-provider.tsx | `{method: number, code?: string}` | `true` | |
| `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect` | `mcp.connect/disconnect` (`sdk.gen.ts:2488-2528`) | `context/local.tsx:514-517` | none | MCP status object | |
| `POST /global/upgrade` | `global.upgrade` (`sdk.gen.ts:1360-1377`) | `app.tsx:1058` | `{target?: string}` | upgrade result | fine to 501/stub |
| `POST /log` | `app.log` (`sdk.gen.ts:509-...`) | not called by TUI v1.17.19 | `{service?,level?,message?,extra?}` | `true` | harmless no-op stub |

**Out of scope for this doc (v2 `/api/*` surface, `sdk.client.v2.*`):** `context/data.tsx:422-543` uses it
for per-session hydration reads (session/messages/permission.list/question.list/agent/command/model/
provider/skill lists), and `component/prompt/move.tsx:40` / `dialog-move-session.tsx:77,224,246` use
`v2.projectCopy.*` writes; `experimental.controlPlane.moveSession`, `experimental.workspace.*`,
`experimental.session.background` are experimental-flag flows. Covered in the reads/v2 contract docs.

> CORRECTED (resolves this doc's open question about v2 hydration): the v2 session-scoped
> reads in `data.tsx:416-463` (`v2.session.get/messages`, `permission.list`, `question.list`,
> `permission.saved`) have **no caller anywhere in the v1.17.19 TUI** — verified by the
> 04-reads-v2 trace (data.tsx methods exist but are dead code; the only `useData()` consumer
> is prompt autocomplete reading `reference.list()`). Session hydration on open is entirely
> v1: `GET /session/{id}`, `GET /session/{id}/message?limit=100`, `GET /session/{id}/todo`,
> `GET /session/{id}/diff` (`sync.tsx:596-599`). A writes+reads shim on v1 routes alone fully
> supports session hydration; the `/api/*` session reads can be empty-but-valid stubs.

---

## 13. Verbatim shared response schema: SessionV1.WithParts

(`packages/schema/src/v1/session.ts:490-500`)

```ts
export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export const WithParts = Schema.Struct({ info: Info, parts: Schema.Array(Part) })
```

`UserMessage` verbatim (`schema/src/v1/session.ts:332-354`; wire `types.gen.ts:239-262`):

```ts
{
  id: string, sessionID: string, role: "user",
  time: { created: number },
  format?: OutputFormat,
  summary?: { title?: string, body?: string, diffs: FileDiff[] },
  agent: string,                                             // REQUIRED
  model: { providerID: string, modelID: string, variant?: string },  // REQUIRED
  system?: string, tools?: Record<string, boolean>
}
```

`Part` union (12 members, `schema/src/v1/session.ts:357-370`; full field lists at `types.gen.ts:378-639`):
`text | subtask | reasoning | file | tool | step-start | step-finish | snapshot | patch | agent | retry |
compaction`. Every persisted part has required `id` ("prt..."), `sessionID`, `messageID`, `type`.
`ToolPart` = `{..., type:"tool", callID: string, tool: string, state: ToolState}` with
`ToolState.status ∈ pending|running|completed|error` (`types.gen.ts:477-545`).

---

## 14. Traps / gotchas checklist for the shim implementer

1. **Three different model encodings** in write bodies:
   - `POST /session` (create): `model: { id, providerID, variant? }` — key is **`id`**.
   - prompt / prompt_async / shell: `model: { providerID, modelID }` — key is **`modelID`**, no variant
     (variant is a separate top-level body field on prompt).
   - command / init: `model: "providerID/modelID"` — a **string** (modelID may itself contain `/`; split on
     the FIRST slash only, cf. `packages/tui/src/context/local.tsx:28-32`).
2. **Empty JSON bodies with `Content-Type: application/json`** on `POST /session` and `POST .../fork`
   must be accepted (§1.3).
3. `directory` arrives as an **encoded header on writes** (`x-opencode-directory`) but a **query param on
   reads**, and some writes ALSO pass `?directory=` explicitly (permission/question replies, prompt_async
   from move flows). Support all three; query wins over header (`workspace-routing.ts:86-88`).
4. **Permission dialog dismissal is SSE-driven**: `POST /permission/{id}/reply` → must emit
   `permission.replied` (and honor cascade semantics on reject if you queue multiple asks). Same for
   questions (`question.replied` / `question.rejected`).
5. `reply:"always"` stores the request's own `always` patterns server-side; nothing extra in the body.
   Scope of "always" is the running instance (memory), not config files.
6. Several 200 responses are **bare JSON booleans** (`true`): abort, delete session, summarize, init,
   permission/question replies, deleteMessage. Don't wrap them in objects.
7. The prompt POST **blocks for the whole turn** on the stock server and streams the body (chunked). The TUI
   tolerates any duration (client timeouts disabled) and ignores the body — but do return valid
   `WithParts` JSON with `role:"assistant"` for CLI/plugin compatibility, and don't send it until you have
   final token/cost numbers if you want `opencode run` to report correctly.
8. **Share response must contain `share.url`** — the TUI dereferences `res.data!.share!.url` without checks
   (`routes/session/index.tsx:489`). If you don't implement sharing, return 500
   `{"_tag":"InternalServerError"}` so the TUI's catch shows a toast, or hide the command by serving
   `config.share = "disabled"` from `GET /config` (the command is gated on that —
   `routes/session/index.tsx:464`).
9. **Fork and create responses are load-bearing**: `data.id` is read and immediately navigated to; a fake id
   that then 404s on `GET /session/{id}` bounces the user back home with an error toast
   (`routes/session/index.tsx:283-291`).
10. Message/part/session IDs must be **lexicographically ordered by creation time** (§1.6); TUI sorting,
    undo/redo message selection, and "before" pagination all compare id strings.
11. Unknown top-level JSON keys may appear (future SDKs) — ignore them; conversely never rely on the
    `providerID`/`modelID` the TUI *appears* to spread at top level of `session.prompt` (it's stripped
    client-side, §1.3).
12. On abort, finish the story: set `error: {name:"MessageAbortedError", data:{message:"..."}}` +
    `time.completed` on the assistant message via `message.updated`, flip `session.status` to idle, and
    still resolve any blocked prompt POST with 200.
13. 404s must be `{"name":"NotFoundError","data":{"message":...}}` (name/data shape) for session-scoped
    routes, but `{"_tag":"PermissionNotFoundError"|"QuestionNotFoundError",...}` (tag shape) for
    permission/question — the two shapes coexist in the real server.
14. Never return `text/html` from any path the SDK might hit (§1.4).
15. `PATCH /session/{id}` `permission` payload **appends** rules (merge), and rule evaluation picks the
    **last** matching rule (`permission/index.ts:28-38` `findLast`) — order matters if you implement rules.
