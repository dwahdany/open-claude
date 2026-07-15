// Probe: Options.resume ACROSS a cwd change (the /move mechanism).
// Run: bun test/probe-cross-cwd-resume.ts   (findings summary appended to this header after runs)
//
// Phases:
//   P1 create session in /tmp/oc-probe-move-a (codeword MANGO), capture session id
//   P2 resume that id with cwd /tmp/oc-probe-move-b WITHOUT copying anything → outcome?
//   P3 if P2 failed/lost context: copy <id>.jsonl into cwd-B's munged project dir, resume again
//   P4 resumed cwd-B session + permissionMode bypassPermissions: Bash pwd → runs in dir B?
//   P5 resume the ORIGINAL id from cwd A again (same id in two project dirs — conflict?)
//
// VERIFIED FINDINGS (2026-07-15, SDK 0.3.207 / CLI 2.1.207, model claude-haiku-4-5):
//   * resume is scoped to the project dir derived from the CURRENT cwd. P2 (resume from
//     cwd B, nothing copied) fails deterministically (retried): result subtype
//     "error_during_execution", errors ["No conversation found with session ID: <id>"],
//     num_turns 0, NO init message, and the SDK iterator throws
//     "Error: Claude Code returned an error result: No conversation found...". It is NOT
//     a silent new session.
//   * /move fix: copy ONLY <id>.jsonl from projects/<munge(realpath(oldCwd))>/ into
//     projects/<munge(realpath(newCwd))>/ (mkdir -p it; the dir does not pre-exist and a
//     failed resume does not create it). After the copy, resume from cwd B succeeds with
//     the SAME session id (init.session_id === id) and the codeword survives.
//     (Sessions that spawned subagents also have a <projects>/<dir>/<id>/subagents/ tree —
//     not exercised here; copy it too if present.)
//   * Project-dir munge: realpath(cwd) with every [^A-Za-z0-9] → "-",
//     e.g. /tmp/oc-probe-move-a → -private-tmp-oc-probe-move-a (macOS /tmp symlink resolved).
//   * P4 acceptance: resume in cwd B + permissionMode "bypassPermissions" +
//     allowDangerouslySkipPermissions: true → Bash pwd executed and printed
//     /private/tmp/oc-probe-move-b. (SDK warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED that
//     canUseTool is never consulted in bypass mode.)
//   * New turns append to the jsonl in the CWD-DERIVED project dir only: after P3/P4 the
//     B copy grew 10→26 lines while A stayed at 10. The copies FORK: P5 (resume from A)
//     still works and remembers MANGO but never saw the pwd turn (A file 10→17 lines,
//     B unchanged). Same id in two project dirs = no error, silent divergence. A real
//     /move should delete the source file after copying.
//   * listSessions({dir}) lists the id under BOTH dirs after the copy (SDKSessionInfo.cwd
//     reports the ORIGINAL cwd for both — derived from early transcript entries);
//     getSessionInfo(id) with no dir global-searches and returns the first hit. Every
//     user/assistant transcript entry carries a per-entry "cwd" field.
//   * No SDK option points resume at a transcript path. Relevant Options: resume (id),
//     forkSession, sessionId (custom UUID), resumeSessionAt (msg uuid), continue (latest
//     in cwd), persistSession, sessionStore (alpha, external store). Helpers: listSessions,
//     getSessionInfo, getSessionMessages, forkSession, deleteSession, listSubagents.

