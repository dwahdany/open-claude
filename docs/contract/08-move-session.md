# 08 — `/move`: session move + project copies (git worktrees)

Pinned client: **opencode v1.17.19** (`vendor/opencode` at that tag). All citations are repo-relative `file:line`.

Scope: everything the TUI's `/move` palette command touches — the move dialog's data loads, the
"new copy" (git-worktree) create/delete flows, the actual session move, and the post-move state
the TUI expects (session fields + SSE). Companion docs: 03 (v1 writes), 04 (v2 reads), 02 (SSE
framing), 05 (Session data model).

---

## 0. TL;DR for the shim implementer

`/move` is palette command `session.move` ("Move session", slash `move`), always enabled
(`vendor/opencode/packages/tui/src/component/prompt/index.tsx:545-554` → `move.open()`); logic in
`vendor/opencode/packages/tui/src/component/prompt/move.tsx` + `component/dialog-move-session.tsx`.

Routes in play (none of them are under `/api/*` — see §1.1):

| # | Method + path | Called when | Blocking? |
|---|---|---|---|
| 1 | `POST /experimental/project/{projectID}/copy/refresh` | dialog opens / footer "refresh" / after delete | yes — first-load failure locks dialog with error view |
| 2 | `GET /project/{projectID}/directories` | right after every refresh (and at TUI boot via `project.sync()`) | yes — same |
| 3 | `GET /vcs/status?directory=…` | before moving (source dir), before force-delete | no — `.catch(() => undefined)`; `[]` ⇒ skip file-changes dialog |
| 4 | `POST /experimental/project/{projectID}/copy/generate-name` | "new" option chosen | yes (throwOnError) |
| 5 | `POST /experimental/project/{projectID}/copy` | "new" option chosen | yes (throwOnError) |
| 6 | `GET /path?directory=<newCopyDir>` | right after 5, to bootstrap the new location | yes (throwOnError) |
| 7 | `POST /experimental/control-plane/move-session` | existing session + destination picked | yes (throwOnError) → toast on error |
| 8 | `POST /session/{sessionID}/prompt_async?directory=…` | right after 7 (synthetic `<system-reminder>` note) | no — `.catch(() => undefined)` |
| 9 | `DELETE /experimental/project/{projectID}/copy` | footer "delete" on a strategy row | no — error toast; `forceRequired` triggers confirm + retry with `force:true` |
| 10 | `POST /session?directory=…` | home route only: first prompt submit after a destination was picked | yes |

Minimum for the dialog to *open and function* against our shim: routes 1 (204), 2 (JSON array),
3 (`[]` — already stubbed). Everything else is needed only when the user actually moves/creates/
deletes. After a successful move the TUI expects the **`session.next.moved`** SSE event (§3.2) —
without it the session header/store keeps the old directory.

---

## 1. Transport conventions specific to this flow

### 1.1 "v2" namespace ≠ `/api` prefix

`sdk.client.v2.projectCopy.*` lives on the v2 namespace object (`vendor/opencode/packages/sdk/js/src/v2/gen/sdk.gen.ts:7071-7074`)
but its generated URLs are **`/experimental/project/{projectID}/copy…`** — no `/api` prefix
(sdk.gen.ts:6905,6945,6983). Same story for `sdk.client.experimental.*` (`/experimental/...`,
sdk.gen.ts:648,958) and the plain namespaces (`/path`, `/vcs/status`, `/project/...`,
`/session/...`). Each generated method has its absolute path baked in; the `/api` prefix exists
only on the routes generated from the protocol package (04-reads-v2.md §1). **Register all routes
in this doc at their literal paths, not under `/api`.**

### 1.2 Query/body/header split

- The v2 client's GET-only header→query rewrite (04-reads-v2.md §1.2) applies here too: GETs
  (`/path`, `/vcs/status`, `/project/{id}/directories`) may carry `?directory=` injected from the
  attach `--dir` header; explicitly-passed params win (`client.ts:34-38` — `if (!url.searchParams.has(query))`).
  Non-GET requests keep `x-opencode-directory` (URI-encoded) if the TUI was attached with `--dir`.
- The projectCopy endpoints declare an explicit **`location` query object**, serialized deepObject
  style: `?location[directory]=<dir>&location[workspace]=<id>` (`{ in: "query", key: "location" }`
  sdk.gen.ts:6893,6935,6973; serializer style `vendor/opencode/packages/sdk/js/src/v2/gen/client/utils.gen.ts:265-273`;
  schema `vendor/opencode/packages/protocol/src/groups/location.ts:5-27`). The TUI passes
  `location: { directory: sdk.directory }` — `sdk.directory` is the attach `--dir` value and may be
  `undefined`, in which case the param is omitted entirely (move.tsx:43, dialog-move-session.tsx:78,227,249).
- Everything else on these routes is a JSON body (`Content-Type: application/json`).

### 1.3 Error body dialects on these routes

These are **v1-dialect** errors (`{name, data:{…}}`), not v2 `_tag` errors:

