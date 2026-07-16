// Live E2E: AskUserQuestion previews + delimiter notes.
// - option `preview` renders as a synthetic TEXT part on the assistant message (fenced
//   markdown, unbounded — the transcript scrolls; the dialog would bottom-clip), placed
//   after the question tool part so it sits right above the dialog; raw `preview` also
//   rides on the wire option, and the dialog description stays clean
// - notes ride the dialog's own free-text row: "answer // note" splits into answer + note,
//   an entry starting with "//" is a pure note alongside multi-select labels; notes return
//   via updatedInput.annotations per question (CLI renders ` notes: <text>` in the
//   tool_result) and land in metadata.answers as `note: <text>`
// - loose reply shapes (bare string per answer) normalize instead of hanging the turn
// Run: bun test/live-question-notes.ts   (needs Claude auth; model claude-haiku-4-5)

import { mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TS = Date.now()
const SCRATCH = `/tmp/oc-live-question-${TS}`
const STATE = `/tmp/oc-live-question-${TS}-state`
const PORT = 43600 + (TS % 400)
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }

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

/** Run one turn: send prompt, answer the first question.asked with `reply`, return
 *  {asked, res (assistant message), replied}. Auto-approves any permission.asked. */
async function turn(sid: string, prompt: string, reply: (asked: any) => unknown): Promise<{ asked: any; res: any; replied: boolean }> {
  let asked: any = null
  let replied = false
  const ac = new AbortController()
  const sse = fetch(`${base}/global/event`, { signal: ac.signal }).then(async (res) => {
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
        if (type === "permission.asked") await post(`/permission/${props.id}/reply`, { reply: "once" })
        if (type === "question.asked" && !asked) {
          asked = props
          await post(`/question/${asked.id}/reply`, { answers: reply(asked) })
        }
        if (type === "question.replied") replied = true
      }
    }
  })
  await new Promise((r) => setTimeout(r, 300))
  const res = await post(`/session/${sid}/message`, { agent: "build", model: MODEL, parts: [{ type: "text", text: prompt }] })
  ac.abort()
  await sse.catch(() => {})
  return { asked, res, replied }
}

const questionPart = (res: any): any => (res?.parts ?? []).find((p: any) => p.type === "tool" && p.tool === "question")
const previewPart = (res: any): any => (res?.parts ?? []).find((p: any) => p.type === "text" && String(p.text ?? "").includes("attach a note to any typed answer"))

const PREVIEW_PROMPT =
  'Call the AskUserQuestion tool ONCE with exactly one question: question "Which fruit should I buy?", header "Fruit", multiSelect false, and exactly two options: ' +
  '(1) label "Apples", description "Red fruit", and a preview field of exactly 30 lines: "L1" through "L30", each on its own line with nothing else; ' +
  '(2) label "Bananas", description "Yellow fruit", no preview. ' +
  "After the tool result arrives, reply with the single word DONE."