import { query, type Options, type PermissionResult, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { $ } from "bun"
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MODEL = "claude-haiku-4-5-20251001"
const DIR_A = "/tmp/oc-probe-move-a"
const DIR_B = "/tmp/oc-probe-move-b"
const PROJECTS = join(homedir(), ".claude", "projects")
const NEEDLE = "oc-probe-move"

// ---- harness (engine.ts conventions) ----

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

function log(label: string, obj: unknown): void {
  console.log(`${label} ${JSON.stringify(obj)}`)
}

// One evidence line per SDK message, trimmed to the salient fields.
function slim(m: any): Record<string, unknown> {
  const line: Record<string, unknown> = { type: m.type }
  if (m.subtype) line.subtype = m.subtype
  if (m.type === "stream_event") line.event = m.event?.type
  if (m.type === "system" && m.subtype === "init") {
    line.session_id = m.session_id
    line.cwd = m.cwd
    line.model = m.model
    line.permissionMode = m.permissionMode
    line.apiKeySource = m.apiKeySource
  }
  if (m.type === "assistant" || m.type === "user") {
    const c = m.message?.content
    line.blocks = Array.isArray(c)
      ? c.map((b: any) => (b.type === "text" ? `text:${String(b.text).slice(0, 200)}` : b.type === "tool_use" ? `tool_use:${b.name}:${JSON.stringify(b.input).slice(0, 200)}` : b.type === "tool_result" ? `tool_result:${JSON.stringify(b.content).slice(0, 200)}` : b.type)).join(" | ")
      : typeof c === "string"
        ? `str:${c.slice(0, 200)}`
        : typeof c
    line.session_id = m.session_id
    if (m.parent_tool_use_id) line.ptid = m.parent_tool_use_id
  }
  if (m.type === "result") {
    line.session_id = m.session_id
    line.is_error = m.is_error
    line.num_turns = m.num_turns
    if (m.result !== undefined) line.result = String(m.result).slice(0, 400)
    if (m.errors?.length) line.errors = m.errors
    if (m.terminal_reason) line.terminal_reason = m.terminal_reason
  }
  return line
}

interface PhaseResult {
  label: string
  initSessionIds: string[]
  initCwds: string[]
  results: { subtype: string; result?: string; errors?: string[]; session_id: string }[]
  assistantTexts: string[]
  toolUses: { name: string; input: unknown }[]
  error?: string
  stderrTail?: string
}

function userMsg(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage
}

// Mirrors src/engine.ts startQuery(): streaming input, claude_code preset, settingSources [].
async function runPhase(label: string, prompts: string[], opts: Partial<Options>): Promise<PhaseResult> {
  const input = new InputQueue()
  const abort = new AbortController()
  const stderrBuf: string[] = []
  const res: PhaseResult = { label, initSessionIds: [], initCwds: [], results: [], assistantTexts: [], toolUses: [] }
  const options: Options = {
    model: MODEL,
    permissionMode: "default",
    includePartialMessages: true,
    forwardSubagentText: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    abortController: abort,
    stderr: (d: string) => stderrBuf.push(d),
    canUseTool: (toolName: string, toolInput: Record<string, unknown>): Promise<PermissionResult> => {
      log(label, { canUseTool: toolName, input: toolInput })
      return Promise.resolve({ behavior: "allow" })
    },
    ...opts,
  }
  log(label, { phase_options: { cwd: options.cwd, resume: options.resume, permissionMode: options.permissionMode, forkSession: (options as any).forkSession } })
  let turn = 0
  input.push(userMsg(prompts[0]!))
  const q = query({ prompt: input, options })
  const watchdog = setTimeout(() => {
    res.error = (res.error ?? "") + "[watchdog 240s abort]"
    abort.abort()
  }, 240_000)
  try {
    for await (const m of q as AsyncIterable<any>) {
      log(label, slim(m))
      if (m.type === "system" && m.subtype === "init") {
        res.initSessionIds.push(m.session_id)
        res.initCwds.push(m.cwd)
      }
      if (m.type === "assistant" && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
        const text = m.message.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => String(b.text ?? ""))
          .join("\n")
        if (text) res.assistantTexts.push(text)
        for (const b of m.message.content) if (b?.type === "tool_use") res.toolUses.push({ name: b.name, input: b.input })
      }
      if (m.type === "result") {
        res.results.push({ subtype: m.subtype, result: m.result, errors: m.errors, session_id: m.session_id })
        turn++
        if (turn < prompts.length) input.push(userMsg(prompts[turn]!))
        else input.close()
      }
    }
  } catch (e) {
    res.error = (res.error ?? "") + String(e)
  } finally {
    clearTimeout(watchdog)
    input.close()
    abort.abort()
  }
  if (res.error) {
    res.stderrTail = stderrBuf.join("").slice(-3000)
    log(label, { phase_error: res.error, stderr_tail: res.stderrTail })
  }
  log(label, { phase_summary: { initSessionIds: res.initSessionIds, initCwds: res.initCwds, results: res.results, assistantTexts: res.assistantTexts, toolUses: res.toolUses } })
  return res
}

