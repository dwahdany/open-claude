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

export const MODELS: Record<string, ReturnType<typeof model>> = {
  "claude-opus-4-8": model(
    "claude-opus-4-8",
    "Claude Opus 4.8",
    { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    { context: 200000, output: 64000 },
    "2026-05-01",
    EFFORT_VARIANTS,
  ),
  "claude-fable-5": model(
    "claude-fable-5",
    "Claude Fable 5",
    { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    { context: 200000, output: 64000 },
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
    { context: 200000, output: 64000 },
    "2025-10-01",
  ),
}

export const DEFAULT_MODEL = "claude-sonnet-5"

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

export const AGENTS = [
  {
    name: "build",
    description: "The default agent. Executes tools based on configured permissions.",
    mode: "primary",
    native: true,
    permission: [],
    options: {},
  },
  {
    name: "plan",
    description: "Plan mode. Disallows all edit tools.",
    mode: "primary",
    native: true,
    permission: [],
    options: {},
  },
  {
    name: "auto",
    description: "Auto mode. A model classifier approves/denies tool permissions; only risky actions prompt.",
    mode: "primary",
    native: true,
    permission: [],
    options: {},
  },
]

export const CONFIG = { model: `anthropic/${DEFAULT_MODEL}` }
