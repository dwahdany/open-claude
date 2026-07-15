// Probe: SDK session resume + fork (same cwd). Run: bun test/probe-resume.ts
// Full raw message logs land in /tmp/oc-probe-resume-logs/<phase>.jsonl (+ summary.json).
//
// VERIFIED FINDINGS (run 2026-07-15, CLI 2.1.207, SDK 0.3.207, haiku-4-5):
// 1. Session id lives in the system/init message field `session_id`. EVERY stream message
//    carries `session_id` (stream_event, system:status, system:thinking_tokens, assistant,
//    result — missingSessionId was [] in every phase).
// 2. Lazy restart works: a fresh query() with options.resume=<id> + same cwd fully recalls
//    prior turns (codeword probe), including across bun/CLI process boundaries (phase H).
// 3. Plain resume KEEPS the same session id (init.session_id === resumed id) and appends to
//    the same transcript jsonl → repeated resumes reuse the ORIGINAL id every time.
// 4. forkSession: true + resume → NEW session id; history is physically COPIED into the new
//    <forkid>.jsonl; the fork recalls everything; the original stays unpolluted (resuming
//    the original after the fork: recalls its own turns, knows nothing of the fork's).
// 5. A resumed query emits NOTHING until the first user input: with a 12s-delayed prompt the
//    first message (system:init) arrived 8ms AFTER the push (silentUntilPrompt=true). No
//    history replay; no SDKUserMessageReplay (isReplay) frames ever appeared.
// 6. Transcript dir: ~/.claude/projects/<REALPATH(cwd) with "/"→"-">; macOS /tmp/x resolves
//    to /private/tmp/x → dir "-private-tmp-oc-probe-resume". Filename == <session_id>.jsonl.
// 7. resume with an unknown uuid: the stream yields exactly ONE message — result subtype
//    "error_during_execution", is_error:true, num_turns:0, session_id = the bogus id,
//    errors:["No conversation found with session ID: <id>"] — then the iterator THROWS
//    Error("Claude Code returned an error result: No conversation found with session ID:
//    <id>"). No init message is emitted.
// 8. Resume + includePartialMessages/systemPrompt preset: init on resume is IDENTICAL in
//    shape+values to a fresh init (same keys; only uuid differs; session_id per rule above);
//    partial stream_events flow normally. result.num_turns counts only the new process's
//    turns (1); history rides in as usage.cache_read_input_tokens (~24k for 2 prior turns).

import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { mkdirSync, readdirSync, statSync, existsSync } from "node:fs"

const CWD = "/tmp/oc-probe-resume"
const LOGDIR = "/tmp/oc-probe-resume-logs"
const MODEL = "claude-haiku-4-5-20251001"

mkdirSync(CWD, { recursive: true })
mkdirSync(LOGDIR, { recursive: true })

// ---- streaming input queue (copied from src/engine.ts convention) ----
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

function makeUser(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  } as SDKUserMessage
}

interface PhaseResult {
  label: string
  init: any | null
  resultMsg: any | null
  resultText: string | null
  error: string | null
  prePrompt: string[] // compact ids of messages that arrived BEFORE we pushed the prompt
  replayMsgs: string[] // compact ids of messages with isReplay: true (any time)
  sessionIds: Record<string, number> // distinct session_id values → count of messages carrying it
  missingSessionId: string[] // compact ids of messages WITHOUT a session_id field
  nMessages: number
  promptAtMs: number // ms after query() when the prompt was pushed
  times: { t: number; m: string }[] // ms after query() for each received message
}

function compact(m: any): string {
  let s = m.type
  if (m.subtype) s += `:${m.subtype}`
  if (m.type === "stream_event") s += `:${m.event?.type}`
  if (m.isReplay) s += ":REPLAY"
  return s
}