| Error | Status | Body | Source |
|---|---|---|---|
| `ProjectCopyError` | 400 | `{"name":"ProjectCopyError","data":{"message":string,"forceRequired"?:boolean}}` | `vendor/opencode/packages/protocol/src/groups/project-copy.ts:9-18`; mapping `vendor/opencode/packages/server/src/handlers/project-copy.ts:42-68` |
| `MoveSessionError` | 400 | `{"name":"MoveSessionError","data":{"message":string}}` | `vendor/opencode/packages/opencode/src/server/routes/instance/httpapi/groups/control-plane.ts:9-17` |
| `BadRequest` (generate-name) | 400 | `{"name":"BadRequest","data":{"message":string,"kind"?:…}}` | types.gen.ts:7084-7090 |

The TUI *reads* `error.data.forceRequired` structurally (`"data" in result.error && result.error.data.forceRequired`,
dialog-move-session.tsx:235) — get that nesting exactly right. Toast messages come from the
error-interceptor chain `body.data.message → body.message → body.name` (04-reads-v2.md §1.4).

---

## 2. The TUI flow, traced

### 2.1 Opening the dialog (both cases)

`move.open()` (move.tsx:68-102) requires `input.projectID()` = `project.project()` = the `id` from
`GET /project/current` (prompt/index.tsx:211; context/project.tsx:49,78-80). **If our
`/project/current` returns no `id`, `/move` silently no-ops.**

`DialogMoveSession` mounts and immediately loads (dialog-move-session.tsx:73-92):

1. `POST /experimental/project/{projectID}/copy/refresh?location[directory]=<sdk.directory>` (throwOnError)
2. `GET /project/{projectID}/directories` (throwOnError)

Both fail ⇒ if there is no previously-shown list, a locked inline error view
("Could not load project directories", dialog-move-session.tsx:96,302-312); a failed *re*-refresh
keeps the stale list interactive. Additionally, when the dialog's `projectID` differs from the
project context's (not the normal case), it calls `GET /project/current` once to find the current
checkout (dialog-move-session.tsx:60-67); failures are swallowed.

The dialog's `current` marker (move.tsx:76-89): for an existing session it is
`{type:"directory", directory: session.directory, subdirectory: !!session.path}`. On the home route
the `HomeSessionDestination` provider is mounted and its memo always yields a value — the pending
selection, else `{directory: sync.path.directory || paths.cwd, subdirectory: false}`
(session-destination.tsx:26-29, where `sync.path` is the `GET /path` object cached by
`project.sync()`, context/project.tsx:40-48,81-88 / sync.tsx:562-563). The
`{directory: /path.directory, subdirectory: /path.directory !== /path.worktree}` fallback in
move.tsx:84-88 only applies with no session and no provider.

Option list construction (dialog-move-session.tsx:112-184): rows = directories response
(roots, sorted current-first, then strategy-less before strategy rows) **plus** synthesized
subdirectory rows from the v1 session store: every session of this project with a non-trivial
`path` (`session.path && ![".","/"]​.includes(session.path)`) contributes its `directory` under its
longest containing root (dialog-move-session.tsx:128-142). Selecting a row yields
`MoveSessionSelection = {type:"directory", directory, subdirectory: directory !== root.directory} | {type:"new"}`
(dialog-move-session.tsx:22,174-178). Footer actions: `new`, `delete`
(disabled unless the row is a root **with** `strategy`, dialog-move-session.tsx:328-336), `refresh`
(refetch = steps 1+2 again).

### 2.2 Existing session: `moveExistingSession(sessionID, selection)` (move.tsx:117-161)

Exact call order:

1. `GET /vcs/status?directory=<session.directory>` — `.catch(() => undefined)`.
2. `status?.data?.length ? await DialogWorkspaceFileChanges.show(dialog, status.data) : "no"`
   (move.tsx:120). **An empty array (or any error) skips the dialog and fixes `choice = "no"` ⇒
   `moveChanges: false`.** Dialog options are exactly `"no" | "yes"`; Esc resolves `undefined` ⇒
   whole move aborts (dialog-workspace-file-changes.tsx:12-14,133-144; move.tsx:121).
3. If `selection.type === "new"` → the create-copy subflow (§2.4) with `context` = session title +
   last 6 messages' text parts joined by newlines (move.tsx:104-115,123). Its failure toasts
   "Creating workspace failed" and aborts.
4. `POST /experimental/control-plane/move-session` body
   `{"sessionID": "...", "destination": {"directory": "<chosen>"}, "moveChanges": choice === "yes"}`
   (throwOnError → toast via `toast.error`). Note `selection.subdirectory` is **not sent** — the
   server derives it (§3.1).
5. `POST /session/{sessionID}/prompt_async?directory=<chosen>` body
   `{"noReply": true, "parts": [{"type":"text","text":"<system-reminder>The user has changed the current working directory to \"<dir>\". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>","synthetic":true}]}`
   (move.tsx:14-16,139-152; `directory` is a query param, `noReply`/`parts` body —
   sdk.gen.ts:4095-4148, url :4139). Errors ignored.

