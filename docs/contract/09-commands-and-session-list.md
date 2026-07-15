# 09 — Custom commands & the session list (GET /command, POST .../command, GET /session, /session/status, DELETE cascade)

Target client: **opencode TUI v1.17.19** (`vendor/opencode/packages/tui`), talking through the
v2 JS SDK (`@opencode-ai/sdk/v2`). Transport conventions (directory header→query rewrite on GET,
error shapes, `text/html` ban) are as in `03-writes-v1.md` §1 and apply to every route here.

Authoritative sources (paths repo-relative to `vendor/opencode/`):

| What | File |
|---|---|
| `GET /command` route decl | `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts:139-148` |
| `GET /command` handler | `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts:76-78` |
| Command service + schema | `packages/opencode/src/command/index.ts` |
| Command markdown loader | `packages/opencode/src/config/command.ts`, `packages/core/src/v1/config/command.ts` |
| Command wire type | `packages/sdk/js/src/v2/gen/types.gen.ts:2334-2343` |
| Command execution impl | `packages/opencode/src/session/prompt.ts:1356-1481` (+ regexes `1592-1596`) |
| `GET /session` route decl (ListQuery) | `groups/session.ts:30-38,111-120` |
| `GET /session` handler | `handlers/session.ts:64-75` |
| List SQL semantics | `packages/opencode/src/session/session.ts:548-555` (`list`) + `957-1010` (`listByProject`) |
| Session remove (cascade) | `packages/opencode/src/session/session.ts:608-629` |
| Session status service | `packages/opencode/src/session/status.ts`, schema `packages/schema/src/session-status-event.ts` |
| TUI sync-store list | `packages/tui/src/context/sync.tsx:154-168,445-533` |
| TUI sessions dialog | `packages/tui/src/component/dialog-session-list.tsx` |
| TUI delete-failed dialog | `packages/tui/src/component/dialog-session-delete-failed.tsx` |
| TUI slash autocomplete | `packages/tui/src/component/prompt/autocomplete.tsx:447-524,676-708` |
| TUI command submit | `packages/tui/src/component/prompt/index.tsx:1070-1090` |

> Note: `packages/tui/src/plugin/command-shim.ts` is unrelated to server commands — it is a legacy
> adapter for TUI *plugin palette* commands (keymap layer). Server custom commands never pass
> through it. `context/local.tsx` contributes only the currently-selected agent/model/variant that
> ride along on the execute request.

---

## 1. GET /command — list custom commands

- SDK: `command.list` → `GET /command` (`v2/gen/sdk.gen.ts:2165-2188`). Query params: `directory?`,
  `workspace?` (plus the client interceptor injects `?directory=` from the `x-opencode-directory`
  header on every GET).
- Server: `groups/instance.ts:139-148` — success `Schema.Array(Command.Info)`; handler is literally
  `command.list()` (`handlers/instance.ts:76-78`). No filtering, no pagination, no errors beyond
  transport-level ones.

### 1.1 Command schema — verbatim

Server schema (`packages/opencode/src/command/index.ts:22-32`):

```ts
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),          // "providerID/modelID" string (split on FIRST "/")
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  template: Schema.Unknown,                       // wire type claims string — see trap below
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),             // REQUIRED (may be [])
}).annotate({ identifier: "Command" })
```

Generated wire type (`types.gen.ts:2334-2343`):

```ts
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
```

`hints` is computed server-side from the template (`command/index.ts:36-44`): the sorted unique
`$N` placeholders plus `"$ARGUMENTS"` if present — e.g. `["$1","$2","$ARGUMENTS"]`.

**Trap — `template` for MCP commands is not a string.** For MCP-prompt commands the `template`
getter returns a lazy `Promise` (`command/index.ts:110-129`); `Schema.Unknown` passes it through
and `JSON.stringify` serializes a Promise as `{}`. So the stock wire response can contain
`"template": {}` despite the generated type saying `string`. Nothing breaks because **the TUI
never reads `template`** (see §1.3).

### 1.2 What the reference server puts in the list

Built in state init (`command/index.ts:65-157`), keyed by name (later sources do NOT overwrite
earlier ones for skills):

