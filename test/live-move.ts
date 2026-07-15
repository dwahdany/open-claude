// Live E2E: the full /move surface (docs/contract/08-move-session.md) — worktree copies,
// session moves (SSE dual-emit + transcript relocation + context survival), subdirectory
// moves, moveChanges transfer, real /vcs/status, dirty-copy delete, refresh reconciliation.
// Run: bun test/live-move.ts   (needs Claude auth; model claude-haiku-4-5, tiny prompts)
//
// Spawns a real server (`bun run index.ts --port <p> --directory <scratch>`) against a
// scratch git repo (initial commit: README.md + sub/keep.txt) with an ISOLATED XDG_DATA_HOME.
// All compared paths are canonical (realpath) because git output and copy-create responses
// are canonical (macOS /tmp → /private/tmp). Scenarios: S1 generate-name/create/directories/
// path, S2 move + SSE + transcript (and NO session.error from the idle-engine teardown),
// S3 tools in new cwd + recall, S4 subdirectory move, S5 vcs/status + moveChanges,
// S6 dirty-copy delete (forceRequired), S7 refresh prune, S8 same-dir no-op + unknown
// session, S9 moving an unprompted fork SEEDS (copies) the shared transcript — the source
// session keeps its resume material, S10 second server attached at a SUBDIR of the repo
// with a pre-torn project.json: boots + self-heals, /path carve-out (worktree === primary
// attach dir), legacy directory fallback in the ?path= session-list filter.
// Prints PASS/FAIL per check, exits nonzero on failure.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-move-${TS}`
const COPYPARENT = `/tmp/oc-live-move-${TS}-copies`
const STATE = `/tmp/oc-live-move-${TS}-state`
const PORT = 42700 + (TS % 400)
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }
const PROJECTS = join(homedir(), ".claude", "projects")

/** Same munge rule as the Claude CLI / src/store.ts. */
const munge = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "-")

let failures = 0
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const procs: ReturnType<typeof Bun.spawn>[] = []

async function startServer(port: number, directory: string): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "--port", String(port), "--directory", directory], {
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
      if (r.ok) return base
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

/** Raw request when the STATUS CODE is the assertion (204s, expected 400s). */
const raw = (base: string, path: string, method: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })

const textOf = (parts: any[]): string =>
  (parts ?? [])
    .filter((p: any) => p?.type === "text" && p.text)
    .map((p: any) => p.text)
    .join("\n")

/** Blocking prompt; returns the final assistant text. Retries ONCE on flaky/failed turns. */
async function promptExpect(base: string, sessionID: string, text: string, want: (reply: string) => boolean, agent = "build"): Promise<{ ok: boolean; got: string }> {
  let got = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await post(base, `/session/${sessionID}/message`, { agent, model: MODEL, parts: [{ type: "text", text }] })
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

interface CapturedEvent {
  directory?: string
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
            if (evt?.payload?.type) events.push({ directory: evt.directory, type: evt.payload.type, properties: evt.payload.properties })
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

/** Standing SSE listener that auto-approves permission dialogs ("always"), so agent:"auto"
 *  Bash turns can never hang the test waiting for a TUI that isn't there. */
function startAutoApprove(base: string): { stop: () => void } {
  const ctrl = new AbortController()
  void (async () => {
    try {
      const res = await fetch(`${base}/global/event`, { signal: ctrl.signal })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
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
            if (evt?.payload?.type === "permission.asked") {
              void post(base, `/permission/${evt.payload.properties.id}/reply`, { reply: "always" }).catch(() => {})
            }
          } catch {
            /* partial frame */
          }
        }
      }
    } catch {
      /* aborted */
    }
  })()
  return { stop: () => ctrl.abort() }
}

const jsonlsIn = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  } catch {
    return []
  }
}

// ---- setup: scratch repo with an initial commit (README.md + sub/keep.txt) ----

