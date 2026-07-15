// Live E2E: the custom-commands bridge + real /compact (docs/contract/09 §1-2, §5).
// Run: bun test/live-commands.ts   (needs Claude auth; model claude-haiku-4-5, tiny prompts)
//
// Spawns a real server (`bun run index.ts`) WITHOUT OPENCLAUDE_SETTING_SOURCES so project
// .claude/commands load, against a scratch git repo containing commands/greet.md, with an
// ISOLATED XDG_DATA_HOME. Scenarios: S1 GET /command (greet + compact present, TUI-palette
// names filtered, opencode Command shape), S2 POST .../command greet → CLI-side template
// expansion (BANANA) + persisted turn, S3 unknown command → 400 {"_tag":"BadRequest"} +
// session.error SSE + session stays usable, S4 real compact via POST .../summarize →
// reference wire shape (compaction part + summary-flagged assistant, no stdout/synthetic
// artifacts) + post-compact recall, S5 typed /compact via POST .../command → same effect,
// S6 SIGKILL + restart → the compacted CLI session resumes with memory intact.
// Prints PASS/FAIL per check, exits nonzero on failure.

import { mkdirSync, readdirSync, rmSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-commands-${TS}`
const STATE = `/tmp/oc-live-commands-${TS}-state`
const PORT = 43150 + (TS % 400)
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }
const MODEL_STR = `${MODEL.providerID}/${MODEL.modelID}`
const PROJECTS = join(homedir(), ".claude", "projects")

/** Same munge rule as the Claude CLI / src/store.ts. */
const munge = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "-")

let failures = 0
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const procs: ReturnType<typeof Bun.spawn>[] = []

async function startServer(port: number, directory: string): Promise<{ base: string; proc: ReturnType<typeof Bun.spawn> }> {
  const env: Record<string, string | undefined> = { ...process.env, XDG_DATA_HOME: STATE }
  delete env.OPENCLAUDE_SETTING_SOURCES // default setting sources: project commands MUST load
  const proc = Bun.spawn(["bun", "run", "index.ts", "--port", String(port), "--directory", directory], {
    cwd: ROOT,
    env,
    stdout: "ignore",
    stderr: "inherit",
  })
  procs.push(proc)
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/global/health`)
      if (r.ok) return { base, proc }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100)
  }
  throw new Error(`server on :${port} never became healthy`)
}

async function api(base: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(base + path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const post = (base: string, path: string, body?: unknown) =>
  api(base, path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })

/** Raw request when the STATUS CODE is the assertion (expected 400s). */
const raw = (base: string, path: string, method: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })

const textOf = (parts: any[]): string =>
  (parts ?? [])
    .filter((p: any) => p?.type === "text" && p.text)
    .map((p: any) => p.text)
    .join("\n")

/** Blocking prompt; returns the final assistant text. Retries ONCE on flaky/failed turns. */
async function promptExpect(base: string, sessionID: string, text: string, want: (reply: string) => boolean): Promise<{ ok: boolean; got: string }> {
  let got = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await post(base, `/session/${sessionID}/message`, { agent: "build", model: MODEL, parts: [{ type: "text", text }] })
      got = textOf(res?.parts)
      if (want(got)) return { ok: true, got }
      if (res?.info?.error) got += ` [error: ${JSON.stringify(res.info.error)}]`
    } catch (e) {
      got = `threw: ${String(e)}`
    }
    if (attempt === 0) console.log(`  (flaky turn, retrying once: ${JSON.stringify(got).slice(0, 160)})`)
  }
  return { ok: false, got }
}

/** Blocking POST /session/:id/command; retries ONCE on a flaky turn. */
async function commandExpect(base: string, sessionID: string, body: Record<string, unknown>, want: (reply: string, res: any) => boolean): Promise<{ ok: boolean; got: string; res: any }> {
  let got = ""
  let res: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await post(base, `/session/${sessionID}/command`, body)
      got = textOf(res?.parts)
      if (want(got, res)) return { ok: true, got, res }
    } catch (e) {
      got = `threw: ${String(e)}`
    }
    if (attempt === 0) console.log(`  (flaky command, retrying once: ${JSON.stringify(got).slice(0, 160)})`)
  }
  return { ok: false, got, res }
}