async function runPhase(opts: {
  label: string
  prompt: string
  extra?: Partial<Options>
  delayPromptMs?: number
  timeoutMs?: number
}): Promise<PhaseResult> {
  const input = new InputQueue()
  const abort = new AbortController()
  const options: Options = {
    cwd: CWD,
    model: MODEL,
    permissionMode: "default",
    includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    abortController: abort,
    ...(opts.extra ?? {}),
  }
  const res: PhaseResult = {
    label: opts.label,
    init: null,
    resultMsg: null,
    resultText: null,
    error: null,
    prePrompt: [],
    replayMsgs: [],
    sessionIds: {},
    missingSessionId: [],
    nMessages: 0,
    promptAtMs: -1,
    times: [],
  }
  const raw: any[] = []
  console.log(`\n===== phase ${opts.label}: prompt=${JSON.stringify(opts.prompt)} extra=${JSON.stringify(opts.extra ?? {})} delay=${opts.delayPromptMs ?? 0}ms`)
  const t0 = performance.now()
  const q = query({ prompt: input, options })
  let promptSent = false
  const sendPrompt = () => {
    promptSent = true
    res.promptAtMs = Math.round(performance.now() - t0)
    input.push(makeUser(opts.prompt))
    console.log(`[${opts.label}] >>> prompt pushed at +${res.promptAtMs}ms`)
  }
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  if (opts.delayPromptMs) delayTimer = setTimeout(sendPrompt, opts.delayPromptMs)
  else sendPrompt()
  const killer = setTimeout(() => {
    console.log(`[${opts.label}] !!! timeout — aborting`)
    input.close()
    abort.abort()
  }, opts.timeoutMs ?? 120_000)
  try {
    for await (const m of q as AsyncIterable<any>) {
      raw.push(m)
      res.nMessages++
      res.times.push({ t: Math.round(performance.now() - t0), m: compact(m) })
      if ("session_id" in m && typeof m.session_id === "string") {
        res.sessionIds[m.session_id] = (res.sessionIds[m.session_id] ?? 0) + 1
      } else {
        res.missingSessionId.push(compact(m))
      }
      if (!promptSent) res.prePrompt.push(compact(m))
      if (m.isReplay) res.replayMsgs.push(compact(m))
      if (m.type === "system" && m.subtype === "init") res.init = m
      if (m.type === "result") {
        res.resultMsg = m
        res.resultText = typeof m.result === "string" ? m.result : null
        input.close() // end of turn → close input so the CLI exits and the loop ends
      }
      console.log(`[${opts.label}] ${compact(m)}${m.type === "result" ? " result=" + JSON.stringify(m.result ?? m.subtype) : ""}`)
    }
  } catch (e: any) {
    res.error = JSON.stringify({ name: e?.name, message: e?.message, stderr: e?.stderr, code: e?.code, exitCode: e?.exitCode, str: String(e) })
    console.log(`[${opts.label}] THREW: ${res.error}`)
  } finally {
    clearTimeout(killer)
    if (delayTimer) clearTimeout(delayTimer)
    input.close()
    abort.abort()
  }
  await Bun.write(`${LOGDIR}/${opts.label}.jsonl`, raw.map((m) => JSON.stringify(m)).join("\n") + "\n")
  return res
}

// retry-once wrapper for transient API flakes (not used for the intentional-error phase)
async function runPhaseRetry(opts: Parameters<typeof runPhase>[0]): Promise<PhaseResult> {
  const first = await runPhase(opts)
  const flaky = first.error !== null || (first.resultMsg && first.resultMsg.subtype !== "success")
  if (!flaky) return first
  console.log(`[${opts.label}] transient failure — retrying once`)
  return runPhase({ ...opts, label: opts.label + "-retry" })
}

const summary: Record<string, unknown> = {}

// ---- Phase A: fresh session, plant codeword ----
const A = await runPhaseRetry({
  label: "A-fresh",
  prompt: "Remember the codeword: PLUM. Reply with exactly: OK",
})
const idA: string = A.init?.session_id
summary.A = { initSessionId: idA, result: A.resultText, sessionIds: A.sessionIds, missingSessionId: [...new Set(A.missingSessionId)], initUuidPresent: !!A.init?.uuid }
if (!idA) {
  console.log("FATAL: no session id from phase A; aborting probe")
  console.log(JSON.stringify(summary, null, 2))
  process.exit(1)
}

// ---- Phase B: resume idA, DELAY the prompt 4s to see whether history replays at startup ----
const B = await runPhaseRetry({
  label: "B-resume",
  prompt: "Remember a second codeword: MANGO. What was the first codeword? Reply with just the first codeword.",
  extra: { resume: idA },
  delayPromptMs: 4000,
})
const idB: string = B.init?.session_id
summary.B = {
  resumedFrom: idA,
  initSessionId: idB,
  sameIdAsA: idB === idA,
  recalledPLUM: (B.resultText ?? "").includes("PLUM"),
  result: B.resultText,
  prePromptMessages: B.prePrompt,
  replayMsgs: B.replayMsgs,
  sessionIds: B.sessionIds,
}

// ---- Phase C: repeated resume — which id carries the accumulated history? ----
const lastId = idB ?? idA
const C = await runPhaseRetry({
  label: "C-resume-again",
  prompt: "Reply with all codewords you have been told, in order, separated by single spaces, and nothing else.",
  extra: { resume: idB === idA ? idA : lastId },
})
const idC: string = C.init?.session_id
summary.C = {
  resumedFrom: idB === idA ? idA : lastId,
  initSessionId: idC,
  result: C.resultText,
  hasBoth: (C.resultText ?? "").includes("PLUM") && (C.resultText ?? "").includes("MANGO"),
}
// If resume MINTED a new id in B, also check whether the ORIGINAL id still resumes to just turn-1 state.
if (idB !== idA) {
  const C2 = await runPhaseRetry({
    label: "C2-resume-original",
    prompt: "Reply with all codewords you have been told, in order, separated by single spaces, and nothing else.",
    extra: { resume: idA },
  })
  summary.C2 = { resumedFrom: idA, initSessionId: C2.init?.session_id, result: C2.resultText }
}

