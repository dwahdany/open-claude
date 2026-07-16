// Read-only /config bridge. A bare "/config" from the TUI renders the current Claude Code
// settings as an instant synthetic transcript turn — the headless CLI can only print its
// usage dump (the interactive menu lives in Claude Code's own TUI, which isn't running
// here). "/config key=value" still passes through to the CLI, which validates + persists.
//
// Storage map probed live against CLI 2.1.x (throwaway CLAUDE_CONFIG_DIR, every key set
// once, then diff): /config writes land in THREE files, most under a renamed key:
//   - the settings chain, read here with the CLI's precedence
//       <project>/.claude/settings.local.json > <project>/.claude/settings.json >
//       $CLAUDE_CONFIG_DIR/settings.json (default ~/.claude/settings.json)
//   - global state $CLAUDE_CONFIG_DIR/.claude.json (default ~/.claude.json), top-level keys
// Unset keys have no on-disk trace (defaults are compiled into the CLI) → "(default)".

import { homedir } from "node:os"
import { join } from "node:path"
import type { Store } from "./store"
import type { WithParts } from "./types"

interface KeyDef {
  key: string // the /config name (usage-dump order: alphabetical)
  store: "settings" | "global"
  path: string[] // stored key path, which often differs from the /config name
}

export const CONFIG_KEYS: KeyDef[] = [
  { key: "askUserQuestionTimeout", store: "settings", path: ["askUserQuestionTimeout"] },
  { key: "autoCompact", store: "settings", path: ["autoCompactEnabled"] },
  { key: "autoConnectIde", store: "global", path: ["autoConnectIde"] },
  { key: "autoScroll", store: "settings", path: ["autoScrollEnabled"] },
  { key: "checkpoints", store: "settings", path: ["fileCheckpointingEnabled"] },
  { key: "chrome", store: "global", path: ["claudeInChromeDefaultEnabled"] },
  { key: "copyFullResponse", store: "global", path: ["copyFullResponse"] },
  { key: "copyOnSelect", store: "global", path: ["copyOnSelect"] },
  { key: "defaultToAgentsView", store: "global", path: ["defaultToAgentsView"] },
  { key: "editor", store: "settings", path: ["editorMode"] },
  { key: "externalEditorContext", store: "global", path: ["externalEditorContext"] },
  { key: "gitignore", store: "global", path: ["respectGitignore"] },
  { key: "language", store: "settings", path: ["language"] },
  { key: "leftArrowOpensAgents", store: "global", path: ["leftArrowOpensAgents"] },
  { key: "model", store: "settings", path: ["model"] },
  { key: "notifChannel", store: "settings", path: ["preferredNotifChannel"] },
  { key: "outputStyle", store: "settings", path: ["outputStyle"] },
  { key: "permissionMode", store: "settings", path: ["permissions", "defaultMode"] },
  { key: "prStatus", store: "global", path: ["prStatusFooterEnabled"] },
  { key: "progressBar", store: "settings", path: ["terminalProgressBarEnabled"] },
  { key: "promptSuggestionEnabled", store: "settings", path: ["promptSuggestionEnabled"] },
  { key: "recap", store: "settings", path: ["awaySummaryEnabled"] },
  { key: "reduceMotion", store: "settings", path: ["prefersReducedMotion"] },
  { key: "switchModelsOnFlag", store: "settings", path: ["switchModelsOnFlag"] },
  { key: "teammateDefaultModel", store: "global", path: ["teammateDefaultModel"] },
  { key: "teammateMode", store: "settings", path: ["teammateMode"] },
  { key: "theme", store: "settings", path: ["theme"] },
  { key: "thinking", store: "settings", path: ["alwaysThinkingEnabled"] },
  { key: "tips", store: "settings", path: ["spinnerTipsEnabled"] },
  { key: "turnDuration", store: "settings", path: ["showTurnDuration"] },
  { key: "useAutoModeDuringPlan", store: "settings", path: ["useAutoModeDuringPlan"] },
  { key: "verbose", store: "settings", path: ["verbose"] },
  { key: "workflowKeywordTriggerEnabled", store: "settings", path: ["workflowKeywordTriggerEnabled"] },
  { key: "workflowSizeGuideline", store: "global", path: ["workflowSizeGuideline"] },
  { key: "workflows", store: "settings", path: ["enableWorkflows"] },
  { key: "worktreeBaseRef", store: "settings", path: ["worktree", "baseRef"] },
]

