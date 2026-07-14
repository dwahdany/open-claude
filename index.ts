// open-claude: serve the opencode HTTP/SSE API backed by the Claude Agent SDK.
// Usage: bun run index.ts [--port 4096] [--directory /path/to/project]
// Then: opencode attach http://localhost:4096

import { createApp } from "./src/server"
import { Id } from "./src/ids"
import { Store } from "./src/store"

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const val = i >= 0 ? process.argv[i + 1] : undefined
  return val ?? fallback
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

console.log(`open-claude listening on http://localhost:${server.port}`)
console.log(`  directory: ${directory}`)
console.log(`  attach with: opencode attach http://localhost:${server.port}`)
