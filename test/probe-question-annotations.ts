// Probe: what tool_result does the model receive when AskUserQuestion answers are injected
// via canUseTool updatedInput — and are `annotations` ({ notes?, preview? } per question)
// passed through? Run: bun test/probe-question-annotations.ts
// Raw SDK message logs land in /tmp/oc-probe-question-logs/<variant>.jsonl (+ summary.json).
//
// VERIFIED FINDINGS (run 2026-07-16, CLI 2.1.207 via SDK 0.3.207, haiku-4-5; all 6 variants
// succeeded first try, result subtype "success", tool_result is_error=false everywhere):
// 1. The tool_result content is a single plain STRING (never a block array):
//    'Your questions have been answered: "<question>"="<answer>". You can now continue with
//    these answers in mind.' — multiple questions join with ", " inside the same sentence.
// 2. annotations ARE passed through and rendered inline right after the answer:
//    notes only      → ...="Apples" notes: please get the organic ones.
//    notes + preview → ...="Apples" selected preview:\nMOCKUP:\n[apple pic] notes: organic please.
//    (preview renders BEFORE notes, prefixed "selected preview:\n"; notes prefixed "notes: ";
//    separators are single spaces — no punctuation between answer/preview/notes.)
// 3. Annotations bind per question: with two questions and annotations only on the first →
//    '"Q1"="Apples" notes: note attached to first question, "Q2"="Coffee"'.
// 4. Answer strings are NOT validated against option labels: a custom string is echoed
//    verbatim ('"Q"="Cherries, and note: only if they are in season"'); multiSelect
//    comma-joined labels ("Apples, Bananas") pass through unchanged as one string.
// 5. No variant produced is_error or a schema rejection — answers/annotations are legit
//    optional fields of AskUserQuestionInput (see sdk-tools.d.ts), so updatedInput validates.
// 6. The SDK "user" message carrying the tool_result also has a snake_case `tool_use_result`
//    field with the STRUCTURED AskUserQuestionOutput {questions, answers, annotations?} —
//    annotations echoed verbatim; `response`/`afkTimeoutMs` absent when not set.
//    (Field name is tool_use_result, NOT the camelCase toolUseResult of older probes.)
//
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { mkdirSync } from "node:fs"

const CWD = "/tmp/oc-probe-question"
const LOGDIR = "/tmp/oc-probe-question-logs"
const PRIMARY_MODEL = "claude-haiku-4-5-20251001"
const FALLBACK_MODEL = "claude-sonnet-5"

mkdirSync(CWD, { recursive: true })
mkdirSync(LOGDIR, { recursive: true })

// ---- streaming input queue (copied from src/engine.ts convention) ----
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false
  push(msg: SDKUserMessage): void {
    const w = this.waiters.shift()
    if (w) w({ value: msg, done: false })
    else this.items.push(msg)
  }
  close(): void {
    this.closed = true
    let w: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function makeUser(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  } as SDKUserMessage
}

// Question texts we ask the model to use; answers are keyed off the ACTUAL question text
// observed in the tool input (haiku sometimes rephrases), falling back to these.
const ONE_Q_PROMPT =
  'Call the AskUserQuestion tool ONCE with exactly one question: question "Which fruit should I buy?", ' +
  'header "Fruit", multiSelect false, options exactly: ' +
  '[{label: "Apples", description: "Red fruit", preview: "MOCKUP:\\n[apple pic]"}, ' +
  '{label: "Bananas", description: "Yellow fruit"}]. ' +
  "After you get the tool result, reply with the single word DONE."

const MULTI_PROMPT =
  'Call the AskUserQuestion tool ONCE with exactly one question: question "Which fruits should I buy?", ' +
  'header "Fruits", multiSelect true, options exactly: ' +
  '[{label: "Apples", description: "Red fruit"}, {label: "Bananas", description: "Yellow fruit"}, ' +
  '{label: "Cherries", description: "Small red fruit"}]. ' +
  "After you get the tool result, reply with the single word DONE."

