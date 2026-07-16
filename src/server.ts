// opencode-compatible HTTP/SSE server backed by the Claude Agent SDK.
// Contract: docs/contract/00-overview.md. Golden rules: JSON everywhere (never text/html),
// JSON 404 for unknown routes, list routes never empty-body, emit SSE side effects on writes.

import { Hono } from "hono"
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { AGENTS, CONFIG, CONFIG_PROVIDERS, DEFAULT_MODEL, PROVIDER_LIST } from "./catalog"
import { CommandCache } from "./commands"
import { configView } from "./config-view"
import { SessionEngine } from "./engine"
import { modelView } from "./model-view"
import { Id } from "./ids"
import { Store } from "./store"
import { applyChanges, captureChanges, cleanupSource, generateCopyName, gitToplevel, isDirtyWorktreeError, relocateTranscript, slugify, vcsStatus, worktreeAdd, worktreeList, worktreeRemove } from "./vcs"

function notFound(method: string, path: string) {
  return { name: "NotFoundError", data: { message: `route not implemented: ${method} ${path}` } }
}

export function createApp(store: Store) {
  const app = new Hono()
  const engines = new Map<string, SessionEngine>()
  // Slash-command cache (09 §4(b)): boot-warmed from a throwaway query; live engines
  // refresh it on commands_changed pushes.
  const commands = new CommandCache(store.directory)
  commands.warm()

  const engineFor = (sessionID: string, agent: string): SessionEngine => {
    let e = engines.get(sessionID)
    if (!e) {
      e = new SessionEngine(store, sessionID, store.directory, agent, (list) => commands.replace(list))
      engines.set(sessionID, e)
    }
    return e
  }

  // ---- bootstrap (HARD) ----
  app.get("/config/providers", (c) => c.json(CONFIG_PROVIDERS))
  app.get("/provider", (c) => c.json(PROVIDER_LIST))
  app.get("/agent", (c) => c.json(AGENTS))
  app.get("/config", (c) => c.json(CONFIG))

  /** Owning root = longest of (primary, copies) that string-contains the directory, or null.
   *  Exact string containment — paths are byte-stable across the API (doc 08 note 9). */
  const ownerRoot = (dir: string): string | null => {
    let owner = ""
    for (const root of [store.directory, ...store.listCopies().map((r) => r.directory)]) {
      if ((dir === root || dir.startsWith(root + "/")) && root.length > owner.length) owner = root
    }
    return owner || null
  }

  app.get("/path", async (c) => {
    // doc 08 §3.9 + §6.8: directory = the requested ?directory= (or primary); worktree = its
    // owning root (primary/copy) — this keeps worktree === directory for the PRIMARY attach
    // dir even when it sits inside a bigger git repo, so the TUI's session-list path filter
    // (relative(worktree, directory), sync.tsx:154-162) stays inactive there — else the git
    // toplevel, else the directory itself. The TUI also derives subdirectory =
    // directory !== worktree from this, so subdir answers must stay truthful.
    const dir = c.req.query("directory") || store.directory
    const worktree = ownerRoot(dir) ?? (await gitToplevel(dir)) ?? dir
    return c.json({
      home: process.env.HOME ?? "",
      state: `${process.env.HOME ?? ""}/.local/state/opencode`,
      config: `${process.env.HOME ?? ""}/.config/opencode`,
      worktree,
      directory: dir,
    })
  })
  // store.projectID is persisted (project.json) — stable across restarts, matches Session.projectID.
  app.get("/project/current", (c) =>
    c.json({ id: store.projectID, worktree: store.directory, vcs: "git", time: { created: Date.now(), updated: Date.now() }, sandboxes: [] }),
  )
  app.get("/project/:id/directories", (c) => {
    // doc 08 §3.7 — bare deduped array: primary (strategy-less) first, persisted copy rows
    // (strategy "git_worktree"), then any distinct live-session directory not already listed.
    const rows: { directory: string; strategy?: string }[] = []
    const seen = new Set<string>()
    const add = (directory: string, strategy?: string) => {
      if (seen.has(directory)) return
      seen.add(directory)
      rows.push(strategy ? { directory, strategy } : { directory })
    }
    add(store.directory)
    for (const copy of store.listCopies()) add(copy.directory, copy.strategy)
    for (const s of store.listSessions()) add(s.directory)
    return c.json(rows)
  })

  // ---- non-blocking bootstrap batch (SOFT: must resolve 200 JSON) ----
  // Real command list (09 §1): awaits the boot warm (cap ~15s inside list()), [] fallback.
  app.get("/command", async (c) => c.json(await commands.list()))
  app.get("/lsp", (c) => c.json([]))
  app.get("/formatter", (c) => c.json([]))
  app.get("/mcp", (c) => c.json({}))
  app.get("/experimental/resource", (c) => c.json({}))
  app.get("/provider/auth", (c) => c.json({}))
  app.get("/vcs", (c) => c.json({ branch: "" }))
  app.get("/vcs/diff", (c) => c.json([]))
  // REAL status (doc 08 §3.8): non-empty results are what gate the TUI's file-changes
  // dialog and therefore moveChanges:true on move-session. Non-git/missing dir → [].
  app.get("/vcs/status", async (c) => c.json(await vcsStatus(c.req.query("directory") || store.directory)))
  app.get("/experimental/workspace", (c) => c.json([]))
  app.get("/experimental/workspace/status", (c) => c.json([]))
  app.get("/experimental/capabilities", (c) => c.json({ backgroundSubagents: false }))
  app.get("/experimental/console", (c) => c.json({ consoleManagedProviders: [], switchableOrgCount: 0 }))
  app.get("/find/file", (c) => c.json([]))
  app.get("/global/health", (c) => c.json({ healthy: true, version: "1.17.19" }))

  // ---- v2 read stubs (envelope {location, data}) ----
  const location = () => ({ directory: store.directory })
  app.get("/api/location", (c) => c.json(location()))
  for (const r of ["agent", "command", "skill", "reference", "integration", "model", "provider"]) {
    app.get(`/api/${r}`, (c) => c.json({ location: location(), data: [] }))
  }
  app.get("/api/fs/find", (c) => c.json({ location: location(), data: [] }))
  app.get("/api/permission/saved", (c) => c.json({ data: [] }))

  // ---- SSE ----
  app.get("/global/event", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (frame: string) => {
          try {
            controller.enqueue(enc.encode(frame))
          } catch {
            /* closed */
          }
        }
        send(store.bus.connectedFrame())
        const sub = store.bus.subscribe(send)
        const heartbeat = setInterval(() => send(store.bus.heartbeatFrame()), 10_000)
        const signal = c.req.raw.signal
        const cleanup = () => {
          clearInterval(heartbeat)
          sub.unsubscribe()
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        signal.addEventListener("abort", cleanup)
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        Connection: "keep-alive",
      },
    })
  })

  // ---- project copies + /move (docs/contract/08-move-session.md) ----

  const copyError = (c: any, message: string, forceRequired?: boolean) =>
    c.json({ name: "ProjectCopyError", data: { message, ...(forceRequired ? { forceRequired: true } : {}) } }, 400)

  // Reconcile the copies list (§3.3): prune rows whose directory vanished, discover linked
  // worktrees of the PRIMARY repo (first porcelain entry = main checkout → not a copy).
  // A ?location[directory]= query may be present; it is ignored (single-project shim).
  app.post("/experimental/project/:projectID/copy/refresh", async (c) => {
    for (const copy of store.listCopies()) {
      if (!existsSync(copy.directory)) await store.removeCopy(copy.directory)
    }
    const worktrees = await worktreeList(store.directory) // [] when the primary is not a repo
    for (const dir of worktrees.slice(1)) await store.upsertCopy(dir, "git_worktree")
    return c.body(null, 204)
  })

  // ALWAYS 200 {name} (§3.6). No LLM call: deterministic adjective-noun slug seeded off the
  // context hash — the reference also always-200s with a random-slug fallback.
  app.post("/experimental/project/:projectID/copy/generate-name", async (c) => {
    const body = await safeBody(c)
    return c.json({ name: generateCopyName(typeof body.context === "string" ? body.context : undefined) })
  })

  // Create a git-worktree copy (§3.4): body {strategy, directory:<PARENT>, name} → 200
  // {directory:<canonical abs copy dir>}. Collision suffix -2..-10, detached HEAD.
  app.post("/experimental/project/:projectID/copy", async (c) => {
    const body = await safeBody(c)
    try {
      if (body.strategy !== "git_worktree") return copyError(c, `Project copy strategy unavailable: ${body.strategy}`)
      let parent = typeof body.directory === "string" ? body.directory : ""
      if (!parent.startsWith("/")) return copyError(c, `Invalid project copy directory: ${parent || "(missing)"}`)
      const slug = slugify(String(body.name ?? "")) || generateCopyName()
      mkdirSync(parent, { recursive: true })
      parent = realpathSync(parent) // canonical BEFORE worktree add so git records the same path we persist
      let copyDir: string | null = null
      for (let i = 1; i <= 10; i++) {
        const candidate = join(parent, i === 1 ? slug : `${slug}-${i}`)
        if (!existsSync(candidate)) {
          copyDir = candidate
          break
        }
      }
      if (!copyDir) return copyError(c, `Project copy destination already exists: ${join(parent, slug)}`)
      const res = await worktreeAdd(store.directory, copyDir)
      if (!res.ok) return copyError(c, res.stderr.trim() || "git worktree add failed")
      const directory = realpathSync(copyDir)
      await store.upsertCopy(directory, "git_worktree")
      return c.json({ directory })
    } catch (err) {
      return copyError(c, String(err))
    }
  })

  // Remove a copy (§3.5): DELETE with JSON body {directory, force}. A dirty worktree on a
  // non-forced remove → 400 with data.forceRequired:true (the TUI's confirm-and-retry cue).
  app.delete("/experimental/project/:projectID/copy", async (c) => {
    const body = await safeBody(c)
    const directory = typeof body.directory === "string" ? body.directory : ""
    const record = store.listCopies().find((r) => r.directory === directory)
    if (!record) return copyError(c, `Invalid project copy directory: ${directory || "(missing)"}`)
    const res = await worktreeRemove(store.directory, directory, body.force === true)
    if (!res.ok) return copyError(c, res.stderr.trim() || "git worktree remove failed", body.force !== true && isDirtyWorktreeError(res.stderr))
    await store.removeCopy(directory)
    return c.body(null, 204)
  })

  /** path = dest relative to its owning root ("" at a root, or when dest is its own root). */
  const subdirPath = (dest: string): string => {
    const owner = ownerRoot(dest)
    return owner && dest !== owner ? dest.slice(owner.length + 1) : ""
  }

  // Move a session (§3.1-3.2): stop the engine, optionally transfer uncommitted changes,
  // relocate the Claude transcript, mutate the session (dual-emits session.updated +
  // session.next.moved), THEN clean the source. 204 on success.
  app.post("/experimental/control-plane/move-session", async (c) => {
    const body = await safeBody(c)
    const moveError = (message: string) => c.json({ name: "MoveSessionError", data: { message } }, 400)
    const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
    const session = store.getSession(sessionID)
    if (!session) return moveError(`Session not found: ${sessionID}`)
    const destination = typeof body.destination?.directory === "string" ? body.destination.directory : ""
    if (!destination) return moveError("Destination directory is required")
    if (session.directory === destination) return c.body(null, 204) // silent no-op (§3.1 step 1)
    let destStat
    try {
      destStat = statSync(destination)
    } catch {
      /* missing */
    }
    if (!destStat?.isDirectory()) return moveError(`Destination directory does not exist: ${destination}`)
    const oldDirectory = session.directory

    // a. Stop a live engine BEFORE relocating files: CLI teardown keeps appending to the
    // transcript briefly, so give it ~250ms to settle.
    const engine = engines.get(sessionID)
    if (engine) {
      await engine.interrupt()
      engine.dispose()
      engines.delete(sessionID)
      await Bun.sleep(250)
    }

    // b. moveChanges only across DIFFERENT resolved roots (§3.1 step 3): capture at the
    // source, apply at the destination; cleanup is deferred until after the events (step 5).
    let cleanup: (() => Promise<void>) | null = null
    if (body.moveChanges === true) {
      const sourceRoot = await gitToplevel(oldDirectory)
      if (!sourceRoot) return moveError("Source is not a Git repository")
      const destRoot = (await gitToplevel(destination)) ?? destination
      if (sourceRoot !== destRoot) {
        // Scope = the session's subdirectory within its root, "." at the root itself.
        let scope: string
        try {
          scope = relative(sourceRoot, realpathSync(oldDirectory)) || "."
        } catch {
          scope = "."
        }
        const captured = await captureChanges(sourceRoot, scope)
        if (!captured.ok) return moveError(captured.message)
        if (captured.patch) {
          const applied = await applyChanges(destRoot, captured.patch)
          if (!applied.ok) return moveError("Unable to apply your changes in the destination directory. The files may conflict with existing changes.")
          cleanup = () => cleanupSource(sourceRoot, scope)
        }
      }
    }

    // c. Relocate the Claude transcript (resume is scoped to munge(realpath(cwd)) — probe
    // header in test/probe-cross-cwd-resume.ts). Missing transcript = log and continue.
    // SHARED-uuid guard: until a fork's first init re-uuids it, the fork and its source
    // share ONE transcript (store.forkSession) — moving that jsonl would strand the other
    // sharer's resume. forkPending mover → "seed"; owner another session still inherits
    // from → "copy"; sole owner → "move" (see RelocateMode in src/vcs.ts).
    const { claudeSessionId, forkPending } = store.resumeInfo(sessionID)
    if (claudeSessionId) {
      const shared = store.listSessions().some((s) => s.id !== sessionID && store.resumeInfo(s.id).claudeSessionId === claudeSessionId)
      relocateTranscript(claudeSessionId, oldDirectory, destination, forkPending ? "seed" : shared ? "copy" : "move")
    }

    // d+e. Mutate + dual-emit (session.updated + session.next.moved, new-dir envelopes).
    store.moveSession(sessionID, destination, subdirPath(destination))

    // Source cleanup ONLY after a successful apply AND after the events (§3.1 step 5).
    if (cleanup) await cleanup()
    return c.body(null, 204)
  })

  // ---- sessions ----

  // Directory resolution for creates (03-writes-v1.md §1.1): the TUI sends ?directory= as a
  // QUERY param (never in the body); writes without it carry the URI-encoded
  // x-opencode-directory header; else fall back to the server's primary directory.
  const resolveDirectory = (c: any): string => {
    const q = c.req.query("directory")
    if (q) return q
    const h = c.req.header("x-opencode-directory")
    if (h) {
      try {
        return decodeURIComponent(h)
      } catch {
        return h
      }
    }
    return store.directory
  }

  app.post("/session", async (c) => {
    const body = await safeBody(c)
    const session = store.createSession({
      agent: body.agent,
      model: body.model, // {id, providerID, variant?}
      title: body.title,
      parentID: body.parentID,
      id: body.id,
      directory: resolveDirectory(c),
    })
    return c.json(session)
  })

  // List semantics per docs/contract/09 §3.1: filters compose; sort by time.updated DESC
  // BEFORE the limit cut (default 100). All query params arrive as strings.
  app.get("/session", (c) => {
    const q = c.req.query()
    let list = store.listSessions()
    if (q.roots === "true") list = list.filter((s) => !s.parentID)
    if (q.scope !== "project") {
      const path = q.path
      if (path !== undefined && path !== "") {
        // equals-or-under, PLUS the reference's legacy fallback for rows without a stored
        // path — `(path IS NULL AND directory = :directory)` (09 §3.1): shim-created
        // sessions carry no path until they are moved, so without it a TUI whose path
        // filter is active would see an empty list. Empty-string path matches everything.
        list = list.filter((s) => s.path === path || (s.path !== undefined && s.path.startsWith(path + "/")) || (s.path === undefined && !!q.directory && s.directory === q.directory))
      } else if (path === undefined && q.directory) {
        list = list.filter((s) => s.directory === q.directory)
      }
    }
    if (q.search) {
      const needle = q.search.toLowerCase()
      list = list.filter((s) => s.title.toLowerCase().includes(needle)) // TITLE substring only
    }
    if (q.start) {
      const start = Number(q.start)
      if (Number.isFinite(start)) list = list.filter((s) => s.time.updated >= start)
    }
    list.sort((a, b) => b.time.updated - a.time.updated)
    const limit = Number(q.limit ?? "")
    return c.json(list.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 100))
  })

  // Busy-only map, {} when idle (09 §3.4). MUST register before /session/:id — Hono matches
  // in registration order, so the param route would otherwise capture id="status" and 404.
  app.get("/session/status", (c) => c.json(store.status()))

  app.get("/session/:id", (c) => {
    const s = store.getSession(c.req.param("id"))
    if (!s) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    return c.json(s)
  })

  app.get("/session/:id/message", (c) => c.json(store.messages(c.req.param("id"))))
  app.get("/session/:id/message/:mid", (c) => {
    const wp = store.messages(c.req.param("id")).find((m) => m.info.id === c.req.param("mid"))
    if (!wp) return c.json({ name: "NotFoundError", data: { message: "message not found" } }, 404)
    return c.json(wp)
  })
  app.get("/session/:id/todo", (c) => c.json(store.todos(c.req.param("id"))))
  app.get("/session/:id/diff", (c) => c.json([]))

  const resolveModel = (body: any, session: any) => {
    if (body.model?.modelID) return { providerID: body.model.providerID ?? "anthropic", modelID: body.model.modelID, variant: body.variant }
    if (session?.model?.id) return { providerID: session.model.providerID ?? "anthropic", modelID: session.model.id, variant: session.model.variant }
    return { providerID: "anthropic", modelID: DEFAULT_MODEL, variant: body.variant }
  }
  const textOf = (parts: any[]): string =>
    (parts ?? [])
      .filter((p) => p?.type === "text" && !p.synthetic && p.text)
      .map((p) => p.text)
      .join("\n\n")
  // noReply persists the message verbatim INCLUDING synthetic parts (the post-move reminder,
  // doc 08 §2.2 step 5); textOf strips synthetic only so they never re-prompt the model.
  const rawTextOf = (parts: any[]): string =>
    (parts ?? [])
      .filter((p) => p?.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n\n")

  app.post("/session/:id/message", async (c) => {
    const id = c.req.param("id")
    const session = store.getSession(id)
    if (!session) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    const body = await safeBody(c)
    const agent = body.agent ?? session.agent ?? "build"
    const model = resolveModel(body, session)
    const text = textOf(body.parts)
    const engine = engineFor(id, agent)
    if (body.noReply) {
      // Persist a user message without running the model.
      const user = store.newUserMessage(id, agent, model)
      store.addMessage(id, user)
      store.putPart(id, store.newPart(id, user.id, { type: "text", text: rawTextOf(body.parts), synthetic: true }))
      return c.json({ info: user, parts: store.messages(id).find((m) => m.info.id === user.id)?.parts ?? [] })
    }
    await engine.prompt(text, model, agent)
    // Return the final assistant message + its parts (TUI ignores this; other clients read it).
    const msgs = store.messages(id)
    const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant")
    return c.json(lastAssistant ?? { info: null, parts: [] })
  })

  app.post("/session/:id/prompt_async", async (c) => {
    const id = c.req.param("id")
    const session = store.getSession(id)
    if (!session) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    const body = await safeBody(c)
    const agent = body.agent ?? session.agent ?? "build"
    const model = resolveModel(body, session)
    const text = textOf(body.parts)
    if (body.noReply) {
      const user = store.newUserMessage(id, agent, model)
      store.addMessage(id, user)
      store.putPart(id, store.newPart(id, user.id, { type: "text", text: rawTextOf(body.parts), synthetic: true }))
    } else {
      void engineFor(id, agent).prompt(text, model, agent)
    }
    return c.body(null, 204)
  })

  // Custom-command execution (09 §2): validate the NAME against the cache, then run a
  // blocking turn whose text is the reconstructed slash invocation — the Claude CLI does its
  // own $ARGUMENTS/positional templating (do NOT re-implement 09 §2.2). "compact" routes to
  // the real compaction (same outcome as the palette's POST /summarize — 09 §5.7).
  app.post("/session/:id/command", async (c) => {
    const id = c.req.param("id")
    const session = store.getSession(id)
    if (!session) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    const body = await safeBody(c)
    const name = typeof body.command === "string" ? body.command : ""
    const agent = body.agent ?? session.agent ?? "build"
    // body.model is a "providerID/modelID" STRING split on the FIRST slash (09 §2.1);
    // fall back to the session model.
    const base = resolveModel({}, session)
    const slash = typeof body.model === "string" ? body.model.indexOf("/") : -1
    const model =
      slash > 0
        ? { providerID: body.model.slice(0, slash), modelID: body.model.slice(slash + 1), variant: body.variant }
        : { ...base, variant: body.variant ?? base.variant }
    const args = typeof body.arguments === "string" ? body.arguments : ""
    // Bare /config: render current settings from disk instead of forwarding — headless the
    // CLI can only print its usage dump (09 §6). Intercepted BEFORE the name validation so
    // it needs neither the command-cache warm nor an engine spawn ("config" is a CLI
    // built-in, always present). With args it still passes through and persists.
    if (name === "config" && !args.trim()) return c.json(await configView(store, id, model, agent))
    // /model (bare AND with args): read-only view (09 §6.2). The TUI's picker re-sends its
    // model with every prompt, so a CLI-side switch could never stick — it would only desync
    // the footer from what actually serves the turns (probe: test/probe-model-switch.ts).
    // "model" is deliberately NOT shadowed from GET /command, so the stock TUI always routes
    // it here rather than as prompt text the CLI would execute.
    if (name === "model") return c.json(modelView(store, id, model, agent, args.trim()))
    const list = await commands.list()
    if (!list.some((cmd) => cmd.name === name)) {
      // Reference behavior (09 §2.2 step 1): session.error SSE (the TUI toasts it) + 400
      // {"_tag":"BadRequest"} — never 404 for unknown NAMES.
      store.error(id, { name: "UnknownError", data: { message: `Command not found: "${name}". Available commands: ${list.map((x) => x.name).join(", ")}` } })
      return c.json({ _tag: "BadRequest" }, 400)
    }
    const engine = engineFor(id, agent)
    if (name === "compact") await engine.compact(args.trim() || undefined, model, agent)
    else await engine.prompt("/" + name + (args ? " " + args : ""), model, agent)
    // Respond like the message route: final assistant message + parts (TUI ignores it).
    const wp = [...store.messages(id)].reverse().find((m) => m.info.role === "assistant")
    return c.json(wp ?? { info: null, parts: [] })
  })

  app.post("/session/:id/abort", async (c) => {
    const e = engines.get(c.req.param("id"))
    if (e) await e.interrupt()
    return c.json(true)
  })

  app.delete("/session/:id", (c) => {
    const id = c.req.param("id")
    if (!store.getSession(id)) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    // Cascade CHILDREN-FIRST (09 §3.5); each deleteSession emits session.deleted {sessionID, info}
    // (info is required by both TUI consumers) and removes the disk record.
    const removeTree = (sid: string): void => {
      for (const child of store.listSessions().filter((s) => s.parentID === sid)) removeTree(child.id)
      engines.get(sid)?.dispose()
      engines.delete(sid)
      store.deleteSession(sid)
    }
    removeTree(id)
    return c.json(true)
  })

  app.patch("/session/:id", async (c) => {
    const id = c.req.param("id")
    if (!store.getSession(id)) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    const body = await safeBody(c)
    store.touchSession(id, { title: body.title })
    return c.json(store.getSession(id))
  })

  app.post("/session/:id/fork", async (c) => {
    // Body may carry {messageID} for a point-in-time fork; we still do a FULL fork for now
    // (the Claude-side transcript has no per-message cut on plain forkSession — limitation).
    await safeBody(c)
    const forked = store.forkSession(c.req.param("id"))
    if (!forked) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    return c.json(forked)
  })

  // Real compaction (09 §5): body {providerID, modelID, auto?} — the TUI's /compact palette
  // entry sends its selected model, fire-and-forget. BLOCKING like the reference (the
  // handler awaits the whole compact turn), then bare true.
  app.post("/session/:id/summarize", async (c) => {
    const id = c.req.param("id")
    const session = store.getSession(id)
    if (!session) return c.json({ name: "NotFoundError", data: { message: "session not found" } }, 404)
    const body = await safeBody(c)
    // Nothing to compact (no live engine AND no resumable CLI transcript): the reference
    // still answers true (it runs a degenerate summarize call on empty sessions — 09 §5.2);
    // we skip the pointless LLM round-trip and just return the same body.
    if (!engines.has(id) && !store.resumeInfo(id).claudeSessionId) return c.json(true)
    // Reference agent selection: the LAST user message's agent, else the default.
    const lastUser = [...store.messages(id)].reverse().find((m) => m.info.role === "user")
    const agent = (lastUser?.info as { agent?: string } | undefined)?.agent ?? session.agent ?? "build"
    const model =
      typeof body.modelID === "string" && body.modelID
        ? { providerID: typeof body.providerID === "string" && body.providerID ? body.providerID : "anthropic", modelID: body.modelID }
        : resolveModel({}, session)
    await engineFor(id, agent).compact(undefined, model, agent)
    return c.json(true)
  })
  app.post("/session/:id/share", (c) => c.json({ ...store.getSession(c.req.param("id")), share: { url: "" } }, 500))
  app.delete("/session/:id/share", (c) => c.json(store.getSession(c.req.param("id"))))

  // ---- permissions ----
  app.post("/permission/:requestID/reply", async (c) => {
    const requestID = c.req.param("requestID")
    const body = await safeBody(c)
    for (const e of engines.values()) {
      if (e.replyPermission(requestID, body.reply, body.message)) return c.json(true)
    }
    return c.json({ _tag: "PermissionNotFoundError", requestID, message: "permission not found" }, 404)
  })

  // ---- questions (AskUserQuestion bridge) ----
  app.get("/question", (c) => {
    const out = []
    for (const e of engines.values()) out.push(...e.pendingQuestionList())
    return c.json(out)
  })

  app.post("/question/:requestID/reply", async (c) => {
    const requestID = c.req.param("requestID")
    const body = await safeBody(c)
    const answers: string[][] = Array.isArray(body.answers) ? body.answers : []
    for (const e of engines.values()) {
      if (e.replyQuestion(requestID, answers)) return c.json(true)
    }
    return c.json({ _tag: "QuestionNotFoundError", requestID, message: "question not found" }, 404)
  })

  app.post("/question/:requestID/reject", (c) => {
    const requestID = c.req.param("requestID")
    for (const e of engines.values()) {
      if (e.rejectQuestion(requestID)) return c.json(true)
    }
    return c.json({ _tag: "QuestionNotFoundError", requestID, message: "question not found" }, 404)
  })

  // ---- benign stubs ----
  app.post("/instance/dispose", (c) => c.json(true))
  app.post("/log", (c) => c.json(true))

  // ---- 404 catch-all: JSON, never text/html (rule 2) ----
  app.notFound((c) => c.json(notFound(c.req.method, new URL(c.req.url).pathname), 404))
  app.onError((err, c) => c.json({ name: "UnknownError", data: { message: String(err) } }, 500))

  return app
}

async function safeBody(c: any): Promise<any> {
  try {
    const text = await c.req.text()
    if (!text) return {}
    return JSON.parse(text)
  } catch {
    return {}
  }
}
