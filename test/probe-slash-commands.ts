// Probe: slash commands over the Agent SDK (custom commands + /compact + recognition rules).
// Run: bun run test/probe-slash-commands.ts   (requires authenticated Claude Code CLI)
//
// VERIFIED FINDINGS (run 2026-07-15, SDK 0.3.207 / CLI 2.1.207, model claude-haiku-4-5):
// 1. Listing: Query.supportedCommands(): Promise<SlashCommand[]>; SlashCommand =
//    { name, description, argumentHint, aliases? }. Same list on initializationResult().commands;
//    system/init carries names-only slash_commands: string[]. /compact entry:
//    {name:"compact", description:"Free up context by summarizing the conversation so far",
//     argumentHint:"<optional custom summarization instructions>"}.
// 2. settingSources: [] → 40 commands: built-ins + 15 bundled skills only. Project
//    .claude/commands, user ~/.claude/skills, and plugins are NOT loaded. settingSources
//    unset (default) → 54: adds project command "greet" (description = file body + " (project)"
//    suffix, argumentHint ""), user skills, plugin skills ("frontend-design:frontend-design").
// 3. Custom command execution needs default settingSources. "/greet world" (plain text block,
//    streaming input) expands: transcript gets a user msg "<command-message>greet</command-message>\n
//    <command-name>/greet</command-name>\n<command-args>world</command-args>" plus an isMeta user
//    msg with the $ARGUMENTS-substituted body; NO user message appears on the SDK stream — just
//    a normal model turn (result num_turns:1, terminal_reason:"completed") whose reply said BANANA.
//    With settingSources: [] the same send returns "Unknown command: /greet. Did you mean /reset?".
// 4. /compact (2 prior turns, then "/compact") emits, in order, with NO stream_events:
//    system/status{status:"compacting"} → system/status{status:null,compact_result:"success"} →
//    system/init (re-init) → system/compact_boundary{compact_metadata:{trigger:"manual",
//    pre_tokens:25242,post_tokens:1102,cumulative_dropped_tokens:24140,duration_ms:11124,
//    preserved_segment{head/anchor/tail_uuid},preserved_messages{anchor_uuid,uuids,all_uuids}}} →
//    user(isSynthetic:true,isReplay:false, content STRING "This session is being continued from a
//    previous conversation…<summary>") → user(isReplay:true, content "<local-command-stdout>Compacted
//    </local-command-stdout>") → result{subtype:"success",num_turns:0,result:"",stop_reason:null,
//    NO terminal_reason}. Post-compact "What is my favorite fruit?" still answers KIWI.
// 5. Unknown command ("/xyzzy-not-real hello"): NO model call. Stream: assistant msg with
//    message.model:"<synthetic>", uuid-style message.id, zero usage, content [{type:"text",
//    text:"Unknown command: /xyzzy-not-real"}] → result{subtype:"success",is_error:false,
//    num_turns:0,total_cost_usd:0,duration_api_ms:0,result:"Unknown command: /xyzzy-not-real"}.
//    Transcript stores it as type:"system",subtype:"local_command" with <local-command-stdout> tags.
//    Near-miss names get "Did you mean /reset?" appended. Same behavior in both settingSources modes.
// 6. Slash only recognized at message start: "please run /compact" went to the model as literal
//    text (num_turns:1, no compact messages); model replied conversationally.
// 7. system/init is re-emitted at EVERY user turn (and again mid-/compact), not just once.

import { query, type Options, type PermissionResult, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { mkdirSync, writeFileSync } from "node:fs"

const MODEL = "claude-haiku-4-5-20251001"
const DIR = "/tmp/oc-probe-slash"
const DIR_COMPACT = "/tmp/oc-probe-slash-compact"

// ---- fixtures ----
mkdirSync(`${DIR}/.claude/commands`, { recursive: true })
mkdirSync(DIR_COMPACT, { recursive: true })
writeFileSync(`${DIR}/.claude/commands/greet.md`, "Say the word BANANA and then greet: $ARGUMENTS\n")

// ---- engine-style input queue (copied from src/engine.ts conventions) ----
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

// ---- logging helpers ----
function trunc(v: unknown, max = 600): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + `…[+${v.length - max}]` : v
  if (Array.isArray(v)) return v.map((x) => trunc(x, max))
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = trunc(val, max)
    return o
  }
  return v
}

function summarize(m: any): Record<string, unknown> {
  if (m.type === "stream_event") {
    const ev = m.event ?? {}
    const line: Record<string, unknown> = { type: "stream_event", event: ev.type }
    if (ev.content_block) line.block = ev.content_block.type
    if (ev.delta?.type) line.delta = ev.delta.type
    return line
  }
  if (m.type === "assistant" || m.type === "user") {
    const c = m.message?.content
    const blocks = Array.isArray(c) ? c.map((b: any) => b.type) : [typeof c]
    const text = Array.isArray(c)
      ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
      : typeof c === "string" ? c : ""
    const line: Record<string, unknown> = { type: m.type, blocks, text: trunc(text, 800), ptid: m.parent_tool_use_id }
    if (m.isSynthetic !== undefined) line.isSynthetic = m.isSynthetic
    if (m.subtype) line.subtype = m.subtype
    if (m.isReplay !== undefined) line.isReplay = m.isReplay
    return line
  }
  if (m.type === "result") {
    return {
      type: "result", subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns,
      terminal_reason: m.terminal_reason, stop_reason: m.stop_reason, result: trunc(m.result, 500),
    }
  }
  // system + everything else: full (truncated) JSON
  return trunc(m, 800) as Record<string, unknown>
}

