# 00 — Overview: implementation plan, route matrix, canonical turn sequence

Master index for the open-claude shim (Bun + Hono server reimplementing the opencode
v1.17.19 HTTP/SSE API on top of `@anthropic-ai/claude-agent-sdk` 0.3.207, serving the
stock `opencode attach http://localhost:PORT` TUI).

Companion docs (read these for verbatim types, traces, and traps — this file only
sequences and classifies):

| Doc | Contents |
|---|---|
| `01-bootstrap.md` | attach flow, transport conventions, all bootstrap GET contracts, provider/agent/config JSON |
| `02-events.md` | `GET /global/event` SSE framing, full event catalog, requirement tiers |
| `03-writes-v1.md` | every v1 write route (create/prompt/abort/permission/question/...) |
| `04-reads-v2.md` | `/api/*` GET routes, location envelope, `_tag` errors |
| `05-data-model.md` | ID algorithm, Session/Message/Part schemas, tool renderer field contract |
| `06-stubs.md` | non-blocking stubs, error shapes, 404 contract, auth, CORS |
| `07-sdk-mapping.md` | Claude Agent SDK surface + SDK-message → opencode-event mapping |

This overview was written after a verification pass that cross-checked the seven docs
against each other and re-checked load-bearing claims against `vendor/opencode` source.
Corrections applied in place (search for `> CORRECTED:`):