// ---- filesystem evidence ----

function probeProjectDirs(): string[] {
  if (!existsSync(PROJECTS)) return []
  return readdirSync(PROJECTS).filter((d) => d.includes(NEEDLE))
}

function findTranscripts(id: string): string[] {
  const hits: string[] = []
  for (const d of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, d, `${id}.jsonl`)
    if (existsSync(p)) hits.push(p)
  }
  return hits
}

async function snapshot(tag: string): Promise<void> {
  const out: Record<string, unknown> = {}
  for (const d of probeProjectDirs()) {
    const dir = join(PROJECTS, d)
    const files: Record<string, unknown> = {}
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      const st = statSync(p)
      if (st.isDirectory()) files[f + "/"] = readdirSync(p)
      else if (f.endsWith(".jsonl")) files[f] = { bytes: st.size, lines: (await Bun.file(p).text()).split("\n").filter(Boolean).length }
      else files[f] = { bytes: st.size }
    }
    out[d] = files
  }
  log("SNAPSHOT", { tag, projects: out })
}

// ---- main ----

const pgrepBefore = (await $`pgrep -f claude`.nothrow().text()).trim().split("\n").filter(Boolean)

// P0: fresh dirs + clean slate for probe-derived project dirs only.
for (const d of [DIR_A, DIR_B]) {
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  await $`git -C ${d} init -q`
}
for (const d of probeProjectDirs()) rmSync(join(PROJECTS, d), { recursive: true, force: true })
log("P0", { dirs: [DIR_A, DIR_B], realpaths: [realpathSync(DIR_A), realpathSync(DIR_B)], cleanedProjectDirs: true })

// P1: create session in A.
let p1 = await runPhase("P1", ["Remember the codeword: MANGO. Reply OK."], { cwd: DIR_A })
if (p1.error || p1.results[0]?.subtype !== "success") {
  log("P1", { retrying: true })
  p1 = await runPhase("P1retry", ["Remember the codeword: MANGO. Reply OK."], { cwd: DIR_A })
}
const id1 = p1.initSessionIds[0]
if (!id1) {
  log("FATAL", { msg: "no session id from P1", error: p1.error })
  process.exit(1)
}
await snapshot("after-P1")
log("P1", { id1, transcripts: findTranscripts(id1) })

// P2: resume from B with NO copying.
let p2 = await runPhase("P2", ["What is the codeword? Reply with just the codeword."], { cwd: DIR_B, resume: id1 })
if (p2.error) {
  log("P2", { retrying_to_confirm_deterministic: true })
  p2 = await runPhase("P2retry", ["What is the codeword? Reply with just the codeword."], { cwd: DIR_B, resume: id1 })
}
await snapshot("after-P2")
const p2Text = [...p2.assistantTexts, ...p2.results.map((r) => r.result ?? "")].join(" ")
const p2HasCodeword = p2Text.includes("MANGO")
const p2SameId = p2.initSessionIds[0] === id1
log("P2", { verdict: { error: p2.error ?? null, sameSessionId: p2SameId, initSessionId: p2.initSessionIds[0] ?? null, codewordSurvived: p2HasCodeword } })