function assistantText(msgs: any[]): string {
  return msgs
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .map((m) => (Array.isArray(m.message?.content) ? m.message.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : ""))
    .join("\n")
}

// ---- session harness ----
class ProbeSession {
  input = new InputQueue()
  abort = new AbortController()
  q: ReturnType<typeof query>
  events: any[] = []
  private waiters: { pred: (m: any) => boolean; resolve: (m: any | null) => void }[] = []
  private ended = false
  donePromise: Promise<void>

  constructor(public name: string, extra: Partial<Options>) {
    const options: Options = {
      cwd: DIR,
      model: MODEL,
      permissionMode: "default",
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      abortController: this.abort,
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: (toolName): Promise<PermissionResult> => {
        console.log(JSON.stringify({ s: this.name, canUseTool: toolName, action: "deny" }))
        return Promise.resolve({ behavior: "deny", message: "probe: tools disabled" })
      },
      ...extra,
    }
    this.q = query({ prompt: this.input, options })
    this.donePromise = this.consume()
  }

  private async consume(): Promise<void> {
    try {
      for await (const m of this.q as AsyncIterable<any>) {
        this.events.push(m)
        console.log(JSON.stringify({ s: this.name, ...summarize(m) }))
        for (const w of [...this.waiters]) {
          if (w.pred(m)) {
            this.waiters.splice(this.waiters.indexOf(w), 1)
            w.resolve(m)
          }
        }
      }
    } catch (err) {
      console.log(JSON.stringify({ s: this.name, streamError: String(err) }))
    } finally {
      this.ended = true
      for (const w of this.waiters) w.resolve(null)
      this.waiters = []
    }
  }

  waitFor(pred: (m: any) => boolean, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      if (this.ended) return resolve(null)
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped)
        resolve(null)
      }, timeoutMs)
      const wrapped = (m: any | null) => {
        clearTimeout(t)
        resolve(m)
      }
      this.waiters.push({ pred, resolve: wrapped })
    })
  }

  send(text: string): void {
    console.log(JSON.stringify({ s: this.name, SEND: text }))
    this.input.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: "probe",
    } as SDKUserMessage)
  }

  /** Send text, wait for endPred (default: result message), drain a little, return the turn's messages. */
  async turn(text: string, opts?: { endPred?: (m: any) => boolean; timeoutMs?: number; drainMs?: number }): Promise<any[]> {
    const startIdx = this.events.length
    const endPred = opts?.endPred ?? ((m) => m.type === "result")
    this.send(text)
    const end = await this.waitFor(endPred, opts?.timeoutMs ?? 120_000)
    if (!end) console.log(JSON.stringify({ s: this.name, TURN_TIMEOUT: text }))
    await new Promise((r) => setTimeout(r, opts?.drainMs ?? 1200))
    return this.events.slice(startIdx)
  }

  async close(): Promise<void> {
    this.input.close()
    await Promise.race([this.donePromise, new Promise((r) => setTimeout(r, 15_000))])
    this.abort.abort()
  }
}

const report: Record<string, unknown> = {}

