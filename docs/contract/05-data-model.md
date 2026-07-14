# 05 — Data Model: Sessions, Messages, Parts, Identifiers

Contract reference for the open-claude shim. Extracted from opencode **v1.17.19** source at
`vendor/opencode/` and the published SDK at `node_modules/@opencode-ai/sdk` (1.17.19).
All paths below are repo-relative. Line numbers refer to the vendored tag.

The stock TUI (`packages/tui`) is TypeScript and talks to the server **exclusively through
`@opencode-ai/sdk/v2`** (`vendor/opencode/packages/tui/src/context/sync.tsx:22`,
`vendor/opencode/packages/tui/src/context/sdk.tsx`). The v2 client hits the *same* HTTP paths
as v1 for sessions/messages (`/session/{sessionID}/message`, see
`vendor/opencode/packages/sdk/js/src/v2/gen/sdk.gen.ts:3399-4395`) — "v2" is a regenerated
client + extra endpoints/events, not a different message data model (see §8).

---

## 1. Identifier scheme

### 1.1 Prefixes

`vendor/opencode/packages/opencode/src/id/id.ts:3-14` (the module actually used by the server
for messages/parts/events/tools; sessions use the identical algorithm in
`vendor/opencode/packages/schema/src/identifier.ts`):

```ts
const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

const LENGTH = 26
```

### 1.2 Format

`id.ts:51-70` (identical logic in `schema/src/identifier.ts:14-30`):

```ts
export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++
  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
  now = direction === "descending" ? ~now : now
  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }
  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}
```

So an ID is: `<prefix>_<12 lowercase hex chars><14 base62 chars>` — 26 chars after the `_`.

- Time component: low **48 bits** of `timestamp_ms * 4096 + counter` (counter starts at 1 per
  millisecond, max 4095/ms). For **descending**, the value is bitwise-NOT'ed (two's-complement
  low 48 bits), so newer IDs sort lexicographically **smaller**.
- Random suffix: 14 chars from `0-9A-Za-z` (`randomBase62`, `id.ts:41-49`).
- `Identifier.timestamp(id)` (`id.ts:73-78`) recovers `ms = value / 0x1000` — ascending only.

### 1.3 Direction per entity — **this matters, the TUI sorts by ID**

| Entity | Prefix | Direction | Source |
|---|---|---|---|
| Session | `ses` | **descending** (newest = lexicographically smallest) | `vendor/opencode/packages/schema/src/session-id.ts:5-14` (`"ses_" + descending()`); used via `SessionID.descending()` in `vendor/opencode/packages/opencode/src/session/session.ts:515` |
| Message | `msg` | **ascending** | `vendor/opencode/packages/opencode/src/session/schema.ts:10-15` (`Identifier.ascending("message")`); `MessageID.ascending()` at creation, `prompt.ts:657,1187` |
| Part | `prt` | **ascending** | `vendor/opencode/packages/opencode/src/session/schema.ts:19-25` |
| Event | `evt` | ascending | `vendor/opencode/packages/opencode/src/sync/schema.ts:9` |
| Permission | `per` | ascending (created per request) | `id.ts:8` |
| Question | `que` | ascending | `id.ts:9` |
| Tool (registry) | `tool` | ascending | `vendor/opencode/packages/opencode/src/tool/schema.ts:12` |
| Workspace | `wrk` | ascending | `id.ts:13` |

Verified against real opencode v1.17 data on disk: `ses_321603910ffeuWVg3W7VJEyx5M`,
`msg_c6db8a91b001VpIfRHRJD7NgcS` (descending session hex ends in `...ffe` = `~(ts*4096+1)`,
ascending message hex ends in `...001` = counter 1).

Worked examples (algorithm run verbatim, `t0 = 1783944000000` = 2026-07-13T12:00:00Z):

```
ascending  msg @ t0, counter 1  -> msg_f5b593200001<14 rand>
ascending  msg @ t0, counter 2  -> msg_f5b593200002<14 rand>
descending ses @ t0             -> ses_0a4a6cdffffe<14 rand>
descending ses @ t0 + 1s        -> ses_0a4a6ca17ffe<14 rand>   (sorts BEFORE the older one)
```

### 1.4 Trap: 48-bit truncation / wrap

`ts_ms * 4096` overflows 48 bits for any modern timestamp; only the low 48 bits are kept.
Effective wrap period is 2^36 ms ≈ 795 days. The current window began 2024-06-10 and wraps
around **2026-08-14T07:19:55Z** — after that, freshly generated ascending IDs sort *before*
pre-wrap IDs (and descending IDs invert likewise). This is inherent to stock opencode, so the
shim must use the **same** encoding (not e.g. full-precision hex) or its IDs will not interleave
consistently with client expectations and with any IDs the TUI has already seen. Within one
shim-managed server, all IDs are minted by the shim, so the wrap only matters if you persist
sessions across the boundary date.

### 1.5 Where sorting-by-ID is load-bearing in the TUI (traced)

- Session list store kept sorted by `a.id.localeCompare(b.id)`:
  `vendor/opencode/packages/tui/src/context/sync.tsx:167` — because sessions are
  *descending*-encoded, ascending lexicographic order = newest first.