### 2.3 Home route (no session yet)

`onSelect` just stores the selection in the `HomeSessionDestination` context and closes the dialog
(move.tsx:91-97; routes/home/session-destination.tsx:13-37). **No HTTP happens at selection time
for `type:"directory"`.** When the first prompt is submitted (prompt/index.tsx:991-1022):

1. `const directory = await move.getDirectory(store.prompt.input)` (prompt/index.tsx:995;
   move.tsx:166-173) — `type:"directory"` returns the stored directory as-is; `type:"new"` runs the
   create-copy subflow (§2.4) with the prompt text as naming `context`.
2. `POST /session?directory=<directory>` body `{agent, model:{id,providerID,variant?}, workspaceID?}`
   — **the chosen directory travels as the `directory` query param of session create**
   (sdk.gen.ts:3410-3457 — `{ in: "query", key: "directory" }` at :3435, url `/session` at :3449).
3. The normal first `POST /session/{id}/prompt` (or `/command`, `/shell`) follows. **No
   move-session call and no reminder part on this path** — the session is born in the right
   directory. `homeDestination` is cleared in `finishSubmit()` (move.tsx:179-183).

### 2.4 Create-copy subflow (`create(context?)`, move.tsx:30-66)

1. `POST /experimental/project/{projectID}/copy/generate-name` body `{"context": "<text or undefined>"}`
   (throwOnError) → `{"name": "<slug>"}`.
2. `POST /experimental/project/{projectID}/copy?location[directory]=<sdk.directory>` body
   `{"strategy": "git_worktree", "directory": "<paths.worktree>/<projectID.slice(0,6)>", "name": "<generated>"}`
   (throwOnError) → `{"directory": "<absolute copy dir>"}` — missing `directory` in the response
   throws "No project copy directory returned" (move.tsx:50-51).
3. `GET /path?directory=<copyDir>` (throwOnError) — comment in source: "Call a location-based route
   to make sure it's bootstrapped before moving on" (move.tsx:53-55). Only the 200 matters; the
   body is unused here.

**Where `paths.worktree` comes from — it is NOT `GET /path`.** `useTuiPaths()` is fed with
client-local process values at TUI startup: `{cwd: process.cwd(), home: global.home, state: global.state, worktree: global.data + "/worktree"}`
(`vendor/opencode/packages/tui/src/app.tsx:256-262`; type `tui/src/context/runtime.tsx:3-8`), where
`global.data` = `<xdg-data>/opencode` (e.g. `~/.local/share/opencode`,
`vendor/opencode/packages/core/src/global.ts:10-31`). So new copies land at
`~/.local/share/opencode/worktree/<projectID first 6 chars>/<name>` **computed on the client** and
passed to the server in the create body (`directory` = the *parent* dir; the server appends the
name, §4.2). The `worktree` field of `GET /path` is a different concept (the instance's project
root, §2.6-item-8) — don't conflate them.

### 2.5 Delete-copy subflow (`remove(option)`, dialog-move-session.tsx:210-280)

Only for roots with `strategy` (guard :211-215 — `if (!root?.strategy) return`). Two-step confirm
(first press marks, second press executes), then:

1. `DELETE /experimental/project/{projectID}/copy?location[directory]=<sdk.directory>` body
   `{"directory": "<row dir>", "force": false}` (no throwOnError; result checked structurally).
2. On 400 with `data.forceRequired: true`: `GET /vcs/status?directory=<row dir>` (catch→undefined) →
   `DialogWorkspaceFileChanges.show(…, {title:"Delete working copy?", message:"This working copy has file changes. Do you want to delete it anyway?"})`
   → if "yes", the same `DELETE` with `"force": true` (:246-253). Any other error → toast
   "Failed to delete project copy".
3. On success: `refetch()` (refresh + directories again). If the deleted copy was the current one:
   fall back to `project.data.project.mainDir` = the **last strategy-less row** of the directories
   response (`directories.data.findLast(item => item.strategy === undefined)?.directory`,
   context/project.tsx:51) — on the session route it navigates home (:193-208).

---

## 3. Endpoint contracts

### 3.1 `POST /experimental/control-plane/move-session`

- Client: `sdk.client.experimental.controlPlane.moveSession({sessionID, destination, moveChanges})` —
  sdk.gen.ts:617-658 (url :648). All three fields in body (:636-638). No query, no path params.
- Server route: `vendor/opencode/packages/opencode/src/server/routes/instance/httpapi/groups/control-plane.ts:19-35`;
  handler `…/handlers/control-plane.ts:8-28`; service `vendor/opencode/packages/core/src/control-plane/move-session.ts`.
- Request body (`MoveSession.Input`, move-session.ts:16-26; wire type types.gen.ts:7190-7199):

