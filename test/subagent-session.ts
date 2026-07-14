// Integration test: prompt forces a Task subagent → child session mirrored over SSE →
// parent task tool part links it via state.metadata.sessionId → child transcript fetchable.
// Run against a live shim: bun run test/subagent-session.ts [baseURL]

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
          // auto-approve everything (clean-room shim gates the Task tool too)
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

  const t0 = Date.now()
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
            text: "Use the Task tool (subagent_type: general-purpose, run_in_background: false) to have a subagent compute 19*21 and reply with just the number. Tell the subagent to not use any tools. Then report the subagent's answer.",
          },
        ],
      }),
    })
  ).json()) as any
  console.log(`turn done in ${Date.now() - t0}ms`)
  await new Promise((r) => setTimeout(r, 500))
  ac.abort()
  await sse.catch(() => {})

  // 1. A child session must have been announced with parentID = main session.
  const childUpdates = events.filter((e) => e.type === "session.updated" && e.props?.info?.parentID === sid)
  const childID = childUpdates[0]?.props?.info?.id as string | undefined
  console.log("child session:", childID, "title:", childUpdates[0]?.props?.info?.title)

  // 2. The parent's task tool part must carry state.metadata.sessionId → child.
  const taskParts = events.filter((e) => e.type === "message.part.updated" && e.props?.part?.type === "tool" && e.props?.part?.tool === "task")
  const linked = taskParts.some((e) => e.props.part.state?.metadata?.sessionId === childID)
  console.log("task tool part events:", taskParts.length, "linked to child:", linked)

  // 3. Child transcript must be fetchable (this is what the TUI pull-syncs on click).
  let childMsgs: any[] = []
  if (childID) childMsgs = (await (await fetch(`${BASE}/session/${childID}/message`)).json()) as any[]
  const childUser = childMsgs.find((m) => m.info.role === "user")
  const childAssistant = childMsgs.find((m) => m.info.role === "assistant")
  const childText = (childAssistant?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ")
  console.log("child messages:", childMsgs.length, "| user text:", JSON.stringify((childUser?.parts?.[0]?.text ?? "").slice(0, 60)), "| assistant text:", JSON.stringify(childText.slice(0, 60)))

  // 4. Child went busy → idle.
  const childIdle = events.some((e) => e.type === "session.status" && e.props?.sessionID === childID && e.props?.status?.type === "idle")

  // 5. Final answer flowed back to the parent turn.
  const finalText = (res.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ")
  console.log("parent final text:", JSON.stringify(finalText.slice(0, 100)))

  const ok = !!childID && linked && !!childUser && !!childText && childIdle && finalText.includes("399")
  console.log("\n=== VERDICT ===")
  console.log("child session created:", !!childID)
  console.log("task part metadata.sessionId linked:", linked)
  console.log("child transcript has user+assistant text:", !!childUser && !!childText)
  console.log("child session reached idle:", childIdle)
  console.log("parent answer contains 399:", finalText.includes("399"))
  process.exit(ok ? 0 : 1)
}

main()