- **01**: SSE frames carry **no `event:` line** (effect Sse encoder omits it for
  `"message"`); directory query param is **single-encoded**, not double-encoded
  (`pick()` in `sdk/js/src/v2/client.ts:10-16` decodes the header before it enters the
  query; the server's second `decodeURIComponent` is a guarded no-op).
- **02**: canonical turn-start order is user `message.updated` → assistant
  `message.updated` → `session.status busy` (busy is set at LLM-stream start,
  `processor.ts:639`, after `prompt.ts` created both messages); trap T4 rewritten —
  session ids in stock opencode are **descending**-encoded and every visible session
  list sorts by `time.updated`, so descending `ses_` ids are correct (and required to
  reproduce stock child-subagent ordering).
- **03**: open question resolved — the v2 `/api/session/*` hydration reads are dead code
  at v1.17.19; session hydration is entirely v1 (`sync.tsx:596-599`).
- **05**: tool-name mapping evidence strengthened (`sdk-tools.d.ts:536` literal
  `tool: "Bash"`; full `ToolInputSchemas` interface list).

Independently re-verified during the pass (no correction needed): the TUI prompt route is
`POST /session/{sessionID}/message` via `sdk.client.session.prompt` with
`{throwOnError:true}` and a bare `.catch(toast)` — **the response body is never read;
all rendering is SSE** (`packages/tui/src/component/prompt/index.tsx:1093-1118`);
`message.part.delta` string-appends and silently drops unknown parts
(`sync.tsx:392-409`); the four fatal bootstrap calls are exactly
`/config/providers`, `/provider`, `/agent`, `/config` (`sync.tsx:452-463`);
`useConnected()` requires a provider id ≠ `"opencode"` (`use-connected.tsx:4-12`);
the ToolState/Part field names cited in 02/03/04/05 agree with
`packages/schema/src/v1/session.ts`.

---

## 1. Golden rules (apply to every route)

1. `Content-Type: application/json` everywhere except the SSE stream. **Never** exactly
   `text/html` — the client interceptor hard-throws (`v2/client.ts:84-90`).
2. Unknown route → `404` JSON: `{"name":"NotFoundError","data":{"message":"route not implemented: GET /x"}}`.
3. Never 204/empty-body a list route (client parses empty as `{}`, not `[]`).
4. Errors: legacy routes `{"name":..., "data":{"message":...}}`; `/api/*` and
   permission/question routes `{"_tag":..., "message":...}` (see 04 §1.4, 06 §4).
5. IDs: `<prefix>_<12 hex><14 base62>`, `ses_` **descending**, `msg_`/`prt_`/`per_`/`que_`/`evt_`
   **ascending** — reuse opencode's `hex(ms*4096+counter)` encoding (05 §1). The TUI
   binary-searches everything by raw id string; part display order IS part-id order.
6. Times are epoch **milliseconds**; costs are dollars; token limits are counts.
7. Directory scoping: GET/HEAD → `?directory=` query (single-encoded; apply guarded
   `decodeURIComponent`), non-GET → `x-opencode-directory` header (URI-encoded once);
   `/api/*` GETs also carry `location[directory]`. Accept and never 400 on these params.
   Fallback: shim cwd. Serve ONE canonical byte-identical directory string everywhere
   (`/path.directory === /path.worktree === /api/location.directory === session.directory`).
8. Every write must emit its SSE side effects, or the TUI appears frozen (dialog
   dismissal, list updates, spinner — all SSE-driven).
9. Provider id must be `anthropic` (not `opencode`); ≥1 provider and ≥1 visible
   `mode:"primary"` agent are mandatory or the home screen breaks.
10. Session ids must start with `ses` (client-side validation); `projectID` on sessions
    must equal `GET /project/current`'s stable `id`.

---

## 2. Implementation checklist (dependency order)

### M0 — HTTP skeleton (no TUI yet)
- [ ] Hono app, JSON-404 catch-all (rule 2), no HTML anywhere.
- [ ] Directory resolution middleware (rule 7); config for the canonical directory.
- [ ] ID generator module implementing opencode's algorithm (05 §1.2) with
      ascending/descending + per-ms counter.
- [ ] `GET /global/health` → `{"healthy":true,"version":"1.17.19"}`.

### M1 — Boot: `opencode attach` reaches the interactive home screen
Blocking, fatal-on-failure (01 §4.1):
- [ ] `GET /config/providers` — anthropic provider + Claude models (01 §5.1 JSON; decide
      the model catalog + `variants` up front).
- [ ] `GET /provider` — `{all, default, connected:["anthropic"]}` (01 §5.2).
- [ ] `GET /agent` — `[build, plan]` minimum (01 §5.3).
- [ ] `GET /config` — `{}` or `{"model":"anthropic/claude-sonnet-5"}` (01 §5.4).

Blocking, failure-tolerant (must not connection-fail):
- [ ] `GET /path` — worktree === directory === canonical dir (01 §5.5).
- [ ] `GET /project/current` — stable `id` (01 §5.6); `GET /project/{id}/directories` → `[{directory}]`.

Non-blocking batch — ALL must resolve 200 JSON or sync never reaches "complete" (06 §2.3):
- [ ] `GET /session` → `[]` (honor nothing yet; TUI re-sorts client-side).
- [ ] `GET /command` `[]`, `/lsp` `[]`, `/formatter` `[]`, `/mcp` `{}`,
      `/experimental/resource` `{}`, `/session/status` `{}`, `/provider/auth` `{}`,
      `/vcs` `{"branch":...}` (object, never empty body),
      `/experimental/workspace` `[]`, `/experimental/workspace/status` `[]`,
      `/experimental/capabilities` `{"backgroundSubagents":false}`,
      `/experimental/console` `{"consoleManagedProviders":[],"switchableOrgCount":0}`.

v2 stubs (allSettled-protected but keep stderr clean; envelope required — 04 §4):
- [ ] `GET /api/location` → bare LocationInfo; the 7 list routes
      (`/api/agent|command|skill|reference|integration|model|provider`) →
      `{location, data: []}` with byte-identical `location.directory`.

SSE:
- [ ] `GET /global/event`: headers per 02 §2; first frame `server.connected`; heartbeat
      every 10 s; frames are exactly `data: <compact JSON>\n\n` (no `event:`/`id:` lines);
      no gzip/buffering; accept `?directory=` param.

**Verify milestone:** `opencode attach http://localhost:PORT` shows the home screen with
prompt + model name; no "connect a provider" dialog; `/status` style dialogs empty but
functional.

### M2 — Prompt round-trip (the core)
- [ ] `POST /session` (create; accepts empty body; body `model.id` NOT `modelID`) →
      Session JSON; emit `session.updated` immediately (there is no `session.created`
      handler in the TUI).
- [ ] `GET /session/{id}` (404 JSON when unknown), `GET /session/{id}/message?limit=100`
      → `[{info, parts}]` oldest→newest, `GET /session/{id}/todo` `[]`,
      `GET /session/{id}/diff` `[]` — session-open hydration (03 CORRECTED note).
- [ ] Claude Agent SDK bridge: one long-lived `query()` per session, streaming input
      iterable, `includePartialMessages:true`,
      `systemPrompt:{type:'preset',preset:'claude_code'}`, cwd = session directory;
      record `system/init.session_id` for resume (07 §2-3).
- [ ] `POST /session/{id}/message`: persist user message, push into the query iterable,
      emit the turn event sequence (§4 below), block until turn end, respond
      `{info: assistantMessage, parts}` (TUI ignores the body; `opencode run` reads it).
- [ ] `session.status` events + `GET /session/status` reflecting live busy/idle.
- [ ] `POST /session/{id}/abort` → `query.interrupt()`, cleanup per 07 §10.8
      (MessageAbortedError + `time.completed` + idle), respond `true`.
- [ ] SSE store + REST store are the same store: what events built must be exactly what
      `GET /session/{id}/message` returns (TUI re-hydrates on session open/reconnect).

**Verify milestone:** type a prompt, watch streamed text render, spinner busy→idle,
Esc-Esc interrupts, reopening the session replays the transcript.

### M3 — Tool calls + permissions
- [ ] Tool part lifecycle from SDK stream (pending → running → completed/error) with
      name/input translation (`Bash`→`bash`, `file_path`→`filePath`, …) and metadata
      synthesis (`bash.metadata.output`, `edit.metadata.diff`, …) — 05 §6.3/6.5, 07 §10.4.
- [ ] `canUseTool` ↔ `permission.asked` / `POST /permission/{requestID}/reply`
      (`{reply:"once"|"always"|"reject", message?}`) ↔ broadcast `permission.replied`
      (dialog dismissal is SSE-only). "always": persist the request's own `always[]`
      patterns in-memory; reject cascades to all pending permissions of the session (03 §9).
- [ ] `POST /question/{requestID}/reply` (`{answers: string[][]}`) / `/reject` +
      `question.replied`/`question.rejected` events (map `AskUserQuestion`).
- [ ] `todo.updated` from TodoWrite tool calls; `session.error` mapping table (07 §10.11).

### M4 — Session management writes
- [ ] `POST /session/{id}/fork` (empty body OK; response Session is navigated to),
      `DELETE /session/{id}` (+ `session.deleted` event, `properties.info` required),
      `PATCH /session/{id}` (rename → `session.updated`),
      `POST /session/{id}/prompt_async` (204; used with `noReply:true`),
      `POST /session/{id}/shell` (bash tool part, blocks), `POST /session/{id}/command`.
- [ ] Session list filtering (`start`, `path`/`scope`, `search`, `limit`) once sessions persist.
- [ ] Share: either real `share.url` or 500 `{"_tag":"InternalServerError"}` / serve
      `config.share="disabled"`. Revert/unrevert: implement or 409/400 stub.
- [ ] Benign no-op successes: `POST /instance/dispose` → `true` (+ emit
      `server.instance.disposed` if you actually re-init), mcp connect/disconnect.

### M5 — Polish
- [ ] Subagents: child sessions per Task tool (`metadata.sessionId`,
      `session.parentID`, `forwardSubagentText:true`) — 07 §10.9.
- [ ] Compaction (`/summarize` + compact_boundary mapping — 07 §10.10), retries
      (`session.status retry`), `session.diff`, `/api/fs/find` real implementation
      (walk cwd; powers @-mentions), `GET /find/file`.
- [ ] `server.instance.disposed` on shim restart; optional basic auth; CORS if a web UI
      ever connects.

---

## 3. Route matrix

Classification: **HARD** = must be correct/complete (TUI exits, crashes, or core UX
breaks). **SOFT** = must exist and resolve with schema-valid (empty) JSON. **STUB** =
JSON-404 or benign `true` acceptable. (V) = verify against docs for exact shape.

| Route | Class | Minimal response | Doc |
|---|---|---|---|
| `GET /config/providers` | HARD | providers+default JSON | 01 §5.1 |
| `GET /provider` | HARD | `{all,default,connected}` | 01 §5.2 |
| `GET /agent` | HARD | `[build, plan]` | 01 §5.3 |
| `GET /config` | HARD | `{}` | 01 §5.4 |
| `GET /path` | HARD | path object | 01 §5.5 |
| `GET /project/current` | HARD | Project (stable id) | 01 §5.6 |
| `GET /project/{id}/directories` | SOFT | `[{directory}]` | 01 §5.7 |
| `GET /session` | HARD | `[]` / Session[] | 01 §5.8 |
| `GET /session/{id}` | HARD | Session / 404 JSON | 01 §5.8 |
| `GET /session/{id}/message` | HARD | `[{info,parts}]` | 05 §6.1 |
| `GET /session/{id}/message/{mid}` | SOFT | `{info,parts}` | 05 §6.1 |
| `GET /session/{id}/todo` | SOFT | `[]` | 06 §3.3 |
| `GET /session/{id}/diff` | SOFT | `[]` | 06 §3.3 |
| `GET /session/status` | HARD | `{}` / live map | 01 §5.9 |
| `GET /global/event` (SSE) | HARD | see §4 | 02 |
| `GET /global/health` | SOFT | `{"healthy":true,"version":"1.17.19"}` | 01 §5.15 |
| `POST /session` | HARD | Session | 03 §2 |
| `POST /session/{id}/message` | HARD | `{info,parts}` (blocks) | 03 §3 |
| `POST /session/{id}/prompt_async` | HARD | 204 | 03 §4 |
| `POST /session/{id}/abort` | HARD | `true` | 03 §7 |
| `POST /session/{id}/fork` | HARD | Session | 03 §8.1 |
| `DELETE /session/{id}` | HARD | `true` + event | 03 §8.2 |
| `PATCH /session/{id}` | HARD | Session + event | 03 §8.3 |
| `POST /session/{id}/shell` | HARD | `{info,parts}` (blocks) | 03 §5 |
| `POST /session/{id}/command` | HARD | `{info,parts}` (blocks) | 03 §6 |
| `POST /session/{id}/summarize` | SOFT | `true` (or full compaction) | 03 §8.4 |
| `POST /session/{id}/share`, `DELETE .../share` | SOFT | Session w/ `share.url` or 500 | 03 §8.5 |
| `POST /session/{id}/revert`, `/unrevert` | SOFT | Session | 03 §8.6 |
| `POST /permission/{requestID}/reply` | HARD | `true` + `permission.replied` | 03 §9 |
| `POST /question/{requestID}/reply`, `/reject` | HARD | `true` + events | 03 §10 |
| `GET /command`,`/lsp`,`/formatter` | SOFT | `[]` | 06 §3.1 |
| `GET /mcp`,`/experimental/resource`,`/provider/auth` | SOFT | `{}` | 06 §3.1 |
| `GET /vcs` | SOFT | `{}`/`{"branch":...}` (never empty body) | 06 §3.1 |
| `GET /vcs/diff`, `/vcs/status` | SOFT | `[]` | 06 §3.3 |
| `GET /experimental/capabilities` | SOFT | `{"backgroundSubagents":false}` | 01 §5.13 |
| `GET /experimental/console` | SOFT | `{"consoleManagedProviders":[],"switchableOrgCount":0}` | 01 §5.13 |
| `GET /experimental/workspace`, `+/status` | SOFT | `[]` | 01 §5.14 |
| `GET /api/location` | SOFT | LocationInfo (bare) | 04 §2.1 |
| `GET /api/{agent,command,skill,reference,integration,model,provider}` | SOFT | `{location, data:[]}` | 04 §2.2-2.8 |
| `GET /api/fs/find` | SOFT→real | `{location, data:[]}` (implement for @-mentions) | 04 §2.15 |
| `GET /find/file` | SOFT | `[]` | 06 §3.3 |
| `GET /api/session*`, `/api/permission/saved`, session perm/question lists | STUB | `{data:[],cursor:{}}` / `{data:[]}` | 04 §2.9-2.14 |
| `POST /instance/dispose` | STUB | `true` | 06 §3.4 |
| `PUT /auth/{providerID}`, oauth routes | STUB | `true` / 404 JSON | 03 §12 |
| `POST /mcp/{name}/connect|disconnect` | STUB | `true` | 06 §3.4 |
| `POST /global/upgrade`, `POST /log` | STUB | 404 JSON / `true` | 03 §12 |
| `GET /tui/control/next` | STUB | park forever, never instant 200 | 06 §3.5 |
| `POST /session/{id}/permissions/{pid}` (deprecated) | STUB | not needed for pinned TUI | 03 §9.1 |
| everything else | STUB | JSON 404 | 06 §4.5 |

---

## 4. Canonical event sequence for one complete assistant turn

From `POST /session/{sid}/message` to idle. Envelope for every frame:
`{"directory":"<canonical dir>","payload":{"id":"evt_<ascending>","type":...,"properties":{...}}}` —
**never set `workspace`** (02 T2). Wire framing: `data: <single-line JSON>\n\n`.

Sequence (verified order per stock server `prompt.ts` + `processor.ts`; the TUI is
order-insensitive for steps 1-3 but strict about 4-before-5 and part-before-delta):

```
 1. message.updated        {sessionID, info: <UserMessage: id msg_A, agent, model{providerID,modelID}, time{created}>}
 2. message.part.updated   {sessionID, time, part: <TextPart prt_1 of msg_A with the prompt text>}
 3. message.updated        {sessionID, info: <AssistantMessage msg_B: parentID msg_A, mode/agent "build",
                            modelID/providerID, path{cwd,root}, cost 0, tokens zeroed, time{created}>}
 4. session.status         {sessionID, status:{type:"busy"}}
 5. message.part.updated   {sessionID, time, part:{id:prt_2, type:"step-start", messageID:msg_B, ...}}
    -- optional reasoning --
 6. message.part.updated   {part:{id:prt_3, type:"reasoning", text:"", time:{start}}}
 7. message.part.delta     {messageID:msg_B, partID:prt_3, field:"text", delta:"..."} × N
 8. message.part.updated   {part:{...prt_3, text:<full>, time:{start,end}}}
    -- text --
 9. message.part.updated   {part:{id:prt_4, type:"text", text:"", time:{start}}}      <- MUST precede deltas
10. message.part.delta     {messageID:msg_B, partID:prt_4, field:"text", delta:"Hello"} × N
11. message.part.updated   {part:{...prt_4, text:<full accumulated>, time:{start,end}}}  <- authoritative reconcile
    -- tool call (repeat 12-16 per tool; whole block 5-17 repeats per API step) --
12. message.part.updated   {part:{id:prt_5, type:"tool", callID:"toolu_x", tool:"bash",
                            state:{status:"pending", input:{}, raw:""}}}
13. (permission gate)      permission.asked {id:"per_1", sessionID, permission:"bash", patterns:[...],
                            metadata:{}, always:[...], tool:{messageID:msg_B, callID:"toolu_x"}}
14. (after POST reply)     permission.replied {sessionID, requestID:"per_1", reply:"once"}
15. message.part.updated   {part:{...prt_5, state:{status:"running", input:{command:"ls"}, time:{start}}}}
16. message.part.updated   {part:{...prt_5, state:{status:"completed", input:{...}, output:"...",
                            title:"ls", metadata:{output:"...", exit:0}, time:{start,end}}}}
                           (error: state:{status:"error", error:"<string>", time:{start,end}})
    (todowrite tools also →) todo.updated {sessionID, todos:[{content,status,priority}]}
17. message.part.updated   {part:{id:prt_6, type:"step-finish", reason:"stop"|"tool-calls", cost,
                            tokens:{input,output,reasoning,cache:{read,write}}}}
    + message.updated      {info:{...msg_B, finish, cost, tokens}}   <- after each step
    -- turn end --
18. message.updated        {info:{...msg_B, time:{created, completed:<now>}, finish:"stop",
                            cost:<total_cost_usd>, tokens:<LAST step's usage — the current
                            context. NOT the SDK result.usage, which sums every API call in
                            the turn and overstates context by N× (test/probe-usage.ts); the
                            TUI context %% = this msg's token total / model limit.context>}}
19. session.updated        {sessionID, info:<Session with updated title/time.updated/tokens/cost>}
20. session.status         {sessionID, status:{type:"idle"}}
21. session.idle           {sessionID}          (deprecated, TUI ignores; emit for parity)
    ... then the blocked POST /session/{sid}/message resolves 200 {info: msg_B, parts:[...]}
```

Abort variant: after `POST .../abort` → close open parts, fail running tools
(`error:"Tool execution aborted"`, `metadata.interrupted:true`), `message.updated` with
`error:{name:"MessageAbortedError",data:{message}}` + `time.completed`, optional
`session.error` (TUI-silent for that name), `session.status idle`, and the blocked prompt
POST still resolves 200.

Error variant: `session.error {sessionID, error:<union per 07 §10.11>}` + same
completion/idle bookkeeping.

Sample compact frames for each event type: 07 §11; full turn walkthrough with
algorithm-accurate IDs: 05 §9.

Key invariants (from 02 §9 / 05 §10):
- `message.part.updated` (empty text) MUST precede any `message.part.delta` for that part.
- Deltas append; the final part.updated replaces — never resend full text as a delta.
- No tool-input delta event exists in v1; accumulate `input_json_delta` silently.
- Never materialize tool_result user messages (breaks idle detection).
- `assistant.parentID` must reference the user message; `time.completed` must be set at
  turn end or the TUI spins forever.
- `message.part.updated` carries the sibling `properties.time` (epoch ms) — always set it.

---

## 5. Resolved decisions (consolidated from the seven docs)

1. **Events**: emit only the classic v1 family (message.*, session.status/updated/deleted,
   permission.*, question.*, todo.updated, session.error, session.diff). Skip all
   `session.next.*` and all `type:"sync"` twins. Never emit `catalog.updated` /
   `reference.updated` / `integration.updated` unless the corresponding `/api/*` GETs are
   solid (floating-promise risk, 04 T3).
2. **Deltas**: use `message.part.delta` bracketed by full part.updated snapshots (stock
   pattern); pure-snapshot streaming also works if simpler.
3. **Prompt POST**: block until turn completion, return final `{info, parts}`.
4. **Process model**: one long-lived `query()` per session (streaming input, `interrupt()`
   for abort, `resume` across restarts). `systemPrompt: {type:'preset',preset:'claude_code'}`;
   never set `Options.env` without spreading `process.env`.
5. **IDs**: opencode's exact encoding, `ses_` descending, everything else ascending.
6. **Model catalog**: invest in v1 `/config/providers` fidelity (hardcode context/cost
   tables); `/api/model` + `/api/provider` stay `[]`.
7. **Tool translation**: lowercase names + camelCase input keys + synthesized metadata
   per 05 §6.5 / 07 §8.5; unmapped tools fall back to GenericTool (safe).
8. **Errors**: per-route shape fidelity (name/data vs _tag) per 06 §4.
9. **Auth**: skip unless `OPENCODE_SERVER_PASSWORD` is set; then Basic + `?auth_token=`
   incl. the SSE route.
10. **Workspaces**: entirely out of scope (flag off in the pinned TUI); never set the
    `workspace` envelope field.

---

## 6. Remaining genuinely-open questions

Design decisions with no source-derivable answer (must be settled during implementation):

1. **Claude-session ↔ opencode-session mapping persistence.** Where the shim stores
   `ses_* ↔ Claude session UUID` (+ transcript state) so `resume` works across shim
   restarts. Related: does the shim persist opencode-side messages/parts itself, or
   rebuild them from `getSessionMessages()` on demand?
2. **Permission pattern synthesis.** What `patterns`/`always` strings to put in
   `permission.asked` for each Claude tool (opencode's tools generate these server-side;
   e.g. bash command prefixes). Also whether TUI "always" replies should be forwarded to
   the SDK as `updatedPermissions` (destination `session` vs `localSettings`) in addition
   to the shim's in-memory allow list.
3. **pending→running transition signal.** Which SDK signal marks "tool actually
   executing": the post-permission `SDKAssistantMessage` containing the final tool_use
   block, first `tool_progress`, or immediately after canUseTool-allow. Validate against
   a live stream (07 doc recommends the assistant-message signal).
4. **Variants.** Which `model.variants` keys to expose (e.g. thinking levels
   low/high/max) and how they map to the SDK `thinking`/`effort` options; `{}` disables
   the variants dialog entirely.
5. **Multi-client / multi-directory.** `/global/event` is unfiltered and the TUI does no
   directory filtering — fine for one project; concurrent attachments to different
   directories would leak events between TUIs. Single-project-per-shim-instance is the
   simple answer.
6. **Compaction summary text.** `SDKCompactBoundaryMessage` carries no summary text;
   emit the CompactionPart boundary only, or synthesize a summary from
   `getSessionMessages()` after compaction?
7. **AskUserQuestion routing.** Map to the opencode question flow
   (`question.asked`/`POST /question/.../reply`) vs rendering as a question ToolPart —
   depends on how the SDK surfaces the tool (canUseTool vs a dedicated control request);
   needs a live check.
8. **Bun unhandled-rejection behavior** of the compiled TUI (whether a floating-promise
   rejection kills it) — only matters if the shim ever emits catalog/reference/
   integration events; avoidable by never emitting them.
9. **Runtime `tool_use.name` strings** beyond the confirmed set (Bash/Read/Edit/Write/
   Glob/Grep/Task doc-confirmed) — log one live session before freezing the mapping table.
10. **`--continue` with zero sessions** leaves the TUI on a dummy session route (stock
    behavior). Optionally pre-create a session to make `-c` friendlier — cosmetic.
11. **ID wrap on 2026-08-14** (48-bit truncation period rollover): ignore, or avoid
    persisting sessions across the boundary (stock opencode has the same defect).