const TWO_Q_PROMPT =
  "Call the AskUserQuestion tool ONCE with exactly TWO questions. " +
  'Question 1: question "Which fruit should I buy?", header "Fruit", multiSelect false, options ' +
  '[{label: "Apples", description: "Red fruit"}, {label: "Bananas", description: "Yellow fruit"}]. ' +
  'Question 2: question "Which drink should I buy?", header "Drink", multiSelect false, options ' +
  '[{label: "Coffee", description: "Hot drink"}, {label: "Juice", description: "Cold drink"}]. ' +
  "After you get the tool result, reply with the single word DONE."

interface Variant {
  name: string
  prompt: string
  // Given the original tool input and the question texts, build updatedInput.
  build: (input: Record<string, unknown>, qs: string[]) => Record<string, unknown>
}

const VARIANTS: Variant[] = [
  {
    name: "label-only",
    prompt: ONE_Q_PROMPT,
    build: (input, [q0]) => ({ ...input, answers: { [q0!]: "Apples" } }),
  },
  {
    name: "notes",
    prompt: ONE_Q_PROMPT,
    build: (input, [q0]) => ({
      ...input,
      answers: { [q0!]: "Apples" },
      annotations: { [q0!]: { notes: "please get the organic ones" } },
    }),
  },
  {
    name: "notes-preview",
    prompt: ONE_Q_PROMPT,
    build: (input, [q0]) => ({
      ...input,
      answers: { [q0!]: "Apples" },
      annotations: { [q0!]: { notes: "organic please", preview: "MOCKUP:\n[apple pic]" } },
    }),
  },
  {
    name: "custom-answer",
    prompt: ONE_Q_PROMPT,
    build: (input, [q0]) => ({
      ...input,
      answers: { [q0!]: "Cherries, and note: only if they are in season" },
    }),
  },
  {
    name: "multiselect",
    prompt: MULTI_PROMPT,
    build: (input, [q0]) => ({ ...input, answers: { [q0!]: "Apples, Bananas" } }),
  },
  {
    name: "two-questions",
    prompt: TWO_Q_PROMPT,
    build: (input, [q0, q1]) => ({
      ...input,
      answers: { [q0!]: "Apples", [q1!]: "Coffee" },
      annotations: { [q0!]: { notes: "note attached to first question" } },
    }),
  },
]

interface VariantResult {
  name: string
  model: string
  askInput: Record<string, unknown> | null // original tool input from canUseTool
  updatedInputSent: Record<string, unknown> | null // what we returned via updatedInput
  toolUseId: string | null
  toolUseBlockInput: unknown // the tool_use block input as the assistant emitted it
  toolResultContent: unknown // EXACT tool_result content block(s), verbatim from the stream
  toolResultIsError: boolean | null
  toolUseResultField: unknown // the SDK user message's tool_use_result field, if present
  finalText: string | null
  resultSubtype: string | null
  error: string | null
  nMessages: number
}

