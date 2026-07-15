// Live E2E: persistence + resume-across-restart + fork isolation + list filters + delete cascade.
// Run: bun test/live-resume.ts   (needs Claude auth; model claude-haiku-4-5, tiny codeword prompts)
//
// Spawns real servers (`bun run index.ts --port <p> --directory <scratch>`) against a scratch
// git project under /tmp with an ISOLATED XDG_DATA_HOME, so nothing leaks into the user's real
// open-claude state. Scenarios:
//   S1 create session (?directory=) + prompt PLUM → reply lands in GET /session/:id/message
//   S2 SIGKILL server → fresh server: session survives with the SAME projectID; resumed
//      engine recalls PLUM (lazy restart via stored claudeSessionId)
//   S3 POST fork: fork recalls PLUM; original then learns OTTER; fork must NOT know it
//   S4 GET /session filters: roots=true / search (case-insensitive title) / limit
//   S5 DELETE parent → children-first session.deleted cascade (with info) over /global/event
// Prints PASS/FAIL per check, exits nonzero on any failure, always kills spawned servers.

import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-resume-${TS}`
const STATE = `/tmp/oc-live-resume-state-${TS}`
const PORT1 = 42200 + (TS % 400)
const PORT2 = PORT1 + 1
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }

let failures = 0
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const procs: ReturnType<typeof Bun.spawn>[] = []

async function startServer(port: number): Promise<{ proc: ReturnType<typeof Bun.spawn>; base: string }> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "--port", String(port), "--directory", SCRATCH], {
    cwd: ROOT,
    env: { ...process.env, XDG_DATA_HOME: STATE }, // isolate persistence from the real state root
    stdout: "ignore",
    stderr: "inherit",
  })
  procs.push(proc)
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/global/health`)
      if (r.ok) return { proc, base }
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

