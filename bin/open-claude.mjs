#!/usr/bin/env node
// Launcher: the server itself needs Bun (Bun.serve). Under bunx/bun this file just imports
// the entry; under node/npx it re-execs bun, or explains how to get it. Plain JS on purpose —
// it must parse and run under node without any Bun APIs.

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts")

if (typeof globalThis.Bun !== "undefined") {
  await import(pathToFileURL(entry).href)
} else {
  const res = spawnSync("bun", [entry, ...process.argv.slice(2)], { stdio: "inherit" })
  if (res.error && res.error.code === "ENOENT") {
    console.error("open-claude runs on Bun (https://bun.sh), which was not found on your PATH.")
    console.error("Install it with:  curl -fsSL https://bun.sh/install | bash")
    process.exit(1)
  }
  process.exit(res.status ?? 1)
}
