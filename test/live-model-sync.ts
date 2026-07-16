// Live E2E: model desync guards. The TUI's model picker is authoritative — it re-sends its
// model with every prompt and the server cannot move it mid-session, so:
//   1. POST /session/:id/command "model" (bare + args) is intercepted with a read-only view
//      (never forwarded — a CLI-side switch could never stick).
//   2. A drift that DOES reach the CLI (raw "/model X" prompt text from a non-TUI client)
//      self-heals: the drifted turn's assistant message is restamped with the model that
//      actually served it (message_start.message.model), and the next turn re-asserts the
//      picker's model via setModel (probe: test/probe-model-switch.ts).
// Run: bun test/live-model-sync.ts   (needs Claude auth; tiny haiku/sonnet prompts)

import { mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-model-${TS}`
const STATE = `/tmp/oc-live-model-${TS}-state`
const PORT = 43500 + (TS % 400)
const HAIKU = "claude-haiku-4-5-20251001"
const SONNET = "claude-sonnet-5"
const MODEL = { providerID: "anthropic", modelID: HAIKU }

let failures = 0
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

mkdirSync(SCRATCH, { recursive: true })

const proc = Bun.spawn(["bun", "run", "index.ts", "--port", String(PORT), "--directory", SCRATCH], {
  cwd: ROOT,
  env: { ...process.env, XDG_DATA_HOME: STATE },
  stdout: "ignore",
  stderr: "inherit",
})
const base = `http://127.0.0.1:${PORT}`

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(base + path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })

const textOf = (wp: any): string => (wp?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")

try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/global/health`)).ok) break
    } catch {}
    await Bun.sleep(100)
  }

  const ses = await post("/session", {})

  // 1. /model intercept: instant synthetic view, engine-less (works pre-warm), never busy.
  const bare = await post(`/session/${ses.id}/command`, { command: "model", agent: "build", model: `anthropic/${HAIKU}` })
  check("/model bare: read-only view with current model", textOf(bare).includes("Current model: Claude Haiku 4.5"), textOf(bare).split("\n")[0])
  const withArg = await post(`/session/${ses.id}/command`, { command: "model", arguments: SONNET, agent: "build", model: `anthropic/${HAIKU}` })
  check("/model <arg>: not applied, points at the picker", /read-only/.test(textOf(withArg)) && textOf(withArg).includes("Claude Sonnet 5"), textOf(withArg).split("\n")[0])
  const status = await api("/session/status")
  check("intercepts never set busy", !(ses.id in status), JSON.stringify(status))

  // 2. Fabricate real drift: raw "/model sonnet-id" as prompt text (non-TUI-client path)
  // reaches the CLI and flips its session model. The turn itself is synthetic (no API call).
  const drift = await post(`/session/${ses.id}/message`, {
    agent: "build",
    model: MODEL,
    parts: [{ type: "text", text: `/model ${SONNET}` }],
  })
  check("raw /model passthrough executed by CLI", /set model/i.test(textOf(drift)), textOf(drift).slice(0, 80))

  // 3. Drifted turn: requested haiku, actually served by sonnet → restamped truthfully.
  const drifted = await post(`/session/${ses.id}/message`, {
    agent: "build",
    model: MODEL,
    parts: [{ type: "text", text: "Reply with just: OK" }],
  })
  check("drifted turn restamped with the SERVING model", drifted?.info?.modelID === SONNET, `modelID=${drifted?.info?.modelID}`)

  // 4. Next turn: applyMode sees the adopted drift and re-asserts the picker's haiku.
  const healed = await post(`/session/${ses.id}/message`, {
    agent: "build",
    model: MODEL,
    parts: [{ type: "text", text: "Reply with just: OK" }],
  })
  check("next turn re-asserts the picker's model", healed?.info?.modelID === HAIKU, `modelID=${healed?.info?.modelID}`)

  // The stored transcript must agree with what the POSTs returned (TUI refetches on open).
  const msgs = await api(`/session/${ses.id}/message`)
  const assistants = msgs.filter((m: any) => m.info.role === "assistant").map((m: any) => m.info.modelID)
  check("stored transcript models match", JSON.stringify(assistants.slice(-2)) === JSON.stringify([SONNET, HAIKU]), JSON.stringify(assistants))
} catch (err) {
  check("suite ran to completion", false, String(err))
} finally {
  proc.kill()
  rmSync(SCRATCH, { recursive: true, force: true })
  rmSync(STATE, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS")
process.exit(failures ? 1 : 0)