/** Collect session.deleted events from /global/event while run() executes. */
async function collectDeleted(base: string, run: () => Promise<void>): Promise<{ id?: string; hasInfo: boolean }[]> {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/global/event`, { signal: ctrl.signal })
  const reader = res.body!.getReader()
  const deleted: { id?: string; hasInfo: boolean }[] = []
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
            if (evt?.payload?.type === "session.deleted") deleted.push({ id: evt.payload.properties?.info?.id, hasInfo: !!evt.payload.properties?.info })
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
  return deleted
}

// ---- main ----

mkdirSync(SCRATCH, { recursive: true })
Bun.spawnSync(["git", "init", "-q"], { cwd: SCRATCH })

try {
  // ---- S1: create + prompt on server 1 ----
  const srv1 = await startServer(PORT1)
  const sess = await post(srv1.base, `/session?directory=${encodeURIComponent(SCRATCH)}`, {
    agent: "build",
    model: { id: MODEL.modelID, providerID: MODEL.providerID },
    title: "resume-e2e main",
  })
  const origID: string = sess.id
  const projectID: string = sess.projectID
  check("S1 create: session has ?directory= and a projectID", sess.directory === SCRATCH && !!projectID, `dir=${sess.directory}`)

  const s1 = await promptExpect(srv1.base, origID, "Remember the codeword: PLUM. Reply with exactly: OK", (r) => r.trim().length > 0)
  const s1msgs = await api(srv1.base, `/session/${origID}/message`)
  const s1assistant = [...s1msgs].reverse().find((m: any) => m.info?.role === "assistant" && textOf(m.parts).length > 0)
  check("S1 prompt: assistant reply landed in GET /session/:id/message", s1.ok && !!s1assistant, JSON.stringify(s1.got).slice(0, 120))

  // ---- S2: SIGKILL → fresh server → same projectID + codeword recall ----
  await Bun.sleep(800) // let the trailing persistence flush (~300ms) land before the kill
  srv1.proc.kill("SIGKILL")
  await srv1.proc.exited

  const srv2 = await startServer(PORT2)
  const list2 = await api(srv2.base, "/session")
  const survived = list2.find((s: any) => s.id === origID)
  const proj2 = await api(srv2.base, "/project/current")
  check("S2 restart: session listed with the same projectID", !!survived && survived.projectID === projectID && proj2.id === projectID, `session.projectID=${survived?.projectID} project/current=${proj2.id}`)

  const s2 = await promptExpect(srv2.base, origID, "What is the codeword? Reply with just the codeword.", (r) => r.toUpperCase().includes("PLUM"))
  check("S2 resume: codeword recalled across process death", s2.ok, JSON.stringify(s2.got).slice(0, 120))

  // ---- S3: fork recalls; original's later turns don't leak into the fork ----
  const fork = await post(srv2.base, `/session/${origID}/fork`)
  const origMsgs = await api(srv2.base, `/session/${origID}/message`)
  const forkMsgs = await api(srv2.base, `/session/${fork.id}/message`)
  check(
    "S3 fork: new session, deep-copied transcript",
    fork.id !== origID && forkMsgs.length === origMsgs.length && forkMsgs.length > 0 && forkMsgs.every((m: any) => m.info.sessionID === fork.id),
    `orig=${origMsgs.length} fork=${forkMsgs.length}`,
  )

  const s3a = await promptExpect(srv2.base, fork.id, "What is the codeword? Reply with just the codeword.", (r) => r.toUpperCase().includes("PLUM"))
  check("S3 fork: recalls the codeword", s3a.ok, JSON.stringify(s3a.got).slice(0, 120))

  const s3b = await promptExpect(srv2.base, origID, "Remember a second codeword: OTTER. Reply with exactly: OK", (r) => r.trim().length > 0)
  check("S3 original: accepted a new codeword after the fork", s3b.ok, JSON.stringify(s3b.got).slice(0, 120))

  const s3c = await promptExpect(srv2.base, fork.id, "Were you ever told a codeword OTTER? Reply with exactly one word: YES or NO.", (r) => /\bNO\b/i.test(r) && !/\bYES\b/i.test(r))
  check("S3 fork: did NOT learn the original's new codeword", s3c.ok, JSON.stringify(s3c.got).slice(0, 120))

  // ---- S4: roots / search / limit filters ----
  const child = await post(srv2.base, "/session", { parentID: origID, title: "child-of-e2e" })
  const roots = await api(srv2.base, "/session?roots=true")
  const rootIDs = roots.map((s: any) => s.id)
  check("S4 roots=true: drops child sessions, keeps roots", !rootIDs.includes(child.id) && rootIDs.includes(origID) && rootIDs.includes(fork.id))

  const search = await api(srv2.base, "/session?search=CHILD-OF")
  check("S4 search: case-insensitive title substring", search.length === 1 && search[0].id === child.id, `hits=${search.map((s: any) => s.title).join(",")}`)

  const limited = await api(srv2.base, "/session?limit=1")
  check("S4 limit: applied after time.updated DESC sort", limited.length === 1 && limited[0].id === child.id, `got ${limited.map((s: any) => s.id).join(",")}`)

  // ---- S5: delete cascade, children first, info required ----
  let delRes: any
  const deleted = await collectDeleted(srv2.base, async () => {
    delRes = await api(srv2.base, `/session/${origID}`, { method: "DELETE" })
  })
  check(
    "S5 delete: cascade emits child-first session.deleted with info",
    delRes === true && deleted.length === 2 && deleted[0]?.id === child.id && deleted[1]?.id === origID && deleted.every((d) => d.hasInfo),
    JSON.stringify(deleted),
  )
  const after = await api(srv2.base, "/session")
  const afterIDs = after.map((s: any) => s.id)
  check("S5 delete: parent+child gone, fork untouched", !afterIDs.includes(origID) && !afterIDs.includes(child.id) && afterIDs.includes(fork.id))
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
  // Clean up scratch state + the Claude-side transcripts this run created.
  rmSync(SCRATCH, { recursive: true, force: true })
  rmSync(STATE, { recursive: true, force: true })
  const projects = join(homedir(), ".claude", "projects")
  try {
    for (const d of readdirSync(projects)) {
      if (d.includes(`oc-live-resume-${TS}`)) rmSync(join(projects, d), { recursive: true, force: true })
    }
  } catch {
    /* nothing to clean */
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S) — scratch kept at ${SCRATCH}, state at ${STATE}`)
process.exit(failures === 0 ? 0 : 1)
