// Smoke test: Agent SDK under Bun with local auth (subscription login or ANTHROPIC_API_KEY).
import { query } from "@anthropic-ai/claude-agent-sdk"

const q = query({
  prompt: "Reply with exactly: OK",
  options: {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 1,
    allowedTools: [],
  },
})

for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("init:", JSON.stringify({ model: msg.model, apiKeySource: msg.apiKeySource, cwd: msg.cwd }))
  }
  if (msg.type === "result") {
    console.log("result:", JSON.stringify({ subtype: msg.subtype, result: (msg as any).result, cost: (msg as any).total_cost_usd }))
  }
}
