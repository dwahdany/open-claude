// open-claude: serve the opencode HTTP/SSE API backed by the Claude Agent SDK.
// Usage: open-claude [--port 4096] [--directory /path/to/project] [--attach]
// Without --attach, connect a client yourself: opencode attach http://localhost:4096

import { createApp } from "./src/server"
import { Id } from "./src/ids"
import { Store } from "./src/store"

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

Options:
  --port <n>         port to listen on (default 4096)
  --directory <dir>  working directory for the Claude Code agent (default: cwd)
  --attach           also launch \`opencode attach\` and hand over the terminal
  --help             show this help

Requires the opencode CLI v${OPENCODE_PIN} (https://opencode.ai) and Claude auth
(a Claude subscription via \`claude /login\`, or ANTHROPIC_API_KEY).

Env:
  OPENCLAUDE_SETTING_SOURCES=none  ignore ~/.claude allowlists (prompt for every tool)
  OPENCLAUDE_ULTRACODE=1           enable ultracode (needs workflows + xhigh model)`)
  process.exit(0)
}

const port = Number(arg("port", "4096"))
const directory = arg("directory", process.cwd())
const projectID = Id.project()

const store = new Store(directory, projectID)
const app = createApp(store)

const server = Bun.serve({
  port,
  idleTimeout: 0, // never time out SSE / long-blocking prompt requests
  fetch: app.fetch,
})

const url = `http://localhost:${server.port}`
console.log(`open-claude listening on ${url}`)
console.log(`  directory: ${directory}`)

if (flag("attach")) {
  const version = Bun.spawnSync(["opencode", "--version"])
  if (!version.success) {
    console.error(`\nopencode CLI not found — install v${OPENCODE_PIN} from https://opencode.ai,`)
    console.error(`or connect any opencode client manually: opencode attach ${url}`)
    process.exit(1)
  }
  const found = version.stdout.toString().trim()
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
  process.exit(code)
} else {
  console.log(`  attach with: opencode attach ${url}`)
}
