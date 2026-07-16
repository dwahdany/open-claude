// Once-a-day npm release check. No self-updater on purpose: this package is executed BY a
// package manager (bun/bunx/npx or a checkout), so the manager owns the install — the shim
// only reports that a newer version exists, with the update command matching how it was
// launched (same detection rules as alias.ts aliasTarget). Never blocks and never throws:
// boot latency and offline operation must be unaffected, so callers just void/await the
// promise and print the line if there is one.

import { dirname, join } from "node:path"
import { stateFile } from "./alias"

const PKG = "@dwahdany/open-claude"
const DAY_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 3000

type Env = Record<string, string | undefined>

/** Plain x.y.z compare (this package never publishes pre-release tags): is latest newer? */
export function isNewer(current: string, latest: string): boolean {
  const a = current.split(".").map((n) => parseInt(n, 10) || 0)
  const b = latest.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0)
  }
  return false
}

/** Update command for the current launch mode (mirror of aliasTarget's mode detection). */
export function updateCommand(entry: string, which: (cmd: string) => string | null = Bun.which): string {
  const onPath = which("open-claude")
  if (onPath && !/node_modules|\/_npx\/|\/bunx-/.test(onPath)) {
    return onPath.includes("/.bun/") ? `bun add -g ${PKG}@latest` : `npm i -g ${PKG}@latest`
  }
  if (entry.includes("node_modules")) return entry.includes("/_npx/") ? `npx -y ${PKG}@latest` : `bunx ${PKG}@latest`
  return `git -C "${dirname(entry)}" pull`
}

async function latestFromNpm(): Promise<string | null> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG)}/latest`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { version?: string }
  return typeof body.version === "string" ? body.version : null
}

export interface UpdateCheckOptions {
  env?: Env
  /** absolute path of the running entry script (default Bun.main) */
  entry?: string
  which?: (cmd: string) => string | null
  now?: number
  /** override TTY detection (tests) */
  interactive?: boolean
  currentVersion?: string
  fetchLatest?: () => Promise<string | null>
}

/** Resolves to a printable notice line, or null (up to date / throttled / offline / opted out). */
export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<string | null> {
  try {
    const env = opts.env ?? process.env
    const interactive = opts.interactive ?? process.stdout.isTTY === true
    if (!interactive || env.OPENCLAUDE_NO_UPDATE_CHECK || env.CI) return null

    const file = stateFile(env)
    let state: Record<string, unknown> = {}
    try {
      state = (await Bun.file(file).json()) as Record<string, unknown>
    } catch {
      /* missing or corrupt state — treat as first check */
    }
    const now = opts.now ?? Date.now()
    const last = typeof state.lastUpdateCheck === "number" ? state.lastUpdateCheck : 0
    if (now - last < DAY_MS) return null
    // Recorded BEFORE the fetch: a hung registry must not become a re-check on every boot.
    try {
      await Bun.write(file, JSON.stringify({ ...state, lastUpdateCheck: now }, null, 2) + "\n")
    } catch {
      /* unwritable state dir: the check still runs, it just may repeat */
    }

    const current =
      opts.currentVersion ??
      ((await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version: string }).version
    const latest = await (opts.fetchLatest ?? latestFromNpm)()
    if (!latest || !isNewer(current, latest)) return null
    return `open-claude ${latest} is available (running ${current}) — update: ${updateCommand(opts.entry ?? Bun.main, opts.which ?? Bun.which)}`
  } catch {
    return null // an update check must never affect the actual tool
  }
}