mkdirSync(join(SCRATCH, "sub"), { recursive: true })
mkdirSync(COPYPARENT, { recursive: true })
await Bun.write(join(SCRATCH, "README.md"), "hello\n")
await Bun.write(join(SCRATCH, "sub", "keep.txt"), "keep\n") // tracked → `git clean -fd` can't delete sub/
Bun.spawnSync(["git", "init", "-q"], { cwd: SCRATCH })
Bun.spawnSync(["git", "-C", SCRATCH, "add", "-A"])
Bun.spawnSync(["git", "-C", SCRATCH, "-c", "user.email=e2e@open-claude.test", "-c", "user.name=oc-e2e", "commit", "-q", "-m", "init"])
const PRIMARY = realpathSync(SCRATCH)
const SUB = join(PRIMARY, "sub")

let autoApprove: { stop: () => void } | null = null

try {
  const base = await startServer(PORT, PRIMARY)
  autoApprove = startAutoApprove(base)
  const pid: string = (await api(base, "/project/current")).id

  // ---- S1: generate-name → create copy → directories + /path bootstrap ----
  const gen = await post(base, `/experimental/project/${pid}/copy/generate-name`, { context: "move e2e scratch work" })
  check("S1 generate-name: 200 with a slug", typeof gen?.name === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(gen.name), JSON.stringify(gen))

  const created = await post(base, `/experimental/project/${pid}/copy`, { strategy: "git_worktree", directory: COPYPARENT, name: gen.name })
  const COPY1: string = created.directory
  check("S1 create copy: directory exists and is canonical", !!COPY1 && existsSync(COPY1) && COPY1 === realpathSync(COPY1), COPY1)
  const top1 = Bun.spawnSync(["git", "-C", COPY1, "rev-parse", "--show-toplevel"]).stdout.toString().trim()
  check("S1 copy is its own worktree root", top1 === COPY1, `toplevel=${top1}`)

  const dirs1 = await api(base, `/project/${pid}/directories`)
  check(
    "S1 directories: strategy-less primary + git_worktree copy",
    dirs1.some((r: any) => r.directory === PRIMARY && r.strategy === undefined) && dirs1.some((r: any) => r.directory === COPY1 && r.strategy === "git_worktree"),
    JSON.stringify(dirs1),
  )

  const path1 = await api(base, `/path?directory=${encodeURIComponent(COPY1)}`)
  check("S1 /path bootstrap: worktree === directory === copy", path1.worktree === COPY1 && path1.directory === COPY1, JSON.stringify({ worktree: path1.worktree, directory: path1.directory }))

  // ---- S2: session in primary, codeword, move → SSE dual-emit + transcript relocation ----
  const sess = await post(base, `/session?directory=${encodeURIComponent(PRIMARY)}`, { agent: "build", model: { id: MODEL.modelID, providerID: MODEL.providerID }, title: "move-e2e main" })
  const sid: string = sess.id
  const p1 = await promptExpect(base, sid, "Remember the codeword: PLUM. Reply with exactly: OK", (r) => r.trim().length > 0)
  check("S2 prompt: codeword turn completed", p1.ok, JSON.stringify(p1.got).slice(0, 120))
  await Bun.sleep(500) // let the CLI finish flushing the transcript

  const oldMunged = join(PROJECTS, munge(PRIMARY))
  const newMunged = join(PROJECTS, munge(COPY1))
  const transcripts = jsonlsIn(oldMunged)
  check("S2 transcript exists in the source munged dir", transcripts.length > 0, oldMunged)

  const evs2 = await collectEvents(base, async () => {
    const res = await raw(base, "/experimental/control-plane/move-session", "POST", { sessionID: sid, destination: { directory: COPY1 } })
    check("S2 move-session → 204", res.status === 204, String(res.status))
  })
  const moved2 = evs2.find((e) => e.type === "session.next.moved" && e.properties?.sessionID === sid)
  check(
    "S2 session.next.moved: new-dir envelope, subdirectory ''",
    !!moved2 && moved2.properties.location?.directory === COPY1 && moved2.properties.subdirectory === "" && moved2.directory === COPY1 && typeof moved2.properties.timestamp === "number",
    JSON.stringify(moved2),
  )
  const updated2 = evs2.find((e) => e.type === "session.updated" && e.properties?.info?.id === sid)
  check("S2 session.updated carries the new directory", !!updated2 && updated2.properties.info.directory === COPY1, JSON.stringify(updated2?.properties?.info?.directory))
  const errs2 = evs2.filter((e) => e.type === "session.error")
  check("S2 no session.error from the idle-engine teardown", errs2.length === 0, JSON.stringify(errs2.map((e) => e.properties?.error)))

  const after2 = await api(base, `/session/${sid}`)
  check("S2 GET /session/:id reflects the move", after2.directory === COPY1 && after2.path === "", `directory=${after2.directory} path=${JSON.stringify(after2.path)}`)
  check(
    "S2 transcript jsonl relocated old→new munged dir",
    transcripts.every((f) => !existsSync(join(oldMunged, f)) && existsSync(join(newMunged, f))),
    `old=${jsonlsIn(oldMunged).length} new=${jsonlsIn(newMunged).length}`,
  )

  // ---- S3: tools run in the NEW cwd; context survived the move ----
  const p2 = await promptExpect(base, sid, "Use the Bash tool to run pwd and reply with just its output", (r) => r.includes(COPY1), "auto")
  check("S3 Bash pwd executes in the copy's cwd", p2.ok, JSON.stringify(p2.got).slice(0, 160))
  const p3 = await promptExpect(base, sid, "What is the codeword? Reply with just the codeword.", (r) => r.toUpperCase().includes("PLUM"))
  check("S3 codeword recalled after the move", p3.ok, JSON.stringify(p3.got).slice(0, 120))

  // ---- S4: subdirectory move → path "sub", truthful /path ----
  const sess2 = await post(base, `/session?directory=${encodeURIComponent(PRIMARY)}`, { title: "move-e2e sub" })
  const evs4 = await collectEvents(base, async () => {
    const res = await raw(base, "/experimental/control-plane/move-session", "POST", { sessionID: sess2.id, destination: { directory: SUB } })
    check("S4 move to subdirectory → 204", res.status === 204, String(res.status))
  })
  const moved4 = evs4.find((e) => e.type === "session.next.moved" && e.properties?.sessionID === sess2.id)
  check("S4 session.next.moved subdirectory 'sub'", !!moved4 && moved4.properties.subdirectory === "sub" && moved4.properties.location?.directory === SUB, JSON.stringify(moved4?.properties))
  const after4 = await api(base, `/session/${sess2.id}`)
  check("S4 session.path === 'sub'", after4.directory === SUB && after4.path === "sub", `path=${JSON.stringify(after4.path)}`)
  const path4 = await api(base, `/path?directory=${encodeURIComponent(SUB)}`)
  check("S4 /path: worktree=primary, directory=sub", path4.worktree === PRIMARY && path4.directory === SUB, JSON.stringify({ worktree: path4.worktree, directory: path4.directory }))

  // ---- S5: real vcs/status + moveChanges transfer to a fresh copy ----
  const gen2 = await post(base, `/experimental/project/${pid}/copy/generate-name`, {})
  const COPY2: string = (await post(base, `/experimental/project/${pid}/copy`, { strategy: "git_worktree", directory: COPYPARENT, name: gen2.name })).directory
  await Bun.write(join(PRIMARY, "zeta.txt"), `MOVECHANGES-${TS}\n`) // untracked → "added"
  await Bun.write(join(PRIMARY, "README.md"), "hello\nMOVED-LINE\n") // tracked edit → "modified"
  const vs = await api(base, `/vcs/status?directory=${encodeURIComponent(PRIMARY)}`)
  const zeta = vs.find((f: any) => f.file === "zeta.txt")
  const readme = vs.find((f: any) => f.file === "README.md")
  check("S5 vcs/status: added + modified with plausible counts", zeta?.status === "added" && readme?.status === "modified" && readme.additions >= 1, JSON.stringify(vs))

  const sess3 = await post(base, `/session?directory=${encodeURIComponent(PRIMARY)}`, { title: "move-e2e changes" })
  const res5 = await raw(base, "/experimental/control-plane/move-session", "POST", { sessionID: sess3.id, destination: { directory: COPY2 }, moveChanges: true })
  check("S5 move with moveChanges → 204", res5.status === 204, String(res5.status))
  const zetaMoved = existsSync(join(COPY2, "zeta.txt")) && (await Bun.file(join(COPY2, "zeta.txt")).text()) === `MOVECHANGES-${TS}\n`
  const readmeMoved = existsSync(join(COPY2, "README.md")) && (await Bun.file(join(COPY2, "README.md")).text()).includes("MOVED-LINE")
  check("S5 both changes present at the destination", zetaMoved && readmeMoved, `zeta=${zetaMoved} readme=${readmeMoved}`)
  const srcStatus = Bun.spawnSync(["git", "-C", PRIMARY, "status", "--porcelain"]).stdout.toString().trim()
  check("S5 source git status clean after cleanup", srcStatus === "", JSON.stringify(srcStatus))

  // ---- S6: dirty-copy delete → forceRequired, then force:true removes it ----
  const COPY3: string = (await post(base, `/experimental/project/${pid}/copy`, { strategy: "git_worktree", directory: COPYPARENT, name: "dirty-target" })).directory
  await Bun.write(join(COPY3, "dirty.txt"), "dirt\n")
  const del1 = await raw(base, `/experimental/project/${pid}/copy`, "DELETE", { directory: COPY3, force: false })
  const del1body: any = await del1.json()
  check("S6 non-forced delete of dirty copy → 400 forceRequired", del1.status === 400 && del1body?.name === "ProjectCopyError" && del1body?.data?.forceRequired === true, JSON.stringify(del1body))
  const del2 = await raw(base, `/experimental/project/${pid}/copy`, "DELETE", { directory: COPY3, force: true })
  check("S6 forced delete → 204", del2.status === 204, String(del2.status))
  const dirs6 = await api(base, `/project/${pid}/directories`)
  check("S6 deleted copy gone from directories", !dirs6.some((r: any) => r.directory === COPY3) && !existsSync(COPY3), JSON.stringify(dirs6))

  // ---- S7: refresh reconciliation prunes out-of-band-removed copies ----
  const COPY4: string = (await post(base, `/experimental/project/${pid}/copy`, { strategy: "git_worktree", directory: COPYPARENT, name: "stale-target" })).directory
  check("S7 setup: copy listed", (await api(base, `/project/${pid}/directories`)).some((r: any) => r.directory === COPY4), COPY4)
  Bun.spawnSync(["git", "-C", PRIMARY, "worktree", "remove", "--force", COPY4])
  const ref = await raw(base, `/experimental/project/${pid}/copy/refresh`, "POST")
  check("S7 refresh → 204", ref.status === 204, String(ref.status))
  const dirs7 = await api(base, `/project/${pid}/directories`)
  check(
    "S7 stale row pruned, live copies kept",
    !dirs7.some((r: any) => r.directory === COPY4) && dirs7.some((r: any) => r.directory === COPY1 && r.strategy === "git_worktree") && dirs7.some((r: any) => r.directory === COPY2 && r.strategy === "git_worktree"),
    JSON.stringify(dirs7),
  )

  // ---- S8: same-directory move = silent no-op; unknown session = MoveSessionError ----
  const evs8 = await collectEvents(base, async () => {
    const res = await raw(base, "/experimental/control-plane/move-session", "POST", { sessionID: sess2.id, destination: { directory: SUB } })
    check("S8 same-directory move → 204", res.status === 204, String(res.status))
  })
  check("S8 no session.next.moved for a no-op", !evs8.some((e) => e.type === "session.next.moved"), JSON.stringify(evs8.map((e) => e.type)))
  const resU = await raw(base, "/experimental/control-plane/move-session", "POST", { sessionID: "ses_doesnotexist", destination: { directory: PRIMARY } })
  const bodyU: any = await resU.json()
  check("S8 unknown session → 400 MoveSessionError", resU.status === 400 && bodyU?.name === "MoveSessionError" && String(bodyU?.data?.message).includes("Session not found"), JSON.stringify(bodyU))

  // ---- S9: moving an UNPROMPTED fork must not steal the shared transcript ----
  // The fork inherits its source's Claude uuid (forkPending); the move must SEED a copy at
  // the destination and leave every source jsonl in place — else the source session's next
  // resume dies with "No conversation found with session ID".
  const srcMunged = join(PROJECTS, munge(COPY1)) // sess's transcripts live here since S2
  const subMunged = join(PROJECTS, munge(SUB))
  const srcBefore = jsonlsIn(srcMunged)
  const subBefore = new Set(jsonlsIn(subMunged))
  check("S9 setup: source munged dir has transcripts", srcBefore.length > 0, srcMunged)
  const fork = await post(base, `/session/${sid}/fork`)
  const evs9 = await collectEvents(base, async () => {
    const res = await raw(base, "/experimental/control-plane/move-session", "POST", { sessionID: fork.id, destination: { directory: SUB } })
    check("S9 move unprompted fork → 204", res.status === 204, String(res.status))
  })
  check("S9 no session.error during the fork move", !evs9.some((e) => e.type === "session.error"), JSON.stringify(evs9.map((e) => e.type)))
  const after9 = await api(base, `/session/${fork.id}`)
  check("S9 fork relocated (directory=sub, path='sub')", after9.directory === SUB && after9.path === "sub", `directory=${after9.directory} path=${JSON.stringify(after9.path)}`)
  check(
    "S9 source munged dir untouched (nothing deleted)",
    srcBefore.every((f) => existsSync(join(srcMunged, f))),
    `before=${srcBefore.length} after=${jsonlsIn(srcMunged).length}`,
  )
  const seeded = jsonlsIn(subMunged).filter((f) => !subBefore.has(f))
  check(
    "S9 destination got a seed COPY of a source transcript",
    seeded.length > 0 && seeded.every((f) => srcBefore.includes(f) && existsSync(join(srcMunged, f))),
    `seeded=${JSON.stringify(seeded)}`,
  )
  const p9 = await promptExpect(base, fork.id, "What is the codeword? Reply with just the codeword.", (r) => r.toUpperCase().includes("PLUM"))
  check("S9 moved fork recalls the codeword via the seed", p9.ok, JSON.stringify(p9.got).slice(0, 120))
  check(
    "S9 source transcripts still intact after the fork's first turn",
    srcBefore.every((f) => existsSync(join(srcMunged, f))),
    `after=${jsonlsIn(srcMunged).length}`,
  )

  // ---- S10: attach at a SUBDIR of the repo + torn project.json → self-heal, /path carve-out,
  // legacy directory fallback in the session-list path filter ----
  const subStateDir = join(STATE, "open-claude", "project", munge(SUB))
  mkdirSync(subStateDir, { recursive: true })
  await Bun.write(join(subStateDir, "project.json"), '{"id":"prj_x","directory":"/tr') // torn mid-write
  const base2 = await startServer(PORT + 1, SUB)
  const proj10 = await api(base2, "/project/current")
  check("S10 torn project.json: server boots and mints a fresh id", typeof proj10?.id === "string" && proj10.id.length > 0, JSON.stringify(proj10?.id))
  let healed10: any = null
  try {
    healed10 = await Bun.file(join(subStateDir, "project.json")).json()
  } catch {
    /* still torn */
  }
  check("S10 project.json rewritten valid + id matches", healed10?.id === proj10.id, JSON.stringify(healed10))
  const path10 = await api(base2, "/path")
  check(
    "S10 /path carve-out: worktree === primary attach dir (not the outer git toplevel)",
    path10.worktree === SUB && path10.directory === SUB,
    JSON.stringify({ worktree: path10.worktree, directory: path10.directory }),
  )
  const sess10 = await post(base2, `/session?directory=${encodeURIComponent(SUB)}`, { title: "subdir visibility" })
  const list10 = await api(base2, `/session?path=sub&directory=${encodeURIComponent(SUB)}`)
  check(
    "S10 active ?path= filter still lists path-less sessions (legacy directory fallback)",
    Array.isArray(list10) && list10.some((s: any) => s.id === sess10.id),
    `hits=${Array.isArray(list10) ? list10.length : JSON.stringify(list10)}`,
  )
} catch (err) {
  check("unhandled test error", false, String(err))
} finally {
  autoApprove?.stop()
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
  for (const dir of [SCRATCH, COPYPARENT, STATE]) rmSync(dir, { recursive: true, force: true })
  try {
    for (const d of readdirSync(PROJECTS)) {
      if (d.includes(`oc-live-move-${TS}`)) rmSync(join(PROJECTS, d), { recursive: true, force: true })
    }
  } catch {
    /* nothing to clean */
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S) — scratch kept at ${SCRATCH}, state at ${STATE}`)
process.exit(failures === 0 ? 0 : 1)
