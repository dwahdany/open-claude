// Per-session Claude Agent SDK bridge. One long-lived query() in streaming-input mode per
// session; maps SDK messages/stream events to opencode v1 SSE events + stored state.
// Contract: docs/contract/07-sdk-mapping.md §10.
//
// Subagents (Task/Agent tool, workflow agents): the CLI forwards their content as COMPLETE
// assistant/user messages with parent_tool_use_id set (never as partial stream events —
// verified with test/sdk-subagent-probe.ts). Each subagent is mirrored as an opencode child
// session (parentID set); the parent's task tool part gets state.metadata.sessionId, which is
// what the TUI reads to show live progress and navigate into the child transcript.

import { query, type EffortLevel, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import { Id } from "./ids"
import { newPermissionRequest, type Store } from "./store"
import { flattenToolResult, mapToolInput, mapToolName, toolMetadata, toolTitle } from "./tools"
import type { AssistantMessage, Part, QuestionInfo, QuestionRequest, ToolState, UserMessage } from "./types"

// Unbounded async queue used as the query()'s input iterable.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(msg: SDKUserMessage): void {
    const w = this.waiters.shift()
    if (w) w({ value: msg, done: false })
    else this.items.push(msg)
  }

  close(): void {
    this.closed = true
    let w: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])

/** Catalog variant keys are the Agent SDK effort levels plus "ultracode", which is not an
 *  effort: it maps to Settings.ultracode in startQuery/applyVariant (catalog.ts EFFORT_VARIANTS). */
export function variantEffort(variant?: string): EffortLevel | undefined {
  return variant && EFFORT_LEVELS.has(variant) ? (variant as EffortLevel) : undefined
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  mappedTool: string
}

interface PendingQuestion {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
  request: QuestionRequest
  notes: boolean // a synthetic trailing "Notes" question was appended to request.questions
}

// The stock TUI question dialog renders only {label, description} per option and has no
// notes affordance. Previews fold into the description (the TUI renders \n and word-wraps,
// but a dialog taller than the terminal bottom-clips with no scroll — hence a line budget
// per question, split across options that carry previews).
const PREVIEW_LINE_BUDGET = 24
const NOTES_HEADER = "Notes"
const NO_NOTE_LABEL = "No note"

/** Quote-bar each preview line under the description, clamped to maxLines. */
export function foldPreview(description: string, preview: string, maxLines: number): string {
  const lines = preview.trimEnd().split("\n")
  const shown = lines.length > maxLines ? lines.slice(0, Math.max(1, maxLines - 1)) : lines
  const quoted = shown.map((l) => `│ ${l}`)
  if (shown.length < lines.length) quoted.push(`│ … (+${lines.length - shown.length} more preview lines)`)
  return description ? `${description}\n${quoted.join("\n")}` : quoted.join("\n")
}

interface BlockCtx {
  partID: string
  kind: "text" | "reasoning" | "tool"
  raw: string // accumulated input_json_delta for tool blocks
  toolUseId?: string
}

type ToolPart = Extract<Part, { type: "tool" }>

interface ToolCtx {
  part: ToolPart // live ref, same object as in the store
  sessionID: string // session the part lives in (main or a child)
  input: Record<string, unknown>
  name: string
  start: number
  extraMeta?: Record<string, unknown> // task-link metadata (sessionId/parentSessionId/background)
}

interface ChildCtx {
  sessionID: string
  agent: string
  user: UserMessage | null
  assistant: AssistantMessage | null
  // Workflow runs never stream per-agent content over the SDK boundary; their child
  // transcript is a progress log built from task_progress/task_notification instead.
  isWorkflow?: boolean
  lastProgress?: string
}

export class SessionEngine {
  private input = new InputQueue()
  private q: Query | null = null
  private abort = new AbortController()
  private started = false
  private disposed = false
  private currentVariant: string | undefined
  private activeModelID = ""
  private activePermissionMode: Options["permissionMode"]
  private lastModel = { providerID: "anthropic", modelID: "" }
  private turnQueue: Promise<void> = Promise.resolve()

  // Per-turn state (main session)
  private assistant: AssistantMessage | null = null
  private turnDone: Deferred<void> | null = null
  private resultErrored = false // this turn already surfaced session.error from an error result
  // Active compaction — a manual /compact turn OR an unprompted auto-compact mid-turn.
  // Maps the CLI sequence onto the reference pair (09 §5): userID = the compaction user
  // message (carries the {type:"compaction"} part), assistant = the summary message.
  private compactCtx: { userID: string; assistant: AssistantMessage | null; postTokens?: number } | null = null
  private partObjs = new Map<string, Part>() // partID → live Part object (same ref as in store)
  private blocks = new Map<number, BlockCtx>() // content_block index → ctx (reset per step)
  private textAccum = new Map<string, string>()
  private stepTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

  // All tool calls (main turn + subagents), keyed by tool_use_id.
  private tools = new Map<string, ToolCtx>()

  // Subagent mirrors: parent_tool_use_id → child session; task_id → same ctx for task_* lifecycle.
  private children = new Map<string, ChildCtx>()
  private childrenByTask = new Map<string, ChildCtx>()

  // Permission + question bridges: request id → pending
  private pendingPermissions = new Map<string, PendingPermission>()
  private alwaysAllow = new Set<string>()
  private pendingQuestions = new Map<string, PendingQuestion>()

  constructor(
    private store: Store,
    private sessionID: string,
    private directory: string,
    private agent: string,
    private onCommandsChanged?: (commands: SlashCommand[]) => void, // commands_changed → server cache
  ) {}

