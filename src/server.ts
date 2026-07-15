// opencode-compatible HTTP/SSE server backed by the Claude Agent SDK.
// Contract: docs/contract/00-overview.md. Golden rules: JSON everywhere (never text/html),
// JSON 404 for unknown routes, list routes never empty-body, emit SSE side effects on writes.

import { Hono } from "hono"
import { AGENTS, CONFIG, CONFIG_PROVIDERS, DEFAULT_MODEL, PROVIDER_LIST } from "./catalog"
import { SessionEngine } from "./engine"
import { Id } from "./ids"
import { Store } from "./store"

function notFound(method: string, path: string) {
  return { name: "NotFoundError", data: { message: `route not implemented: ${method} ${path}` } }
}

export function createApp(store: Store) {
  const app = new Hono()
  const engines = new Map<string, SessionEngine>()

  const engineFor = (sessionID: string, agent: string): SessionEngine => {
    let e = engines.get(sessionID)
    if (!e) {
      e = new SessionEngine(store, sessionID, store.directory, agent)
      engines.set(sessionID, e)
    }
    return e
  }

  // ---- bootstrap (HARD) ----
  app.get("/config/providers", (c) => c.json(CONFIG_PROVIDERS))
  app.get("/provider", (c) => c.json(PROVIDER_LIST))
  app.get("/agent", (c) => c.json(AGENTS))
  app.get("/config", (c) => c.json(CONFIG))

  app.get("/path", (c) => {
    // A ?directory= query (per-session dirs) echoes back as both directory and worktree.
    const dir = c.req.query("directory") || store.directory
    return c.json({
      home: process.env.HOME ?? "",
      state: `${process.env.HOME ?? ""}/.local/state/opencode`,
      config: `${process.env.HOME ?? ""}/.config/opencode`,
      worktree: dir,
      directory: dir,
    })
  })
  // store.projectID is persisted (project.json) — stable across restarts, matches Session.projectID.
  app.get("/project/current", (c) =>
    c.json({ id: store.projectID, worktree: store.directory, vcs: "git", time: { created: Date.now(), updated: Date.now() }, sandboxes: [] }),
  )
  app.get("/project/:id/directories", (c) => {
    // Primary directory first, then every distinct live-session directory (no worktree strategy yet).
    const dirs = new Set<string>([store.directory])
    for (const s of store.listSessions()) dirs.add(s.directory)
    return c.json([...dirs].map((directory) => ({ directory })))
  })

  // ---- non-blocking bootstrap batch (SOFT: must resolve 200 JSON) ----
  app.get("/command", (c) => c.json([]))
  app.get("/lsp", (c) => c.json([]))
  app.get("/formatter", (c) => c.json([]))
  app.get("/mcp", (c) => c.json({}))
  app.get("/experimental/resource", (c) => c.json({}))
  app.get("/provider/auth", (c) => c.json({}))
  app.get("/vcs", (c) => c.json({ branch: "" }))
  app.get("/vcs/diff", (c) => c.json([]))
  app.get("/vcs/status", (c) => c.json([]))
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
        // equals-or-under; empty-string path (cwd == worktree root) matches everything
        list = list.filter((s) => s.path === path || (s.path !== undefined && s.path.startsWith(path + "/")))
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
      store.putPart(id, store.newPart(id, user.id, { type: "text", text, synthetic: true }))
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
      store.putPart(id, store.newPart(id, user.id, { type: "text", text, synthetic: true }))
    } else {
      void engineFor(id, agent).prompt(text, model, agent)
    }
    return c.body(null, 204)
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

  app.post("/session/:id/summarize", (c) => c.json(true))
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
