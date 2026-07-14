// Integration test: a Workflow tool run renders as a task part (Task renderer) linked to a
// child session whose transcript is a live progress log fed by task_progress/task_notification.
// Requires an account with the Workflows feature. Run: bun run test/workflow-render.ts [baseURL]

const BASE = process.argv[2] ?? "http://localhost:4098"

const SCRIPT = [
  "export const meta = { name: 'ping', description: 'one-agent ping', phases: [{ title: 'P' }] }",
  "phase('P')",
  "const r = await agent('Reply with exactly the word plum-7742 and nothing else. Do not use tools.')",
  "return { word: r }",
].join("\n")

async function main() {
  const session = (await (
    await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", model: { id: "claude-sonnet-5", providerID: "anthropic" } }),
    })
  ).json()) as any
  const sid = session.id as string
  console.log("session:", sid)

  const events: { type: string; props: any }[] = []
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
        const line = buf.slice(0, idx).replace(/^data: /, "")
        buf = buf.slice(idx + 2)
        if (!line) continue
        const obj = JSON.parse(line)
        events.push({ type: obj.payload?.type, props: obj.payload?.properties })
        if (obj.payload?.type === "permission.asked") {
          await fetch(`${BASE}/permission/${obj.payload.properties.id}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          })
        }
      }
    }
  })
  await new Promise((r) => setTimeout(r, 300))

  await fetch(`${BASE}/session/${sid}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      parts: [{ type: "text", text: `Invoke the Workflow tool exactly once with this exact script, then stop:\n\n${SCRIPT}` }],
    }),
  }).then((r) => r.json())
  console.log("turn 1 returned (workflow launched async)")

  // The workflow keeps running after the turn; wait for the child session to reach idle.
  const childOf = () => events.find((e) => e.type === "session.updated" && e.props?.info?.parentID === sid)?.props?.info
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const child = childOf()
    if (child && events.some((e) => e.type === "session.status" && e.props?.sessionID === child.id && e.props?.status?.type === "idle")) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  await new Promise((r) => setTimeout(r, 500))
  ac.abort()
  await sse.catch(() => {})

  const child = childOf()
  console.log("child session:", child?.id, "| agent:", child?.agent, "| title:", child?.title)

  const taskParts = events.filter((e) => e.type === "message.part.updated" && e.props?.part?.type === "tool" && e.props?.part?.tool === "task" && e.props?.part?.state?.input?.subagent_type === "workflow")
  const lastTask = taskParts.at(-1)?.props?.part
  console.log("workflow task part:", taskParts.length, "| description:", lastTask?.state?.input?.description, "| metadata:", JSON.stringify(lastTask?.state?.metadata))

  let childMsgs: any[] = []
  if (child) childMsgs = (await (await fetch(`${BASE}/session/${child.id}/message`)).json()) as any[]
  const progressTexts = childMsgs.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text))
  console.log("child progress log:")
  for (const t of progressTexts) console.log("   •", JSON.stringify(t.slice(0, 90)))

  const childIdle = events.some((e) => e.type === "session.status" && e.props?.sessionID === child?.id && e.props?.status?.type === "idle")
  const linked = lastTask?.state?.metadata?.sessionId === child?.id && lastTask?.state?.metadata?.background === true

  const ok = !!child && linked && progressTexts.length >= 1 && childIdle
  console.log("\n=== VERDICT ===")
  console.log("workflow child session created:", !!child)
  console.log("task part linked (sessionId + background):", linked)
  console.log("progress log has entries:", progressTexts.length >= 1)
  console.log("child reached idle:", childIdle)
  process.exit(ok ? 0 : 1)
}

main()