1. Built-ins `init` ("guided AGENTS.md setup") and `review` ("review changes [commit|branch|pr],
   defaults to uncommitted", `subtask: true`), `source: "command"`.
2. Every entry of `config.command` (merged from `opencode.json` and `{command,commands}/**/*.md`
   files under config dirs — `config/command.ts:13-39`; markdown frontmatter supplies
   `description/agent/model/variant/subtask`, the body is the template). `source: "command"`.
   **The config-level `variant` field is dropped** — it is not part of `Command.Info`
   (`command/index.ts:90-103` copies only agent/model/description/subtask).
3. Every MCP prompt, `source: "mcp"`, hints `["$1".."$n"]` from the prompt's declared arguments.
4. Every skill not shadowed by an existing name, `source: "skill"`, template = skill content
   (+ base-directory epilogue), `hints: []`.

Wire example:

```json
[
  { "name": "init", "description": "guided AGENTS.md setup", "source": "command",
    "template": "...", "hints": [] },
  { "name": "component", "description": "scaffold a component", "agent": "build",
    "model": "anthropic/claude-opus-4-5", "source": "command",
    "template": "Create component $1 in $2\n$ARGUMENTS", "subtask": false,
    "hints": ["$1", "$2", "$ARGUMENTS"] }
]
```

### 1.3 What the TUI actually consumes

- Fetched **once per bootstrap**, non-blocking: `sdk.client.command.list({ workspace })` →
  `store.command` (`sync.tsx:517`), default `[]` on error. Re-fetched only on full re-bootstrap
  (`server.instance.disposed`). **No SSE event updates the command list at v1.17.19.**
- Fields read anywhere in the TUI: **`name`, `description`, `source` — nothing else.**
  `template`, `hints`, `agent`, `model`, `subtask` are never dereferenced client-side (verified by
  grep across `packages/tui/src`); they exist for the server's own execution step and for other
  clients. You must still emit `name`, `template`, `hints` to be schema-shaped.
- Autocomplete (`autocomplete.tsx:447-474`): opens when the input's first character is `/` and the
  cursor is inside the first token (`:676-708`); options = TUI palette slash entries
  (`useCommandSlashes()`, local dispatch — e.g. `/compact`, `/new`, `/share`) **plus** every server
  command **except `source === "skill"`** (hidden). MCP commands display as `/name:mcp`. Selecting
  a server command only **inserts the text `/name ␣`** into the input; fuzzy match runs over
  display AND `description` (`:502-521`).

---

## 2. Executing a custom command — client trace + server semantics

### 2.1 The TUI side: name match → POST /session/{sessionID}/command

There is **no client-side template substitution**. On submit (`prompt/index.tsx:1070-1090`), if the
input starts with `/` AND the first whitespace-token of the first line (minus the slash) equals the
`name` of some entry in `store.command`:

```ts
// firstLine = "/component Button src/ui", rest = subsequent lines
const [command, ...firstLineArgs] = firstLine.split(" ")
const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")
void sdk.client.session.command({
  sessionID,
  command: command.slice(1),        // "component" — name without slash
  arguments: args,                  // remainder of first line + "\n" + remaining lines
  agent: agent.name,                // TUI's currently selected agent
  model: `${selectedModel.providerID}/${selectedModel.modelID}`,   // STRING encoding
  variant,                          // thinking variant or undefined
  parts: nonTextParts.filter((x) => x.type === "file"),            // @-mention / pasted files
})
```

Fire-and-forget (`void`) — response ignored; rendering is SSE. If the first token does **not**
match a listed command, the whole text (slash included) is sent as a **normal prompt part** via
`POST /session/{id}/message`. If no session exists yet (home screen), `POST /session` runs first
and the command is posted to the fresh id.

Wire (per `sdk.gen.ts:4155-4206`): path `sessionID`; query `directory?`/`workspace?` (TUI passes
neither explicitly; header interceptor covers writes); JSON body:

```
POST /session/ses_.../command HTTP/1.1
x-opencode-directory: %2FUsers%2Fme%2Fproj
Content-Type: application/json

{"command":"component","arguments":"Button src/ui",
 "agent":"build","model":"anthropic/claude-opus-4-5","parts":[]}
```

Body schema (`CommandInput` minus `sessionID`, `prompt.ts:1536-1562`): `messageID?`, `agent?`,
`model?` (string), `arguments` (required, may be `""`), `command` (required), `variant?`,
`parts?` (file parts only).

### 2.2 The reference server's execution pipeline (`prompt.ts:1356-1481`)

1. **Lookup** `commands.get(input.command)`. Unknown → publish SSE `session.error` with
   `Command not found: "<name>". Available commands: ...` and fail → handler maps every failure to
   HTTP 400 `{"_tag":"BadRequest"}` (`handlers/session.ts:331-339`). Missing session → 404
   `{"name":"NotFoundError","data":{...}}` first.
2. **Agent override**: `agentName = cmd.agent ?? input.agent` — the command definition **wins**
   over the request. Resolved against the agent registry; unknown agent → `session.error` SSE +
   400. No `cmd.agent` and no `input.agent` → default agent.
3. **Argument tokenization** (`prompt.ts:1372-1373`, regexes `1592-1596`):
   `arguments.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi)`, then each token is
   quote-trimmed (`/^["']|["']$/g`). So `"a b" c` → `["a b", "c"]`.
4. **Positional substitution**: every `$N` in the template is replaced; the **highest-numbered**
   placeholder receives `args.slice(N-1).join(" ")` (the rest of the args), lower ones get the
   single token, out-of-range → `""` (`1376-1389`).
5. **`$ARGUMENTS`** is replaced with the **raw, untokenized** `input.arguments` string (`1390-1391`).
6. **No placeholders at all** (`$N` count 0 and no `$ARGUMENTS`) and non-blank arguments →
   arguments are appended: `template + "\n\n" + input.arguments` (`1393-1395`).
7. **Inline shell blocks**: every `` !`cmd` `` (`SHELL_REGEX /!`([^`]+)`/g`,
   `config/markdown.ts:6`) is executed via the preferred shell and its output spliced in
   (`1397-1408`), then the template is trimmed.
8. **Model resolution for the task** (`1411-1419`), first hit wins:
   `cmd.model` (string, `Provider.parseModel` splits on the **first** `/`) → the `cmd.agent`'s
   configured model → `input.model` (string) → the session's current model.
9. **Template → parts** (`resolvePromptParts`, `prompt.ts:157-191`): the template becomes one text
   part, plus a file part for every `@path` mention that stats on disk
   (`mime: "text/plain"` or `"application/x-directory"`), or an `agent` part if the mention names
   an agent. File parts duplicated by `input.parts` are de-duped by path (`1433-1438`).
10. **Subtask wrapping** (`1439-1458`): `isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true`.
    If true, the entire command becomes ONE `subtask` part
    `{type:"subtask", agent, description: cmd.description ?? "", command: input.command, model: taskModel, prompt: <template text>}`
    and the **user message itself** is attributed to `input.agent ?? default` with
    `input.model ?? current` (the subtask runs the command agent; the outer message does not).
    Otherwise parts = template parts + `input.parts`.
11. Runs a normal **blocking prompt turn** (`prompt(...)` — same machinery as
    `POST .../message`), returns `{info: AssistantMessage, parts}` (200), and publishes SSE
    `command.executed {name, sessionID, arguments, messageID}`
    (`packages/schema/src/v1/legacy-event.ts:8-16`). **The TUI does not consume
    `command.executed`** (no subscriber at v1.17.19) — safe to omit in a shim.

Errors: 400 `{"_tag":"BadRequest"}` (any pipeline failure, after a `session.error` SSE that the TUI
*does* render as a toast), 404 NotFoundError for the session.

---

## 3. GET /session — list query semantics

- SDK: `session.list` → `GET /session` (`v2/gen/sdk.gen.ts:3362-3403`). Query params:
  `directory?`, `workspace?`, `scope?: "project"`, `path?: string`,
  `roots?: boolean|"true"|"false"`, `start?: number`, `search?: string`, `limit?: number`.
- Route decl `groups/session.ts:30-38,111-120` (`QueryBoolean` accepts only the strings
  `"true"|"false"`, `groups/query.ts:3-8`; numbers arrive as decimal strings via
  `NumberFromString`). Response: `Schema.Array(Session.Info)`.

### 3.1 Handler + SQL — exact behavior (`handlers/session.ts:64-75`, `session.ts:957-1010`)

```
directory := (query has "directory") ? <middleware-resolved instance directory> : undefined
directory := undefined                       if scope === "project"     // handler line 67
conditions:
  project_id = <project of the instance>                                 // ALWAYS — implicit scoping
  workspace_id = <workspaceID>              if ?workspace= resolved      // experimental
  IF path !== undefined AND path !== "":
      (path = :path OR path LIKE ':path/%'
       [OR (path IS NULL AND directory = :directory)  if directory])     // legacy rows w/o path
  ELSE IF scope !== "project" AND directory:
      directory = :directory
  parent_id IS NULL                         if roots (true)
  time_updated >= :start                    if start
  title LIKE '%' || :search || '%'          if search                    // TITLE substring, case-insensitive (SQLite LIKE)
ORDER BY time_updated DESC
LIMIT limit ?? 100
```

Facts that follow:

- **`search` matches the TITLE only** (never directory/slug), substring, both sides wildcarded.
- **`roots=true` excludes exactly the sessions with a `parentID`** (i.e. subagent/subtask child
  sessions; forked sessions are siblings with no parentID and stay included).
- **`scope=project`** disables the directory filter → all sessions of the project.
- **`path=""` (empty string, sent when cwd == worktree root)** behaves like `scope=project`: the
  truthiness check skips the path condition AND the `else if` directory branch. The client
  serializer keeps empty strings (`?path=`) — only `undefined/null` params are dropped
  (`gen/client/utils.gen.ts:17-19`).
- **Non-empty `path`** selects sessions whose stored `path` (cwd relative to the worktree,
  `sessionPath()` `session.ts:171-173`) equals it or lives under it (`path/…`), plus legacy rows
  matched by absolute `directory`.
- Default `limit` 100; **ordering is `time.updated` DESC** (no id tiebreak in this v1 route).
- **No archived filter** — v1 `GET /session` returns archived sessions too (unlike
  `listGlobal`, `session.ts:557-596`, which is the `/api` surface).
- `start` is a lower bound on `time.updated` in epoch ms.

### 3.2 What the TUI sends

Two distinct callers, both ultimately `GET /session`:

1. **Sync store** (home screen + fallback data; `sync.tsx:154-168`):
   `{ start: Date.now() - 30*24*60*60*1000, ...sessionListQuery() }` where `sessionListQuery()` is
   `{scope:"project"}` when the "session directory filtering" toggle (KV
   `session_directory_filter_enabled`, default **true**, `app.tsx:934-945`) is off or paths are
   unknown, else `{path: relative(worktree, directory)}` (POSIX-slashed; `""` at the repo root).
   Result is sorted client-side by `id.localeCompare` (ascending — with stock **descending** `ses_`
   ids that is newest-first). Runs at bootstrap, on `sync.session.refresh()`, and on toggle.
   Note: **no `roots`** — the store DOES contain child sessions.
2. **DialogSessionList** (`dialog-session-list.tsx:24-32`):

   ```ts
   createDialogSessionListQuery({ search, filter }) = {
     roots: true,
     limit: search ? 30 : 100,
     ...(search ? { search } : {}),   // search is trim()ed; empty → browse query
     ...filter,                       // same {scope:"project"} | {path} as the sync store
   }
   ```

   - Browse resource: fired on dialog open with no `search`/`start`.
   - Search resource: fired per debounced keystroke (150 ms) with `search` + `limit: 30`.
   Failures resolve to `undefined` (silent fallback to the sync store), so a shim returning
   errors here degrades silently — return `200 []` at minimum.

Effective browse request line the shim will see:

```
GET /session?directory=%2FUsers%2Fme%2Fproj&roots=true&limit=100&path= HTTP/1.1
```

### 3.3 How the dialog uses the results vs the local store (`dialog-session-list.tsx:79-93,188-266`)

- Base list: `searchResults() ?? browseResults() ?? sync.data.session`.
- Every returned row is **swapped for the sync-store copy when one exists**
  (`synced.get(session.id) ?? session`) so live SSE updates win over the HTTP snapshot; the
  current-route session and pinned session ids are appended from the store if the server response
  lacks them.
- Sessions whose id arrived in a `session.deleted` SSE while the dialog is open are hidden.
- **A second, client-side filter applies:** `session.title.toLowerCase().includes(query)`.
  Consequence: a server `search` implementation that matches anything other than a title substring
  returns rows the dialog immediately hides. Match titles, case-insensitively.
- Display order ignores server order: `orderByRecency` re-sorts by `time.updated` DESC and
  **drops every session with `parentID !== undefined`** (belt-and-braces with `roots=true`).
  There is **no parent/child grouping UI** — children are simply invisible in this dialog.
- Grouping/labels: "Pinned" category first, then day buckets by `new Date(time.updated).toDateString()`
  ("Today" for today). Footer per row: derived from `session.path`/`session.directory`
  (worktree base name when the session lives outside the project main dir).

### 3.4 GET /session/status + spinner

- Route `GET /session/status` (`groups/session.ts:121-131`): success
  `Record<sessionID, SessionStatus.Info>`; handler returns the in-memory map — **only non-idle
  sessions appear**; setting `idle` deletes the key (`session/status.ts:35-48`).
- Schema (`packages/schema/src/session-status-event.ts:9-33`):
  `{type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, next, action?}`.
- TUI reads it once at bootstrap into `store.session_status` (`sync.tsx:524-526`) and thereafter
  applies `session.status` SSE events (`sync.tsx:310-313`). The dialog shows a spinner on a row
  when `status?.type === "busy" || status?.type === "retry"` (`dialog-session-list.tsx:237-244`).

### 3.5 DELETE /session/{sessionID} — failure dialog + cascade

- Success: bare `true`; unknown session → 404 `{"name":"NotFoundError","data":{"message":...}}`
  (`handlers/session.ts:178-181`).
- **Reference server cascades**: `session.remove` recursively removes all children first
  (`session.ts:619-622`), publishing one `session.deleted {sessionID, info}` event **per session**
  (children first, parent last) and cancelling that session's background jobs.
- **`session.deleted` MUST carry the full `info`**: both the sync store (`sync.tsx:267-277`) and
  the open dialog (`dialog-session-list.tsx:95-99`) read `event.properties.info.id` — an event
  with only `sessionID` breaks removal. (Schema: `packages/schema/src/v1/session.ts:588-595`.)
- **What triggers `DialogSessionDeleteFailed`** (`dialog-session-list.tsx:299-345`): the delete is
  double-press confirmed, then `sdk.client.session.delete({sessionID})`; **any** `result.error` or
  thrown transport error → if the session has a **`workspaceID`**, `recover(session)` opens
  `DialogSessionDeleteFailed` ("could not be deleted because the workspace ... is not available",
  offering "Delete workspace" via `experimental.workspace.remove` or "Restore to new workspace");
  if it has **no** `workspaceID`, a plain error toast. There is no special error shape — the
  branch keys entirely off `session.workspaceID`. The reference failure that motivates it comes
  from the workspace-routing middleware, *before* the handler: session's `workspaceID` resolves to
  no workspace → **500 `text/plain` body `Workspace not found: <id>`**
  (`middleware/workspace-routing.ts:102-107,173-175`); broken remote sync → 503 `text/plain`.
  A shim that never sets `workspaceID` on sessions can only ever produce the toast path.
- After a successful delete the dialog refetches browse (and search, if active); actual row
  removal still rides on the `session.deleted` SSE.

---

## 4. open-claude implementation notes

Current state: sections (a) AND (b) are IMPLEMENTED (verified by test/live-resume.ts and
test/live-commands.ts): `GET /session` honors roots/search/start/limit/scope/path with
sort-then-limit, `DELETE /session/:id` cascades children-first (each `session.deleted`
carrying `info`), `GET /session/status` returns the busy-only map, `GET /command` serves the
boot-warmed SDK command cache (src/commands.ts), `POST /session/:id/command` executes
commands CLI-side, and `POST /session/:id/summarize` performs a real compaction (§5).

### (a) /sessions dialog parity within one run

Implement on `GET /session` (all params optional, all combinable):

1. `roots=true` (string `"true"`) → drop sessions with `parentID` set. Our subagent child
   sessions must keep `parentID` populated or they pollute the dialog (they are also filtered
   client-side, so this is belt-and-braces — but `limit` truncation happens server-side, so
   children crowding the first 100 rows would push real sessions out).
2. `search=<s>` → case-insensitive **title substring** (`title.toLowerCase().includes(s.toLowerCase())`).
   Anything else gets re-hidden by the dialog's own title filter.
3. `start=<ms>` → `time.updated >= start` (sync store always sends now−30d).
4. Sort by `time.updated` DESC **before** applying `limit` (default 100). Client re-sorts, but the
   cut must be recency-correct.
5. `scope=project`, `path=...`, `directory`, `workspace`: with one project per run and no
   per-session subdirectories, treat all four as no-ops — but tolerate `path=` (empty) and
   `path=sub/dir` (return sessions whose stored `path` equals/prefixes it once /move lands and
   sessions can point at other directories; until then, matching everything is what the reference
   does for `path=""`). After /move is implemented, set `session.path` =
   `relative(worktree, directory)` and honor the equals-or-`path/`-prefix rule, else moved
   sessions vanish from (or wrongly stay in) the filtered list.
6. `DELETE /session/:id`: recursively delete children first (each publishing
   `session.deleted {sessionID, info}`), then the parent; respond bare `true`; 404 name/data shape
   for unknown ids. No special error handling needed for the failed-delete dialog (we never set
   `workspaceID`).
7. Keep `GET /session/status` as-is (busy-only map matches stock); consider adding
   `{type:"retry",...}` passthrough if the engine ever surfaces retries — the dialog and the
   session header already render it.

### (b) Custom command listing + execution over the Claude Agent SDK

SDK surface (`@anthropic-ai/claude-agent-sdk` 0.3.207): `query.supportedCommands(): Promise<SlashCommand[]>`
(sdk.d.ts:2352) with `SlashCommand = { name: string; description: string; argumentHint: string; aliases?: string[] }`
(sdk.d.ts:6457-6474); the same list arrives in `initializationResult.commands`
(`SDKControlInitializeResponse`, sdk.d.ts:3369-3388) and is refreshed by pushed
`SDKCommandsChangedMessage` (`type:"system", subtype:"commands_changed"`, sdk.d.ts:2856-2862 —
REPLACE the cache; `supportedCommands()` is captured at initialize and goes stale).

Proposed field mapping for `GET /command` (opencode `Command` ← SDK `SlashCommand`):

| opencode field | source | notes |
|---|---|---|
| `name` | `name` | both are slash-less; TUI matches the first token by string equality |
| `description` | `description` | shown in autocomplete; fuzzy-matched |
| `template` | **cannot map** — SDK never exposes command bodies | serve `""` (or `"$ARGUMENTS"`); TUI never reads it |
| `hints` | `argumentHint ? [argumentHint] : []` | TUI never reads it; required field, any strings OK |
| `agent` | **cannot map** (no per-command agent in SDK) | omit — reference falls back to `input.agent` anyway |
| `model` | **cannot map** | omit |
| `subtask` | **cannot map** | omit (false-y) |
| `source` | hardcode `"command"` | `"skill"` would HIDE the entry from autocomplete; the SDK list mixes skills and commands with no discriminator, so everything ships visible |
| — | `aliases` **cannot map** | opencode has no alias field and the TUI matches exact names; either emit one duplicate `Command` per alias or drop them |

Timing gotcha: the TUI fetches `GET /command` at bootstrap, usually **before any session/engine
exists**, and never refetches. Options: (1) warm a throwaway `query()` at server start, call
`supportedCommands()`, cache, dispose; (2) return the cache (initially `[]`) and accept that the
first run of a server has no autocomplete until restart — (1) is the parity option. Update the
cache from `commands_changed` messages on live engines (helps future fetches, not the already-
booted TUI).

Execution mapping for `POST /session/:id/command`:

- Reconstruct the slash text and feed it to the engine as a normal user turn:
  `text = "/" + body.command + (body.arguments ? " " + body.arguments : "")`. The Claude Code CLI
  performs its own `$ARGUMENTS`/positional substitution, frontmatter agent/model resolution and
  `!`-prefix shell handling for custom commands — do NOT re-implement §2.2 templating in the shim.
- Honor `body.agent`/`body.model` exactly like a prompt request (`model` here is the
  `"providerID/modelID"` **string** — split on the first `/`); `variant` → effort as usual;
  append `body.parts` file parts to the turn.
- Unknown command name (not in the cached list): mirror the reference — publish `session.error`
  SSE (renders a toast) and answer 400 `{"_tag":"BadRequest"}`; alternatively forward to the CLI
  and let its "Unknown slash command" error surface as the assistant error. Do not 404.
- Respond after the turn with `{info, parts}` of the final assistant message (TUI ignores it);
  emit the standard turn SSE sequence. `command.executed` SSE is optional (no TUI consumer).
- Flag for the /compact work: the TUI's `/compact` is a **local palette entry** that POSTs
  `/session/:id/summarize` when selected from the autocomplete — but if our `GET /command` list
  also contains a `compact` entry (the SDK exposes built-ins like `/compact`), a fully-typed
  `/compact` + Enter (autocomplete closed) will hit `POST /session/:id/command` instead. Both
  paths must therefore work; consider filtering SDK built-ins that shadow opencode palette slashes
  (`compact`, `init`, `exit`, ...) out of `GET /command` to keep a single code path, or exploit it
  deliberately as the /compact implementation.

---

## 5. POST /session/:id/summarize — the reference compaction contract (extracted)

Target for open-claude's real /compact. Authoritative sources (repo-relative to
`vendor/opencode/`):

| What | File |
|---|---|
| Route decl + `SummarizePayload` | `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:65-69,303-316` |
| Handler | `.../handlers/session.ts:273-293` |
| Compaction service (message shapes) | `packages/opencode/src/session/compaction.ts:289-536` |
| Loop dispatch (busy status, auto-overflow) | `packages/opencode/src/session/prompt.ts:1081-1167` |
| `session.compacted` event schema | `packages/schema/src/session-compaction-event.ts` |
| v1 wire schemas (`CompactionPart`, `Assistant.summary`) | `packages/schema/src/v1/session.ts:195-201,470` |
| TUI trigger | `packages/tui/src/routes/session/index.tsx:554-579` |
| TUI rendering | `routes/session/index.tsx:1378,1442-1451`; `component/prompt/index.tsx:262-281` |

### 5.1 Request / response

- `POST /session/{sessionID}/summarize`, JSON body `{providerID, modelID, auto?: boolean}`
  (`SummarizePayload`). The TUI's **/compact palette entry (aliases: `["summarize"]`)**
  fire-and-forgets it with the currently-selected model; the response is ignored — all
  rendering rides SSE. No provider selected → local toast, no request.
- Response: `200` bare `true`, returned only **after the whole compaction turn completes**
  (the handler awaits `promptSvc.loop`). Unknown session → 404
  `{"name":"NotFoundError","data":{...}}`; other pipeline failures → 400 (BadRequest).
- **Empty session is NOT an error**: the reference still creates the message pair below,
  runs a degenerate summarize call, and returns `true`.

### 5.2 Handler pipeline (handlers/session.ts:273-293)

`revert cleanup → agent := findLast(user message).agent ?? defaultAgent →
compaction.create({sessionID, agent, model: payload, auto: payload.auto ?? false}) →
prompt loop → true`.

### 5.3 Wire-observable sequence (v1 SSE)

a. `message.updated` — NEW **user** message `{agent, model: <payload model>, time.created}`
   with **no text part ever**.
b. `message.part.updated` — a **compaction part** on it:
   `{type:"compaction", auto: <payload.auto ?? false>}` (+ optional `overflow`,
   `tail_start_id` backfilled later; schema v1/session.ts:195-201).
c. `session.status {type:"busy"}` (loop entry).
d. `message.updated` — NEW **assistant** message
   `{parentID: <compaction user msg id>, mode:"compaction", agent:"compaction",
   summary:true, cost:0, tokens zeroed}` (compaction.ts:356-381).
e. The summary text streams into it as one normal **text part**
   (message.part.updated/deltas) framed by step-start/step-finish parts; on completion the
   assistant message carries the compaction call's usage in tokens/cost, `finish`,
   `time.completed` (processor.ts:435-456).
f. `session.compacted {sessionID}` on success — **no TUI consumer at v1.17.19**.
g. `session.status idle` + `session.idle` at loop exit.

`GET /session/:id/message` afterwards returns EVERYTHING: the full pre-compact history plus
the compaction pair — `filterCompacted` is server-internal model-input pruning, never
applied to the read route.

### 5.4 Auto-compaction

The loop creates the same pair with `auto:true` when the last finished assistant message
overflows the model window (prompt.ts:1159-1166) — mid-conversation, unprompted — then (in
the non-overflow path) appends a synthetic `"Continue if you have next steps..."` user
message (`synthetic:true` text part, `metadata.compaction_continue`; compaction.ts:451-503).

### 5.5 What the TUI renders

- The compaction **user** message → a centered `── Compaction ──` horizontal rule
  (`UserMessage` shows no bubble when there is no non-synthetic text part; the compaction
  part adds the rule — routes/session/index.tsx:1378,1442-1451).
- The summary **assistant** message renders as a NORMAL assistant message — the TUI never
  reads `Assistant.summary` or mode `"compaction"`.
- Context % in the prompt footer = token sum of the **last assistant message with
  `tokens.output > 0`** (prompt/index.tsx:262-281) — after a compact that is the summary
  message, so its tokens define the displayed context size.
- `session.time.compacting` ("compacting" spinner state in sync.tsx:581) has no live writer
  at this tag — dead field, safe to ignore.

### 5.6 open-claude mapping (CLI 2.1.207 /compact sequence → this shape)

The CLI emits, with ZERO stream_events (probe test/probe-slash-commands.ts finding 4):
`system/status {status:"compacting"}` → `system/status {status:null, compact_result}` →
re-emitted `system/init` → `system/compact_boundary {compact_metadata:{trigger, pre_tokens,
post_tokens, ...}}` → `user {isSynthetic:true, content: STRING "This session is being
continued..."}` → `user {isReplay:true, content "<local-command-stdout>Compacted
</local-command-stdout>"}` → `result {subtype:"success", num_turns:0}`.

Mapping (src/engine.ts `compact()` / `compactCtx`):

- `compact()` entry (serialized through the same turnQueue as prompts): creates the
  compaction user message + `{type:"compaction", auto:false}` part up front (§5.3 a-b),
  sets busy, pushes `"/compact[ <instructions>]"`.
- status frames: no reference equivalent (busy already set) — ignored; a
  `compact_result:"failed"` surfaces `session.error` with `compact_error`.
- re-emitted `system/init`: harmless (silent claudeSessionId capture no-ops/updates).
- `compact_boundary`: opens the summary assistant message (mode/agent `"compaction"`,
  `summary:true`, parentID = compaction user msg; §5.3 d). For `trigger:"auto"`
  (unprompted mid-turn) the PAIR is created here with `auto:true`; the in-flight outer
  turn's state is untouched.
- `user isSynthetic` (string content): becomes the summary message's text part; the message
  completes with `finish:"stop"` and `tokens {input:0, output: post_tokens}` — the closest
  observable analogue of the reference's compaction-call usage, and it makes the TUI
  context % show the post-compact size (§5.5). Session tokens touched to match;
  `session.compacted` emitted.
- `user isReplay "<local-command-stdout>"`: dropped — the engine never renders main-session
  user frames, so neither this nor the synthetic blob can appear as a user message.
- `result` (num_turns 0): finalizes the turn (busy → idle) — this is what unblocks the
  blocking POST.
- `POST /session/:id/summarize`: honors the body model, agent = last user message's agent
  (§5.2), blocking, returns `true`. Sessions with nothing to compact (no live engine AND no
  stored claudeSessionId) return `true` with no side effects — the reference would run a
  degenerate summarize call; the shim skips the pointless LLM round-trip.

### 5.7 The typed /compact path

`GET /command` deliberately does NOT shadow-filter the SDK's `compact` entry
(src/commands.ts `SHADOWED_TUI_SLASHES`), so a fully-typed `/compact [instructions]` +
Enter reaches `POST /session/:id/command`, which routes `command === "compact"` to the same
engine entry point (instructions appended after the slash) — the same real compaction as
the palette's `POST /summarize`. Every other TUI palette slash name/alias IS filtered out
of the list so the palette stays the single dispatch path for them.
