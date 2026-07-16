// In-memory state + SSE emission + disk persistence. Critical invariant (docs/contract/07 §10):
// every mutation that emits an SSE event ALSO updates the stored state, because the TUI
// re-fetches GET /session/{id}/message on session open/reconnect and must see identical state.
//
// Persistence (docs/contract/07 §13): state root is
//   (XDG_DATA_HOME | ~/.local/share)/open-claude/project/<munge(realpath(primaryDirectory))>/
// with project.json {id, directory, copies} (projectID minted once, stable forever —
// /project/current must match Session.projectID across restarts; copies are the managed
// git-worktree rows of doc 08, persisted so they survive restarts even with zero sessions
// in them) and session/<id>.json snapshots. Hydration on
// boot writes straight into the private maps — NEVER through the emitting mutations — so a
// connected TUI does not get the entire history replayed over SSE. `busy` is transient and
// never persisted; every session loads idle.

import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Bus } from "./bus"
import { Id } from "./ids"
import { emptyTokens } from "./types"
import type { AssistantMessage, Message, Part, PermissionRequest, Session, Todo, UserMessage, WithParts } from "./types"

interface SessionState {
  session: Session
  messages: Map<string, WithParts>
  order: string[] // message ids, ascending
  todos: Todo[]
  busy: boolean // transient — never persisted
  claudeSessionId?: string // Claude session UUID from system/init — the resume key
  forkPending?: boolean // next engine start must pass forkSession: true (set by fork copies)
}

// On-disk shape of session/<id>.json. The order array is implicit in `messages`.
interface SessionFile {
  session: Session
  messages: WithParts[]
  todos: Todo[]
  claudeSessionId?: string
  forkPending?: boolean
}

/** Same rule the Claude CLI uses for ~/.claude/projects: every non-alphanumeric char → "-". */
export const munge = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "-")

/** Global (cross-project) launch defaults, persisted in settings.json under the data root. */
export interface GlobalDefaults {
  model?: string // "providerID/modelID"
  agent?: string
}

/** Managed project-copy row (doc 08 §3.7): only strategy at this tag is "git_worktree". */
export interface CopyRecord {
  directory: string
  strategy: string
  time: number
}

export class Store {
  readonly bus: Bus
  readonly directory: string
  readonly projectID: string
  private readonly stateDir: string
  private sessions = new Map<string, SessionState>()
  private copies: CopyRecord[] = []
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private projectFlush: Promise<void> = Promise.resolve() // serializes project.json writers
  private settingsFlush: Promise<void> = Promise.resolve() // serializes settings.json writers

  private constructor(directory: string, projectID: string, stateDir: string) {
    this.directory = directory
    this.projectID = projectID
    this.stateDir = stateDir
    this.bus = new Bus(directory)
  }

  /** Async boot factory: resolves the state dir, loads project.json + every session file
   *  BEFORE the server starts. Must be the only way to construct a Store. */
  static async load(directory: string): Promise<Store> {
    let real = directory
    try {
      real = realpathSync(directory)
    } catch {
      /* directory not on disk yet — key state off the raw path */
    }
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const stateDir = join(dataHome, "open-claude", "project", munge(real))
    mkdirSync(join(stateDir, "session"), { recursive: true })

    // project.json is load-bearing (the once-forever projectID) and parse-GUARDED: a corrupt
    // file (external tampering, a pre-atomic-write tear) must degrade to a fresh id + atomic
    // rewrite, never to a boot-time crash.
    const projectFile = Bun.file(join(stateDir, "project.json"))
    let projectID: string | undefined
    let copies: CopyRecord[] = []
    if (await projectFile.exists()) {
      try {
        const data = (await projectFile.json()) as { id?: unknown; copies?: unknown }
        if (typeof data.id === "string" && data.id) projectID = data.id
        else console.error("open-claude: project.json has no valid id — minting a fresh projectID")
        if (Array.isArray(data.copies)) copies = data.copies as CopyRecord[]
      } catch (err) {
        console.error("open-claude: unreadable project.json — minting a fresh projectID:", err)
      }
    }

    const store = new Store(directory, projectID ?? Id.project(), stateDir)
    store.copies = copies
    if (!projectID) await store.persistProject() // first boot or healed corruption: write-through
    for (const f of readdirSync(join(stateDir, "session"))) {
      if (!f.endsWith(".json")) continue
      try {
        const data = (await Bun.file(join(stateDir, "session", f)).json()) as SessionFile
        const messages = new Map<string, WithParts>()
        const order: string[] = []
        for (const wp of data.messages ?? []) {
          messages.set(wp.info.id, wp)
          order.push(wp.info.id)
        }
        store.sessions.set(data.session.id, {
          session: data.session,
          messages,
          order,
          todos: data.todos ?? [],
          busy: false,
          claudeSessionId: data.claudeSessionId,
          forkPending: data.forkPending,
        })
      } catch (err) {
        console.error(`open-claude: skipping unreadable session file ${f}:`, err)
      }
    }
    store.installExitFlush()
    return store
  }