  private startQuery(model: string, permissionMode: Options["permissionMode"], variant?: string): void {
    if (this.started) return
    this.started = true
    this.currentVariant = variant
    this.activeModelID = model
    this.activePermissionMode = permissionMode
    // cwd + resume state come from the store at (re)start time: sessions own their directory,
    // and a stored claudeSessionId enables lazy restart — a resumed query emits nothing until
    // the first pushed input (probe-resume finding 5), so arming resume here is free.
    const resume = this.store.resumeInfo(this.sessionID)
    const options: Options = {
      cwd: this.store.getSession(this.sessionID)?.directory ?? this.directory,
      model,
      permissionMode,
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true, // AI status lines on task_progress (workflows + bg subagents)
      abortController: this.abort,
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: (toolName, input, opts) => this.onCanUseTool(toolName, input, opts.toolUseID),
    }
    const effort = variantEffort(variant)
    if (effort) options.effort = effort
    if (resume.claudeSessionId) {
      options.resume = resume.claudeSessionId
      // Fork copies inherit the source's uuid; forkSession mints the fork its own on first init.
      if (resume.forkPending) options.forkSession = true
    }
    // Settings.ultracode = xhigh effort + standing workflow orchestration. The env var is a
    // standing override; the "ultracode" catalog variant opts in per session. Only takes
    // effect when the account has workflows enabled and the model supports xhigh.
    if (process.env.OPENCLAUDE_ULTRACODE === "1" || variant === "ultracode") options.settings = { ultracode: true }
    // OPENCLAUDE_SETTING_SOURCES=none ignores the user's ~/.claude allowlists, so every
    // gated tool routes through canUseTool (clean-room permission prompts). Default: load
    // the user's settings, matching normal Claude Code behavior.
    if (process.env.OPENCLAUDE_SETTING_SOURCES === "none") options.settingSources = []
    this.q = query({ prompt: this.input, options })
    void this.consume()
  }

  /**
   * Mid-session variant changes ride the flag-settings layer (there is no Query.setEffort).
   * Settings.effortLevel has no 'max' member, so 'max' picked after the first turn clamps
   * to 'xhigh'. "ultracode" rides Settings.ultracode instead of an effort level; null clears
   * a key back to lower-precedence sources, so the default (no variant) resets both. With
   * OPENCLAUDE_ULTRACODE=1 the env override is standing and the flag is never cleared here.
   */
  private async applyVariant(variant: string | undefined): Promise<void> {
    if (variant === this.currentVariant) return
    const effort = variantEffort(variant)
    try {
      await this.q?.applyFlagSettings({
        effortLevel: effort ? (effort === "max" ? "xhigh" : effort) : null,
        ...(process.env.OPENCLAUDE_ULTRACODE === "1" ? {} : { ultracode: variant === "ultracode" ? true : null }),
      })
      this.currentVariant = variant
    } catch {
      /* control request failed; keep the previous variant and retry on the next change */
    }
  }

  /** Model/permission-mode changes after turn 1 ride the streaming control channel. */
  private async applyMode(modelID: string, permissionMode: Options["permissionMode"]): Promise<void> {
    try {
      if (modelID !== this.activeModelID) {
        await this.q?.setModel(modelID)
        this.activeModelID = modelID
      }
      if (permissionMode !== this.activePermissionMode) {
        await this.q?.setPermissionMode(permissionMode!)
        this.activePermissionMode = permissionMode
      }
    } catch {
      /* keep the previous model/mode; retried on the next turn */
    }
  }

  /** Submit a user turn. Turns are serialized per session (a second prompt mid-stream would
   *  otherwise corrupt the per-turn state). Resolves when this turn completes. */
  prompt(text: string, model: { providerID: string; modelID: string; variant?: string }, agent: string): Promise<void> {
    const run = this.turnQueue.then(() => this.runTurn(text, model, agent))
    this.turnQueue = run.catch(() => {})
    return run
  }

  /** Real compaction (09 §5): pushes "/compact" and maps the CLI's frame sequence onto the
   *  reference wire shape. Serialized through the SAME queue as prompts so it can never
   *  interleave a streaming turn. Resolves when the compact turn's result arrives. */
  compact(instructions: string | undefined, model: { providerID: string; modelID: string; variant?: string }, agent: string): Promise<void> {
    const run = this.turnQueue.then(() => this.runCompactTurn(instructions, model, agent))
    this.turnQueue = run.catch(() => {})
    return run
  }