interface CapturedEvent {
  type: string
  properties: any
}

/** Capture every /global/event frame emitted while run() executes. */
async function collectEvents(base: string, run: () => Promise<void>): Promise<CapturedEvent[]> {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/global/event`, { signal: ctrl.signal })
  const reader = res.body!.getReader()
  const events: CapturedEvent[] = []
  const dec = new TextDecoder()
  let buf = ""
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (!frame.startsWith("data: ")) continue
          try {
            const evt = JSON.parse(frame.slice(6))
            if (evt?.payload?.type) events.push({ type: evt.payload.type, properties: evt.payload.properties })
          } catch {
            /* partial frame */
          }
        }
      }
    } catch {
      /* aborted */
    }
  })()
  await Bun.sleep(200) // let the subscription attach before mutating
  await run()
  await Bun.sleep(600) // drain in-flight frames
  ctrl.abort()
  await pump
  return events
}

// ---- setup: scratch git repo with .claude/commands/greet.md ----

mkdirSync(join(SCRATCH, ".claude", "commands"), { recursive: true })
await Bun.write(join(SCRATCH, ".claude", "commands", "greet.md"), "Say the word BANANA and then greet: $ARGUMENTS\n")
await Bun.write(join(SCRATCH, "README.md"), "hello\n")
Bun.spawnSync(["git", "init", "-q"], { cwd: SCRATCH })
Bun.spawnSync(["git", "-C", SCRATCH, "add", "-A"])
Bun.spawnSync(["git", "-C", SCRATCH, "-c", "user.email=e2e@open-claude.test", "-c", "user.name=oc-e2e", "commit", "-q", "-m", "init"])
const PRIMARY = realpathSync(SCRATCH)

try {
  const { base, proc: server1 } = await startServer(PORT, PRIMARY)

  // ---- S1: GET /command — warmed cache, opencode shape, shadow filter ----
  let cmds: any[] = []
  for (let i = 0; i < 30; i++) {
    cmds = await api(base, "/command")
    if (Array.isArray(cmds) && cmds.some((c: any) => c.name === "greet")) break
    await Bun.sleep(2000)
  }
  const greet = cmds.find((c: any) => c.name === "greet")
  check("S1 greet present with source 'command'", !!greet && greet.source === "command", JSON.stringify(greet))
  check(
    "S1 greet has the full Command shape (name/description/template/hints)",
    !!greet && typeof greet.name === "string" && typeof greet.description === "string" && greet.template === "" && Array.isArray(greet.hints),
    JSON.stringify(greet),
  )
  const compactCmd = cmds.find((c: any) => c.name === "compact")
  check("S1 compact present (deliberately unshadowed)", !!compactCmd && compactCmd.source === "command", JSON.stringify(compactCmd))
  const shadowHits = cmds.filter((c: any) => ["clear", "agents", "rename", "help", "exit", "new"].includes(c.name))
  check("S1 TUI palette slash names absent (clear/agents/rename/...)", shadowHits.length === 0, JSON.stringify(shadowHits.map((c: any) => c.name)))

  // ---- S2: POST /session/:id/command greet → CLI-side expansion + persisted turn ----
  const sessA = await post(base, `/session?directory=${encodeURIComponent(PRIMARY)}`, { agent: "build", model: { id: MODEL.modelID, providerID: MODEL.providerID }, title: "commands-e2e greet" })
  const g = await commandExpect(base, sessA.id, { command: "greet", arguments: "world", agent: "build", model: MODEL_STR }, (reply, res) => reply.includes("BANANA") && res?.info?.role === "assistant")
  check("S2 greet: 200 {info, parts}, assistant text contains BANANA", g.ok, JSON.stringify(g.got).slice(0, 200))
  const msgsA = await api(base, `/session/${sessA.id}/message`)
  const userA = msgsA.find((m: any) => m.info.role === "user" && textOf(m.parts) === "/greet world")
  const asstA = msgsA.find((m: any) => m.info.role === "assistant" && textOf(m.parts).includes("BANANA"))
  check("S2 GET messages shows the turn (user '/greet world' + assistant parts)", !!userA && !!asstA, `user=${!!userA} assistant=${!!asstA} count=${msgsA.length}`)

  // ---- S3: unknown command → session.error SSE + 400 BadRequest; session stays usable ----
  let unknownStatus = 0
  let unknownBody: any = null
  const evs3 = await collectEvents(base, async () => {
    const res = await raw(base, `/session/${sessA.id}/command`, "POST", { command: "xyzzy-not-real", arguments: "hello" })
    unknownStatus = res.status
    unknownBody = await res.json()
  })
  check("S3 unknown command → 400 {\"_tag\":\"BadRequest\"}", unknownStatus === 400 && unknownBody?._tag === "BadRequest", `${unknownStatus} ${JSON.stringify(unknownBody)}`)
  const err3 = evs3.find((e) => e.type === "session.error" && e.properties?.sessionID === sessA.id)
  check("S3 session.error SSE precedes the 400", !!err3 && String(err3.properties?.error?.data?.message ?? "").includes("xyzzy-not-real"), JSON.stringify(err3?.properties))
  const usable = await promptExpect(base, sessA.id, "Reply with exactly: PONG", (r) => r.includes("PONG"))
  check("S3 session still usable after the rejected command", usable.ok, JSON.stringify(usable.got).slice(0, 120))

  // ---- S4: real compact via POST /session/:id/summarize ----
  const sessB = await post(base, `/session?directory=${encodeURIComponent(PRIMARY)}`, { agent: "build", model: { id: MODEL.modelID, providerID: MODEL.providerID }, title: "commands-e2e compact" })
  const t1 = await promptExpect(base, sessB.id, "My favorite fruit is KIWI. Reply with just: OK", (r) => r.trim().length > 0)
  check("S4 codeword turn 1 (KIWI) completed", t1.ok, JSON.stringify(t1.got).slice(0, 120))
  const t2 = await promptExpect(base, sessB.id, "My favorite city is OSLO. Reply with just: OK", (r) => r.trim().length > 0)
  check("S4 codeword turn 2 (OSLO) completed", t2.ok, JSON.stringify(t2.got).slice(0, 120))

  let sumRes: any = null
  const evs4 = await collectEvents(base, async () => {
    sumRes = await post(base, `/session/${sessB.id}/summarize`, { providerID: MODEL.providerID, modelID: MODEL.modelID })
  })
  check("S4 summarize responds bare true AFTER the compact completes", sumRes === true, JSON.stringify(sumRes))
  const evPart = evs4.find((e) => e.type === "message.part.updated" && e.properties?.part?.type === "compaction")
  check("S4 SSE: compaction part emitted", !!evPart && evPart.properties.part.auto === false, JSON.stringify(evPart?.properties?.part))
  const evSummary = evs4.find((e) => e.type === "message.updated" && e.properties?.info?.summary === true)
  check("S4 SSE: summary-flagged assistant message emitted (agent 'compaction')", !!evSummary && evSummary.properties.info.agent === "compaction", JSON.stringify(evSummary?.properties?.info?.agent))
  check("S4 SSE: session.compacted emitted", evs4.some((e) => e.type === "session.compacted" && e.properties?.sessionID === sessB.id), JSON.stringify(evs4.map((e) => e.type)))

  const msgsB = await api(base, `/session/${sessB.id}/message`)
  const compactionUser = msgsB.find((m: any) => m.info.role === "user" && m.parts.some((p: any) => p.type === "compaction"))
  check(
    "S4 messages: compaction user message (auto:false, NO text part)",
    !!compactionUser && compactionUser.parts.every((p: any) => p.type !== "text") && compactionUser.parts.some((p: any) => p.type === "compaction" && p.auto === false),
    JSON.stringify(compactionUser?.parts?.map((p: any) => p.type)),
  )
  const summaryMsg = msgsB.find((m: any) => m.info.role === "assistant" && m.info.summary === true)
  check(
    "S4 messages: summary assistant (mode/agent compaction, finish stop, parentID = compaction user, non-empty text)",
    !!summaryMsg && summaryMsg.info.agent === "compaction" && summaryMsg.info.finish === "stop" && summaryMsg.info.parentID === compactionUser?.info?.id && textOf(summaryMsg.parts).length > 0,
    JSON.stringify({ agent: summaryMsg?.info?.agent, finish: summaryMsg?.info?.finish, textLen: textOf(summaryMsg?.parts ?? []).length }),
  )
  const allParts = msgsB.flatMap((m: any) => m.parts)
  check(
    "S4 no raw <local-command-stdout> artifacts anywhere",
    allParts.every((p: any) => !(p.type === "text" && String(p.text).includes("<local-command-stdout>"))),
    "",
  )
  const syntheticUserLeak = msgsB.find((m: any) => m.info.role === "user" && m.parts.some((p: any) => p.type === "text" && String(p.text).startsWith("This session is being continued")))
  check("S4 no giant synthetic summary rendered as a plain user message", !syntheticUserLeak, JSON.stringify(syntheticUserLeak?.info?.id))

  const recall = await promptExpect(base, sessB.id, "What is my favorite fruit? Answer with just the fruit name.", (r) => /kiwi/i.test(r))
  check("S4 post-compact context recall (KIWI)", recall.ok, JSON.stringify(recall.got).slice(0, 120))

  // ---- S5: typed-compact path via POST /session/:id/command ----
  // Re-state the codeword first so the SECOND summary is guaranteed to carry it for S6.
  const t5 = await promptExpect(base, sessB.id, "Remember: my favorite fruit is KIWI. Reply with just: OK", (r) => r.trim().length > 0)
  check("S5 reinforcement turn completed", t5.ok, JSON.stringify(t5.got).slice(0, 120))
  const beforeCount = msgsB.filter((m: any) => m.parts.some((p: any) => p.type === "compaction")).length
  const typed = await commandExpect(base, sessB.id, { command: "compact", arguments: "", agent: "build", model: MODEL_STR }, (_reply, res) => res?.info?.summary === true)
  check("S5 typed /compact → response info IS a summary assistant", typed.ok, JSON.stringify(typed.res?.info?.agent))
  const msgsB2 = await api(base, `/session/${sessB.id}/message`)
  const compactions2 = msgsB2.filter((m: any) => m.info.role === "user" && m.parts.some((p: any) => p.type === "compaction"))
  const summaries2 = msgsB2.filter((m: any) => m.info.role === "assistant" && m.info.summary === true)
  check("S5 second compaction pair persisted (same effect as the palette path)", compactions2.length === beforeCount + 1 && summaries2.length === 2, `pairs=${compactions2.length} summaries=${summaries2.length}`)

  // ---- S6: engine restart safety — SIGKILL + restart, compacted CLI session resumes ----
  await Bun.sleep(1200) // let the persistence throttle flush before the hard kill
  server1.kill("SIGKILL")
  await server1.exited
  const { base: base2 } = await startServer(PORT + 1, PRIMARY)
  const survived = await api(base2, `/session/${sessB.id}`)
  check("S6 session survives the restart", survived?.id === sessB.id, JSON.stringify(survived?.id))
  const recall6 = await promptExpect(base2, sessB.id, "What is my favorite fruit? Answer with just the fruit name.", (r) => /kiwi/i.test(r))
  check("S6 post-restart recall through the compacted transcript (KIWI)", recall6.ok, JSON.stringify(recall6.got).slice(0, 120))
} catch (err) {
  check("unhandled test error", false, String(err))
} finally {
  for (const p of procs) {
    try {
      p.kill("SIGKILL")
    } catch {
      /* already dead */
    }
  }
}

if (failures === 0) {
  for (const dir of [SCRATCH, STATE]) rmSync(dir, { recursive: true, force: true })
  try {
    for (const d of readdirSync(PROJECTS)) {
      if (d.includes(`oc-live-commands-${TS}`)) rmSync(join(PROJECTS, d), { recursive: true, force: true })
    }
  } catch {
    /* nothing to clean */
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S) — scratch kept at ${SCRATCH}, state at ${STATE}`)
process.exit(failures === 0 ? 0 : 1)