- Messages and parts are binary-search inserted **by ID string** on every
  `message.updated` / `message.part.updated` event: `sync.tsx:41-52` (`search`), `sync.tsx:322,331`
  (messages), `sync.tsx:377,386` (parts). Parts of one message render strictly in part-ID order.
  **The shim must mint part IDs in the intended display order.**
- Queued-prompt detection compares message IDs as strings:
  `vendor/opencode/packages/tui/src/routes/session/index.tsx:1373`
  (`props.message.id > props.pending`) and the pending memo at `index.tsx:238-242`
  (`x.id > completed`). Cross-role comparisons work because all `msg_` IDs share one clock.
- Child-session ordering: `index.tsx:207-212` sorts children by raw `<`/`>` on `id`.

---

## 2. Session object

### 2.1 Wire type (what the TUI receives)

`vendor/opencode/packages/sdk/js/src/v2/gen/types.gen.ts:170-221` (generated from the server's
Effect schema `vendor/opencode/packages/schema/src/v1/session.ts:543-568`, identifier `Session`):

```ts
export type Session = {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: Array<SnapshotFileDiff>
  }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  share?: { url: string }
  title: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  metadata?: { [key: string]: unknown }
  time: {
    created: number      // epoch ms
    updated: number      // epoch ms
    compacting?: number  // epoch ms; presence => TUI shows "compacting" status
    archived?: number
  }
  permission?: PermissionRuleset
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}
```

Note `model.id` (NOT `model.modelID`) on sessions — but `model.modelID` on messages. Easy to mix up.

### 2.2 Server creation defaults (traced)

`vendor/opencode/packages/opencode/src/session/session.ts:501-540` (`createNext`):

- `id: SessionID.descending(input.id)` — client may supply its own ID.
- `slug: Slug.create()`, `version: InstallationVersion`, `cost: 0`, `tokens: EmptyTokens`
  (all-zero), `title` defaults to a prefix + ISO timestamp when absent,
  `time: { created: Date.now(), updated: Date.now() }`.
- Emits `session.created` with `{ sessionID, info }` (`session.ts:537`).

### 2.3 Traced TUI reads of Session

- `time.compacting` → status "compacting" (`sync.tsx:581`).
- `parentID` → sidebar/prompt hiding for subagent sessions (`routes/session/index.tsx:228-235,265`),
  child grouping (`index.tsx:207-212`).
- `directory`, `path`, `workspaceID` updated from `session.next.moved` events (`sync.tsx:294-308`).
- `title` in the header (`index.tsx:202-205`), `time.updated` for the session list filter
  (`sync.tsx:166` — `session.list({ start: Date.now() - 30d })`).

---

## 3. Message info: User / Assistant

Wire shapes: `vendor/opencode/packages/sdk/js/src/v2/gen/types.gen.ts:239-376`. Source schema:
`vendor/opencode/packages/schema/src/v1/session.ts:332-355` (User), `:453-488` (Assistant),
`:490-491` (`Info = Union([User, Assistant])`, discriminator `role`).

### 3.1 UserMessage (types.gen.ts:239-262)

```ts
export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }               // epoch ms
  format?: OutputFormat                   // {type:"text"} | {type:"json_schema", schema, retryCount?}
  summary?: { title?: string; body?: string; diffs: Array<SnapshotFileDiff> }
  agent: string                           // REQUIRED
  model: {                                // REQUIRED
    providerID: string
    modelID: string
    variant?: string
  }
  system?: string
  tools?: { [key: string]: boolean }
}
```

Server fills `agent`/`model` from the resolved agent + model when creating the user message
(`vendor/opencode/packages/opencode/src/session/prompt.ts:656-670`).

### 3.2 AssistantMessage (types.gen.ts:333-374)

```ts
export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }   // epoch ms; completed set at end
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
        | StructuredOutputError | ContextOverflowError | ContentFilterError | ApiError
  parentID: string        // REQUIRED: id of the triggering user message
  modelID: string
  providerID: string
  mode: string            // legacy alias of agent; server sets both to agent name
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean       // true only for summarization/compaction assistant messages
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  structured?: unknown
  variant?: string
  finish?: string         // step-finish reason, e.g. "stop", "tool-calls", "error"
}
```

Error variants all have shape `{ name: "<Name>", data: {...} }` (types.gen.ts:264-331); every
`data` has at least `message: string` except `MessageOutputLengthError` (empty record).

Server creation (traced, `prompt.ts:1186-1200`):

```ts
const msg: SessionV1.Assistant = {
  id: MessageID.ascending(),
  parentID: lastUser.id,
  role: "assistant",
  mode: agent.name,
  agent: agent.name,
  variant: lastUser.model.variant,
  path: { cwd: ctx.directory, root: ctx.worktree },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: model.id,
  providerID: model.providerID,
  time: { created: Date.now() },
  sessionID,
}
```

`cost`/`tokens`/`finish` are mutated on each `step-finish` LLM event and re-published via
`message.updated` (`vendor/opencode/packages/opencode/src/session/processor.ts:435-456`);
`time.completed` is set in cleanup (`processor.ts:595-596`). On abort, `error` is set to
`MessageAbortedError` and `time.completed` stamped (`prompt.ts:1203-1211`).

### 3.3 Traced TUI reads of message fields

- `role` discriminates rendering (`routes/session/index.tsx` `UserMessage`/`AssistantMessage`
  components, `:1350`, `:1455`).
