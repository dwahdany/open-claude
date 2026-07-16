// Read-only /model bridge. The TUI's model picker is authoritative: it re-sends its
// selection with EVERY prompt (vendor prompt/index.tsx submit), and the server cannot move
// the picker mid-session (the TUI re-reads it from the last user message only on session
// SWITCH). So a CLI-side "/model X" can never stick — the engine re-asserts the picker's
// model on the next turn (setModel wins: probe test/probe-model-switch.ts Q4), and until
// then the footer would show a model that isn't the one serving the turns. The command
// route intercepts /model (bare AND with args) and renders this view instead of forwarding.
// Contract: docs/contract/09-commands-and-session-list.md §6.2.

import { canonModelID, MODELS } from "./catalog"
import { syntheticTurn } from "./config-view"
import type { Store } from "./store"
import type { WithParts } from "./types"

/** CLI /model alias vocabulary → catalog ids. The CLI also accepts best/opusplan/default
 *  and [1m] forms; those have no catalog row and get the generic picker pointer. */
const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5-20251001",
  fable: "claude-fable-5",
}

/** Resolve a /model argument (alias, id, dated id, [1m] suffix) to a catalog id, or undefined. */
export function resolveModelArg(arg: string): string | undefined {
  const bare = arg.trim().toLowerCase().replace(/\[1m\]$/, "")
  const canon = canonModelID(ALIASES[bare] ?? arg.trim())
  return MODELS[canon] ? canon : undefined
}

export function renderModelView(model: { providerID: string; modelID: string; variant?: string }, args: string): string {
  const currentName = MODELS[model.modelID]?.name ?? model.modelID
  const variant = model.variant ? ` · variant ${model.variant}` : ""
  const lines: string[] = []
  if (args) {
    const target = resolveModelArg(args)
    lines.push(
      "`/model` is read-only here: the TUI's model picker re-sends its selection with every message, so a session-side switch would be silently reverted (and until then the footer would show the wrong model).",
      "",
      target === model.modelID
        ? `You are already on ${currentName}.`
        : target
          ? `To switch to ${MODELS[target]!.name}, pick it in the model list — /models (ctrl+x m).`
          : `Switch models in the model list — /models (ctrl+x m).`,
    )
  } else {
    lines.push(`Current model: ${currentName} (${model.providerID}/${model.modelID}${variant})`, "", "Switch with the model list — /models (ctrl+x m); the picker's choice rides every prompt. Variants (effort) live in the variant picker.")
  }
  const width = Math.max(...Object.values(MODELS).map((m) => m.name.length))
  lines.push(
    "",
    "```",
    ...Object.values(MODELS).map((m) => `${m.id === model.modelID ? "→" : " "} ${m.name.padEnd(width)}  ${m.id}`),
    "```",
  )
  return lines.join("\n")
}

/** The /model transcript turn: instant, engine-less (matches the /config intercept). */
export function modelView(store: Store, sessionID: string, model: { providerID: string; modelID: string; variant?: string }, agent: string, args: string): WithParts {
  return syntheticTurn(store, sessionID, model, agent, "/model" + (args ? " " + args : ""), renderModelView(model, args))
}
