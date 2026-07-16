// Live E2E: context-token accounting behind the TUI's context gauge. A multi-API-call turn
// must end with message tokens == the LAST step-finish's tokens (the current context), NOT
// the per-call SUM the SDK reports in result.usage — that sum re-counts the cached context
// once per tool round-trip and drove the gauge past 1000% (test/probe-usage.ts findings).
// Also asserts the catalog limits the TUI divides by match the CLI-reported context windows.
// Run: bun test/live-tokens.ts   (needs Claude auth; model claude-haiku-4-5, tiny prompts)

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-tokens-${TS}`
const STATE = `/tmp/oc-live-tokens-${TS}-state`
const PORT = 43100 + (TS % 400)
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }

let failures = 0
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

mkdirSync(SCRATCH, { recursive: true })
writeFileSync(join(SCRATCH, "a.txt"), "alpha-7231\n")
writeFileSync(join(SCRATCH, "b.txt"), "bravo-4410\n")

const proc = Bun.spawn(["bun", "run", "index.ts", "--port", String(PORT), "--directory", SCRATCH], {
  cwd: ROOT,
  env: { ...process.env, XDG_DATA_HOME: STATE }, // isolate persistence from the real state root
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

const contextOf = (t: any): number => (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)

try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/global/health`)).ok) break
    } catch {}
    await Bun.sleep(100)
  }

  // Catalog limits: what the TUI divides the gauge by must match the CLI's own numbers.
  const providers = await api("/config/providers")
  const models = providers.providers[0].models
  check("catalog: fable-5 context 1M", models["claude-fable-5"].limit.context === 1000000, String(models["claude-fable-5"].limit.context))
  check("catalog: opus-4-8 context 1M", models["claude-opus-4-8"].limit.context === 1000000, String(models["claude-opus-4-8"].limit.context))
  check("catalog: sonnet-5 context 1M", models["claude-sonnet-5"].limit.context === 1000000, String(models["claude-sonnet-5"].limit.context))
  const haiku = models["claude-haiku-4-5-20251001"].limit
  check("catalog: haiku 200k context / 32k output", haiku.context === 200000 && haiku.output === 32000, JSON.stringify(haiku))

  const ses = await post("/session", {})

  // Read-only tools never hit a permission dialog, and each tool round-trip is its own API
  // call, so this yields ≥2 step-finish parts. Retry once: haiku occasionally skips tools.
  let res: any
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await post(`/session/${ses.id}/message`, {
      agent: "build",
      model: MODEL,
      parts: [{ type: "text", text: "Read a.txt with the Read tool. After it returns, read b.txt with the Read tool. Then reply with exactly: done" }],
    })
    if ((res?.parts ?? []).filter((p: any) => p.type === "step-finish").length >= 2) break
    console.log("  (single-step turn, retrying once)")
  }

  const steps = (res?.parts ?? []).filter((p: any) => p.type === "step-finish")
  const text = (res?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
  check("turn completed with done", /done/i.test(text), text.slice(0, 120))
  check("multi-call turn (≥2 step-finish parts)", steps.length >= 2, `steps=${steps.length}`)

  const msgTokens = res?.info?.tokens
  const last = steps[steps.length - 1]?.tokens
  check("message tokens == LAST step's tokens", JSON.stringify(msgTokens) === JSON.stringify(last), `msg=${JSON.stringify(msgTokens)} last=${JSON.stringify(last)}`)

  const summed = steps.reduce((n: number, s: any) => n + contextOf(s.tokens), 0)
  check("message tokens are NOT the per-call sum", steps.length < 2 || contextOf(msgTokens) < summed, `msg=${contextOf(msgTokens)} summed=${summed}`)
  check("context fits the model window", contextOf(msgTokens) > 0 && contextOf(msgTokens) < 200000, String(contextOf(msgTokens)))

  // The session mirror (list row) must carry the same non-inflated snapshot.
  const listed = (await api("/session")).find((s: any) => s.id === ses.id)
  check("session.tokens mirrors message tokens", JSON.stringify(listed?.tokens) === JSON.stringify(msgTokens), JSON.stringify(listed?.tokens))
} catch (err) {
  check("suite ran to completion", false, String(err))
} finally {
  proc.kill()
  rmSync(SCRATCH, { recursive: true, force: true })
  rmSync(STATE, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS")
process.exit(failures ? 1 : 0)
