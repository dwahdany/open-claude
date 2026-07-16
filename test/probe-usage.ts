// Probe: SDK usage semantics for the context-% display (run: bun test/probe-usage.ts [model]).
// Questions:
//   1. Is result.usage summed across every API call in the turn (inflating the TUI context %)?
//   2. What do stream message_start / message_delta usage events carry per call?
//   3. What contextWindow does the CLI itself report per model (result.modelUsage)?
//
// FINDINGS (2026-07-16, CLI 2.1.207):
//   1. YES — result.usage sums per-call usage: with 3 API calls at ~22k context each,
//      result cache_read=43928 (=21895+22033) + cache_creation=22342, i.e. ~66k for a
//      22k-context turn. Long tool-heavy turns reach millions → "2.3M (1163%)" gauges.
//      result.usage.iterations[] holds ONLY the final call, not all of them.
//   2. Every API call emits message_start.usage {input, cache_read, cache_creation, small
//      output} and message_delta.usage with the SAME input/cache fields plus cumulative
//      output_tokens (+ output_tokens_details.thinking_tokens). The LAST call's usage is
//      the true current-context size. assistant messages can re-emit per content block
//      (4 usage repeats for 3 calls) — dedupe by call, not by count.
//   3. contextWindow via result.modelUsage on this auth: fable-5 1M, opus-4-8 1M,
//      sonnet-5 1M, haiku-4-5 200k; maxOutputTokens 64k except haiku 32k.
import { query } from "@anthropic-ai/claude-agent-sdk"

const MODEL = process.argv[2] ?? "claude-fable-5"

const q = query({
  prompt: `Use the Bash tool to run \`echo one\`, then use it again to run \`echo two\`, then reply done.`,
  options: {
    model: MODEL,
    maxTurns: 6,
    allowedTools: ["Bash"],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
  },
})

const calls: unknown[] = []
for await (const msg of q) {
  if (msg.type === "stream_event") {
    const e = (msg as any).event
    if (e.type === "message_start") console.log("message_start.usage:", JSON.stringify(e.message?.usage))
    if (e.type === "message_delta") console.log("message_delta.usage:", JSON.stringify(e.usage))
  }
  if (msg.type === "assistant") {
    calls.push((msg as any).message.usage)
    console.log("assistant.message.usage:", JSON.stringify((msg as any).message.usage))
  }
  if (msg.type === "result") {
    console.log("result.usage:", JSON.stringify((msg as any).usage))
    console.log("result.modelUsage:", JSON.stringify((msg as any).modelUsage))
    console.log("result.num_turns:", (msg as any).num_turns)
  }
}
console.log(`per-call count: ${calls.length}`)