- Assistant footer (`index.tsx:1461-1559`): `agent` (color), `mode` (titlecased label),
  `providerID`+`modelID` (model display name), `finish` (footer shown early when set and not
  `"tool-calls"`/`"unknown"`, `:1463-1465`), `time.completed` minus the **parent user message's**
  `time.created` for the duration (`:1467-1473` — requires `parentID` to point at the user
  message that is in the store), `error` (rendered unless `name === "MessageAbortedError"`,
  which instead renders "interrupted", `:1519-1556`).
- Context-usage gauge: last assistant message with `tokens.output > 0`;
  `input + output + reasoning + cache.read + cache.write` vs the model's context limit
  (`component/prompt/index.tsx:267-278`, `routes/session/subagent-footer.tsx:35-52`,
  `feature-plugins/sidebar/context.tsx:20-33`). **`cost` is never rendered by the TUI**
  (only summed into session objects server-side); safe to leave 0.
- Working/idle state: last message `role === "user"` → working; assistant without
  `time.completed` → working (`sync.tsx:578-587`).
- Transcript export reads `agent`, `modelID`, `providerID`, `time.created/completed`
  (`util/transcript.ts:67-82`).
- User message: `time.created` timestamp display (`index.tsx:1429`), `agent` for border color
  (`:1374`).

---

## 4. The 12-part union

Wire shapes `types.gen.ts:378-639`; source schema `schema/src/v1/session.ts:81-325,357-370`.
Union discriminator is `type`:

```ts
export type Part =
  | TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart
  | StepStartPart | StepFinishPart | SnapshotPart | PatchPart
  | AgentPart | RetryPart | CompactionPart
```

Every part has the base fields (`schema/src/v1/session.ts:81-85`):

```ts
{ id: string /* prt_ */, sessionID: string, messageID: string }
```

### 4.1 TextPart (types.gen.ts:378-393)

```ts
{
  ...base, type: "text", text: string,
  synthetic?: boolean,          // hidden from user-visible text if true
  ignored?: boolean,
  time?: { start: number; end?: number },
  metadata?: Record<string, unknown>,
}
```

### 4.2 ReasoningPart (types.gen.ts:410-423)

```ts
{
  ...base, type: "reasoning", text: string,
  metadata?: Record<string, unknown>,
  time: { start: number; end?: number },   // time REQUIRED; end set => "done"
}
```

TUI treats `time.end !== undefined` as "thinking finished" (`routes/session/index.tsx:1585`)
and computes the "Thought for Xs" duration from `end - start` (`:1587-1590`). It also strips
the literal string `"[REDACTED]"` from reasoning text (`:1581`).

### 4.3 ToolPart + ToolState (types.gen.ts:477-545)

```ts
export type ToolPart = {
  ...base, type: "tool",
  callID: string,          // provider tool-call id; used to match permission requests
  tool: string,            // tool name — see §7 vocabulary
  state: ToolState,
  metadata?: Record<string, unknown>,   // part-level (e.g. { providerExecuted: true })
}

export type ToolStatePending  = { status: "pending";  input: Record<string, unknown>; raw: string }
export type ToolStateRunning  = { status: "running";  input: Record<string, unknown>;
                                  title?: string; metadata?: Record<string, unknown>;
                                  time: { start: number } }
export type ToolStateCompleted = { status: "completed"; input: Record<string, unknown>;
                                  output: string; title: string;                       // REQUIRED
                                  metadata: Record<string, unknown>;                   // REQUIRED
                                  time: { start: number; end: number; compacted?: number };
                                  attachments?: Array<FilePart> }
export type ToolStateError    = { status: "error"; input: Record<string, unknown>;
                                  error: string;                                       // plain string!
                                  metadata?: Record<string, unknown>;
                                  time: { start: number; end: number } }
```

Note `ToolStateError.error` is a **string**, not an error object. The TUI substring-matches it
to detect permission denials: `"QuestionRejectedError"`, `"rejected permission"`,
`"specified a rule"`, `"user dismissed"` render as strikethrough-denied rather than red-failed
(`routes/session/index.tsx:1857-1863`).

`ToolStatePending.raw` is the partial streamed JSON of the input (server initializes
`{ status: "pending", input: {}, raw: "" }`, `processor.ts:243`).

### 4.4 StepStartPart / StepFinishPart (types.gen.ts:547-573)

```ts
{ ...base, type: "step-start", snapshot?: string }
{ ...base, type: "step-finish", reason: string, snapshot?: string, cost: number,
  tokens: { total?: number; input: number; output: number; reasoning: number;
            cache: { read: number; write: number } } }
```

The TUI **ignores both** (see §6.2) — but the server emits them and re-reads `step-finish`
history server-side; emit them for fidelity.

### 4.5 FilePart (types.gen.ts:466-475)

```ts
{ ...base, type: "file", mime: string, filename?: string, url: string,
  source?: FilePartSource }
// FilePartSource (types.gen.ts:425-464) = FileSource | SymbolSource | ResourceSource,
// discriminated on "type" ("file" | "symbol" | "resource"); each carries
// text: { value: string; start: number; end: number } plus path/range/name/kind or clientName/uri.
```

TUI renders user-message file parts as chips using `mime` (`application/x-directory` special
case) and `filename` (`routes/session/index.tsx:1406-1421`).