async function main(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      await api("/session")
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    // ---- turn 1: previews → transcript part; "answer // note" delimiter ----
    let sid = (await post("/session", { agent: "build", model: MODEL })).id as string
    let t = await turn(sid, PREVIEW_PROMPT, () => [["Apples // only organic, and skip bruised ones"]])
    // haiku occasionally skips the tool call — one retry on a fresh session
    if (!t.asked) {
      sid = (await post("/session", { agent: "build", model: MODEL })).id as string
      t = await turn(sid, PREVIEW_PROMPT, () => [["Apples // only organic, and skip bruised ones"]])
    }

    check("question.asked fired", !!t.asked)
    const qs = t.asked?.questions ?? []
    check("no synthetic Notes tab (1 question on the wire)", qs.length === 1, `got ${qs.length}`)
    const apples = qs[0]?.options?.[0] ?? {}
    const rawPreviewLines = typeof apples.preview === "string" ? apples.preview.split("\n").length : 0
    check("raw preview rides on the wire option", rawPreviewLines >= 25, `preview lines: ${rawPreviewLines}`)
    check("dialog description stays clean (no folding)", apples.description === "Red fruit" && !String(apples.description).includes("│"), JSON.stringify(apples.description))

    const pv = previewPart(t.res)
    check("synthetic preview text part exists on the assistant message", !!pv)
    const pvText = String(pv?.text ?? "")
    check("preview part is fenced markdown titled by option label", pvText.includes("**Apples**") && pvText.includes("```"), JSON.stringify(pvText.slice(0, 80)))
    check("preview part carries the FULL preview (no truncation)", pvText.includes("L1\n") && pvText.includes("L30"), `has L30: ${pvText.includes("L30")}`)
    const parts = t.res?.parts ?? []
    const qIdx = parts.findIndex((p: any) => p.type === "tool" && p.tool === "question")
    const pvIdx = parts.findIndex((p: any) => p.id === pv?.id)
    check("preview part sits after the tool part (right above the dialog)", qIdx >= 0 && pvIdx > qIdx, `tool@${qIdx} preview@${pvIdx}`)
    check("question.replied emitted", t.replied)

    const part1 = questionPart(t.res)
    check("question tool part completed", part1?.state?.status === "completed", part1?.state?.status)
    const meta1 = part1?.state?.metadata?.answers
    check(
      "delimiter splits: metadata.answers = clean answer + note entry",
      JSON.stringify(meta1) === JSON.stringify([["Apples", "note: only organic, and skip bruised ones"]]),
      JSON.stringify(meta1),
    )
    const out1 = String(part1?.state?.output ?? "")
    check("tool_result: clean answer + note via annotations", out1.includes('"Apples" notes: only organic, and skip bruised ones'), JSON.stringify(out1))

    // ---- turn 2: multi-select — labels + a pure "// note" entry ----
    const t2 = await turn(
      sid,
      'Call the AskUserQuestion tool ONCE with exactly one question: question "Pick drinks", header "Drinks", multiSelect true, options Coffee ("Hot"), Juice ("Cold"), Water ("Plain"), no previews. Then reply with the single word DONE.',
      () => [["Coffee", "Juice", "// decaf please"]],
    )
    check("turn 2 question.asked fired", !!t2.asked)
    check("no preview part when no previews", !previewPart(t2.res))
    const part2 = questionPart(t2.res)
    const meta2 = part2?.state?.metadata?.answers
    check("pure-note entry rides beside toggled labels", JSON.stringify(meta2) === JSON.stringify([["Coffee", "Juice", "note: decaf please"]]), JSON.stringify(meta2))
    const out2 = String(part2?.state?.output ?? "")
    check("multi-select tool_result: labels + note", out2.includes('"Coffee, Juice" notes: decaf please'), JSON.stringify(out2))

    // ---- turn 3: loose reply shape (bare string), no note anywhere ----
    const t3 = await turn(
      sid,
      'Call the AskUserQuestion tool ONCE with exactly one question: question "Pick a color", header "Color", multiSelect false, options Red ("Warm") and Blue ("Cool"), no previews. Then reply with the single word DONE.',
      () => ["Red"], // bare string where [["Red"]] belongs — must normalize, not hang
    )
    check("turn 3 question.asked fired", !!t3.asked)
    const part3 = questionPart(t3.res)
    const meta3 = part3?.state?.metadata?.answers
    check("loose bare-string reply normalizes", JSON.stringify(meta3) === JSON.stringify([["Red"]]), JSON.stringify(meta3))
    const out3 = String(part3?.state?.output ?? "")
    check("no note → no annotations in tool_result", out3.includes('"Red"') && !out3.includes("notes:"), JSON.stringify(out3))
  } finally {
    proc.kill()
    rmSync(SCRATCH, { recursive: true, force: true })
    rmSync(STATE, { recursive: true, force: true })
  }
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS")
  process.exit(failures ? 1 : 0)
}

main()