```jsonc
{
  "sessionID": "ses_…",                         // required, SessionID
  "destination": { "directory": "/abs/path" },  // required; MoveSessionDestination = { directory: string } (types.gen.ts:3029-3031)
  "moveChanges": true                            // optional boolean
}
```

- Success: **204 No Content** (types.gen.ts:7211-7216). Errors: **400**
  `{"name":"MoveSessionError","data":{"message":…}}` (or `InvalidRequestError` for malformed bodies;
  types.gen.ts:7201-7206). Handler message mapping (handlers/control-plane.ts:30-37):
  - session unknown → `"Session not found: <id>"`
  - destination resolves to a different project → `"Destination directory belongs to another project"`
  - patch apply failed → `"Unable to apply your changes in the destination directory. The files may conflict with existing changes."`
  - capture/reset failures → underlying git message (e.g. `"Source is not a Git repository"`).
- Reference semantics (move-session.ts:77-138), in order:
  1. Load session; **no-op 204** if `session.location.directory === destination.directory` (:81).
  2. `project.resolve(source dir)` and `project.resolve(destination dir)`; destination project id
     must equal `session.projectID` (:83-87). Project identity = git remote-URL hash ?? cached
     `<gitCommonDir>/opencode` file ?? first root-commit sha; no repo ⇒ `"global"`
     (`vendor/opencode/packages/core/src/project.ts:110-122`). Git worktrees share the common dir ⇒
     same project id — that's why worktree copies are always valid destinations.
  3. `moveChanges` is only honored when the *resolved project roots differ*
     (`input.moveChanges && source.directory !== destination.directory`, :89) — moving between
     subdirectories of one checkout never transfers changes. When honored: capture a patch from the
     source (`git diff --binary HEAD -- <scope>` + per-untracked-file `git diff --binary --no-index -- /dev/null <file>`,
     `vendor/opencode/packages/core/src/git.ts:729-787`), apply it at the destination (`git apply -`
     with the patch on stdin, cwd = destination, git.ts:789-814).
  4. Publish `SessionEvent.Moved` (§3.2) — note: published **before** source cleanup.
  5. If a patch was moved: discard source changes — `git checkout -- <scope>` (index preserved) then
     `git clean -fd -- <scope>` (git.ts:816-853 via move-session.ts:113-137).

### 3.2 Post-move state + SSE (what the TUI needs to see)

- Server-side session mutation (projector `vendor/opencode/packages/core/src/session/projector.ts:243-258`):
  `directory = destination.directory`, `path = subdirectory`, `workspace_id`, `time_updated = event timestamp`,
  plus a session-context-epoch reset (next prompt rebuilds instruction context for the new cwd).
  `subdirectory = path.relative(resolvedProjectRoot, destination.directory)` with `/` separators
  (move-session.ts:109) — **empty string when the destination is the project root** (so
  `session.path` is `""`/falsy at a root, a non-empty relative path like `"packages/tui"` in a
  subdirectory). That is exactly what the dialog's `subdirectory` booleans mirror client-side; the
  flag itself is never sent over the wire.
- SSE: the TUI updates its session store from **`session.next.moved`** on `/global/event`
  (sync.tsx:294-308 sets `session.directory/path/workspaceID/time.updated`). Payload (event schema
  `vendor/opencode/packages/schema/src/session-event.ts:76-85`; wire type `EventSessionNextMoved`,
  types.gen.ts:6268-6277):

```jsonc
// inside the GlobalEvent envelope {directory, payload:{…}} — see 02-events.md
{
  "id": "evt_…",
  "type": "session.next.moved",
  "properties": {
    "timestamp": 1760000000000,                 // epoch ms
    "sessionID": "ses_…",
    "location": { "directory": "/new/dir" },    // LocationRef; workspaceID? optional
    "subdirectory": ""                          // relative path from project root; "" at root
  }
}
```

  A full-info `session.updated` (`{properties:{info: Session}}`, sync.tsx:279-292) would also
  reconcile the store, but `session.next.moved` is what the reference server emits and is the
  targeted contract. Emit it *after* replying 204 (ordering vs. the reply is not observed, but the
  store update is what un-sticks the header/cwd display).

### 3.3 `POST /experimental/project/{projectID}/copy/refresh`

- Client: `sdk.client.v2.projectCopy.refresh({projectID, location})` — sdk.gen.ts:6957-6987
  (url :6983). Path param `projectID`; query `location[directory]`/`location[workspace]` (optional);
  **no body**.
- Protocol: `vendor/opencode/packages/protocol/src/groups/project-copy.ts:46-54`; handler
  `vendor/opencode/packages/server/src/handlers/project-copy.ts:32-38`.
- Success: **204 No Content** (types.gen.ts:13574-13579). Errors: 400 `ProjectCopyError` (§1.3) or
  `InvalidRequestError`.