async function runVariant(v: Variant, model: string): Promise<VariantResult> {
  const input = new InputQueue()
  const abort = new AbortController()
  const res: VariantResult = {
    name: v.name,
    model,
    askInput: null,
    updatedInputSent: null,
    toolUseId: null,
    toolUseBlockInput: null,
    toolResultContent: null,
    toolResultIsError: null,
    toolUseResultField: null,
    finalText: null,
    resultSubtype: null,
    error: null,
    nMessages: 0,
  }
  const raw: unknown[] = []
  console.log(`\n===== variant ${v.name} (model ${model})`)
  const options: Options = {
    cwd: CWD,
    model,
    permissionMode: "default",
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    maxTurns: 4,
    abortController: abort,
    canUseTool: async (toolName, toolInput) => {
      if (toolName !== "AskUserQuestion") return { behavior: "allow" as const }
      res.askInput = toolInput
      const qs = Array.isArray((toolInput as { questions?: unknown }).questions)
        ? ((toolInput as { questions: { question?: unknown }[] }).questions ?? []).map((q) => String(q?.question ?? ""))
        : []
      const updated = v.build(toolInput, qs)
      res.updatedInputSent = updated
      console.log(`[${v.name}] canUseTool AskUserQuestion; qs=${JSON.stringify(qs)}`)
      return { behavior: "allow" as const, updatedInput: updated }
    },
  }
  const q = query({ prompt: input, options })
  input.push(makeUser(v.prompt))
  const killer = setTimeout(() => {
    console.log(`[${v.name}] !!! timeout — aborting`)
    input.close()
    abort.abort()
  }, 150_000)
  try {
    for await (const m of q as AsyncIterable<any>) {
      raw.push(m)
      res.nMessages++
      if (m.type === "assistant") {
        const blocks = Array.isArray(m.message?.content) ? m.message.content : []
        for (const b of blocks) {
          if (b?.type === "tool_use" && b.name === "AskUserQuestion") {
            res.toolUseId = b.id
            res.toolUseBlockInput = b.input
          }
          if (b?.type === "text") res.finalText = b.text
        }
      }
      if (m.type === "user") {
        const blocks = Array.isArray(m.message?.content) ? m.message.content : []
        for (const b of blocks) {
          if (b?.type === "tool_result" && (res.toolUseId === null || b.tool_use_id === res.toolUseId)) {
            res.toolResultContent = b.content
            res.toolResultIsError = b.is_error ?? false
            if ("tool_use_result" in m) res.toolUseResultField = m.tool_use_result
          }
        }
      }
      if (m.type === "result") {
        res.resultSubtype = m.subtype
        input.close()
      }
      console.log(`[${v.name}] ${m.type}${m.subtype ? ":" + m.subtype : ""}`)
    }
  } catch (e: any) {
    res.error = JSON.stringify({ name: e?.name, message: e?.message, str: String(e) })
    console.log(`[${v.name}] THREW: ${res.error}`)
  } finally {
    clearTimeout(killer)
    input.close()
    abort.abort()
  }
  await Bun.write(`${LOGDIR}/${v.name}${model === FALLBACK_MODEL ? "-sonnet" : ""}.jsonl`, raw.map((m) => JSON.stringify(m)).join("\n") + "\n")
  return res
}

function good(r: VariantResult): boolean {
  return r.error === null && r.askInput !== null && r.toolResultContent !== null && r.resultSubtype === "success"
}

const results: VariantResult[] = []
for (const v of VARIANTS) {
  let r = await runVariant(v, PRIMARY_MODEL)
  if (!good(r)) {
    console.log(`[${v.name}] first attempt incomplete — retrying on ${PRIMARY_MODEL}`)
    r = await runVariant(v, PRIMARY_MODEL)
  }
  if (!good(r)) {
    console.log(`[${v.name}] retry incomplete — falling back to ${FALLBACK_MODEL}`)
    r = await runVariant(v, FALLBACK_MODEL)
  }
  results.push(r)
}

console.log("\n===== SUMMARY =====")
for (const r of results) {
  console.log(`\n--- ${r.name} (model ${r.model}) ok=${good(r)} is_error=${r.toolResultIsError}`)
  console.log(`updatedInput extras: answers=${JSON.stringify((r.updatedInputSent as any)?.answers)} annotations=${JSON.stringify((r.updatedInputSent as any)?.annotations)}`)
  console.log(`tool_result content: ${JSON.stringify(r.toolResultContent)}`)
  console.log(`toolUseResult field: ${JSON.stringify(r.toolUseResultField)}`)
  console.log(`final text: ${JSON.stringify(r.finalText)}`)
}
await Bun.write(`${LOGDIR}/summary.json`, JSON.stringify(results, null, 2))
console.log(`\nraw logs: ${LOGDIR}/<variant>.jsonl ; summary: ${LOGDIR}/summary.json`)
