// Live E2E: AskUserQuestion previews + notes bridge.
// - option `preview` folds into the TUI-visible description (quote-barred `│ ` lines,
//   24-line budget per question split across preview options) and also rides raw on the wire
// - a synthetic trailing "Notes" tab collects a free-text note; on reply it is stripped,
//   returns via updatedInput.annotations (CLI renders ` notes: <text>` into the tool_result)
//   and lands in metadata.answers[0] as `note: <text>` for the transcript
// - "No note" (or empty) on the Notes tab → no annotations, no note in metadata
// - OPENCLAUDE_NO_QUESTION_NOTES=1 → no Notes tab at all
// Run: bun test/live-question-notes.ts   (needs Claude auth; model claude-haiku-4-5)

import { mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-question-${TS}`
const STATE = `/tmp/oc-live-question-${TS}-state`
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }

let failures = 0
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

mkdirSync(SCRATCH, { recursive: true })

interface Shim {
  proc: ReturnType<typeof Bun.spawn>
  base: string
  api: (path: string, init?: RequestInit) => Promise<any>
  post: (path: string, body?: unknown) => Promise<any>
}

async function startShim(port: number, extraEnv: Record<string, string> = {}): Promise<Shim> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "--port", String(port), "--directory", SCRATCH], {
    cwd: ROOT,
    env: { ...process.env, XDG_DATA_HOME: STATE, ...extraEnv },
    stdout: "ignore",
    stderr: "inherit",
  })
  const base = `http://127.0.0.1:${port}`
  const api = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(base + path, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }
  const post = (path: string, body?: unknown) =>
    api(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (let i = 0; i < 150; i++) {
    try {
      await api("/session")
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return { proc, base, api, post }
}

/** Run one turn: send prompt, answer the first question.asked with `reply`, return
 *  {asked, res (assistant message), replied}. Auto-approves any permission.asked. */
async function turn(shim: Shim, sid: string, prompt: string, reply: (asked: any) => string[][]): Promise<{ asked: any; res: any; replied: boolean }> {
  let asked: any = null
  let replied = false
  const ac = new AbortController()
  const sse = fetch(`${shim.base}/global/event`, { signal: ac.signal }).then(async (res) => {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const line = frame.replace(/^data: /, "")
        if (!line) continue
        const obj = JSON.parse(line)
        const type = obj.payload?.type
        const props = obj.payload?.properties
        if (type === "permission.asked") await shim.post(`/permission/${props.id}/reply`, { reply: "once" })
        if (type === "question.asked" && !asked) {
          asked = props
          await shim.post(`/question/${asked.id}/reply`, { answers: reply(asked) })
        }
        if (type === "question.replied") replied = true
      }
    }
  })
  await new Promise((r) => setTimeout(r, 300))
  const res = await shim.post(`/session/${sid}/message`, { agent: "build", model: MODEL, parts: [{ type: "text", text: prompt }] })
  ac.abort()
  await sse.catch(() => {})
  return { asked, res, replied }
}

const questionPart = (res: any): any => (res?.parts ?? []).find((p: any) => p.type === "tool" && p.tool === "question")

const PREVIEW_PROMPT =
  'Call the AskUserQuestion tool ONCE with exactly one question: question "Which fruit should I buy?", header "Fruit", multiSelect false, and exactly two options: ' +
  '(1) label "Apples", description "Red fruit", and a preview field of exactly 30 lines: "L1" through "L30", each on its own line with nothing else; ' +
  '(2) label "Bananas", description "Yellow fruit", no preview. ' +
  "After the tool result arrives, reply with the single word DONE."

async function main(): Promise<void> {
  const shim = await startShim(43600 + (TS % 400))
  let noNotesShim: Shim | null = null
  try {
    // ---- turn 1: preview folding + a real note ----
    let sid = (await shim.post("/session", { agent: "build", model: MODEL })).id as string
    let t = await turn(shim, sid, PREVIEW_PROMPT, (asked) => {
      const labels = asked.questions[0]?.options?.map((o: any) => o.label) ?? []
      return [[labels[0] ?? "Apples"], ["only organic, and skip bruised ones"]]
    })
    // haiku occasionally skips the tool call — one retry on a fresh session
    if (!t.asked) {
      sid = (await shim.post("/session", { agent: "build", model: MODEL })).id as string
      t = await turn(shim, sid, PREVIEW_PROMPT, () => [["Apples"], ["only organic, and skip bruised ones"]])
    }

    check("question.asked fired", !!t.asked)
    const qs = t.asked?.questions ?? []
    check("Notes tab appended (2 questions on the wire)", qs.length === 2, `got ${qs.length}`)
    check("Notes tab shape", qs[1]?.header === "Notes" && qs[1]?.options?.[0]?.label === "No note", JSON.stringify(qs[1] ?? null))

    const apples = qs[0]?.options?.[0] ?? {}
    const bananas = qs[0]?.options?.[1] ?? {}
    const rawPreviewLines = typeof apples.preview === "string" ? apples.preview.split("\n").length : 0
    check("raw preview rides on the wire option", rawPreviewLines >= 25, `preview lines: ${rawPreviewLines}`)
    const descLines: string[] = String(apples.description ?? "").split("\n")
    const quoted = descLines.filter((l: string) => l.startsWith("│ "))
    check("preview folded into description with quote bars", descLines[0] === "Red fruit" && quoted.length > 0, JSON.stringify(descLines.slice(0, 3)))
    check("folded preview clamped to the 24-line budget", quoted.length <= 24, `quoted lines: ${quoted.length}`)
    check(
      "over-budget preview ends with a counted marker",
      rawPreviewLines <= 24 || /^│ … \(\+\d+ more preview lines\)$/.test(quoted[quoted.length - 1] ?? ""),
      JSON.stringify(quoted[quoted.length - 1] ?? null),
    )
    check("preview-less option untouched", bananas.description === "Yellow fruit" && bananas.preview === undefined, JSON.stringify(bananas))
    check("question.replied emitted", t.replied)

    const part1 = questionPart(t.res)
    check("question tool part completed", part1?.state?.status === "completed", part1?.state?.status)
    const meta1 = part1?.state?.metadata?.answers
    check(
      "metadata.answers = original answers + note entry (Notes tab stripped)",
      JSON.stringify(meta1) === JSON.stringify([["Apples", "note: only organic, and skip bruised ones"]]),
      JSON.stringify(meta1),
    )
    const out1 = String(part1?.state?.output ?? "")
    check("tool_result carries the note via annotations", out1.includes("notes: only organic, and skip bruised ones"), JSON.stringify(out1))
    check("tool_result has no preview echo (we do not send annotations.preview)", !out1.includes("selected preview"), JSON.stringify(out1))

    // ---- turn 2: "No note" leaves no trace; also a deliberately LOOSE reply shape (bare
    // string instead of a one-entry array) — a throw here would strand the CLI's canUseTool
    // promise and hang the turn, so this doubles as the normalization regression test ----
    const t2 = await turn(
      shim,
      sid,
      'Call the AskUserQuestion tool ONCE with exactly one question: question "Pick a drink", header "Drink", multiSelect false, options Coffee ("Hot") and Juice ("Cold"), no previews. Then reply with the single word DONE.',
      () => [["Juice"], "No note"] as unknown as string[][],
    )
    check("turn 2 question.asked fired", !!t2.asked)
    const part2 = questionPart(t2.res)
    const meta2 = part2?.state?.metadata?.answers
    check('loose reply shape + "No note" strips cleanly from metadata.answers', JSON.stringify(meta2) === JSON.stringify([["Juice"]]), JSON.stringify(meta2))
    const out2 = String(part2?.state?.output ?? "")
    check('"No note" sends no annotations', out2.includes('"Juice"') && !out2.includes("notes:"), JSON.stringify(out2))

    // ---- OPENCLAUDE_NO_QUESTION_NOTES=1: no Notes tab ----
    noNotesShim = await startShim(44000 + (TS % 400), { OPENCLAUDE_NO_QUESTION_NOTES: "1" })
    const sid3 = (await noNotesShim.post("/session", { agent: "build", model: MODEL })).id as string
    const t3 = await turn(
      noNotesShim,
      sid3,
      'Call the AskUserQuestion tool ONCE with exactly one question: question "Pick a color", header "Color", multiSelect false, options Red ("Warm") and Blue ("Cool"), no previews. Then reply with the single word DONE.',
      () => [["Red"]],
    )
    check("kill-switch: single question on the wire (no Notes tab)", t3.asked?.questions?.length === 1, `got ${t3.asked?.questions?.length}`)
    const part3 = questionPart(t3.res)
    check("kill-switch: plain answer still round-trips", JSON.stringify(part3?.state?.metadata?.answers) === JSON.stringify([["Red"]]), JSON.stringify(part3?.state?.metadata?.answers))
  } finally {
    shim.proc.kill()
    noNotesShim?.proc.kill()
    rmSync(SCRATCH, { recursive: true, force: true })
    rmSync(STATE, { recursive: true, force: true })
  }
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS")
  process.exit(failures ? 1 : 0)
}

main()
