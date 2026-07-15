// SDK slash-command bridge for GET /command + POST /session/:id/command validation.
// Contract: docs/contract/09-commands-and-session-list.md §1, §2, §4(b).
//
// The TUI fetches GET /command ONCE at bootstrap (before any engine exists) and never
// refetches, so the list is warmed at server boot from a throwaway query() —
// supportedCommands() resolves off the control channel without pushing any input, so the
// warm costs no tokens. Live engines refresh the cache on {type:"system",
// subtype:"commands_changed"} pushes (REPLACE semantics — probe test/probe-slash-commands.ts).

import { query, type Options, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk"

/** opencode Command wire shape (09 §1.1) — only fields we can source from the SDK; the TUI
 *  reads name/description/source, but template/hints must exist to be schema-shaped. */
export interface OpencodeCommand {
  name: string
  description: string
  source: "command"
  template: string
  hints: string[]
}

/**
 * TUI palette slash names + aliases, harvested from vendor/opencode/packages/tui/src:
 * app.tsx:570-835 (slashName/slashAliases), component/prompt/index.tsx:420-555,
 * routes/session/index.tsx:460-960, and the always-on feature plugins
 * (feature-plugins/system/diff-viewer.tsx registers "diff"). SDK commands with these
 * names are hidden from GET /command so the palette entry stays the single dispatch
 * path — EXCEPT "compact"
 * (deliberately NOT listed): exposing the SDK's compact entry means a fully-typed
 * /compact + Enter reaches POST /session/:id/command, which performs a real compaction —
 * the same outcome as the palette's POST /session/:id/summarize (09 §5).
 */
export const SHADOWED_TUI_SLASHES: ReadonlySet<string> = new Set([
  // app.tsx global palette
  "sessions", "resume", "continue", "new", "clear", "workspaces", "models", "mo", "agents",
  "mcps", "variants", "connect", "org", "orgs", "switch-org", "status", "debug", "themes",
  "help", "exit", "quit", "q",
  // component/prompt palette + always-on feature plugins
  "editor", "skills", "warp", "move", "diff",
  // routes/session palette ("compact" deliberately kept visible)
  "share", "rename", "timeline", "fork", "summarize", "unshare", "undo", "redo",
  "timestamps", "toggle-timestamps", "thinking", "toggle-thinking", "copy", "export",
])

/** SlashCommand → opencode Command (09 §4(b) mapping table): template is unmappable (the
 *  SDK never exposes command bodies) and aliases are dropped (the TUI matches exact names). */
export function toOpencodeCommands(list: SlashCommand[]): OpencodeCommand[] {
  return list
    .filter((c) => !SHADOWED_TUI_SLASHES.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description ?? "",
      source: "command" as const,
      template: "",
      hints: c.argumentHint ? [c.argumentHint] : [],
    }))
}

/** Input iterable that never yields: the warm query only serves control-channel requests. */
const idleInput: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
}

export class CommandCache {
  private commands: OpencodeCommand[] | null = null
  private warming: Promise<void> | null = null

  constructor(private directory: string) {}

  /** Fire-and-forget warm. Re-armed by list() whenever a previous warm settled empty. */
  warm(): void {
    if (this.commands || this.warming) return
    this.warming = this.fetch()
      .then((list) => {
        if (list) this.commands = toOpencodeCommands(list)
      })
      .catch(() => {})
      .finally(() => {
        this.warming = null
      })
  }

  /** GET /command: await the warm (cap ~15s), then serve what we have — [] lets the TUI
   *  boot without autocomplete; a later call retries the warm. */
  async list(): Promise<OpencodeCommand[]> {
    if (this.commands) return this.commands
    this.warm()
    const w = this.warming
    if (w) await Promise.race([w, Bun.sleep(15_000)])
    return this.commands ?? []
  }

  /** commands_changed push from a live engine: REPLACE the cache (09 §4(b)). */
  replace(list: SlashCommand[]): void {
    this.commands = toOpencodeCommands(list)
  }

  /** One throwaway query: same settingSources policy as engines (project commands only load
   *  with default sources), persistSession: false so no transcript lands on disk, aborted
   *  right after reading. null on failure/timeout so the caller can retry later. */
  private async fetch(): Promise<SlashCommand[] | null> {
    const abort = new AbortController()
    const options: Options = {
      cwd: this.directory,
      permissionMode: "default",
      persistSession: false,
      abortController: abort,
      systemPrompt: { type: "preset", preset: "claude_code" },
    }
    if (process.env.OPENCLAUDE_SETTING_SOURCES === "none") options.settingSources = []
    const q = query({ prompt: idleInput, options })
    const drain = (async () => {
      try {
        for await (const _ of q) {
          /* discard — nothing streams without input */
        }
      } catch {
        /* aborted */
      }
    })()
    try {
      return await Promise.race([q.supportedCommands(), Bun.sleep(30_000).then(() => null)])
    } catch {
      return null
    } finally {
      abort.abort()
      await drain
    }
  }
}
