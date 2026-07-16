# open-claude

Run the **opencode** frontend (its TUI, and by extension its web/desktop clients) on top
of a **Claude Code** backend.

opencode has a strict client/server split: every frontend is a thin client of a local
HTTP + SSE API, and `opencode attach <url>` points the stock TUI at any server that speaks
that API. `open-claude` is that server — it reimplements the opencode v1.17.19 wire
contract and drives the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
(the real Claude Code engine) underneath. So you get opencode's renderer with Claude Code's
agent, prompts, tools, and permission model.

```
┌────────────────┐  HTTP + SSE (opencode API)  ┌──────────────┐   stream-json   ┌─────────────┐
│ opencode TUI   │ ───────────────────────────▶│  open-claude │ ───────────────▶│ Claude Code │
│ (stock, v1.17) │ ◀─────────────────────────── │  (this repo) │ ◀───────────────│ (Agent SDK) │
└────────────────┘    server.connected /        └──────────────┘   SDK messages  └─────────────┘
                      message.* / permission.*
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- `opencode` CLI **v1.17.19** (the contract is pinned to this version — `opencode upgrade`)
- Claude auth: either a Claude Pro/Max subscription (`claude /login`) or `ANTHROPIC_API_KEY`
  in the environment. The Agent SDK picks up whichever is present.

## Usage

```sh
bunx @dwahdany/open-claude
```

That's the whole quickstart: it starts the server and drops you straight into the opencode
TUI, attached. Quitting the TUI stops the server. (open-claude itself is just the server —
the TUI always connects via opencode's own `opencode attach <url>`; the default merely runs
that for you.)

The server listens on `127.0.0.1` with an OS-assigned free port (same defaults as
`opencode serve`), so multiple instances run side by side without colliding. Pass
`--port <n>` if you need a stable address.

To run the server standalone and connect clients yourself, pass `--serve` (this also
happens automatically when opencode isn't installed or stdout isn't a terminal):

```sh
bunx @dwahdany/open-claude --serve --directory /path/to/your/project
# prints e.g. "open-claude listening on http://127.0.0.1:52341" — in another terminal:
opencode attach http://127.0.0.1:52341
```

From a checkout: `bun install && bun run start`.

`--directory` is the working directory the Claude Code agent operates in (defaults to the
shim's cwd). Then use the opencode TUI exactly as normal: type prompts, watch streaming
text and tool calls, approve/deny permission prompts. First `bunx` run downloads the
bundled Claude Code engine (~230MB, cached); later runs start instantly.

On the very first interactive run, open-claude offers to save an `oclaude` shell alias
(one appended line in your `~/.zshrc` / `~/.bashrc` / fish config, pointing at however you
launched it — global install, `bunx`, or a checkout). Answer once and it never asks again;
set `OPENCLAUDE_NO_ALIAS_PROMPT=1` to suppress the offer entirely.

### Config

| Env var | Effect |
|---|---|
| `OPENCLAUDE_SETTING_SOURCES=none` | Ignore your `~/.claude` allowlists so **every** gated tool routes through opencode's permission dialog (clean-room prompts). Default: load your Claude Code settings, matching normal Claude Code behavior. |
| `OPENCLAUDE_ULTRACODE=1` | Enable Claude Code's ultracode mode (`Settings.ultracode`): xhigh effort plus standing workflow orchestration. Only takes effect when your account has workflows enabled and the model supports xhigh. |
| `OPENCLAUDE_NO_ALIAS_PROMPT=1` | Never offer the first-run `oclaude` shell alias. |
| `OPENCLAUDE_NO_UPDATE_CHECK=1` | Never check npm for a newer version. |
| `OPENCLAUDE_NO_QUESTION_NOTES=1` | Drop the synthetic "Notes" tab from question dialogs — restores one-keystroke submit on single questions; free text is still available via "Type your own answer". |

### Updating

open-claude updates through whatever runs it — there is no self-updater, by design:

| How you run it | Update with |
|---|---|
| Global install | `bun add -g @dwahdany/open-claude@latest` (or `npm i -g …@latest`) |
| `bunx` / `npx` | `bunx @dwahdany/open-claude@latest` — the bare spec reuses the cached copy, so pass `@latest` when you want the newest |
| Source checkout | `git pull` |

At most once a day (interactive runs only) open-claude asks npm whether a newer version
exists and prints a one-line notice with the command matching your launch mode — in serve
logs, or after the TUI hands the terminal back, never during a session. Offline or slow
registries are ignored silently. `OPENCLAUDE_NO_UPDATE_CHECK=1` (or `CI`) disables it.

## What works

- Boot: `opencode attach` reaches the interactive home screen; model picker lists Claude models.
- Prompt round-trip: streaming text + reasoning render live; cost/context gauge update; Esc-Esc interrupts.
- Tools: bash/read/edit/write/glob/grep/todowrite/… render with opencode's per-tool views.
- Permissions: Claude Code's `canUseTool` gate ↔ opencode's `permission.asked` dialog ↔ reply round-trip.
- **Agents** (Tab to cycle): `build` (default mode), `plan` (plan mode), `auto` (Claude Code's
  `auto` permission mode — a model classifier handles permission prompts; anything it escalates
  still surfaces as an opencode permission dialog).
- **Reasoning effort**: the model variant picker (low/medium/high/xhigh/max) maps to Agent SDK
  `effort`. First pick applies at query start; later changes apply mid-session via the
  flag-settings layer (which has no `max` member, so `max` picked after turn 1 clamps to `xhigh`;
  reverting to "no variant" falls back to the session's initial effort, not the global default).
- **Mid-session switching**: model and build↔plan agent changes on later turns ride
  `setModel`/`setPermissionMode`; turns are serialized per session; Esc-Esc aborts map to
  `MessageAbortedError` (no error toast) and in-flight tool parts are errored out. The TUI's
  model picker is authoritative: the engine tracks the CLI's *actual* model every turn and
  re-asserts the picker's choice if anything drifts CLI-side, and each assistant message is
  stamped with the model that actually served it (so the context gauge divides by the right
  window even across a drifted turn).
- **Subagents**: Task/Agent runs (and workflow-spawned agents with a spawning tool call) mirror
  into opencode **child sessions** — the task tool part links via `metadata.sessionId`, so the
  TUI shows live progress and "view subagents" navigates into the child transcript.
- **Workflows**: `Workflow` tool runs render through the same Task view — spinner + live
  phase/agent line while running, and a child session containing a progress log
  (`task_progress` ticks, with `agentProgressSummaries` AI status lines, closed by the
  completion summary). Requires the account-gated Workflows feature.
- **Questions**: `AskUserQuestion` maps to opencode's question dialog; selected labels return
  to the model via `updatedInput.answers`. Option **previews** (mockups, code snippets) fold
  into the option description as quote-barred lines (line-budgeted so the dialog can't outgrow
  the terminal, which would clip with no scroll). A trailing **Notes** tab lets you attach a
  free-text note to your answer — it returns via `updatedInput.annotations`, which the CLI
  renders into the tool result (` notes: …`), and shows in the transcript as `note: …`.
  Disable with `OPENCLAUDE_NO_QUESTION_NOTES=1`.
- **`/config`**: bare `/config` renders your current Claude Code settings (with the file each
  value comes from) instantly in the transcript — headless, the CLI could only print its usage
  dump. `/config key=value` still passes through to the CLI and persists.
- **`/model`**: intercepted as a read-only view (current model, catalog, pointer to `/models`).
  The CLI's session-scoped switch could never stick here — the picker re-sends its model with
  every prompt — so forwarding it would only desync the footer from the model actually serving
  the turns.
- Session hydration: reopening a session replays its transcript.

## Verified

- `test/sdk-smoke.ts` — Agent SDK runs under Bun with local auth.
- `test/tool-permission.ts` — HTTP+SSE permission bridge (Write tool → dialog → approve → file written).
- `test/subagent-session.ts` — Task subagent → child session over SSE, task part linked via
  `metadata.sessionId`, child transcript fetchable, busy→idle lifecycle.
- `test/question-bridge.ts` — AskUserQuestion → `question.asked` → reply → answer reaches the model.
- `test/live-question-notes.ts` — option previews fold into descriptions (quote-barred, budget-clamped,
  raw `preview` on the wire), Notes tab note returns via `updatedInput.annotations` and lands in the
  tool_result + transcript metadata, "No note"/loose reply shapes/kill-switch all round-trip.
- `test/pty_question.py` — the real TUI renders folded previews and the Notes tab; a typed note
  round-trips on-screen (CLI-side contract in `test/probe-question-annotations.ts`).
- `test/live-model-sync.ts` — `/model` intercept (read-only view, session never busy) and
  model-drift self-heal: a raw `/model` passthrough flips the CLI, the drifted turn's message
  is restamped with the serving model, the next turn re-asserts the picker's choice
  (CLI-side contract in `test/probe-model-switch.ts`).
- `test/workflow-render.ts` — Workflow run → task part linked to a child session with a live
  progress log, busy→idle on completion.
- `test/sdk-subagent-probe.ts` — documents how the SDK forwards subagent content (complete
  messages with `parent_tool_use_id`; never partial stream events).
- `test/pty_attach.py` / `test/pty_permission.py` — the **stock opencode TUI** driven in a PTY:
  boots against the shim, renders a streamed answer (including a Task subagent turn with the
  "view subagents" affordance), renders + approves a permission dialog.

## Known limitations / not yet wired

- **Subagent transcripts arrive per-block**: child sessions update as each subagent message
  completes (no token-level streaming — the Agent SDK doesn't forward subagent partials).
- **Workflow inner agents render as a progress log, not transcripts**: their conversations
  never cross the SDK stream at all (only phase-level `task_progress` does). Full per-agent
  transcripts exist only on disk (`transcriptDir`) — deliberately not tailed.
- **Compaction**: emits the boundary only; no summary text.
- **Single project per instance**: `/global/event` is unfiltered; run one shim per directory.
- **Pinned to opencode v1.17.19** — the API is mid v1→v2 migration; other versions may drift.

## How it's built

The complete reverse-engineered wire contract lives in [`docs/contract/`](docs/contract/)
(bootstrap endpoints, SSE event vocabulary, v1 writes, v2 reads, data model + ID scheme,
stubs, and the Agent-SDK→opencode event mapping), extracted from the pinned opencode source.
Start with [`docs/contract/00-overview.md`](docs/contract/00-overview.md).

Source layout:

| File | Role |
|---|---|
| `src/ids.ts` | opencode-compatible identifier generation (sortable, direction-aware) |
| `src/catalog.ts` | static provider/model/agent/config bootstrap JSON |
| `src/bus.ts` | SSE event bus + exact `data:`-only framing |
| `src/store.ts` | in-memory sessions/messages/parts; keeps REST state and SSE in sync |
| `src/engine.ts` | one Claude Agent SDK `query()` per session; maps SDK stream → opencode events |
| `src/tools.ts` | Claude Code tool name/input → opencode tool rendering contract |
| `src/config-view.ts` | read-only `/config` bridge: current-settings view from the CLI's three config files |
| `src/server.ts` | Hono routes (bootstrap, SSE, session CRUD, prompt, permissions, stubs) |
| `index.ts` | entry point |
