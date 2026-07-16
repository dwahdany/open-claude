// open-claude: serve the opencode HTTP/SSE API backed by the Claude Agent SDK.
// Usage: open-claude [--port <n>] [--hostname <host>] [--directory /path/to/project] [--serve]
// Default: start the server AND hand the terminal to `opencode attach`.
// --serve (or a non-TTY, or no opencode CLI) runs the server standalone and prints the URL.

import { offerAliasOnFirstRun } from "./src/alias"
import { createApp } from "./src/server"
import { Store } from "./src/store"
import { checkForUpdate } from "./src/update"

const OPENCODE_PIN = "1.17.19"

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const val = i >= 0 ? process.argv[i + 1] : undefined
  return val ?? fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

if (flag("help") || flag("h")) {
  console.log(`open-claude — run the opencode TUI on a Claude Code backend

Usage: open-claude [options]

By default this starts the server and immediately launches \`opencode attach\`
against it (one command, full UI). Quitting the TUI stops the server.

Options:
  --port <n>         port to listen on (default: 0 — an OS-assigned free port,
                     so multiple instances can run side by side)
  --hostname <host>  hostname to listen on (default 127.0.0.1)
  --directory <dir>  working directory for the Claude Code agent (default: cwd)
  --serve            server only: print the URL and wait for clients to attach
  --help             show this help

Requires the opencode CLI v${OPENCODE_PIN} (https://opencode.ai) and Claude auth
(a Claude subscription via \`claude /login\`, or ANTHROPIC_API_KEY).

Env:
  OPENCLAUDE_SETTING_SOURCES=none  ignore ~/.claude allowlists (prompt for every tool)
  OPENCLAUDE_ULTRACODE=1           enable ultracode (needs workflows + xhigh model)
  OPENCLAUDE_NO_ALIAS_PROMPT=1     never offer the first-run \`oclaude\` shell alias
  OPENCLAUDE_NO_UPDATE_CHECK=1     never check npm for a newer version
  OPENCLAUDE_NO_QUESTION_NOTES=1   drop the extra "Notes" tab on question dialogs`)
  process.exit(0)
}

const port = Number(arg("port", "0")) // 0 = let the OS pick a free port (matches `opencode serve`)
const hostname = arg("hostname", "127.0.0.1")
const directory = arg("directory", process.cwd())

// Before any server output: on the very first interactive run, offer to save an
// `oclaude` shell alias. No-op on non-TTYs and every run after the first.
await offerAliasOnFirstRun()

// Loads project.json (stable projectID) + every persisted session BEFORE serving.
const store = await Store.load(directory)
const app = createApp(store)

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0, // never time out SSE / long-blocking prompt requests
    fetch: app.fetch,
  })
} catch (err) {
  if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
    console.error(`open-claude: port ${port} is already in use — pass a different --port, or omit --port to auto-pick a free one`)
    process.exit(1)
  }
  throw err
}

const urlHost = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname
const url = `http://${urlHost}:${server.port}`
console.log(`open-claude listening on ${url}`)
console.log(`  directory: ${directory}`)

// Background npm release check (throttled to one per day; never throws). Printed only
// where it cannot corrupt the TUI: serve-mode logs, or after the TUI returns the terminal.
const updateNotice = checkForUpdate()

// Attaching is the default; --serve/--no-attach opts out, a non-TTY (pipes, CI) implies it,
// and a missing opencode CLI degrades to serve-only instead of failing. --attach is a
// legacy no-op alias from when serve-only was the default.
const serveOnly = flag("serve") || flag("no-attach") || !process.stdout.isTTY

function opencodeVersion(): string | null {
  try {
    const res = Bun.spawnSync(["opencode", "--version"])
    return res.success ? res.stdout.toString().trim() : null
  } catch {
    return null
  }
}

const found = serveOnly ? null : opencodeVersion()
if (!serveOnly && found === null) {
  console.log(`  opencode CLI not found — running server-only.`)
  console.log(`  install opencode v${OPENCODE_PIN} (https://opencode.ai), then: opencode attach ${url}`)
}

if (!serveOnly && found !== null) {
  if (found !== OPENCODE_PIN) {
    console.warn(`  warning: opencode ${found} detected; this server implements the v${OPENCODE_PIN} API and other versions may drift`)
  }
  const tui = Bun.spawn(["opencode", "attach", url, "--dir", directory], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await tui.exited
  server.stop(true)
  // Settled long ago in any real session; the race caps a TUI that exits within seconds of boot.
  const notice = await Promise.race([updateNotice, new Promise<null>((r) => setTimeout(() => r(null), 250))])
  if (notice) console.log(notice)
  process.exit(code)
} else {
  console.log(`  attach with: opencode attach ${url}`)
  void updateNotice.then((notice) => {
    if (notice) console.log(notice)
  })
}
