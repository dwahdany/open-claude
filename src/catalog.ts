// Static bootstrap catalog: provider/model/agent/config JSON the TUI hard-requires.
// Contract: docs/contract/01-bootstrap.md §5.1-5.4. Provider id MUST be "anthropic"
// (not "opencode") and there must be ≥1 provider and ≥1 primary agent or the home screen breaks.

const API = { id: "anthropic", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" }

const CAPS = {
  temperature: true,
  reasoning: true,
  attachment: true,
  toolcall: true,
  input: { text: true, audio: false, image: true, video: false, pdf: true },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
  interleaved: true,
}

function model(
  id: string,
  name: string,
  cost: { input: number; output: number; cache: { read: number; write: number } },
  limit: { context: number; output: number },
  release_date: string,
  variants: Record<string, Record<string, unknown>> = {},
) {
  return {
    id,
    providerID: "anthropic",
    api: API,
    name,
    capabilities: CAPS,
    cost,
    limit,
    status: "active",
    options: {},
    headers: {},
    release_date,
    variants,
  }
}

// Variant keys are Agent SDK effort levels (engine.ts variantEffort maps key → Options.effort)
// plus "ultracode" → Settings.ultracode (xhigh effort + standing workflow orchestration; only
// takes effect when the account has workflows enabled and the model supports xhigh).
// The TUI only reads the keys for its variant picker; the values carry no options.
const EFFORT_VARIANTS = { low: {}, medium: {}, high: {}, xhigh: {}, max: {}, ultracode: {} }

// limit values are what the Claude Code CLI itself reports for this auth
// (result.modelUsage contextWindow/maxOutputTokens — test/probe-usage.ts); the TUI's
// context % divides the last assistant message's tokens by limit.context.
export const MODELS: Record<string, ReturnType<typeof model>> = {
  "claude-opus-4-8": model(
    "claude-opus-4-8",
    "Claude Opus 4.8",
    { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    { context: 1000000, output: 64000 },
    "2026-05-01",
    EFFORT_VARIANTS,
  ),
  "claude-fable-5": model(
    "claude-fable-5",
    "Claude Fable 5",
    { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    { context: 1000000, output: 64000 },
    "2026-06-01",
    EFFORT_VARIANTS,
  ),
  "claude-sonnet-5": model(
    "claude-sonnet-5",
    "Claude Sonnet 5",
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    { context: 1000000, output: 64000 },
    "2026-02-01",
    EFFORT_VARIANTS,
  ),
  "claude-haiku-4-5-20251001": model(
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
    { context: 200000, output: 32000 },
    "2025-10-01",
  ),
}

export const DEFAULT_MODEL = "claude-sonnet-5"

/** Map a CLI-reported model id onto the catalog id the TUI knows: exact match, or a dated
 *  variant in either direction ("claude-sonnet-5-20260201" ↔ "claude-sonnet-5"). Unknown ids
 *  pass through raw — the TUI then renders them without context-limit metadata, which is the
 *  honest fallback. */
export function canonModelID(id: string): string {
  if (MODELS[id]) return id
  const dated = (long: string, short: string) => long.startsWith(short + "-") && /^\d{8}$/.test(long.slice(short.length + 1))
  for (const c of Object.keys(MODELS)) {
    if (dated(id, c) || dated(c, id)) return c
  }
  return id
}

export const PROVIDER = {
  id: "anthropic",
  name: "Anthropic",
  source: "env",
  env: ["ANTHROPIC_API_KEY"],
  options: {},
  models: MODELS,
}

export const CONFIG_PROVIDERS = {
  providers: [PROVIDER],
  default: { anthropic: DEFAULT_MODEL },
}

export const PROVIDER_LIST = {
  all: [PROVIDER],
  default: { anthropic: DEFAULT_MODEL },
  connected: ["anthropic"],
}

// Colors are PINNED to what the TUI's index-based fallback assigned when the order was
// fixed [build, plan, auto] (local.tsx colors() = [secondary, accent, success, ...]).
// /agent is now served with the persisted default agent first (server.ts), and without
// explicit colors a reorder would rotate every agent's color between launches.
export const AGENTS = [
  {
    name: "build",
    description: "The default agent. Executes tools based on configured permissions.",
    mode: "primary",
    native: true,
    color: "secondary",
    permission: [],
    options: {},
  },
  {
    name: "plan",
    description: "Plan mode. Disallows all edit tools.",
    mode: "primary",
    native: true,
    color: "accent",
    permission: [],
    options: {},
  },
  {
    name: "auto",
    description: "Auto mode. A model classifier approves/denies tool permissions; only risky actions prompt.",
    mode: "primary",
    native: true,
    color: "success",
    permission: [],
    options: {},
  },
]

/** AGENTS with `first` moved to the front — the TUI boots on `agents().at(0)` and never
 *  persists its agent selection itself, so list order IS the startup mode. Unknown or
 *  absent names keep the stock order. */
export function orderedAgents(first?: string) {
  const hit = AGENTS.find((a) => a.name === first)
  if (!hit) return AGENTS
  return [hit, ...AGENTS.filter((a) => a !== hit)]
}

export const DEFAULT_MODEL_REF = `anthropic/${DEFAULT_MODEL}`

/** Validate + normalize a "providerID/modelID" ref against the catalog (dated ids canon
 *  to their catalog row). Anything else → undefined — a bad persisted/client value must
 *  fall back to the stock default, never reach the TUI, whose isModelValid would silently
 *  discard it anyway. */
export function validModelRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const slash = ref.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = ref.slice(0, slash)
  const modelID = canonModelID(ref.slice(slash + 1))
  if (providerID !== "anthropic" || !MODELS[modelID]) return undefined
  return `${providerID}/${modelID}`
}