- Reference semantics (`ProjectCopy.refresh`, `vendor/opencode/packages/core/src/project/copy.ts:215-270`):
  1. Read all stored rows for the project; stat each directory (`exists`).
  2. For every **strategy-less row that exists** (a "source" checkout), run each registered
     strategy's `list()` — for `git_worktree` that is `git worktree list --porcelain` from the
     discovered repo, first `worktree ` line = `main`, rest = `linked`
     (`copy-strategies.ts:23-33`, git.ts:912-923).
  3. Upsert discovered dirs: main worktree → `strategy: undefined`, linked worktrees →
     `strategy: "git_worktree"` (`behavior: "replace"`).
  4. Delete rows whose directory no longer exists on disk (prunes stale copies).
  5. If anything changed, publish event `project.directories.updated` `{projectID}`
     (`vendor/opencode/packages/schema/src/project-directories.ts:6-10`) — **the v1.17.19 TUI does
     not subscribe to it** (grep: no handler in tui/src), so a shim may skip emitting it.
- Equivalent shell semantics for our shim: `git worktree list --porcelain` in the project root;
  add rows for linked worktrees, drop rows for missing dirs.
- Also: the reference runs one refresh automatically after instance boot (copy.ts:110-126).

### 3.4 `POST /experimental/project/{projectID}/copy` (create)

- Client: `sdk.client.v2.projectCopy.create({projectID, location, strategy, directory, name})` —
  sdk.gen.ts:6916-6955 (url :6945). Path `projectID`; query `location`; body
  `{"strategy": string, "directory": AbsolutePath, "name"?: string}` (types.gen.ts:13515-13531 —
  note `strategy`/`directory` required in the payload schema, protocol groups/project-copy.ts:21).
  TUI always sends `strategy: "git_worktree"`, `directory` = client-computed **parent** dir (§2.4),
  `name` = generated slug.
- Success: **200** `{"directory": "/abs/copy/dir"}` (`ProjectCopy.Copy`, types.gen.ts:6145-6147).
  Errors: 400 `ProjectCopyError` — messages from handlers/project-copy.ts:57-68
  (`"Project copy source not found: …"`, `"Project copy destination already exists: …"`,
  `"Project copy directory unavailable: …"`, `"Invalid project copy directory: …"`,
  `"Project copy strategy unavailable: …"`, or the git error message).
- Reference semantics (copy.ts:172-199 + handler): `sourceDirectory` is **not client-supplied** —
  the handler injects the request-location's project directory
  (`location.project.directory`, `vendor/opencode/packages/server/src/handlers/project-copy.ts:12-23`);
  the source must already be a known project directory row. Then:
  `mkdir -p <directory>`; final copy dir = `<directory>/<name>` (suffix `-2`, `-3`, … up to 10 when
  taken, copy.ts:176-183); strategy create = `git worktree add --detach <copyDir> HEAD` run in the
  source repo (git.ts:879-896 — detached HEAD, no branch); insert row
  `{directory: <canonical copyDir>, strategy: "git_worktree"}`; publish `project.directories.updated`.
  Response directory is the **canonical resolved** path (symlinks resolved — macOS `/tmp` etc.).
- Only registered strategy at this tag: `"git_worktree"` (copy.ts:154-155, copy-strategies.ts:11).
  Unknown strategy value ⇒ 400 `StrategyUnavailableError` message.

### 3.5 `DELETE /experimental/project/{projectID}/copy` (remove)

- Client: `sdk.client.v2.projectCopy.remove({projectID, location, directory, force})` —
  sdk.gen.ts:6875-6914 (url :6905). **A DELETE with a JSON body** `{"directory": string, "force": boolean}`
  (both required, types.gen.ts:13480-13494); query `location`.
- Success: **204**. Errors: 400 `ProjectCopyError`; the load-bearing one is
  `{"name":"ProjectCopyError","data":{"message":…,"forceRequired":true}}` — set `forceRequired` iff
  a non-forced remove failed because the worktree is dirty. Reference detection: `git worktree remove <dir>`
  stderr matching `/contains modified or untracked files|is dirty/i` (git.ts:855-877, mapping
  handlers/project-copy.ts:50).
- Reference semantics (copy.ts:201-213): row must exist **and have a `strategy`** (else 400
  `"Invalid project copy directory: …"`); run `git worktree remove [--force] <dir>` with cwd =
  the repo's common dir (git.ts:898-910); delete the row; publish `project.directories.updated`.

### 3.6 `POST /experimental/project/{projectID}/copy/generate-name`