  private async runCompactTurn(instructions: string | undefined, model: { providerID: string; modelID: string; variant?: string }, agent: string): Promise<void> {
    if (this.disposed) return
    this.lastModel = { providerID: model.providerID, modelID: model.modelID }
    const permissionMode: Options["permissionMode"] = agent === "plan" ? "plan" : agent === "auto" ? "auto" : "default"
    this.startQuery(model.modelID, permissionMode, model.variant)
    await this.applyVariant(model.variant)
    await this.applyMode(model.modelID, permissionMode)

    // Reference shape (09 §5.3 a-b): a user message carrying ONLY a compaction part — the
    // TUI renders it as the "── Compaction ──" rule, never as a text bubble.
    const user = this.store.newUserMessage(this.sessionID, agent, model)
    this.store.addMessage(this.sessionID, user)
    this.store.putPart(this.sessionID, this.store.newPart(this.sessionID, user.id, { type: "compaction", auto: false }))
    this.store.setBusy(this.sessionID, true)

    // No streaming assistant: /compact emits ZERO stream_events (probe finding 4). The
    // summary message opens at compact_boundary instead.
    this.assistant = null
    this.compactCtx = { userID: user.id, assistant: null }
    this.partObjs.clear()
    this.blocks.clear()
    this.textAccum.clear()
    this.stepTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    this.resultErrored = false
    this.turnDone = defer<void>()

    this.input.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "/compact" + (instructions ? " " + instructions : "") }] },
      parent_tool_use_id: null,
    })

    await this.turnDone.promise
  }

  private async runTurn(text: string, model: { providerID: string; modelID: string; variant?: string }, agent: string): Promise<void> {
    if (this.disposed) return
    this.agent = agent
    this.lastModel = { providerID: model.providerID, modelID: model.modelID }
    const permissionMode: Options["permissionMode"] = agent === "plan" ? "plan" : agent === "auto" ? "auto" : "default"
    this.startQuery(model.modelID, permissionMode, model.variant)
    await this.applyVariant(model.variant)
    await this.applyMode(model.modelID, permissionMode)

    // Persist + emit the user message and its text part.
    const user = this.store.newUserMessage(this.sessionID, agent, model)
    this.store.addMessage(this.sessionID, user)
    const textPart = this.store.newPart(this.sessionID, user.id, { type: "text", text })
    this.store.putPart(this.sessionID, textPart)
    this.store.setBusy(this.sessionID, true)

    // Reset per-turn state; open the assistant message eagerly (parentID = user msg).
    this.assistant = this.store.newAssistantMessage(this.sessionID, user.id, agent, model.providerID, model.modelID, model.variant)
    this.store.addMessage(this.sessionID, this.assistant)
    this.partObjs.clear()
    this.blocks.clear()
    this.textAccum.clear()
    this.stepTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    this.resultErrored = false
    this.turnDone = defer<void>()

    // No session_id stamp: it would be an opencode ses_ id, not a Claude UUID; the field is
    // optional on input and the CLI ignores it.
    this.input.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    })

    await this.turnDone.promise
  }

  async interrupt(): Promise<void> {
    // Dismiss any open dialogs first (vendor behavior: abort implies reject).
    for (const id of [...this.pendingPermissions.keys()]) this.replyPermission(id, "reject", "Interrupted")
    for (const id of [...this.pendingQuestions.keys()]) this.rejectQuestion(id)
    try {
      await this.q?.interrupt()
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.input.close()
    for (const p of this.pendingPermissions.values()) p.resolve({ behavior: "deny", message: "session closed" })
    this.pendingPermissions.clear()
    for (const p of this.pendingQuestions.values()) p.resolve({ behavior: "deny", message: "session closed" })
    this.pendingQuestions.clear()
    for (const c of this.children.values()) this.store.setBusy(c.sessionID, false)
  }

  // ---- permission bridge ----

  replyPermission(requestID: string, reply: "once" | "always" | "reject", message?: string, cascade = true): boolean {
    const pending = this.pendingPermissions.get(requestID)
    if (!pending) return false
    this.pendingPermissions.delete(requestID)
    this.store.bus.publish("permission.replied", { sessionID: this.sessionID, requestID, reply })
    if (reply === "reject") {
      pending.resolve({ behavior: "deny", message: message ?? "Rejected by user" })
      // Vendor cascade: a user reject also rejects every other pending permission in the session.
      if (cascade) {
        for (const [id, p] of [...this.pendingPermissions]) {
          this.pendingPermissions.delete(id)
          this.store.bus.publish("permission.replied", { sessionID: this.sessionID, requestID: id, reply: "reject" })
          p.resolve({ behavior: "deny", message: message ?? "Rejected by user" })
        }
      }
    } else {
      if (reply === "always") this.alwaysAllow.add(pending.mappedTool)
      pending.resolve({ behavior: "allow" })
    }
    return true
  }

  private onCanUseTool(toolName: string, input: Record<string, unknown>, toolUseID: string, signal?: AbortSignal): Promise<PermissionResult> {
    // AskUserQuestion is an interactive-input tool, not a permission: the harness collects
    // answers and injects them via updatedInput.answers (question text → answer string).
    if (toolName === "AskUserQuestion") return this.askQuestion(input, toolUseID, signal)

    const mapped = mapToolName(toolName)
    if (this.alwaysAllow.has(mapped)) return Promise.resolve({ behavior: "allow" })

    const messageID = this.assistant?.id ?? ""
    const req = newPermissionRequest(this.sessionID, mapped, [], [mapped], { messageID, callID: toolUseID })
    const deferred = defer<PermissionResult>()
    this.pendingPermissions.set(req.id, { resolve: deferred.resolve, mappedTool: mapped })
    // The CLI aborts the request when the turn is interrupted — dismiss the dialog too.
    signal?.addEventListener("abort", () => this.replyPermission(req.id, "reject", "Aborted", false), { once: true })
    this.store.bus.publish("permission.asked", {
      id: req.id,
      sessionID: req.sessionID,
      permission: req.permission,
      patterns: req.patterns,
      metadata: req.metadata,
      always: req.always,
      tool: req.tool,
    })
    return deferred.promise
  }

  // ---- question bridge ----

  private askQuestion(input: Record<string, unknown>, toolUseID: string, signal?: AbortSignal): Promise<PermissionResult> {
    const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
    const questions: QuestionInfo[] = raw.map((q) => {
      const opts = Array.isArray(q?.options) ? (q.options as Record<string, unknown>[]) : []
      const previews = opts.filter((o) => typeof o?.preview === "string" && o.preview !== "").length
      const budget = previews ? Math.max(3, Math.floor(PREVIEW_LINE_BUDGET / previews)) : 0
      return {
        question: String(q?.question ?? ""),
        header: String(q?.header ?? ""),
        options: opts.map((o) => {
          const label = String(o?.label ?? "")
          const description = String(o?.description ?? "")
          const preview = typeof o?.preview === "string" && o.preview !== "" ? o.preview : undefined
          return preview ? { label, description: foldPreview(description, preview, budget), preview } : { label, description }
        }),
        multiple: q?.multiSelect === true,
      }
    })
    const notes = process.env.OPENCLAUDE_NO_QUESTION_NOTES !== "1" && questions.length > 0
    if (notes)
      questions.push({
        question: "Add a note to your answer? (optional)",
        header: NOTES_HEADER,
        options: [{ label: NO_NOTE_LABEL, description: "Send the answer as-is" }],
        multiple: false,
      })
    const request: QuestionRequest = {
      id: Id.question(),
      sessionID: this.sessionID,
      questions,
      tool: { messageID: this.assistant?.id ?? "", callID: toolUseID },
    }
    const deferred = defer<PermissionResult>()
    this.pendingQuestions.set(request.id, { resolve: deferred.resolve, input, request, notes })
    signal?.addEventListener("abort", () => this.rejectQuestion(request.id), { once: true })
    this.store.bus.publish("question.asked", { ...request })
    return deferred.promise
  }

  /** answers: one array per question, each entry a selected option label (or one custom string). */
  replyQuestion(requestID: string, answers: string[][]): boolean {
    const pending = this.pendingQuestions.get(requestID)
    if (!pending) return false
    this.pendingQuestions.delete(requestID)
    this.store.bus.publish("question.replied", { sessionID: this.sessionID, requestID, answers })
    const questions = pending.request.questions
    const asked = pending.notes ? questions.length - 1 : questions.length // questions the model actually asked
    const note = pending.notes
      ? (answers[asked] ?? [])
          .filter((a) => a && a !== NO_NOTE_LABEL)
          .join("\n")
          .trim()
      : ""
    // The TUI's question tool renderer reads metadata.answers (string[][]) from the tool part,
    // iterating the model's ORIGINAL questions — so the synthetic Notes answer is stripped and
    // the note appended to the first answer (extra strings render joined with ", ").
    const metaAnswers = Array.from({ length: asked }, (_, i) => [...(answers[i] ?? [])])
    if (note) metaAnswers[0]?.push(`note: ${note}`)
    const toolCtx = pending.request.tool ? this.tools.get(pending.request.tool.callID) : undefined
    if (toolCtx) toolCtx.extraMeta = { ...toolCtx.extraMeta, answers: metaAnswers }
    const byQuestion: Record<string, string> = {}
    questions.slice(0, asked).forEach((q, i) => {
      const a = answers[i] ?? []
      if (a.length) byQuestion[q.question] = a.join(", ")
    })
    // The note rides updatedInput.annotations on the first question: the CLI renders it in the
    // tool_result as ` notes: <text>` right after that question's answer (probe-verified,
    // test/probe-question-annotations.ts).
    const firstQuestion = questions[0]?.question
    const annotations = note && firstQuestion !== undefined ? { [firstQuestion]: { notes: note } } : undefined
    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.input, answers: byQuestion, ...(annotations ? { annotations } : {}) },
    })
    return true
  }

  rejectQuestion(requestID: string): boolean {
    const pending = this.pendingQuestions.get(requestID)
    if (!pending) return false
    this.pendingQuestions.delete(requestID)
    this.store.bus.publish("question.rejected", { sessionID: this.sessionID, requestID })
    pending.resolve({ behavior: "deny", message: "User dismissed the question dialog" })
    return true
  }

  pendingQuestionList(): QuestionRequest[] {
    return [...this.pendingQuestions.values()].map((p) => p.request)
  }

  // ---- SDK message consumption ----

  private async consume(): Promise<void> {
    if (!this.q) return
    try {
      for await (const msg of this.q) {
        try {
          this.handle(msg)
        } catch (err) {
          // Never let one bad message kill the stream (e.g. a mirrored child session was
          // deleted out from under us) — a dead consume loop makes the engine a zombie.
          console.error("open-claude: dropped SDK message:", err)
        }
      }
    } catch (err) {
      // The iterator throws right AFTER an error result (probe-verified double on the
      // resume-not-found path), and dispose()'s abort makes it throw "Operation aborted"
      // (deliberate teardown on move/delete — the TUI toasts every session.error except
      // MessageAbortedError). Only report throws that no result announced and that
      // teardown didn't cause.
      if (!this.resultErrored && !this.disposed) this.store.error(this.sessionID, { name: "UnknownError", data: { message: String(err) } })
      this.resultErrored = false
    } finally {
      // Stream over. Unless we were disposed, the CLI died or the stream errored — without a
      // reset the engine is a zombie (started stays true, q stays set, and the next prompt
      // hangs forever on turnDone). Dismiss open dialogs, error in-flight main-session tool
      // parts, then arm a lazy restart: the next prompt re-runs startQuery, which resumes via
      // the stored claudeSessionId, and the conversation continues.
      if (!this.disposed) {
        for (const id of [...this.pendingPermissions.keys()]) this.replyPermission(id, "reject", "Claude process exited", false)
        for (const id of [...this.pendingQuestions.keys()]) this.rejectQuestion(id)
        this.failInFlightTools("Claude process exited")
        this.started = false
        this.q = null
        this.abort = new AbortController()
        this.input = new InputQueue()
      }
      this.finishTurn() // unblock the POST whether or not a turn was in flight
    }
  }

  private handle(msg: SDKMessage): void {
    // resultErrored dedupes ONLY the immediate result→iterator-throw pair: any message that
    // arrives after the flagging result proves the stream survived it, so a LATER genuine
    // stream death must surface its own session.error (carried-over /move review fix).
    if (this.resultErrored) this.resultErrored = false
    switch (msg.type) {
      case "stream_event": {
        const m = msg as SDKMessage & { parent_tool_use_id: string | null; event: unknown }
        // Subagent content never arrives as partial events (probe-verified); only main-session
        // partials are rendered here.
        if (!m.parent_tool_use_id) this.onStreamEvent(m.event as never)
        break
      }
      case "assistant": {
        const m = msg as SDKMessage & { parent_tool_use_id: string | null; message?: { content?: unknown; model?: string } }
        // Main-session assistant content is rendered from stream events — EXCEPT synthetic
        // messages (message.model === "<synthetic>"): those arrive COMPLETE with zero
        // stream_events (unknown-command output and similar local command stdout) and would
        // otherwise be invisible. Forwarded subagent messages (parent_tool_use_id set) are
        // mirrored into the child session.
        if (m.parent_tool_use_id) this.onChildAssistant(m.parent_tool_use_id, m.message?.content)
        else if (m.message?.model === "<synthetic>") this.onSyntheticAssistant(m.message?.content)
        break
      }
      case "user": {
        const m = msg as SDKUserMessage & { isSynthetic?: boolean; isReplay?: boolean }
        const content = (m.message as { content?: unknown })?.content
        // /compact frames (probe finding 4): the isSynthetic STRING user message is the
        // summary — rendered as the reference's summary assistant message, never as a user
        // message. The isReplay "<local-command-stdout>" frame needs no handling: main-session
        // user frames are never rendered.
        if (!m.parent_tool_use_id && this.compactCtx && m.isSynthetic === true && m.isReplay !== true && typeof content === "string") {
          this.onCompactSummary(content)
          break
        }
        if (m.parent_tool_use_id) this.onChildUser(m.parent_tool_use_id, content)
        this.onToolResults(m) // tool_results resolve via the shared tools map, main or child
        break
      }
      case "system": {
        const m = msg as SDKMessage & { subtype?: string } & Record<string, unknown>
        // init re-fires at the start of EVERY user turn on CLI 2.1.207 (and again mid-
        // /compact); the capture is a SILENT store mutation that no-ops when unchanged.
        // After a fork, the first init's NEW uuid replaces the inherited one and clears
        // forkPending.
        if (m.subtype === "init") {
          if (typeof m.session_id === "string" && m.session_id) this.store.setClaudeSessionId(this.sessionID, m.session_id)
        } else if (m.subtype === "task_started") this.onTaskStarted(m)
        else if (m.subtype === "task_progress") this.onTaskProgress(m)
        else if (m.subtype === "task_updated") this.onTaskLifecycle(String(m.task_id ?? ""), (m.patch as { status?: string } | undefined)?.status)
        else if (m.subtype === "task_notification") this.onTaskLifecycle(String(m.task_id ?? ""), m.status as string | undefined, typeof m.summary === "string" ? m.summary : undefined)
        else if (m.subtype === "compact_boundary") this.onCompactBoundary(m)
        else if (m.subtype === "status") this.onCompactStatus(m)
        else if (m.subtype === "commands_changed") this.onCommandsChanged?.((m.commands as SlashCommand[] | undefined) ?? [])
        break
      }
      case "result":
        this.onResult(msg as never)
        break
    }
  }

  /** Synthetic main-session assistant messages (message.model === "<synthetic>") carry
   *  complete text blocks and no stream events — render them into the current turn's
   *  assistant message so "Unknown command: /x"-style output is visible and persisted. */
  private onSyntheticAssistant(content: unknown): void {
    const A = this.assistant
    if (!A || !Array.isArray(content)) return
    const now = Date.now()
    for (const block of content as { type?: string; text?: unknown }[]) {
      if (block?.type !== "text" || !block.text) continue
      this.putPart(this.store.newPart(this.sessionID, A.id, { type: "text", text: String(block.text), time: { start: now, end: now } }))
    }
  }

  // ---- compaction mapping (09 §5: CLI /compact sequence → reference wire shape) ----

  /** Opens the summary assistant message once (reference 09 §5.3 d): parentID = the
   *  compaction user message, mode/agent "compaction", summary: true. */
  private compactAssistant(): AssistantMessage {
    const c = this.compactCtx!
    if (c.assistant) return c.assistant
    const A = this.store.newAssistantMessage(this.sessionID, c.userID, "compaction", this.lastModel.providerID, this.lastModel.modelID)
    A.summary = true
    c.assistant = A
    this.store.addMessage(this.sessionID, A)
    this.putPart(this.store.newPart(this.sessionID, A.id, { type: "step-start" }))
    return A
  }

  private onCompactBoundary(m: Record<string, unknown>): void {
    const meta = (m.compact_metadata ?? {}) as Record<string, unknown>
    if (!this.compactCtx) {
      // UNPROMPTED auto-compaction mid-turn (trigger:"auto"): create the reference pair now.
      // The in-flight turn's state (assistant/blocks/tools) is deliberately untouched — the
      // re-emitted system/init and the turn's later frames keep flowing into the outer turn.
      const user = this.store.newUserMessage(this.sessionID, this.agent, this.lastModel)
      this.store.addMessage(this.sessionID, user)
      this.store.putPart(this.sessionID, this.store.newPart(this.sessionID, user.id, { type: "compaction", auto: meta.trigger !== "manual" }))
      this.compactCtx = { userID: user.id, assistant: null }
    }
    this.compactCtx.postTokens = typeof meta.post_tokens === "number" ? meta.post_tokens : undefined
    this.compactAssistant()
  }

  /** The isSynthetic summary user frame: its string content becomes the summary message's
   *  text; tokens = post_tokens (the TUI's context %% reads the LAST assistant message with
   *  output > 0, so this makes it show the post-compact size — 09 §5.5). */
  private onCompactSummary(text: string): void {
    const c = this.compactCtx
    if (!c) return
    const A = this.compactAssistant()
    const now = Date.now()
    this.putPart(this.store.newPart(this.sessionID, A.id, { type: "text", text, time: { start: now, end: now } }))
    A.time.completed = now
    A.finish = "stop"
    if (c.postTokens !== undefined) A.tokens = { input: 0, output: c.postTokens, reasoning: 0, cache: { read: 0, write: 0 } }
    this.putPart(this.store.newPart(this.sessionID, A.id, { type: "step-finish", reason: "stop", cost: A.cost, tokens: { ...A.tokens } }))
    this.store.updateMessage(this.sessionID, A)
    this.store.touchSession(this.sessionID, { tokens: A.tokens })
    // Reference success event (schema/src/session-compaction-event.ts); no TUI consumer.
    this.store.bus.publish("session.compacted", { sessionID: this.sessionID }, this.store.getSession(this.sessionID)?.directory)
    this.compactCtx = null
  }

  /** /compact progress frames have no reference equivalent (busy is already set); only a
   *  failed compact_result surfaces as session.error. */
  private onCompactStatus(m: Record<string, unknown>): void {
    if (m.compact_result != null && m.compact_result !== "success") {
      this.store.error(this.sessionID, { name: "UnknownError", data: { message: `Compaction failed: ${String(m.compact_error ?? m.compact_result)}` } })
    }
  }

  private putPart(part: Part): void {
    this.partObjs.set(part.id, part)
    this.store.putPart(this.sessionID, part)
  }

  private onStreamEvent(event: any): void {
    const A = this.assistant
    if (!A) return

    switch (event.type) {
      case "message_start": {
        this.blocks.clear()
        // Seed this API call's usage: input+cache arrive here, output accrues via message_delta.
        const u = event.message?.usage ?? {}
        this.stepTokens = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: 0,
          cache: { read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 },
        }
        this.putPart(this.store.newPart(this.sessionID, A.id, { type: "step-start" }))
        break
      }
      case "content_block_start": {
        const block = event.content_block
        const idx = event.index as number
        if (block.type === "text") {
          const part = this.store.newPart(this.sessionID, A.id, { type: "text", text: "", time: { start: Date.now() } })
          this.blocks.set(idx, { partID: part.id, kind: "text", raw: "" })
          this.putPart(part)
        } else if (block.type === "thinking") {
          const part = this.store.newPart(this.sessionID, A.id, { type: "reasoning", text: "", time: { start: Date.now() } })
          this.blocks.set(idx, { partID: part.id, kind: "reasoning", raw: "" })
          this.putPart(part)
        } else if (block.type === "redacted_thinking") {
          this.putPart(this.store.newPart(this.sessionID, A.id, { type: "reasoning", text: "[thinking redacted]", time: { start: Date.now(), end: Date.now() }, metadata: { redacted: true } }))
        } else if (block.type === "tool_use") {
          const part = this.store.newPart(this.sessionID, A.id, { type: "tool", callID: block.id, tool: mapToolName(block.name), state: { status: "pending", input: {}, raw: "" } }) as ToolPart
          this.blocks.set(idx, { partID: part.id, kind: "tool", raw: "", toolUseId: block.id })
          this.tools.set(block.id, { part, sessionID: this.sessionID, input: {}, name: block.name, start: Date.now() })
          this.putPart(part)
        }
        break
      }
      case "content_block_delta": {
        const ctx = this.blocks.get(event.index as number)
        if (!ctx) break
        const delta = event.delta
        if (delta.type === "text_delta" || delta.type === "thinking_delta") {
          const text = delta.type === "text_delta" ? delta.text : delta.thinking
          this.textAccum.set(ctx.partID, (this.textAccum.get(ctx.partID) ?? "") + text)
          const part = this.partObjs.get(ctx.partID)
          if (part && (part.type === "text" || part.type === "reasoning")) part.text = this.textAccum.get(ctx.partID)!
          this.store.delta(this.sessionID, A.id, ctx.partID, text)
        } else if (delta.type === "input_json_delta") {
          ctx.raw += delta.partial_json ?? ""
        }
        break
      }
      case "content_block_stop": {
        const ctx = this.blocks.get(event.index as number)
        if (!ctx) break
        if (ctx.kind === "text" || ctx.kind === "reasoning") {
          const part = this.partObjs.get(ctx.partID)
          if (part && (part.type === "text" || part.type === "reasoning")) {
            part.text = this.textAccum.get(ctx.partID) ?? part.text
            if (part.time) part.time.end = Date.now()
            this.putPart(part)
          }
        } else if (ctx.kind === "tool" && ctx.toolUseId) {
          // Input is complete → transition to running (universal signal, independent of permission).
          const input = ctx.raw ? safeParse(ctx.raw) : {}
          this.markRunning(ctx.toolUseId, input)
        }
        break
      }
      case "message_delta": {
        const u = event.usage ?? {}
        this.stepTokens = {
          input: u.input_tokens ?? this.stepTokens.input,
          output: u.output_tokens ?? this.stepTokens.output,
          reasoning: 0,
          cache: {
            read: u.cache_read_input_tokens ?? this.stepTokens.cache.read,
            write: u.cache_creation_input_tokens ?? this.stepTokens.cache.write,
          },
        }
        break
      }
      case "message_stop": {
        this.putPart(this.store.newPart(this.sessionID, A.id, { type: "step-finish", reason: "stop", cost: A.cost, tokens: { ...this.stepTokens } }))
        A.tokens = { ...this.stepTokens }
        this.store.updateMessage(this.sessionID, A)
        break
      }
    }
  }

  private markRunning(useId: string, input: Record<string, unknown>): void {
    const t = this.tools.get(useId)
    if (!t) return
    t.input = input
    if (mapToolName(t.name) === "task" && input.run_in_background === true) t.extraMeta = { ...t.extraMeta, background: true }
    // Workflows always run detached (the tool result returns async_launched immediately),
    // so the Task renderer must derive liveness from the child session, not the ✓.
    if (t.name === "Workflow") t.extraMeta = { ...t.extraMeta, background: true }
    const mapped = mapToolInput(t.name, input)
    t.part.state = {
      status: "running",
      input: mapped,
      title: toolTitle(t.name, mapped),
      time: { start: t.start },
      ...(t.extraMeta ? { metadata: { ...t.extraMeta } } : {}),
    }
    this.store.putPart(t.sessionID, t.part)
  }

  private onToolResults(msg: SDKUserMessage): void {
    const content = (msg.message as any)?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== "tool_result") continue
      const t = this.tools.get(block.tool_use_id as string)
      if (!t) continue
      const output = flattenToolResult(block.content)
      const input = mapToolInput(t.name, t.input)
      const state: ToolState =
        block.is_error === true
          ? { status: "error", input, error: output || "Tool failed", metadata: t.extraMeta ? { ...t.extraMeta } : undefined, time: { start: t.start, end: Date.now() } }
          : {
              status: "completed",
              input,
              output,
              title: toolTitle(t.name, input),
              metadata: { ...toolMetadata(t.name, input, output, msg.tool_use_result), ...t.extraMeta },
              time: { start: t.start, end: Date.now() },
            }
      t.part.state = state
      this.store.putPart(t.sessionID, t.part)

      if (mapToolName(t.name) === "todowrite" && Array.isArray(input.todos)) {
        this.store.setTodos(
          t.sessionID,
          (input.todos as any[]).map((td) => ({ content: String(td.content ?? ""), status: String(td.status ?? "pending"), priority: String(td.priority ?? "medium") })),
        )
      }
    }
  }

  // ---- subagent mirroring ----

  private childFor(parentToolUseId: string, seed?: { description?: string; agent?: string }): ChildCtx {
    let c = this.children.get(parentToolUseId)
    if (c) return c
    const toolCtx = this.tools.get(parentToolUseId)
    const title = seed?.description ?? String(toolCtx?.input?.description ?? "Subagent")
    const agent = seed?.agent ?? String(toolCtx?.input?.subagent_type ?? "task")
    const parentID = toolCtx?.sessionID ?? this.sessionID
    const session = this.store.createSession({
      parentID,
      directory: this.store.getSession(parentID)?.directory, // mirrors inherit the spawning session's dir
      title: `${title} (@${agent} subagent)`,
      agent,
      model: { id: this.lastModel.modelID, providerID: this.lastModel.providerID },
    })
    this.store.setBusy(session.id, true)
    c = { sessionID: session.id, agent, user: null, assistant: null }
    this.children.set(parentToolUseId, c)
    this.linkTaskPart(parentToolUseId, c)
    return c
  }

  /** Link the spawning task tool part so the TUI can show progress + navigate into the child. */
  private linkTaskPart(parentToolUseId: string, c: ChildCtx): void {
    const toolCtx = this.tools.get(parentToolUseId)
    if (!toolCtx) return // spawning tool part not seen yet (nested task); retried when it arrives
    toolCtx.extraMeta = { ...toolCtx.extraMeta, sessionId: c.sessionID, parentSessionId: toolCtx.sessionID }
    const state = toolCtx.part.state
    if (state.status !== "pending") {
      state.metadata = { ...state.metadata, ...toolCtx.extraMeta }
      this.store.putPart(toolCtx.sessionID, toolCtx.part)
    }
    // Re-home under the spawning session — for a task spawned by a subagent, task_started
    // arrived before the subagent's tool part existed and the child defaulted to the main session.
    const sess = this.store.getSession(c.sessionID)
    if (sess && sess.parentID !== toolCtx.sessionID) this.store.touchSession(c.sessionID, { parentID: toolCtx.sessionID })
  }

  private childAssistant(c: ChildCtx): AssistantMessage {
    if (c.assistant) return c.assistant
    if (!c.user) {
      // A user message must exist first: message ids are ascending and the TUI orders by id.
      c.user = this.store.newUserMessage(c.sessionID, c.agent, this.lastModel)
      this.store.addMessage(c.sessionID, c.user)
    }
    c.assistant = this.store.newAssistantMessage(c.sessionID, c.user.id, c.agent, this.lastModel.providerID, this.lastModel.modelID)
    this.store.addMessage(c.sessionID, c.assistant)
    return c.assistant
  }

  /** Forwarded subagent user message: the first text-bearing one is the subagent's prompt. */
  private onChildUser(parentToolUseId: string, content: unknown): void {
    const c = this.childFor(parentToolUseId)
    if (c.user) return // tool_result turns are rendered via tool parts; extra text is dropped
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((b: any) => b?.type === "text")
              .map((b: any) => String(b.text ?? ""))
              .join("\n\n")
          : ""
    if (!text) return
    c.user = this.store.newUserMessage(c.sessionID, c.agent, this.lastModel)
    this.store.addMessage(c.sessionID, c.user)
    this.store.putPart(c.sessionID, this.store.newPart(c.sessionID, c.user.id, { type: "text", text }))
  }

  /** Forwarded subagent assistant message: append its blocks to the child transcript. */
  private onChildAssistant(parentToolUseId: string, content: unknown): void {
    if (!Array.isArray(content)) return
    const c = this.childFor(parentToolUseId)
    const A = this.childAssistant(c)
    const now = Date.now()
    for (const block of content as any[]) {
      if (block?.type === "text") {
        this.store.putPart(c.sessionID, this.store.newPart(c.sessionID, A.id, { type: "text", text: String(block.text ?? ""), time: { start: now, end: now } }))
      } else if (block?.type === "thinking") {
        this.store.putPart(c.sessionID, this.store.newPart(c.sessionID, A.id, { type: "reasoning", text: String(block.thinking ?? ""), time: { start: now, end: now } }))
      } else if (block?.type === "redacted_thinking") {
        this.store.putPart(c.sessionID, this.store.newPart(c.sessionID, A.id, { type: "reasoning", text: "[thinking redacted]", time: { start: now, end: now }, metadata: { redacted: true } }))
      } else if (block?.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>
        const mapped = mapToolInput(block.name, input)
        const part = this.store.newPart(c.sessionID, A.id, {
          type: "tool",
          callID: block.id,
          tool: mapToolName(block.name),
          state: { status: "running", input: mapped, title: toolTitle(block.name, mapped), time: { start: now } },
        }) as ToolPart
        const ctx: ToolCtx = { part, sessionID: c.sessionID, input, name: block.name, start: now }
        if (mapToolName(block.name) === "task" && input.run_in_background === true) ctx.extraMeta = { background: true }
        this.tools.set(block.id, ctx)
        this.store.putPart(c.sessionID, part)
        // If task_started for this nested task already created its child session, link it now.
        const spawned = this.children.get(block.id)
        if (spawned) this.linkTaskPart(block.id, spawned)
      }
    }
    this.store.touchSession(c.sessionID, {})
  }

  private onTaskStarted(m: Record<string, unknown>): void {
    if (m.skip_transcript === true) return
    // task_started fires for every background task type (local_bash jobs, monitors, …);
    // only agent-like tasks are mirrored as child sessions.
    const taskType = typeof m.task_type === "string" ? m.task_type : undefined
    const agentLike = typeof m.subagent_type === "string" || taskType === undefined || taskType === "local_agent" || taskType === "local_workflow" || taskType === "remote_agent"
    if (!agentLike) return
    const toolUseId = typeof m.tool_use_id === "string" ? m.tool_use_id : undefined
    if (!toolUseId) return // not spawned by a tool_use block → nothing to route or link
    const c = this.childFor(toolUseId, {
      description: typeof m.description === "string" ? m.description : undefined,
      agent: typeof m.subagent_type === "string" ? m.subagent_type : typeof m.workflow_name === "string" ? `workflow:${m.workflow_name}` : undefined,
    })
    if (typeof m.task_id === "string") this.childrenByTask.set(m.task_id, c)
    if (m.task_type === "local_workflow") {
      c.isWorkflow = true
      if (!c.user) {
        const text = typeof m.prompt === "string" && m.prompt ? m.prompt : typeof m.description === "string" ? m.description : ""
        if (text) {
          c.user = this.store.newUserMessage(c.sessionID, c.agent, this.lastModel)
          this.store.addMessage(c.sessionID, c.user)
          this.store.putPart(c.sessionID, this.store.newPart(c.sessionID, c.user.id, { type: "text", text }))
        }
      }
    }
  }

  /** Workflow progress ticks: append each distinct phase/summary line to the child log. */
  private onTaskProgress(m: Record<string, unknown>): void {
    const c = this.childrenByTask.get(String(m.task_id ?? ""))
    if (!c?.isWorkflow) return
    const line = typeof m.summary === "string" && m.summary ? m.summary : typeof m.description === "string" ? m.description : ""
    if (!line || line === c.lastProgress) return
    c.lastProgress = line
    this.appendChildText(c, line)
    this.store.touchSession(c.sessionID, {})
  }

  private appendChildText(c: ChildCtx, text: string): void {
    const A = this.childAssistant(c)
    const now = Date.now()
    this.store.putPart(c.sessionID, this.store.newPart(c.sessionID, A.id, { type: "text", text, time: { start: now, end: now } }))
  }

  private onTaskLifecycle(taskId: string, status?: string, summary?: string): void {
    const c = this.childrenByTask.get(taskId)
    if (!c) return
    if (status === "completed" || status === "failed" || status === "stopped" || status === "killed") {
      if (c.isWorkflow && summary && summary !== c.lastProgress) {
        c.lastProgress = summary
        this.appendChildText(c, summary)
      }
      if (c.assistant) {
        c.assistant.time.completed = Date.now()
        this.store.updateMessage(c.sessionID, c.assistant)
      }
      this.store.setBusy(c.sessionID, false)
    }
  }

  private onResult(msg: any): void {
    const A = this.assistant
    // Interrupts surface as terminal_reason 'aborted_streaming'/'aborted_tools' (the result
    // subtype can even be 'success'); MessageAbortedError is the name the TUI suppresses.
    const aborted = String(msg.terminal_reason ?? "").startsWith("aborted")
    if (A) {
      A.cost = msg.total_cost_usd ?? A.cost
      // result.usage is SUMMED over every API call in the turn (test/probe-usage.ts): each
      // tool round-trip re-reads the whole cached context, so cache.read alone stacks to
      // N× the real context and the TUI's gauge reads >1000%. A.tokens already holds the
      // LAST call's usage (message_start/delta → message_stop snapshot) — that IS the
      // current context, and it's what upstream stores too (message.tokens = final step's
      // usage, vendor processor.ts:445). Use the summed result only if nothing streamed.
      if (A.tokens.input + A.tokens.output + A.tokens.cache.read + A.tokens.cache.write === 0) {
        const u = msg.usage ?? {}
        A.tokens = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: 0,
          cache: { read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 },
        }
      }
      A.time.completed = Date.now()
      A.finish = msg.subtype === "success" && !aborted ? "stop" : "error"
      if (aborted) {
        A.error = { name: "MessageAbortedError", data: { message: "Aborted" } }
        this.store.error(this.sessionID, A.error)
        this.resultErrored = true
      } else if (msg.subtype !== "success") {
        A.error = { name: "UnknownError", data: { message: String(msg.result ?? (Array.isArray(msg.errors) ? msg.errors.join("; ") : "error")) } }
        this.store.error(this.sessionID, A.error)
        this.resultErrored = true // the iterator's trailing throw must not re-surface this
      }
      this.store.updateMessage(this.sessionID, A)
      this.store.touchSession(this.sessionID, { cost: A.cost, tokens: A.tokens })
    }
    if (aborted || msg.subtype !== "success") this.failInFlightTools("Aborted")
    // Stale resume target (probe-resume finding 7): clear the stored uuid silently so the NEXT
    // restart starts fresh instead of erroring forever; session.error for this turn was already
    // surfaced above (resultErrored suppresses the catch-path duplicate when the iterator
    // throws right after this result). consume()'s finally self-heals, and finishTurn below
    // finalizes the turn exactly once (setBusy no-ops on the unchanged idle value).
    if (msg.subtype === "error_during_execution" && Array.isArray(msg.errors) && msg.errors.some((e: unknown) => String(e).includes("No conversation found with session ID"))) {
      this.store.setClaudeSessionId(this.sessionID, undefined)
    }
    this.finishTurn()
  }

  /** An aborted/failed turn leaves main-session tool parts stuck pending/running — error them. */
  private failInFlightTools(reason: string): void {
    for (const t of this.tools.values()) {
      if (t.sessionID !== this.sessionID) continue
      const s = t.part.state
      if (s.status !== "pending" && s.status !== "running") continue
      t.part.state = {
        status: "error",
        input: s.status === "running" ? s.input : mapToolInput(t.name, t.input),
        error: reason,
        metadata: t.extraMeta ? { ...t.extraMeta } : undefined,
        time: { start: t.start, end: Date.now() },
      }
      this.store.putPart(t.sessionID, t.part)
    }
  }

  private finishTurn(): void {
    this.compactCtx = null // a failed/aborted compact must not capture a later synthetic frame
    this.store.setBusy(this.sessionID, false)
    const d = this.turnDone
    this.turnDone = null
    d?.resolve()
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