// ---- Phase D: forkSession: true + resume original id ----
const D = await runPhaseRetry({
  label: "D-fork",
  prompt: "Remember a third codeword: OTTER. Reply with all codewords you have been told, in order, separated by single spaces, and nothing else.",
  extra: { resume: idA, forkSession: true },
})
const idD: string = D.init?.session_id
summary.D = {
  forkedFrom: idA,
  initSessionId: idD,
  newIdMinted: idD !== idA,
  recalledPriorCodewords: (D.resultText ?? "").includes("PLUM"),
  result: D.resultText,
  prePromptMessages: D.prePrompt,
  replayMsgs: D.replayMsgs,
}

// ---- Phase E: resume ORIGINAL id after the fork — intact and unpolluted? ----
const E = await runPhaseRetry({
  label: "E-original-after-fork",
  prompt: "Do you know a codeword OTTER? Reply YES or NO, then a space, then all codewords you know, in order, separated by single spaces.",
  extra: { resume: idA },
})
summary.E = {
  resumedFrom: idA,
  initSessionId: E.init?.session_id,
  result: E.resultText,
  knowsOTTER: (E.resultText ?? "").toUpperCase().startsWith("YES"),
  stillHasPLUMandMANGO: (E.resultText ?? "").includes("PLUM") && (E.resultText ?? "").includes("MANGO"),
}

// ---- Phase G: timing — resume with a LONG (12s) prompt delay: does a resumed query emit
// anything (init / history replay) before the first input, or stay fully silent? ----
const G = await runPhaseRetry({
  label: "G-timing",
  prompt: "Reply with exactly: OK",
  extra: { resume: idA },
  delayPromptMs: 12_000,
})
summary.G = {
  promptAtMs: G.promptAtMs,
  firstMessageAtMs: G.times[0]?.t ?? null,
  initAtMs: G.times.find((x) => x.m === "system:init")?.t ?? null,
  prePromptMessages: G.prePrompt,
  firstTimes: G.times.slice(0, 6),
  silentUntilPrompt: (G.times[0]?.t ?? 0) > G.promptAtMs,
}

// ---- Phase H: cross-process resume — resume a session id captured by a PREVIOUS run of
// this script (from summary.json), proving lazy restart across bun processes. ----
const prevSummaryFile = Bun.file(`${LOGDIR}/summary.json`)
if (await prevSummaryFile.exists()) {
  const prev = await prevSummaryFile.json()
  const prevId = prev?.disk?.idA
  if (prevId && prevId !== idA) {
    const H = await runPhaseRetry({
      label: "H-cross-process",
      prompt: "Reply with all codewords you have been told, in order, separated by single spaces, and nothing else.",
      extra: { resume: prevId },
    })
    summary.H = { resumedFrom: prevId, initSessionId: H.init?.session_id, result: H.resultText }
  }
}

// ---- Phase F: bogus uuid resume ----
const F = await runPhase({
  label: "F-bogus-resume",
  prompt: "Reply with exactly: OK",
  extra: { resume: "00000000-0000-4000-8000-000000000000" },
  timeoutMs: 60_000,
})
summary.F = {
  error: F.error,
  init: F.init ? { session_id: F.init.session_id } : null,
  resultMsg: F.resultMsg
    ? { subtype: F.resultMsg.subtype, is_error: F.resultMsg.is_error, result: F.resultMsg.result, errors: F.resultMsg.errors }
    : null,
  nMessages: F.nMessages,
}

// ---- init-message diff: fresh vs resume vs fork ----
function initShape(init: any): Record<string, unknown> {
  if (!init) return { missing: true }
  const { uuid, session_id, tools, slash_commands, skills, ...rest } = init
  return { ...rest, tools_count: tools?.length, slash_commands_count: slash_commands?.length, skills_count: skills?.length }
}
summary.initDiff = {
  A: initShape(A.init),
  B: initShape(B.init),
  D: initShape(D.init),
  keysA: A.init ? Object.keys(A.init).sort() : null,
  keysB: B.init ? Object.keys(B.init).sort() : null,
  keysD: D.init ? Object.keys(D.init).sort() : null,
}

// ---- transcript dir on disk ----
const projects = `${process.env.HOME}/.claude/projects`
const dirs = readdirSync(projects).filter((d) => d.includes("oc-probe-resume"))
const diskInfo: Record<string, unknown> = { matchingDirs: dirs }
for (const d of dirs) {
  const full = `${projects}/${d}`
  const entries = readdirSync(full)
  diskInfo[d] = entries.map((f) => {
    const st = statSync(`${full}/${f}`)
    return { name: f, size: st.size, isDir: st.isDirectory() }
  })
}
diskInfo.idA = idA
diskInfo.idD_fork = idD
diskInfo.fileForIdA = dirs.some((d) => existsSync(`${projects}/${d}/${idA}.jsonl`))
diskInfo.fileForIdD = dirs.some((d) => existsSync(`${projects}/${d}/${idD}.jsonl`))
summary.disk = diskInfo

console.log("\n===== SUMMARY =====")
console.log(JSON.stringify(summary, null, 2))
await Bun.write(`${LOGDIR}/summary.json`, JSON.stringify(summary, null, 2))