// P3: only if P2 failed or lost context — copy the transcript into B's munged dir and retry.
let p3: PhaseResult | null = null
if (!p2HasCodeword) {
  const realB = realpathSync(DIR_B)
  const mungedB = realB.replace(/[^a-zA-Z0-9]/g, "-")
  const bProjDir = join(PROJECTS, mungedB)
  const src = findTranscripts(id1)[0]
  log("P3", { bProjDir, existedBeforeCopy: existsSync(bProjDir), src, srcSiblingsForSession: src ? readdirSync(join(src, "..")).filter((f) => f.includes(id1)) : [] })
  mkdirSync(bProjDir, { recursive: true })
  if (src) copyFileSync(src, join(bProjDir, `${id1}.jsonl`))
  const subDir = src?.replace(/\.jsonl$/, "")
  if (subDir && existsSync(subDir)) log("P3", { subagentDirExists: true, contents: readdirSync(subDir) })
  await snapshot("after-copy")
  p3 = await runPhase("P3", ["What is the codeword? Reply with just the codeword."], { cwd: DIR_B, resume: id1 })
  if (p3.error) p3 = await runPhase("P3retry", ["What is the codeword? Reply with just the codeword."], { cwd: DIR_B, resume: id1 })
  await snapshot("after-P3")
  const t = [...p3.assistantTexts, ...p3.results.map((r) => r.result ?? "")].join(" ")
  log("P3", { verdict: { error: p3.error ?? null, sameSessionId: p3.initSessionIds[0] === id1, codewordSurvived: t.includes("MANGO") } })
} else {
  log("P3", { skipped: "P2 already resumed with context intact; no copy needed" })
}

// P4: acceptance for /move — bypassPermissions turn in cwd B must run Bash pwd in B.
let p4 = await runPhase("P4", ["Use the Bash tool to run pwd and reply with just its output."], {
  cwd: DIR_B,
  resume: id1,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
})
if (p4.error || p4.results[0]?.subtype !== "success") {
  p4 = await runPhase("P4retry", ["Use the Bash tool to run pwd and reply with just its output."], {
    cwd: DIR_B,
    resume: id1,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  })
}
await snapshot("after-P4")
const p4Text = [...p4.assistantTexts, ...p4.results.map((r) => r.result ?? "")].join(" ")
log("P4", { verdict: { error: p4.error ?? null, sameSessionId: p4.initSessionIds[0] === id1, pwdInB: p4Text.includes("oc-probe-move-b"), text: p4Text.slice(0, 300) } })

// P5: resume the original id from cwd A again.
let p5 = await runPhase("P5", ["What is the codeword? And what directory did the pwd command print earlier? Reply in one short line."], { cwd: DIR_A, resume: id1 })
if (p5.error) p5 = await runPhase("P5retry", ["What is the codeword? And what directory did the pwd command print earlier? Reply in one short line."], { cwd: DIR_A, resume: id1 })
await snapshot("after-P5")
const p5Text = [...p5.assistantTexts, ...p5.results.map((r) => r.result ?? "")].join(" ")
log("P5", { verdict: { error: p5.error ?? null, sameSessionId: p5.initSessionIds[0] === id1, codewordSurvived: p5Text.includes("MANGO"), text: p5Text.slice(0, 300) } })

// Cleanup check: no stray claude processes we created.
const pgrepAfter = (await $`pgrep -f claude`.nothrow().text()).trim().split("\n").filter(Boolean)
const newPids = pgrepAfter.filter((p) => !pgrepBefore.includes(p))
for (const pid of newPids) {
  const cwd = (await $`lsof -a -p ${pid} -d cwd -Fn`.nothrow().text()).trim()
  if (cwd.includes(NEEDLE)) {
    await $`kill ${pid}`.nothrow()
    log("CLEANUP", { killed: pid, cwd })
  } else {
    log("CLEANUP", { spared_unrelated_new_pid: pid, cwd })
  }
}
log("DONE", { newClaudePids: newPids.length })