- Client: `sdk.client.experimental.projectCopy.generateName({projectID, context})` —
  sdk.gen.ts:925-968 (url :958). Path `projectID`; body `{"context"?: string}`; optional
  `directory`/`workspace` query (TUI doesn't pass them; attach `--dir` header stays on this POST).
- Route: `…/httpapi/groups/project-copy.ts:15-26`; handler `…/httpapi/handlers/project-copy.ts:20-74`.
- Success: **200** `{"name": string}` (types.gen.ts:8876-8883). Errors: 400 `BadRequest`.
- Reference semantics: asks the provider's *small* model to
  `"Generate a short 2-3 word name that describes this task:\n<context>"`, slugifies
  (lowercase, `[^a-z0-9]+`→`-`, trim `-`, max 3 words); **any failure or empty context falls back
  to a random slug** (`Slug.create()`), and even total failure returns 200 with a random slug
  (handlers/project-copy.ts:62-72). Shim may simply return a random `adjective-noun` slug.

### 3.7 `GET /project/{projectID}/directories`

- Client: `sdk.client.project.directories({projectID})` — sdk.gen.ts:2669-2694 (url :2690).
  Optional `?directory=`/`?workspace=` (workspace passed by `project.sync()`, not by the dialog).
- Route: `…/httpapi/groups/project.ts:65-75`; handler `…/httpapi/handlers/project.ts:52-54` →
  `ProjectDirectories.list` (`vendor/opencode/packages/core/src/project/directories.ts:100-109`,
  ordered `time_created` desc, then directory asc).
- Success: **200** bare JSON array (no envelope):

```ts
// types.gen.ts:3842-3845 (verbatim) — element has NO name field
export type ProjectDirectories = Array<{
  directory: string     // absolute path
  strategy?: string     // "git_worktree" for managed copies; absent for source checkouts
}>
```

- Semantics of `strategy`: only value produced at this tag is `"git_worktree"` (open string for
  future/plugin strategies). **A strategy-less row is a plain source checkout** — inserted whenever
  a project is opened at a directory (`saveProjectDirectory`,
  `vendor/opencode/packages/opencode/src/project/project.ts:195-211`) or discovered as a main
  worktree during refresh. The dialog only enables delete for rows **with** `strategy`
  (dialog-move-session.tsx:328-336) and uses the **last strategy-less row** as `mainDir` fallback
  (context/project.tsx:51).
- Called at TUI boot too (project.sync(), context/project.tsx:44-46) — our current stub
  `[{ "directory": store.directory }]` (src/server.ts:46) is shape-correct: one strategy-less root.

### 3.8 `GET /vcs/status`

- Client: `sdk.client.vcs.status({directory})` — sdk.gen.ts:2057-2080 (url :2076). `?directory=`
  scopes it: the move flow passes the **session's current directory** (move.tsx:119), the delete
  flow passes the **copy's directory** (dialog-move-session.tsx:236).
- Route: `…/httpapi/groups/instance.ts:94-103`; handler `…/handlers/instance.ts:47-49` →
  `Vcs.status` (`vendor/opencode/packages/opencode/src/project/vcs.ts:348-372`): non-git project ⇒
  `[]`; else changed-file list (porcelain status) merged with `git diff --numstat HEAD` counts,
  untracked files stat'ed individually, sorted by file name.
- Success: **200** bare array of

```ts
// types.gen.ts:2311-2316 (verbatim)
export type VcsFileStatus = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}
```

- **Confirmed:** returning `[]` suppresses `DialogWorkspaceFileChanges` and forces
  `moveChanges: false` (move.tsx:120 — `status?.data?.length ? await …show(…) : "no"`); in the
  delete flow it just renders an empty file list inside the force-confirm dialog (that dialog is
  driven by the `forceRequired` error, not by status).

### 3.9 `GET /path`

- Client: `sdk.client.path.get({directory})` — sdk.gen.ts:1957-1987 (url :1982).
- Route: `…/httpapi/groups/instance.ts:18-24,72-82`; handler `…/handlers/instance.ts:29-38`:

```ts
// reference response — Path (types.gen.ts:2298-2304)
{
  home:      Global.Path.home,     // server-side $HOME
  state:     Global.Path.state,    // <xdg-state>/opencode
  config:    Global.Path.config,   // <xdg-config>/opencode
  worktree:  ctx.worktree,         // resolved project ROOT for the request's location
  directory: ctx.directory,        // the resolved request directory itself
}
```

- Fields the TUI actually consumes: `project.sync()` stores the whole object (context/project.tsx:48);
  readers are `instance.directory()` (= `.directory`) and `instance.path().worktree` — used for the
  home-route current marker (`subdirectory = directory !== worktree`, move.tsx:87) and the v1
  session-list `path` filter (`path.relative(worktree, directory)`, sync.tsx:154-162). In the move
  flow the extra `GET /path?directory=<newCopy>` call is a **bootstrap ping**: only the 200 status
  matters (move.tsx:53-55). `useTuiPaths()` is *not* fed from this route (§2.4).
- Our shim today (src/server.ts:34-42) returns `worktree: store.directory, directory: store.directory`
  and ignores `?directory=`. For move support it must (a) answer 200 for any known directory
  (including fresh worktree copies), (b) keep `worktree` = project root and `directory` = the
  requested (or default) directory so the `subdirectory` math and session-list filter stay truthful.

---

## 4. Copy-paste minimal shim responses

`DIR` = project root; `COPYDIR` = created worktree path.

```
POST /experimental/project/{pid}/copy/refresh            → 204 (empty body)
GET  /project/{pid}/directories                          → 200 [ {"directory": DIR}, {"directory": COPYDIR, "strategy": "git_worktree"} ]
GET  /vcs/status?directory=…                             → 200 []                       (skips file-changes dialog ⇒ moveChanges=false)
POST /experimental/project/{pid}/copy/generate-name      → 200 {"name":"brave-otter"}
POST /experimental/project/{pid}/copy                    → 200 {"directory": COPYDIR}   | 400 {"name":"ProjectCopyError","data":{"message":"…"}}
GET  /path?directory=COPYDIR                             → 200 {"home":…,"state":…,"config":…,"worktree":…,"directory":COPYDIR}
POST /experimental/control-plane/move-session            → 204                          | 400 {"name":"MoveSessionError","data":{"message":"…"}}
POST /session/{sid}/prompt_async?directory=…             → (existing prompt_async route; failures tolerated)
DELETE /experimental/project/{pid}/copy                  → 204 | 400 {"name":"ProjectCopyError","data":{"message":"…","forceRequired":true}}
```

Plus SSE after a successful move:

```
data: {"directory":"<newDir>","payload":{"id":"evt_…","type":"session.next.moved","properties":{"timestamp":<now>,"sessionID":"ses_…","location":{"directory":"<newDir>"},"subdirectory":""}}}
```

---

## 5. open-claude implementation notes

*(Pre-implementation analysis, kept for the tradeoff rationale — §6 documents what actually
shipped and where it deviates.)*

What we must implement vs. can stub for `/move` to function end-to-end:

1. **Must: `POST /experimental/control-plane/move-session`.** Update the session record's
   `directory` (+ `path` = relative subdir from project root, `time.updated`), emit
   `session.next.moved`, and point the session's engine at the new cwd (recreate/resume the SDK
   session with the new working directory — same lever as session persistence work). Validate the
   destination exists; return 400 `MoveSessionError` otherwise. `moveChanges` can be a follow-up:
   `git diff --binary HEAD` + `ls-files --others` capture at source, `git apply -` at destination,
   `git checkout -- . && git clean -fd` at source — or initially reject `moveChanges:true` with a
   clear 400 message; the TUI only sends `true` if the user explicitly picked "yes".
