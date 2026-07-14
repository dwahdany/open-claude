// Integration test: prompt forces AskUserQuestion → question.asked fires over SSE →
// POST /question/{id}/reply with a selected label → question.replied → the model receives
// the answer via updatedInput and finishes the turn echoing it.
// Run against a live shim: bun run test/question-bridge.ts [baseURL]

const BASE = process.argv[2] ?? "http://localhost:4098"

async function main() {
  const session = (await (
    await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", model: { id: "claude-haiku-4-5-20251001", providerID: "anthropic" } }),
    })
  ).json()) as any
  const sid = session.id as string
  console.log("session:", sid)

  const events: { type: string; props: any }[] = []
  let asked: any = null
  const ac = new AbortController()
  const sse = fetch(`${BASE}/global/event`, { signal: ac.signal }).then(async (res) => {
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
        events.push({ type, props: obj.payload?.properties })
        if (type === "permission.asked") {
          await fetch(`${BASE}/permission/${obj.payload.properties.id}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          })
        }
        if (type === "question.asked" && !asked) {
          asked = obj.payload.properties
          console.log("→ question.asked:", JSON.stringify(asked.questions?.map((q: any) => ({ q: q.question, opts: q.options?.map((o: any) => o.label) }))))
          // Reply like the TUI does: Array<Array<string>> of selected labels, in question order.
          const answers = asked.questions.map((q: any) => [q.options?.[1]?.label ?? q.options?.[0]?.label ?? "Blue"])
          await fetch(`${BASE}/question/${asked.id}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answers }),
          })
          console.log("← replied:", JSON.stringify(answers))
        }
      }
    }
  })

  await new Promise((r) => setTimeout(r, 300))

  const res = (await (
    await fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" },
        parts: [
          {
            type: "text",
            text: "Use the AskUserQuestion tool to ask me which color I prefer, with options Red and Blue. After I answer, reply with exactly: 'You chose <color>'.",
          },
        ],
      }),
    })
  ).json()) as any

  ac.abort()
  await sse.catch(() => {})

  const chosen = asked?.questions?.[0]?.options?.[1]?.label ?? "Blue"
  const finalText = (res.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ")
  const replied = events.some((e) => e.type === "question.replied")
  console.log("final text:", JSON.stringify(finalText))

  const ok = !!asked && replied && finalText.toLowerCase().includes(chosen.toLowerCase())
  console.log("\n=== VERDICT ===")
  console.log("question.asked fired:", !!asked)
  console.log("question.replied emitted:", replied)
  console.log(`final text echoes chosen label (${chosen}):`, finalText.toLowerCase().includes(chosen.toLowerCase()))
  process.exit(ok ? 0 : 1)
}

main()