### 4.6 SubtaskPart (types.gen.ts:395-408)

```ts
{ ...base, type: "subtask", prompt: string, description: string, agent: string,
  model?: { providerID: string; modelID: string }, command?: string }
```

### 4.7 SnapshotPart / PatchPart (types.gen.ts:575-590)

```ts
{ ...base, type: "snapshot", snapshot: string }
{ ...base, type: "patch", hash: string, files: Array<string> }
```

### 4.8 AgentPart (types.gen.ts:592-603)

```ts
{ ...base, type: "agent", name: string,
  source?: { value: string; start: number; end: number } }
```

### 4.9 RetryPart (types.gen.ts:605-615)

```ts
{ ...base, type: "retry", attempt: number, error: ApiError, time: { created: number } }
```

### 4.10 CompactionPart (types.gen.ts:617-625)

```ts
{ ...base, type: "compaction", auto: boolean, overflow?: boolean, tail_start_id?: string }
```

TUI: a compaction part on a **user** message renders the "── Compaction ──" divider
(`routes/session/index.tsx:1378,1442-1450`).

### 4.11 Input part shapes (what clients POST in prompts)

`schema/src/v1/session.ts:397-451`: `TextPartInput`, `FilePartInput`, `AgentPartInput`,
`SubtaskPartInput` — same as their Part counterparts minus `sessionID`/`messageID`, with
optional `id`. Traced TUI prompt submit sends only `{type:"text",text}` (+ optional synthetic
editor-context text part with `metadata`) and file parts
(`component/prompt/index.tsx:1041-1108`). Server assigns missing part IDs via
`PartID.ascending()` (`prompt.ts:693-697`).

---

## 5. Server streaming lifecycle (what the shim must emit, in order)

Ground truth: `vendor/opencode/packages/opencode/src/session/processor.ts` (LLM event handler)
plus `session.ts:631-645` (event publication):

- `updateMessage(msg)` → publishes event `message.updated` `{ sessionID, info }`
  (`session.ts:631-635`; schema `schema/src/v1/session.ts:596-603`).
- `updatePart(part)` → publishes `message.part.updated` `{ sessionID, part, time: Date.now() }`
  (`session.ts:637-645`; schema `:612-620`; the extra `time` field is the publish timestamp).
- `updatePartDelta` → publishes `message.part.delta`
  `{ sessionID, messageID, partID, field, delta }` (`session.ts:879-887`; schema `:632-641`).
  The server only ever uses `field: "text"` (`processor.ts:303,507`). The TUI generically
  appends `delta` to `part[field]` as a string (`sync.tsx:392-409`) — the part must already
  exist in the store or the delta is dropped (`sync.tsx:394-396`).
- `message.removed` `{ sessionID, messageID }` and `message.part.removed`
  `{ sessionID, messageID, partID }` (schema `:604-611,621-629`).
- `session.error` `{ sessionID?, error }` where error is the assistant-error union
  (schema `:651-657`; published in `processor.ts:611-623`).

Full happy-path sequence for one prompt (all events also persist state the message-list
endpoint must reproduce):

1. `message.updated` — user message info (`prompt.ts:656-670` + `updateMessage`).
2. `message.part.updated` — each user part (text/file/agent), IDs ascending.
3. `message.updated` — assistant message (all-zero tokens, no `completed`).
4. `message.part.updated` — `step-start` part (`processor.ts:424-433`; `snapshot` optional).
5. Reasoning (optional): `reasoning-start` → part.updated with `{type:"reasoning", text:"",
   time:{start}}` (`processor.ts:280-292`); each delta → `message.part.delta` (field `"text"`)
   while mutating server state; `reasoning-end` → part.updated with full text + `time.end`
   (`processor.ts:207-214`).
6. Text: `text-start` → part.updated `{type:"text", text:"", time:{start}}`
   (`processor.ts:486-497`); deltas → `message.part.delta`; `text-end` → final part.updated with
   complete `text` and `time:{start,end}` (`processor.ts:512-532`).
7. Tool call:
   a. `tool-input-start` → part.updated with `state: { status:"pending", input:{}, raw:"" }`
      (`processor.ts:236-245`).
   b. `tool-call` → part.updated with `state: { status:"running", input, time:{start} }`
      (`processor.ts:331-351`). `title`/`metadata` may be streamed into the running state by the
      tool via `ctx.metadata` (e.g. task tool, `tool/task.ts:178-181`).
   c. success → part.updated with `state: { status:"completed", input, output, title, metadata,
      time:{start,end}, attachments? }` (`processor.ts:160-184`).
      failure → `state: { status:"error", input, error: string, metadata?, time:{start,end} }`
      (`processor.ts:186-205`). Aborted mid-run → error state with
      `metadata.interrupted = true`, error `"Tool execution aborted"` (`processor.ts:577-593`).
8. `step-finish` → part.updated `{type:"step-finish", reason, snapshot?, cost, tokens}`; then
   `message.updated` with accumulated `finish`, `cost`, `tokens` (`processor.ts:435-456`).
   If files changed, also a `patch` part (`processor.ts:457-470`).
9. Loop 4–8 for further steps (each LLM round-trip is one step).
10. Cleanup: `time.completed = Date.now()`; final `message.updated` (`processor.ts:595-596`).