export interface ConfigRow {
  key: string
  value?: string
  source?: string // display path of the file the value came from; unset → default
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await Bun.file(path).json()
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function lookup(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const seg of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v)
}

/** Everything environmental is injected (alias.ts pattern) so tests run headless. */
export async function readConfigRows(directory: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): Promise<ConfigRow[]> {
  const configDir = env.CLAUDE_CONFIG_DIR
  const userSettingsPath = configDir ? join(configDir, "settings.json") : join(home, ".claude", "settings.json")
  const globalPath = configDir ? join(configDir, ".claude.json") : join(home, ".claude.json")
  const shorten = (p: string) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p)
  const chain: { label: string; file: Promise<Record<string, unknown> | null> }[] = [
    { label: ".claude/settings.local.json", file: readJson(join(directory, ".claude", "settings.local.json")) },
    { label: ".claude/settings.json", file: readJson(join(directory, ".claude", "settings.json")) },
    { label: shorten(userSettingsPath), file: readJson(userSettingsPath) },
  ]
  const globalLabel = shorten(globalPath)
  const global = await readJson(globalPath)
  const settings = await Promise.all(chain.map((c) => c.file))
  return CONFIG_KEYS.map((def) => {
    if (def.store === "global") {
      const v = global ? lookup(global, def.path) : undefined
      return v === undefined ? { key: def.key } : { key: def.key, value: fmt(v), source: globalLabel }
    }
    for (let i = 0; i < chain.length; i++) {
      const obj = settings[i]
      const v = obj ? lookup(obj, def.path) : undefined
      if (v !== undefined) return { key: def.key, value: fmt(v), source: chain[i]!.label }
    }
    return { key: def.key }
  })
}

export function renderConfigRows(rows: ConfigRow[]): string {
  const keyW = Math.max(...rows.map((r) => r.key.length))
  const valW = Math.max(9, ...rows.map((r) => r.value?.length ?? 0)) // 9 = "(default)"
  const lines = rows.map((r) => {
    const value = r.value ?? "(default)"
    return `${r.key.padEnd(keyW)}  ${r.source ? `${value.padEnd(valW)}  · ${r.source}` : value}`
  })
  return [
    "Claude Code settings — change with `/config key=value` (new sessions pick up changes;",
    "model & permission mode follow the TUI's own pickers per turn).",
    "",
    "```",
    ...lines,
    "```",
  ].join("\n")
}

/** Synthesize the /config transcript turn: user "/config" + completed assistant listing.
 *  Same store factories and event order as a real turn (03 §3), minus busy/step parts —
 *  the turn is instant and never touches an engine. Returns the {info, parts} the command
 *  route responds with. */
export async function configView(store: Store, sessionID: string, model: { providerID: string; modelID: string; variant?: string }, agent: string): Promise<WithParts> {
  const directory = store.getSession(sessionID)?.directory ?? store.directory
  const text = renderConfigRows(await readConfigRows(directory))
  const user = store.newUserMessage(sessionID, agent, model)
  store.addMessage(sessionID, user)
  store.putPart(sessionID, store.newPart(sessionID, user.id, { type: "text", text: "/config" }))
  const assistant = store.newAssistantMessage(sessionID, user.id, agent, model.providerID, model.modelID, model.variant)
  store.addMessage(sessionID, assistant)
  const now = Date.now()
  const part = store.newPart(sessionID, assistant.id, { type: "text", text, time: { start: now, end: now } })
  store.putPart(sessionID, part)
  assistant.finish = "stop"
  assistant.time.completed = Date.now()
  store.updateMessage(sessionID, assistant)
  store.touchSession(sessionID, {})
  return { info: assistant, parts: [part] }
}
