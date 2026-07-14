// In-memory state + SSE emission. Critical invariant (docs/contract/07 §10): every mutation
// that emits an SSE event ALSO updates the stored state, because the TUI re-fetches
// GET /session/{id}/message on session open/reconnect and must see identical state.

import { Bus } from "./bus"
import { Id } from "./ids"
import { emptyTokens } from "./types"
import type { AssistantMessage, Message, Part, PermissionRequest, Session, Todo, UserMessage, WithParts } from "./types"

interface SessionState {
  session: Session
  messages: Map<string, WithParts>
  order: string[] // message ids, ascending
  todos: Todo[]
  busy: boolean
}

export class Store {
  readonly bus: Bus
  readonly directory: string
  readonly projectID: string
  private sessions = new Map<string, SessionState>()

  constructor(directory: string, projectID: string) {
    this.directory = directory
    this.projectID = projectID
    this.bus = new Bus(directory)
  }

  // ---- sessions ----

  createSession(opts: { agent?: string; model?: { id: string; providerID: string; variant?: string }; title?: string; parentID?: string; id?: string }): Session {
    const now = Date.now()
    const session: Session = {
      id: opts.id ?? Id.session(),
      slug: Math.random().toString(36).slice(2, 10),
      projectID: this.projectID,
      directory: this.directory,
      title: opts.title ?? "New session",
      version: "1.17.19",
      parentID: opts.parentID,
      cost: 0,
      tokens: emptyTokens(),
      agent: opts.agent,
      model: opts.model,
      time: { created: now, updated: now },
    }
    this.sessions.set(session.id, { session, messages: new Map(), order: [], todos: [], busy: false })
    // TUI has no session.created handler; session.updated inserts into stores.
    this.bus.publish("session.updated", { sessionID: session.id, info: session })
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)?.session
  }

  listSessions(): Session[] {
    return [...this.sessions.values()].map((s) => s.session)
  }

  touchSession(id: string, patch: Partial<Session>): void {
    const st = this.sessions.get(id)
    if (!st) return
    Object.assign(st.session, patch)
    st.session.time.updated = Date.now()
    this.bus.publish("session.updated", { sessionID: id, info: st.session })
  }

  deleteSession(id: string): boolean {
    const st = this.sessions.get(id)
    if (!st) return false
    this.sessions.delete(id)
    this.bus.publish("session.deleted", { sessionID: id, info: st.session })
    return true
  }

  messages(id: string): WithParts[] {
    const st = this.sessions.get(id)
    if (!st) return []
    return st.order.map((mid) => st.messages.get(mid)!).filter(Boolean)
  }

  todos(id: string): Todo[] {
    return this.sessions.get(id)?.todos ?? []
  }

  setBusy(id: string, busy: boolean): void {
    const st = this.sessions.get(id)
    if (!st) return
    st.busy = busy
    this.bus.publish("session.status", { sessionID: id, status: { type: busy ? "busy" : "idle" } })
    if (!busy) this.bus.publish("session.idle", { sessionID: id })
  }

  isBusy(id: string): boolean {
    return this.sessions.get(id)?.busy ?? false
  }

  status(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [id, st] of this.sessions) {
      if (st.busy) out[id] = { type: "busy" }
    }
    return out
  }

  // ---- messages & parts ----

  private ensure(sessionID: string): SessionState {
    const st = this.sessions.get(sessionID)
    if (!st) throw new Error(`unknown session ${sessionID}`)
    return st
  }

  addMessage(sessionID: string, info: Message): void {
    const st = this.ensure(sessionID)
    st.messages.set(info.id, { info, parts: [] })
    st.order.push(info.id)
    this.bus.publish("message.updated", { sessionID, info })
  }

  updateMessage(sessionID: string, info: Message): void {
    const st = this.ensure(sessionID)
    const wp = st.messages.get(info.id)
    if (wp) wp.info = info
    this.bus.publish("message.updated", { sessionID, info })
  }

  putPart(sessionID: string, part: Part): void {
    const st = this.ensure(sessionID)
    const wp = st.messages.get(part.messageID)
    if (wp) {
      const idx = wp.parts.findIndex((p) => p.id === part.id)
      if (idx >= 0) wp.parts[idx] = part
      else wp.parts.push(part)
    }
    this.bus.publish("message.part.updated", { sessionID, part, time: Date.now() })
  }

  delta(sessionID: string, messageID: string, partID: string, delta: string): void {
    this.bus.publish("message.part.delta", { sessionID, messageID, partID, field: "text", delta })
  }

  setTodos(sessionID: string, todos: Todo[]): void {
    const st = this.ensure(sessionID)
    st.todos = todos
    this.bus.publish("todo.updated", { sessionID, todos })
  }

  error(sessionID: string, error: { name: string; data: Record<string, unknown> }): void {
    this.bus.publish("session.error", { sessionID, error })
  }

  // ---- factories ----

  newUserMessage(sessionID: string, agent: string, model: { providerID: string; modelID: string; variant?: string }): UserMessage {
    return { id: Id.message(), sessionID, role: "user", time: { created: Date.now() }, agent, model }
  }

  newAssistantMessage(sessionID: string, parentID: string, agent: string, providerID: string, modelID: string, variant?: string): AssistantMessage {
    return {
      id: Id.message(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID,
      modelID,
      providerID,
      mode: agent,
      agent,
      path: { cwd: this.directory, root: this.directory },
      cost: 0,
      tokens: emptyTokens(),
      variant,
    }
  }

  newPart<T extends Omit<Part, "id" | "sessionID" | "messageID">>(sessionID: string, messageID: string, part: T): Part {
    return { id: Id.part(), sessionID, messageID, ...part } as Part
  }
}

export function newPermissionRequest(sessionID: string, permission: string, patterns: string[], always: string[], tool?: { messageID: string; callID: string }, metadata: Record<string, unknown> = {}): PermissionRequest {
  return { id: Id.permission(), sessionID, permission, patterns, metadata, always, tool }
}