**The TUI never requires the delta events** — every delta is bracketed by full
`message.part.updated` snapshots, and the resync guard even protects streamed text from being
clobbered by empty text on refetch (`sync.tsx:630-639`). A minimal shim can skip
`message.part.delta` and send periodic full part updates; deltas are an optimization.

---

## 6. REST shapes and traced consumption

### 6.1 GET `/session/{sessionID}/message` → `Array<{ info, parts }>`

`types.gen.ts:9750-9787`:

```ts
query: { directory?, workspace?, limit?: number, before?: string /* opaque cursor */ }
200: Array<{ info: Message; parts: Array<Part> }>
```

Server ordering (traced, `vendor/opencode/packages/opencode/src/session/message-v2.ts:425-467`):
pages newest-first internally, then **reverses** — the returned array is oldest→newest
(ascending message ID). Parts are returned ordered by part ID ascending
(`message-v2.ts:492-504`). `GET /session/{sessionID}/message/{messageID}` returns a single
`{ info, parts }` (`message-v2.ts:506-519`).

The TUI calls `session.messages({ sessionID, limit: 100 })` on session open
(`sync.tsx:597`) alongside `session.get`, `session.todo`, `session.diff` — and keeps at most
100 messages in the store, dropping the oldest with its parts (`sync.tsx:334-352`).

### 6.2 Which part types the TUI actually renders

Assistant messages (`routes/session/index.tsx:1564-1568`):

```ts
const PART_MAPPING = { text: TextPart, tool: ToolPart, reasoning: ReasoningPart }
```

Everything else (`step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry`,
`subtask`, `file` on assistant) is **silently skipped** (`:1482-1492`, `Show when={component()}`).

User messages read: `text` parts (non-synthetic joined, `:1359-1368`), `file` parts (chips,
`:1370,1406-1421`), `compaction` part (divider, `:1378`). Synthetic/ignored text is also
excluded from copy and from message navigation (`:843`, `:387`).

Special behaviors keyed on tool parts:

- `tool === "task"`: reads `state.metadata.sessionId` (**lowercase d**) to link/sync the child
  session, `metadata.background`, and input `description` / `subagent_type`
  (`:2213-2308`, `:1495-1517`).
- `tool === "plan_exit"` / `"plan_enter"` completed → TUI switches local agent to
  `build`/`plan` (`:320-334`).
- Permission requests are matched to a tool part via `callID` (`:1849-1853`).

### 6.3 Tool renderer field contract (traced input/metadata reads)

TUI switch: `routes/session/index.tsx:1731-1781`; recognized display names
(`:2630-2645`): `bash, glob, read, grep, webfetch, websearch, write, edit, task,
apply_patch, todowrite, question, skill, execute` — anything else renders via `GenericTool`
(icon `⚙`, `tool` name + primitive input k=v summary; output only shown if the user enabled
"generic tool output", `:1791-1827`).

| tool | input fields read | state.metadata fields read | server metadata source |
|---|---|---|---|
| `bash` | `command`, `workdir` | `output` (preview string; presence flips to block view), | `tool/shell.ts:585-594`: `{ output, exit, truncated, outputPath? }` |
| `glob` | `pattern`, `path` | `count` | `tool/glob.ts:66-71`: `{ count, truncated }` |
| `grep` | `pattern`, `path` | `matches` | `tool/grep.ts:103-107`: `{ matches, truncated }` |
| `read` | `filePath` (+ other primitives echoed) | `loaded` (string[]; suppressed when `time.compacted`) | `tool/read.ts:362-372`: `{ preview, truncated, loaded, display:{...} }` |
| `write` | `filePath`, `content` | `diagnostics` (presence flips to block view) | `tool/write.ts:92-99`: `{ diagnostics, filepath, exists }` |
| `edit` | `filePath`, `replaceAll` | `diff` (unified diff string; presence flips to diff view), `diagnostics` | `tool/edit.ts:203-208`: `{ diagnostics, diff, filediff }` |
| `task` | `description`, `subagent_type` | `sessionId`, `background` | `tool/task.ts:171-181`: `{ parentSessionId, sessionId, model, background? }` (+`jobId` when background) |
| `webfetch` | `url` | — | `tool/webfetch.ts` (mostly `{}`) |
| `websearch` | `query` | `provider`, `numResults` | `tool/websearch.ts` |
| `todowrite` | `todos` (from **input**) | `todos` (presence gates block view) | `tool/todo.ts:38-41`: `{ todos: params.todos }` |
| `question` | `questions` (`[{question}]`) | `answers` (`string[][]`) | `tool/question.ts` |
| `skill` | `name` | — | `tool/skill.ts` |
| `apply_patch` | — | `files` (`[{type,relativePath,filePath,patch,deletions,movePath?}]`), `diagnostics` | `tool/apply_patch.ts` |
| `execute` | — | `toolCalls` (`[{tool,status,input?}]`), `error` (bool) | `tool/code-mode.ts` |

Todo items: `{ status, content }`, status literal checks `"completed"` / `"in_progress"`
(`component/todo-item.tsx:16-19`); wire `Todo` type also has `priority`
(`types.gen.ts`, `export type Todo`). Diagnostics shape read by the TUI:
`metadata.diagnostics[filePath] = [{ severity: 1, range: { start: { line, character } }, message }]`
(`routes/session/index.tsx:2696-2710`, only severity 1 shown, max 3).

