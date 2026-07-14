// Probe: how does subagent (Task) content arrive on the SDK stream with
// includePartialMessages + forwardSubagentText? Logs one line per SDK message:
// type/subtype, parent_tool_use_id, stream event type, content block types.
// Run: bun run test/sdk-subagent-probe.ts

import { query } from "@anthropic-ai/claude-agent-sdk"

const q = query({
  prompt:
    "Use the Task tool with subagent_type general-purpose and run_in_background false to have a subagent compute 17*23 and reply with just the number. Tell the subagent to not use any tools. Then report the subagent's answer.",
  options: {
    model: "claude-haiku-4-5-20251001",
    includePartialMessages: true,
    forwardSubagentText: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    permissionMode: "default",
  },
})

for await (const m of q as AsyncIterable<any>) {
  const line: Record<string, unknown> = { type: m.type }
  if (m.subtype) line.subtype = m.subtype
  if ("parent_tool_use_id" in m) line.ptid = m.parent_tool_use_id
  if (m.type === "stream_event") {
    line.event = m.event?.type
    const b = m.event?.content_block
    if (b) line.block = b.type + (b.name ? `:${b.name}` : "")
  }
  if (m.type === "assistant" || m.type === "user") {
    const c = m.message?.content
    line.blocks = Array.isArray(c) ? c.map((x: any) => x.type + (x.name ? `:${x.name}` : "")).join(",") : typeof c
  }
  if (typeof m.subtype === "string" && m.subtype.startsWith("task_")) {
    line.task = { task_id: m.task_id, tool_use_id: m.tool_use_id, task_type: m.task_type, status: m.status ?? m.patch?.status, desc: m.description }
  }
  console.log(JSON.stringify(line))
  if (m.type === "result") break
}