2. **Must: `POST …/copy/refresh` → 204.** Real behavior can be `git worktree list --porcelain` +
   prune; a bare 204 no-op is enough for the dialog to open.
3. **Must: `GET /project/{pid}/directories`** listing at least the strategy-less root (already
   stubbed, src/server.ts:46) — add `strategy:"git_worktree"` rows for worktrees we create/discover
   so they're selectable and deletable.
4. **Should: copy create + generate-name + delete** for the "new" option:
   generate-name = random slug (200 guaranteed, §3.6); create = `git worktree add --detach
   <parent>/<name> HEAD` (parent comes from the request body; suffix on collision) → 200
   `{directory}`; delete = `git worktree remove [--force]` with `forceRequired:true` on dirty. If we
   skip these, "new" fails with a toast but directory-to-directory moves still work.
5. **Can stub: `GET /vcs/status` → `[]`** (already stubbed, src/server.ts:57). Verified consequence:
   file-changes dialog never appears and `moveChanges` is always `false` (§3.8) — acceptable until
   we implement real status. Once we return real non-empty status, users can pick "yes" ⇒
   move-session must then honor `moveChanges` (or 400).
6. **`GET /path` must accept `?directory=`** and 200 for any directory we consider valid (it is the
   post-create bootstrap probe). Keep `worktree` = project root; per-request `directory` echo.
7. **`POST /session` must honor its `directory` query param** (home-route destination) and
   `POST /session/{id}/prompt_async` must tolerate a `directory` query param + `noReply`/synthetic
   text part (the move reminder): accept, store the message, **do not** trigger an assistant reply.
8. **`GET /project/current` must return an `id`** or `/move` no-ops silently (§2.1).
9. Paths must be canonical and byte-stable across `/path`, `/project/current`, directories rows,
   session `directory` fields, and the `session.next.moved` payload — the dialog does exact string
   comparisons (`contains`/`===`) for the current marker and delete guard.

---

## 6. Shim implementation status & deviations (implemented; verified by test/live-move.ts)

Everything in §3 is implemented (src/server.ts "project copies + /move" section, git plumbing
in src/vcs.ts, copy records + move mutation in src/store.ts). Where the shim deviates from or
narrows the reference:

1. **`generate-name` makes NO LLM call.** Deterministic adjective-noun slug seeded off an
   FNV-1a hash of `context` (same task text → same suggestion), random slug when context is
   absent/empty. Always 200 — the reference also always-200s with a random-slug fallback.
2. **Single-project shim: no project-identity check on move.** The reference resolves both
   directories to projects and rejects cross-project moves (`"Destination directory belongs to
   another project"`). The shim serves exactly one project, so any EXISTING destination
   directory is accepted; a missing one → 400 `"Destination directory does not exist: <dir>"`.
   Validation messages otherwise follow the reference (`"Session not found: <id>"`,
   `"Source is not a Git repository"`, the verbatim apply-conflict message).