ToolStateRunning/Completed `title` is shown in spinner lines for subagent progress
(`:2235-2237,2276-2279`) and by BlockTool headers.

### 6.4 opencode tool-name vocabulary (server registry)

Built-in `Tool.define` IDs (all in `vendor/opencode/packages/opencode/src/tool/`):
`bash` (`shell/id.ts:16`), `edit` (`edit.ts:59`), `glob` (`glob.ts:18`), `grep` (`grep.ts:21`),
`read` (`read.ts:69`), `write` (`write.ts:28`), `task` (`task.ts:24`), `todowrite`
(`todo.ts:15`), `webfetch` (`webfetch.ts:25`), `websearch` (`websearch.ts:100`),
`apply_patch` (`apply_patch.ts:23`), `question` (`question.ts:15`), `skill` (`skill.ts:13`),
`lsp` (`lsp.ts:38`), `plan_exit` (`plan.ts:16`, also `plan_enter` — see TUI `:327-333`),
`invalid` (`invalid.ts:10`), `execute` (`code-mode.ts:12`).

Permission-request `permission` strings the TUI styles specially mirror these names:
`edit, read, glob, grep, list, bash, task, webfetch, websearch, question, external_directory,
doom_loop, plan_enter/exit...` (`routes/session/permission.tsx:196-330`).

### 6.5 Claude Agent SDK → opencode mapping