// ================= Session A: settingSources [] (engine isolation mode) =================
async function sessionA(): Promise<void> {
  const s = new ProbeSession("A-iso", { settingSources: [] })
  try {
    const init = await s.q.initializationResult()
    const cmds = await s.q.supportedCommands()
    console.log(JSON.stringify({ s: s.name, initializationResult_commands_count: init.commands.length, output_style: init.output_style }))
    console.log(JSON.stringify({ s: s.name, supportedCommands_names: cmds.map((c) => c.name) }))
    console.log(JSON.stringify({ s: s.name, supportedCommands_full: cmds.map((c) => ({ name: c.name, argumentHint: c.argumentHint, aliases: c.aliases, description: trunc(c.description, 90) })) }))
    report.A_commands = cmds.map((c) => c.name)
    report.A_has_compact = cmds.some((c) => c.name === "compact")
    report.A_has_greet = cmds.some((c) => c.name === "greet")
    report.A_has_user_skill = cmds.some((c) => ["cloudflare", "wrangler", "agents-sdk"].includes(c.name))
    report.A_sample_shapes = cmds.filter((c) => ["compact", "greet", "cloudflare"].includes(c.name))

    const initMsg = s.events.find((m) => m.type === "system" && m.subtype === "init")
    report.A_init_slash_commands = initMsg?.slash_commands

    const t1 = await s.turn("/greet world")
    report.A_greet_reply = trunc(assistantText(t1), 400)
    report.A_greet_expanded = assistantText(t1).includes("BANANA")
    report.A_greet_msgtypes = t1.filter((m) => m.type !== "stream_event").map((m) => m.type + (m.subtype ? ":" + m.subtype : ""))
    report.A_greet_user_msgs = t1.filter((m) => m.type === "user").map((m) => summarize(m))
    report.A_greet_result = t1.filter((m) => m.type === "result").map((m) => summarize(m))

    const t2 = await s.turn("/xyzzy-not-real hello")
    report.A_unknown_msgtypes = t2.filter((m) => m.type !== "stream_event").map((m) => m.type + (m.subtype ? ":" + m.subtype : ""))
    report.A_unknown_reply = trunc(assistantText(t2), 400)
    report.A_unknown_system = t2.filter((m) => m.type === "system").map((m) => trunc(m, 500))
    report.A_unknown_result = t2.filter((m) => m.type === "result").map((m) => summarize(m))

    const t3 = await s.turn("please run /compact")
    report.A_midtext_msgtypes = t3.filter((m) => m.type !== "stream_event").map((m) => m.type + (m.subtype ? ":" + m.subtype : ""))
    report.A_midtext_compacted = t3.some((m) => m.type === "system" && (m.subtype === "compact_boundary" || (m.subtype === "status" && m.status === "compacting")))
    report.A_midtext_reply = trunc(assistantText(t3), 400)
  } finally {
    await s.close()
  }
}

// ================= Session B: settingSources unset (CLI defaults) =================
async function sessionB(): Promise<void> {
  const s = new ProbeSession("B-def", {})
  try {
    const cmds = await s.q.supportedCommands()
    console.log(JSON.stringify({ s: s.name, supportedCommands_names: cmds.map((c) => c.name) }))
    report.B_commands_count = cmds.length
    report.B_has_greet = cmds.some((c) => c.name === "greet")
    report.B_has_compact = cmds.some((c) => c.name === "compact")
    report.B_has_user_skill = cmds.some((c) => ["cloudflare", "wrangler", "agents-sdk"].includes(c.name))
    report.B_greet_entry = cmds.find((c) => c.name === "greet")
    report.B_compact_entry = cmds.find((c) => c.name === "compact")

    const t1 = await s.turn("/greet world")
    report.B_greet_reply = trunc(assistantText(t1), 400)
    report.B_greet_expanded = assistantText(t1).includes("BANANA")
    report.B_greet_msgtypes = t1.filter((m) => m.type !== "stream_event").map((m) => m.type + (m.subtype ? ":" + m.subtype : ""))
    report.B_greet_user_msgs = t1.filter((m) => m.type === "user").map((m) => summarize(m))

    const t2 = await s.turn("/xyzzy-not-real hello")
    report.B_unknown_msgtypes = t2.filter((m) => m.type !== "stream_event").map((m) => m.type + (m.subtype ? ":" + m.subtype : ""))
    report.B_unknown_reply = trunc(assistantText(t2), 400)
    report.B_unknown_system = t2.filter((m) => m.type === "system").map((m) => trunc(m, 500))
    report.B_unknown_result = t2.filter((m) => m.type === "result").map((m) => summarize(m))
  } finally {
    await s.close()
  }
}

// ================= Session C: /compact end-to-end =================
async function sessionC(): Promise<void> {
  const s = new ProbeSession("C-compact", { cwd: DIR_COMPACT, settingSources: [] })
  try {
    await s.turn("My favorite fruit is KIWI. Reply with just: OK")
    await s.turn("My favorite city is OSLO. Reply with just: OK")

    const compactEnd = (m: any) =>
      m.type === "result" || (m.type === "system" && m.subtype === "status" && ("compact_result" in m) && m.compact_result !== undefined)
    const t3 = await s.turn("/compact", { endPred: compactEnd, timeoutMs: 240_000, drainMs: 4000 })
    report.C_compact_sequence = t3.filter((m) => m.type !== "stream_event").map((m) => summarize(m))
    report.C_compact_boundary = t3.find((m) => m.type === "system" && m.subtype === "compact_boundary") ?? null
    report.C_compact_status_msgs = t3.filter((m) => m.type === "system" && m.subtype === "status").map((m) => trunc(m, 400))
    report.C_compact_had_result_msg = t3.some((m) => m.type === "result")
    report.C_compact_stream_event_count = t3.filter((m) => m.type === "stream_event").length

    const t4 = await s.turn("What is my favorite fruit? Answer with just the fruit name.")
    report.C_recall_reply = trunc(assistantText(t4), 300)
    report.C_recall_knows_kiwi = /kiwi/i.test(assistantText(t4))
  } finally {
    await s.close()
  }
}

async function withRetry(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.log(JSON.stringify({ RETRY: name, err: String(err) }))
    await fn()
  }
}

await withRetry("A", sessionA)
await withRetry("B", sessionB)
await withRetry("C", sessionC)

console.log("\n===== PROBE REPORT =====")
console.log(JSON.stringify(report, null, 2))
