// Probe: CLI-side model switching vs the shim's model tracking (/model passthrough,
// init.model, message_start.message.model, setModel re-assert).
// Run: bun run test/probe-model-switch.ts   (requires authenticated Claude Code CLI)
//
// Questions this answers (drives the model-desync fix in src/engine.ts + src/server.ts):
// 1. Is "model" in supportedCommands (i.e. does the TUI route "/model X" via POST
//    /session/:id/command rather than as plain prompt text)?
// 2. What does a passthrough "/model <id>" turn emit, and does it actually switch the
//    session's model?
// 3. After a CLI-side switch, what do system/init.model (next turn) and
//    stream_event message_start event.message.model (per API call) report?
// 4. Does Query.setModel(<original>) re-assert over a CLI-side /model switch?
// 5. What does bare "/model" print headless?

import { query, type Options, type PermissionResult, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { mkdirSync } from "node:fs"

const BASE = "claude-haiku-4-5-20251001"
const OTHER = "claude-sonnet-5"
const DIR = "/tmp/oc-probe-model-switch"
mkdirSync(DIR, { recursive: true })

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

function trunc(v: unknown, max = 400): unknown {
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
    if (ev.type === "message_start") line.model = ev.message?.model
    return line
  }
  if (m.type === "assistant" || m.type === "user") {
    const c = m.message?.content
    const text = Array.isArray(c)
      ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
      : typeof c === "string" ? c : ""
    const line: Record<string, unknown> = { type: m.type, model: m.message?.model, text: trunc(text, 500) }
    if (m.isSynthetic !== undefined) line.isSynthetic = m.isSynthetic
    if (m.isReplay !== undefined) line.isReplay = m.isReplay
    return line
  }
  if (m.type === "system" && m.subtype === "init") return { type: "system:init", model: m.model, permissionMode: m.permissionMode }
  if (m.type === "result") return { type: "result", subtype: m.subtype, num_turns: m.num_turns, modelUsage_keys: Object.keys(m.modelUsage ?? {}), result: trunc(m.result, 300) }
  return trunc({ type: m.type, subtype: m.subtype }, 200) as Record<string, unknown>
}

const input = new InputQueue()
const abort = new AbortController()
const events: any[] = []
const waiters: { pred: (m: any) => boolean; resolve: (m: any | null) => void }[] = []
let ended = false

const options: Options = {
  cwd: DIR,
  model: BASE,
  permissionMode: "default",
  includePartialMessages: true,
  abortController: abort,
  systemPrompt: { type: "preset", preset: "claude_code" },
  settingSources: [],
  canUseTool: (): Promise<PermissionResult> => Promise.resolve({ behavior: "deny", message: "probe: tools disabled" }),
}
const q = query({ prompt: input, options })

const done = (async () => {
  try {
    for await (const m of q as AsyncIterable<any>) {
      events.push(m)
      console.log(JSON.stringify(summarize(m)))
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(m)
        }
      }
    }
  } catch (err) {
    console.log(JSON.stringify({ streamError: String(err) }))
  } finally {
    ended = true
    for (const w of waiters) w.resolve(null)
  }
})()

function waitFor(pred: (m: any) => boolean, timeoutMs = 120_000): Promise<any | null> {
  return new Promise((resolve) => {
    if (ended) return resolve(null)
    const t = setTimeout(() => resolve(null), timeoutMs)
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
  })
}

async function turn(text: string): Promise<any[]> {
  const start = events.length
  console.log(JSON.stringify({ SEND: text }))
  input.push({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null } as SDKUserMessage)
  await waitFor((m) => m.type === "result")
  await Bun.sleep(800)
  return events.slice(start)
}

const report: Record<string, unknown> = {}
const initModel = (msgs: any[]) => msgs.find((m) => m.type === "system" && m.subtype === "init")?.model
const startModels = (msgs: any[]) => msgs.filter((m) => m.type === "stream_event" && m.event?.type === "message_start").map((m) => m.event.message?.model)
const asstModels = (msgs: any[]) => msgs.filter((m) => m.type === "assistant").map((m) => m.message?.model)

// Q1: is "model" a supported command?
const cmds = await q.supportedCommands()
report.q1_has_model_command = cmds.some((c) => c.name === "model")
report.q1_model_entry = cmds.find((c) => c.name === "model") ?? null

// Baseline turn on BASE.
const t1 = await turn("Reply with just: OK")
report.t1_init_model = initModel(t1)
report.t1_message_start_models = startModels(t1)

// Q2: passthrough /model switch.
const t2 = await turn(`/model ${OTHER}`)
report.t2_msgs = t2.filter((m) => m.type !== "stream_event").map((m) => summarize(m))
report.t2_init_model = initModel(t2)

// Q3: next plain turn — what model actually serves, what does init say?
const t3 = await turn("Reply with just: OK")
report.t3_init_model = initModel(t3)
report.t3_message_start_models = startModels(t3)
report.t3_assistant_models = asstModels(t3)
report.q2_switch_took_effect = startModels(t3).some((m) => typeof m === "string" && m.includes("sonnet"))

// Q4: setModel re-assert.
await q.setModel(BASE)
const t4 = await turn("Reply with just: OK")
report.t4_init_model = initModel(t4)
report.t4_message_start_models = startModels(t4)
report.q4_setmodel_reasserted = startModels(t4).some((m) => typeof m === "string" && m.includes("haiku"))

// Q5: bare /model headless.
const t5 = await turn("/model")
report.t5_msgs = t5.filter((m) => m.type !== "stream_event").map((m) => summarize(m))

input.close()
await Promise.race([done, Bun.sleep(10_000)])
abort.abort()

console.log("\n===== PROBE REPORT =====")
console.log(JSON.stringify(report, null, 2))