3. **Copy records persist in `project.json`** (state root, 07 §13):
   `{id, directory, copies: [{directory, strategy, time}]}` — copies survive restarts even
   with zero sessions in them. Writes are ATOMIC (tmp + rename) and serialized through one
   writer queue — a torn file would cost the once-forever projectID — and `Store.load`
   parse-guards the file: corruption degrades to a logged fresh-id rewrite, never a boot
   crash. `GET /project/{pid}/directories` = primary (strategy-less) +
   persisted copy rows + distinct live-session directories, deduped in that order.
   `copy/refresh` prunes rows whose directory vanished and upserts linked worktrees from
   `git worktree list --porcelain` run in the PRIMARY checkout only (first entry = main → not
   a copy). `project.directories.updated` is never emitted (the v1.17.19 TUI ignores it, §3.3).
4. **Move sequence** (order matters): interrupt + dispose a live engine, then wait ~250 ms for
   CLI teardown to stop appending to the transcript → capture/apply `moveChanges` (only when
   the two `rev-parse --show-toplevel` roots differ; apply failure aborts the move with the
   reference message and cleans up NOTHING) → relocate the Claude transcript → store mutation →
   events → source cleanup (`checkout -- <scope>` + `clean -fd -- <scope>`), matching the
   reference's capture → apply → publish → cleanup order. The next prompt lazily restarts the
   engine, which reads the NEW cwd from the store and resumes via the stored Claude uuid.
5. **Transcript relocation** (probe ground truth in test/probe-cross-cwd-resume.ts): copy
   `~/.claude/projects/<munge(realpath(old))>/<uuid>.jsonl` (+ the `<uuid>/` sibling dir —
   subagent transcripts) into `<munge(realpath(new))>/`. If the jsonl is not at the expected
   munged path, one bounded scan of `~/.claude/projects/*/` finds it. A missing transcript is
   logged and tolerated — the resume-not-found self-heal (07 §13) starts the session fresh.
   Source/destination handling depends on uuid ownership (`RelocateMode`, src/vcs.ts): a
   session and its not-yet-prompted forks share ONE uuid (07 §13 fork mapping), so
   - sole owner → **move** (delete the source copies; both alive = silent divergent fork);
   - owner whose uuid an unprompted fork still inherits → **copy** (source stays as the
     fork's resume seed; a stale same-uuid file at the destination is overwritten);
   - `forkPending` mover → **seed** (source stays — it belongs to the fork's source session —
     and an existing destination file is never clobbered: it may be the owner's live
     transcript). The seed is read once by the fork's first `resume` + `forkSession` init
     (which mints the fork its own uuid) and then abandoned in place — a small tolerated
     residue.
6. **`session.path` derivation**: owning root = longest of (primary, copy directories) that
   string-contains the destination; `path` = destination relative to it (`""` at a root). A
   destination under no known root is its own root → `path: ""`. Dual-emit on success:
   `session.updated` (full info) AND `session.next.moved`, both with the NEW directory in the
   SSE envelope.
7. **`GET /vcs/status` is real** (§3.8): porcelain status joined with `diff --numstat HEAD`
   counts — untracked → `"added"` with 0/0 (the reference stats untracked files individually;
   the shim reports 0/0 where unknown, also for binary). Non-git or missing directory → `[]`.
8. **`GET /path`** (§3.9): `directory` = requested `?directory=` (or primary); `worktree` =
   the directory's OWNING ROOT — longest of (primary, copy dirs) string-containing it, the
   same rule as `session.path` derivation — falling back to `rev-parse --show-toplevel`,
   then to the directory itself. The owning-root-first order is deliberate: the primary
   attach dir is always its own worktree (`worktree === directory`) even when it sits inside
   a bigger git repo or was given as a non-canonical/symlinked `--directory`, so the TUI's
   session-list filter (`path = relative(worktree, directory)`, sync.tsx:154-162) stays `""`
   (inactive) for the primary. Subdirectory answers stay truthful (`worktree` = the owning
   root) for the dialog's `subdirectory = directory !== worktree` math. Belt-and-braces, the
   v1 list filter also implements the reference's legacy fallback
   `(path IS NULL AND directory = :directory)` (09 §3.1) so path-less sessions remain
   visible under an active `?path=` filter.
9. **Copy create canonicalizes early**: the parent is realpath'd BEFORE `git worktree add` so
   the porcelain list, the stored record, and the 200 `{directory}` are byte-identical
   (macOS `/tmp` symlink). Collision suffixes `-2`..`-10` per §3.4; only `git_worktree` is
   accepted (`"Project copy strategy unavailable: …"` otherwise).
10. **Security**: request-supplied paths are never interpolated into shell strings — every git
    invocation is an argv array (`Bun.spawn(["git", ...])`), patches ride stdin.
