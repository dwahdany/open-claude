// Integration test: prompt that forces a bash tool → permission.asked fires → reply "once"
// → tool runs to completion → turn ends. Exercises the full permission bridge over HTTP+SSE.
// Run against a live shim (start it with a pinned port, e.g. `bun index.ts --serve --port 4096`):
//   bun run test/tool-permission.ts [baseURL]

const BASE = process.argv[2] ?? "http://localhost:4096"

async function main() {
  // 1. Create a session.
  const session = (await (
    await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", model: { id: "claude-haiku-4-5-20251001", providerID: "anthropic" } }),
    })
  ).json()) as any
  const sid = session.id as string
  console.log("session:", sid)

  // 2. Subscribe to SSE; auto-reply to the first permission.asked with "once".
  const events: { type: string; props: any }[] = []
  let repliedTo: string | null = null
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
        if (type === "permission.asked" && !repliedTo) {
          repliedTo = obj.payload.properties.id
          console.log("→ permission.asked:", obj.payload.properties.permission, "reqID:", repliedTo)
          await fetch(`${BASE}/permission/${repliedTo}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          })
          console.log("← replied once")
        }
      }
    }
  })

  await new Promise((r) => setTimeout(r, 300))

  // 3. Send a prompt that forces a bash tool. Blocks until the turn completes.
  const t0 = Date.now()
  const res = (await (
    await fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" },
        parts: [{ type: "text", text: "Create a new file named permtest.txt containing exactly the text hello-tool-9931 using the Write tool. Then stop." }],
      }),
    })
  ).json()) as any
  console.log(`turn done in ${Date.now() - t0}ms`)

  ac.abort()
  await sse.catch(() => {})

  // 4. Report.
  const toolParts = (res.parts ?? []).filter((p: any) => p.type === "tool")
  console.log("\n=== assistant parts ===")
  console.log((res.parts ?? []).map((p: any) => (p.type === "tool" ? `tool:${p.tool}(${p.state.status})` : p.type)).join(", "))
  console.log("\n=== tool states ===")
  for (const tp of toolParts) {
    console.log(`  ${tp.tool}: ${tp.state.status}`, tp.state.status === "completed" ? JSON.stringify(tp.state.output).slice(0, 80) : tp.state.error ?? "")
  }
  const types = events.reduce((m: Record<string, number>, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {})
  console.log("\n=== SSE event counts ===")
  console.log(types)

  const toolCompleted = toolParts.some((p: any) => p.state.status === "completed")
  console.log("\n=== VERDICT ===")
  console.log("permission.asked fired:", !!repliedTo)
  console.log("permission.replied emitted:", (types["permission.replied"] ?? 0) > 0)
  console.log("gated tool ran to completion after approval:", toolCompleted)
  console.log("turn reached idle:", (types["session.idle"] ?? 0) > 0)
  process.exit(toolCompleted && !!repliedTo ? 0 : 1)
}

main()