  // ---- persistence ----

  private sessionFile(id: string): string {
    return join(this.stateDir, "session", `${id}.json`)
  }

  private serialize(st: SessionState): string {
    const data: SessionFile = {
      session: st.session,
      messages: st.order.map((mid) => st.messages.get(mid)!).filter(Boolean),
      todos: st.todos,
      claudeSessionId: st.claudeSessionId,
      forkPending: st.forkPending,
    }
    return JSON.stringify(data)
  }

  private markDirty(id: string): void {
    this.dirty.add(id)
    // Trailing throttle, not a resetting debounce: a steady stream of mutations must still
    // hit disk. The first mutation arms one ~300ms timer; everything dirtied meanwhile
    // flushes together.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flushDirty()
      }, 300)
    }
  }

  private async flushDirty(): Promise<void> {
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const st = this.sessions.get(id)
      if (!st) continue // deleted since it was dirtied
      const path = this.sessionFile(id)
      try {
        await Bun.write(path + ".tmp", this.serialize(st))
        await rename(path + ".tmp", path) // atomic swap — readers never see a torn file
      } catch (err) {
        // Persistence is best-effort: flush I/O failures (ENOSPC, EACCES, dir unmounted) must
        // never escape the void-ed timer call — Bun kills the process on unhandled rejections,
        // taking every live session with it. Keep the id dirty so the next mutation or the
        // exit flush retries; deliberately no self-armed timer (a permanently broken disk
        // would busy-loop every 300ms).
        this.dirty.add(id)
        console.error(`open-claude: failed to persist session ${id}:`, err)
      }
    }
  }

  private installExitFlush(): void {
    // Exit path cannot await: node:fs sync writes are the only way to guarantee the bytes
    // land before the process dies (Bun.write is async-only). Sync fs is acceptable ONLY here.
    const flushSync = () => {
      for (const id of this.dirty) {
        const st = this.sessions.get(id)
        if (!st) continue
        const path = this.sessionFile(id)
        try {
          writeFileSync(path + ".tmp", this.serialize(st))
          renameSync(path + ".tmp", path)
        } catch {
          /* best effort on the way out */
        }
      }
      this.dirty.clear()
    }
    process.on("exit", flushSync)
    process.on("SIGINT", () => {
      flushSync()
      process.exit(130)
    })
    process.on("SIGTERM", () => {
      flushSync()
      process.exit(143)
    })
  }

  /** Session-scoped events carry the owning session's directory in the SSE envelope. */
  private emit(sessionID: string, type: string, properties: Record<string, unknown>): void {
    this.bus.publish(type, properties, this.sessions.get(sessionID)?.session.directory)
  }

  // ---- project copies (doc 08 §3.3-3.5,3.7; persisted in project.json) ----

  listCopies(): CopyRecord[] {
    return [...this.copies]
  }

  /** Insert-or-replace a managed copy row by exact directory (paths are byte-stable per
   *  doc 08 note 9). Awaited by callers — the record must survive an immediate restart. */
  async upsertCopy(directory: string, strategy: string): Promise<void> {
    const existing = this.copies.find((r) => r.directory === directory)
    if (existing) {
      if (existing.strategy === strategy) return
      existing.strategy = strategy
    } else {
      this.copies.push({ directory, strategy, time: Date.now() })
    }
    await this.persistProject()
  }

  async removeCopy(directory: string): Promise<boolean> {
    const before = this.copies.length
    this.copies = this.copies.filter((r) => r.directory !== directory)
    if (this.copies.length === before) return false
    await this.persistProject()
    return true
  }

  /** Atomic + serialized project.json write-through. The projectID is minted once and must
   *  survive any crash (doc 07 §13): tmp + rename so a torn file can never exist on disk,
   *  one writer at a time so concurrent copy mutations cannot interleave whole-file writes.
   *  Best-effort like the session flush — failures log, never throw (callers await). */
  private persistProject(): Promise<void> {
    const path = join(this.stateDir, "project.json")
    const next = this.projectFlush
      .then(async () => {
        await Bun.write(path + ".tmp", JSON.stringify({ id: this.projectID, directory: this.directory, copies: this.copies }))
        await rename(path + ".tmp", path)
      })
      .catch((err) => {
        console.error("open-claude: failed to persist project.json:", err)
      })
    this.projectFlush = next
    return next
  }

  // ---- global settings (settings.json at the data root, shared by every project) ----

  /** Resolved per call, not cached at load: tests re-point XDG_DATA_HOME, and the file is
   *  shared across concurrently running instances. */
  static settingsFile(): string {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    return join(dataHome, "open-claude", "settings.json")
  }

  private static async readSettings(): Promise<Record<string, unknown>> {
    try {
      const data = await Bun.file(Store.settingsFile()).json()
      if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>
    } catch {
      /* missing or corrupt — treated as empty, healed by the next write */
    }
    return {}
  }

  /** Fresh disk read every call: /config and /agent are served from this, and a sibling
   *  instance (another project's server) may have updated the launch defaults since boot. */
  async globalDefaults(): Promise<GlobalDefaults> {
    const d = (await Store.readSettings()).defaults as Record<string, unknown> | undefined
    return {
      model: typeof d?.model === "string" ? d.model : undefined,
      agent: typeof d?.agent === "string" ? d.agent : undefined,
    }
  }

  /** Merge-persist the launch defaults (undefined fields keep their stored value). Same
   *  discipline as project.json: serialized writers, tmp + rename, log-never-throw —
   *  callers fire-and-forget from the prompt path. Read-merge-write against the live file
   *  so two projects' servers converge on last-writer-wins instead of clobbering whole
   *  files, and unchanged values skip the write entirely. */
  noteDefaults(patch: GlobalDefaults): Promise<void> {
    const next = this.settingsFlush
      .then(async () => {
        const settings = await Store.readSettings()
        const prev = (settings.defaults ?? {}) as Record<string, unknown>
        const defaults = { ...prev }
        if (patch.model !== undefined) defaults.model = patch.model
        if (patch.agent !== undefined) defaults.agent = patch.agent
        if (defaults.model === prev.model && defaults.agent === prev.agent) return
        const path = Store.settingsFile()
        await Bun.write(path + ".tmp", JSON.stringify({ ...settings, defaults }, null, 2))
        await rename(path + ".tmp", path)
      })
      .catch((err) => {
        console.error("open-claude: failed to persist settings.json:", err)
      })
    this.settingsFlush = next
    return next
  }

  // ---- sessions ----

  createSession(opts: {
    agent?: string
    model?: { id: string; providerID: string; variant?: string }
    title?: string
    parentID?: string
    id?: string
    directory?: string
    path?: string
  }): Session {
    const now = Date.now()
    const session: Session = {
      id: opts.id ?? Id.session(),
      slug: Math.random().toString(36).slice(2, 10),
      projectID: this.projectID,
      directory: opts.directory ?? this.directory,
      title: opts.title ?? "New session",
      version: "1.17.19",
      parentID: opts.parentID,
      cost: 0,
      tokens: emptyTokens(),
      agent: opts.agent,
      model: opts.model,
      time: { created: now, updated: now },
    }
    if (opts.path !== undefined) session.path = opts.path
    this.sessions.set(session.id, { session, messages: new Map(), order: [], todos: [], busy: false })
    this.markDirty(session.id)
    // TUI has no session.created handler; session.updated inserts into stores.
    this.emit(session.id, "session.updated", { sessionID: session.id, info: session })
    return session
  }

  /** Real fork (03-writes-v1.md §8.1): sibling copy with fresh ascending ids. The deep copy is
   *  SILENT (only the new session is announced) — the TUI re-fetches messages on navigate. */
  forkSession(srcID: string): Session | undefined {
    const src = this.sessions.get(srcID)
    if (!src) return undefined
    const s = src.session
    const forked = this.createSession({ agent: s.agent, model: s.model, title: s.title, directory: s.directory, path: s.path })
    const st = this.sessions.get(forked.id)!
    // Generate replacement ids sequentially in source order so ascending-id ordering (which
    // the TUI sorts by) is preserved; remap sessionID/messageID/parentID references.
    const msgIdMap = new Map<string, string>()
    for (const mid of src.order) {
      const wp = src.messages.get(mid)
      if (!wp) continue
      const newID = Id.message()
      msgIdMap.set(mid, newID)
      const info = structuredClone(wp.info) as Message
      info.id = newID
      info.sessionID = forked.id
      if (info.role === "assistant" && msgIdMap.has(info.parentID)) info.parentID = msgIdMap.get(info.parentID)!
      const parts = wp.parts.map((p) => {
        const np = structuredClone(p)
        np.id = Id.part()
        np.sessionID = forked.id
        np.messageID = newID
        return np
      })
      st.messages.set(newID, { info, parts })
      st.order.push(newID)
    }
    st.todos = structuredClone(src.todos)
    // The fork inherits the source's Claude uuid; forkPending makes the fork's first engine
    // start pass forkSession: true, and its first init's NEW uuid replaces this one.
    st.claudeSessionId = src.claudeSessionId
    st.forkPending = true
    this.markDirty(forked.id)
    return forked
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
    this.markDirty(id)
    this.emit(id, "session.updated", { sessionID: id, info: st.session })
  }

  /** /move mutation (doc 08 §3.1-3.2): directory + path (destination relative to its owning
   *  root, "" at a root) + time.updated, then DUAL-emit — the session.updated the store
   *  mutation always produces AND the targeted session.next.moved. Envelope directory is the
   *  NEW directory for both (emit() reads the already-mutated session). */
  moveSession(id: string, directory: string, path: string): void {
    const st = this.sessions.get(id)
    if (!st) return
    st.session.directory = directory
    st.session.path = path
    st.session.time.updated = Date.now()
    this.markDirty(id)
    this.emit(id, "session.updated", { sessionID: id, info: st.session })
    this.emit(id, "session.next.moved", { timestamp: Date.now(), sessionID: id, location: { directory }, subdirectory: path })
  }

  deleteSession(id: string): boolean {
    const st = this.sessions.get(id)
    if (!st) return false
    this.sessions.delete(id)
    this.dirty.delete(id)
    rmSync(this.sessionFile(id), { force: true })
    // session.deleted MUST carry info (09 §3.5); session is already unmapped, so pass its
    // directory explicitly.
    this.bus.publish("session.deleted", { sessionID: id, info: st.session }, st.session.directory)
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
    // Unchanged value → publish nothing: a double finishTurn (result + consume finally)
    // must not re-emit session.status idle + session.idle for an already-idle session.
    if (!st || st.busy === busy) return
    st.busy = busy // transient — deliberately NOT persisted
    this.emit(id, "session.status", { sessionID: id, status: { type: busy ? "busy" : "idle" } })
    if (!busy) this.emit(id, "session.idle", { sessionID: id })
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

  // ---- Claude session-id capture (engine resume state) ----

  resumeInfo(id: string): { claudeSessionId?: string; forkPending?: boolean } {
    const st = this.sessions.get(id)
    return { claudeSessionId: st?.claudeSessionId, forkPending: st?.forkPending }
  }

  /** SILENT mutation (persists, publishes nothing): capture/replace the Claude session UUID.
   *  init re-fires at the start of every turn (CLI 2.1.207) so this no-ops when unchanged;
   *  any write clears forkPending (the fork's first init replaces the inherited uuid).
   *  Pass undefined to clear a stale uuid (resume-not-found fallback). */
  setClaudeSessionId(id: string, uuid: string | undefined): void {
    const st = this.sessions.get(id)
    if (!st) return
    if (st.claudeSessionId === uuid && !st.forkPending) return
    st.claudeSessionId = uuid
    st.forkPending = undefined
    this.markDirty(id)
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
    this.markDirty(sessionID)
    this.emit(sessionID, "message.updated", { sessionID, info })
  }

  updateMessage(sessionID: string, info: Message): void {
    const st = this.ensure(sessionID)
    const wp = st.messages.get(info.id)
    if (wp) wp.info = info
    this.markDirty(sessionID)
    this.emit(sessionID, "message.updated", { sessionID, info })
  }

  putPart(sessionID: string, part: Part): void {
    const st = this.ensure(sessionID)
    const wp = st.messages.get(part.messageID)
    if (wp) {
      const idx = wp.parts.findIndex((p) => p.id === part.id)
      if (idx >= 0) wp.parts[idx] = part
      else wp.parts.push(part)
    }
    this.markDirty(sessionID)
    this.emit(sessionID, "message.part.updated", { sessionID, part, time: Date.now() })
  }

  delta(sessionID: string, messageID: string, partID: string, delta: string): void {
    // No markDirty: the engine mutates the shared part object and re-putParts it at block
    // end — deltas are an SSE-only optimization (05 §5).
    this.emit(sessionID, "message.part.delta", { sessionID, messageID, partID, field: "text", delta })
  }

  setTodos(sessionID: string, todos: Todo[]): void {
    const st = this.ensure(sessionID)
    st.todos = todos
    this.markDirty(sessionID)
    this.emit(sessionID, "todo.updated", { sessionID, todos })
  }

  error(sessionID: string, error: { name: string; data: Record<string, unknown> }): void {
    this.emit(sessionID, "session.error", { sessionID, error })
  }

  // ---- factories ----

  newUserMessage(sessionID: string, agent: string, model: { providerID: string; modelID: string; variant?: string }): UserMessage {
    return { id: Id.message(), sessionID, role: "user", time: { created: Date.now() }, agent, model }
  }

  newAssistantMessage(sessionID: string, parentID: string, agent: string, providerID: string, modelID: string, variant?: string): AssistantMessage {
    // path derives from the OWNING session's directory, not the server's primary one.
    const dir = this.sessions.get(sessionID)?.session.directory ?? this.directory
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
      path: { cwd: dir, root: dir },
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