Agent SDK 0.3.207 tool input schemas
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:11-52`) and tool-name literals in
option docs (`sdk.d.ts:1322,1384`: `['Read','Grep','Glob','Bash']`, `['Bash','Read','Edit']`):

| Claude Code tool (SDK) | SDK input fields (sdk-tools.d.ts) | map to opencode `tool` | input translation |
|---|---|---|---|
| `Bash` (`BashInput:482`) | `command`, `description?`, `run_in_background?`, `timeout?` | `bash` | pass `command`; put output into `metadata.output` preview + `output` |
| `Edit` (`FileEditInput:544`) | `file_path`, `old_string`, `new_string`, `replace_all?` | `edit` | `filePath ← file_path`, `replaceAll ← replace_all`; synthesize `metadata.diff` (unified diff) for rich rendering |
| `Read` (`FileReadInput:562`) | `file_path`, `offset?`, `limit?` | `read` | `filePath ← file_path` |
| `Write` (`FileWriteInput:580`) | `file_path`, `content` | `write` | `filePath ← file_path`, `content` |
| `Glob` (`GlobInput:590`) | `pattern`, `path?` | `glob` | as-is; `metadata.count` from result lines |
| `Grep` (`GrepInput:600`) | `pattern`, `path?`, `glob?`, `output_mode?`, ... | `grep` | `pattern`/`path`; `metadata.matches` |
| `TodoWrite` (`TodoWriteInput`) | `todos: [{content,status,activeForm}]` | `todowrite` | opencode todos are `{content,status,priority}`; TUI only reads `content`+`status` — pass through, echo into `metadata.todos` |
| `Task`/Agent (`AgentInput:444`) | `description`, `prompt`, `subagent_type?` | `task` | set `metadata.sessionId` to a child session you create/mirror, else TUI shows plain progress |
| `WebFetch` (`WebFetchInput`) | `url`, `prompt` | `webfetch` | `url` |
| `WebSearch` (`WebSearchInput`) | `query`, ... | `websearch` | `query` |
| `ExitPlanMode`/`EnterPlanMode` | — | `plan_exit` / `plan_enter` | completion flips TUI agent build/plan |
| `AskUserQuestion` | `questions[]` | `question` | `input.questions[{question}]`, `metadata.answers: string[][]` |
| `NotebookEdit`, `mcp__*`, others | — | keep original name | rendered by `GenericTool`; lowercase names read nicer |

Unmapped names are safe: `GenericTool` renders any `tool` string.

> CORRECTED (partial resolution of the tool-name open question): additional static
> evidence from the SDK package — `sdk-tools.d.ts:536` contains the literal
> `tool: "Bash"` inside `BashOutput`, and `sdk-tools.d.ts:11-52` (`ToolInputSchemas`)
> enumerates the full input-interface set: Agent(→Task), Bash, TaskOutput, ExitPlanMode,
> FileEdit(→Edit), FileRead(→Read), FileWrite(→Write), Glob, Grep, TaskStop,
> ListMcpResources, Mcp (`mcp__server__tool`), NotebookEdit, ReadMcpResourceDir,
> ReadMcpResource, TodoWrite, WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, plus
> Anthropic-internal tools. Doc comments in `sdk.d.ts:1322,1384` confirm runtime names
> `'Read','Grep','Glob','Bash','Edit'`. The interface names are NOT always the runtime
> `tool_use.name` (e.g. `FileEditInput` ↔ `Edit`, `AgentInput` ↔ `Task`) — a one-time
> live-stream log of `tool_use.name` values is still the definitive check before
> finalizing the mapping table, but the names above are correct with high confidence.

---

## 7. Time fields — summary

All timestamps on the wire are **epoch milliseconds** (plain JS numbers; schema type
`NonNegativeInt` in `schema/src/v1/session.ts:15` et al.).

| Object | field | set when |
|---|---|---|
| Session | `time.created` / `time.updated` / `time.compacting?` / `time.archived?` | create / any touch / during compaction / archive |
| UserMessage | `time.created` | create |
| AssistantMessage | `time.created` / `time.completed?` | create / stream end (also on abort) |
| Text/Reasoning part | `time.start` / `time.end?` | first token / last token |
| ToolState running | `time.start` | tool-call event |
| ToolState completed/error | `time.start`,`time.end` (+`compacted?`) | start / settle |
| RetryPart | `time.created` | retry |
| `message.part.updated` event | `properties.time` | publish instant (`session.ts:642`) |

(The newer internal model in `schema/src/session-message.ts` uses `DateTimeUtcFromMillis` —
still millis on the wire; that model is NOT served on the endpoints the TUI uses, see §8.)

---

## 8. v1 vs v2 — do the shapes differ?

Three "generations" exist in the tree; only one matters:

1. **Legacy v1 SDK** (`packages/sdk/js/src/gen/types.gen.ts`) — stale. Its `AssistantMessage`
   (`gen/types.gen.ts:112-140`) lacks `agent`, `variant`, `structured`, `tokens.total` and the
   newer error variants; `UserMessage` lacks `format`/`model.variant`. **Not used by the TUI.**
2. **Current v1 schema = v2 API shapes** (`packages/schema/src/v1/session.ts` →
   `packages/sdk/js/src/v2/gen/types.gen.ts`). The v2 SDK's `Session`, `Message`, and all 12
   `Part` shapes are generated from the *v1 schema module* — byte-for-byte the structures in
   §§2-4. Session/message endpoints are unprefixed (`/session/...`, `sdk.gen.ts:3399-4395`).
   **This is the contract to implement.** So: the TUI "reads via v2" and the shapes it reads
   ARE the v1 shapes; there is no read/write delta to bridge for messages/parts.
3. **Next-gen internal model** (`packages/schema/src/session-message.ts`,
   `packages/schema/src/session.ts` "SessionV2.Info") — tagged message union
   (`user | assistant | shell | system | synthetic | compaction | agent-switched |
   model-switched`) with `content[]` inside assistant messages, and the
   `session.next.*` / `EventSessionNext*` event family (`v2/gen/types.gen.ts:19-50`). The TUI
   only consumes `session.next.moved` from this family (`sync.tsx:294-308`). Ignore the rest
   for the shim.

Event payload schemas the shim emits (properties objects, from `schema/src/v1/session.ts:571-676`
/ `v2/gen/types.gen.ts` `EventMessagePartDelta` etc.):

```ts
"session.created" | "session.updated" | "session.deleted": { sessionID, info: Session }
"message.updated":       { sessionID, info: Message }
"message.removed":       { sessionID, messageID }
"message.part.updated":  { sessionID, part: Part, time: number }
"message.part.removed":  { sessionID, messageID, partID }
"message.part.delta":    { sessionID, messageID, partID, field: string, delta: string }
"session.diff":          { sessionID, diff: SnapshotFileDiff[] }
"session.error":         { sessionID?, error: AssistantMessage["error"] }
"session.status":        { sessionID, status: {type:"idle"} | {type:"busy"} | {type:"retry",...} }
```

(SSE envelope/framing — `GlobalEvent = { directory, project?, workspace?, payload: { id: "evt_...",
type, properties } }`, `v2/gen/types.gen.ts` `GlobalEvent` — is covered by the events contract
doc; the TUI unwraps `event.payload` and skips `type === "sync"`, `context/event.ts:12-19`.)

---

## 9. Complete sample transcript

`GET /session/ses_0a4a7b85fffeJ2mKw83nDpQr4v/message` → `200 application/json`.
One user turn ("run ls") and one assistant turn (step-start → text → bash tool → step-finish).
IDs generated with the real algorithm at `t0 = 1783944000000` (2026-07-13T12:00:00Z; session
created 60 s earlier). This exact array is also what the corresponding `message.updated` /
`message.part.updated` events must have delivered incrementally.

```json
[
  {
    "info": {
      "id": "msg_f5b5932000014qLxBGZuNkVanx",
      "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
      "role": "user",
      "time": { "created": 1783944000000 },
      "agent": "build",
      "model": { "providerID": "anthropic", "modelID": "claude-opus-4-6" }
    },
    "parts": [
      {
        "id": "prt_f5b593200002Rt7pW3cXqLm0aZ",
        "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
        "messageID": "msg_f5b5932000014qLxBGZuNkVanx",
        "type": "text",
        "text": "run ls in the project root"
      }
    ]
  },
  {
    "info": {
      "id": "msg_f5b593520001Kd82mQyTvBn31c",
      "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
      "role": "assistant",
      "parentID": "msg_f5b5932000014qLxBGZuNkVanx",
      "mode": "build",
      "agent": "build",
      "modelID": "claude-opus-4-6",
      "providerID": "anthropic",
      "path": { "cwd": "/Users/dev/project", "root": "/Users/dev/project" },
      "cost": 0,
      "tokens": {
        "input": 1204, "output": 86, "reasoning": 0,
        "cache": { "read": 0, "write": 0 }
      },
      "finish": "stop",
      "time": { "created": 1783944000800, "completed": 1783944009900 }
    },
    "parts": [
      {
        "id": "prt_f5b5937dc001Xw4NnB0eYhSj9u",
        "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
        "messageID": "msg_f5b593520001Kd82mQyTvBn31c",
        "type": "step-start"
      },
      {
        "id": "prt_f5b593a34001Ce6vZoAqUf2LtH",
        "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
        "messageID": "msg_f5b593520001Kd82mQyTvBn31c",
        "type": "text",
        "text": "I'll list the project root.",
        "time": { "start": 1783944002100, "end": 1783944002600 }
      },
      {
        "id": "prt_f5b593f48001Gh1RsD7kMpEw5y",
        "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
        "messageID": "msg_f5b593520001Kd82mQyTvBn31c",
        "type": "tool",
        "callID": "toolu_01AbCdEfGhIjKlMnOpQrStUv",
        "tool": "bash",
        "state": {
          "status": "completed",
          "input": { "command": "ls", "description": "List files in project root" },
          "output": "README.md\npackage.json\nsrc\n",
          "title": "ls",
          "metadata": {
            "output": "README.md\npackage.json\nsrc",
            "exit": 0,
            "truncated": false
          },
          "time": { "start": 1783944003400, "end": 1783944006100 }
        }
      },
      {
        "id": "prt_f5b595848001Vb9TcF3jZxKq8d",
        "sessionID": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
        "messageID": "msg_f5b593520001Kd82mQyTvBn31c",
        "type": "step-finish",
        "reason": "stop",
        "cost": 0,
        "tokens": {
          "input": 1204, "output": 86, "reasoning": 0,
          "cache": { "read": 0, "write": 0 }
        }
      }
    ]
  }
]
```

Minimal matching `Session` (for `GET /session/{id}` and `session.updated` events):

```json
{
  "id": "ses_0a4a7b85fffeJ2mKw83nDpQr4v",
  "slug": "brave-mountain",
  "projectID": "prj_shim",
  "directory": "/Users/dev/project",
  "title": "run ls in the project root",
  "version": "1.17.19",
  "time": { "created": 1783943940000, "updated": 1783944009900 }
}
```

---

## 10. Traps & gotchas (condensed)

1. **Session IDs descending, message/part IDs ascending.** Getting either direction wrong
   reverses ordering in the TUI everywhere (session list, message order, part order). §1.3.
2. **Part order = part-ID order**, not array order: the TUI store re-sorts on each event
   (`sync.tsx:377-388`). Mint part IDs in display order; never reuse an ID with different content
   except to update that same part.
3. **`message.part.delta` requires a prior `message.part.updated`** for that part
   (`sync.tsx:394-396`), and the delta blindly string-appends to any `field`. Always send the
   initial empty text/reasoning part first. Deltas are optional (§5).
4. **`ToolStateCompleted.title` and `.metadata` are required** (schema `v1/session.ts:277-289`);
   `ToolStateError.error` is a plain string; denial detection is substring matching on that
   string (§4.3).
5. **`assistant.parentID` must reference the user message** or duration display breaks
   (`index.tsx:1467-1473`); it is also schema-required.
6. **`mode` and `agent` are both required** on assistant messages; the server sets both to the
   agent name. The footer renders `mode`, the color comes from `agent`.
7. **Tokens gauge** uses the *last* assistant message with `tokens.output > 0` and sums all five
   counters — put context-window usage in `input` (+`cache.read`) or the % indicator lies. §3.3.
8. **`metadata.sessionId`** on task tool parts is camelCase with lowercase `d`; `session.get` +
   `session.messages` will be called on it, so the child session must actually exist (§6.2).
9. **`finish: "tool-calls"`** on an in-between assistant message suppresses the footer;
   `"stop"` shows it. Set `finish` only from real stop reasons; the TUI treats `"unknown"` as
   not-final too (`index.tsx:1463-1465`).
10. **`MessageAbortedError`** is the one error name with special rendering ("interrupted", not an
    error box). Emit it (and stamp `time.completed`) when a prompt is aborted (§3.2/§3.3).
11. **`synthetic: true` text parts are invisible** in user messages and transcript copy — use
    them for injected context, exactly like the server does (`prompt.ts:441-448,479-487`).
12. **Message list endpoint returns oldest→newest with a `limit` of most recent** — i.e., the
    *last* `limit` messages of the session in ascending order (`message-v2.ts:425-467`).
    The TUI asks for `limit: 100` and prunes its store to 100.
13. **`message.part.updated` carries `time`** (publish ms) next to `part` — include it; the
    schema requires it (`v1/session.ts:612-620`).
14. **Step parts are ignored by the TUI but not by opencode's own history/compaction logic**;
    emit `step-start` before content and `step-finish` (with tokens/cost) after each round so
    exports, other clients, and future TUI versions behave.
15. **ID wrap date 2026-08-14** (§1.4) — cosmetic for a fresh shim, but don't "fix" the encoding.
16. **Session `model.id` vs message `model.modelID`** naming inconsistency (§2.1).
17. The TUI **drops empty-text refetches** so a slow `GET /message` after streaming won't blank
    parts — but only for `text`/`reasoning` parts already tracked as hydrating (`sync.tsx:627-640`).
18. Reasoning parts need `time.end` to stop the "Thinking" spinner (§4.2). Text parts' `time` is
    optional; tool `running.time.start` drives elapsed display.
