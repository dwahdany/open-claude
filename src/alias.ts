// First-run nicety: offer — once, ever — to append a launch alias (default `oclaude`)
// to the user's shell rc file. Interactive TTYs only; the answer, either way, is recorded
// in (XDG_DATA_HOME | ~/.local/share)/open-claude/state.json so the question never repeats.
//
// The alias target depends on how this process was launched, because `open-claude` on
// PATH is not proof of a durable install: bunx/npx prepend ephemeral cache shims to PATH
// while the tool runs, and aliasing those breaks in the next shell.
//   1. durable `open-claude` on PATH (global bun/npm install) → `open-claude`
//   2. running out of a package cache (bunx/npx)             → `bunx @dwahdany/open-claude`
//   3. running from a source checkout                        → `bun "<abs entry>"`

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

export const DEFAULT_ALIAS = "oclaude"
const PKG = "@dwahdany/open-claude"

type Env = Record<string, string | undefined>
type Shell = "zsh" | "bash" | "fish"

export function stateFile(env: Env = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "open-claude", "state.json")
}

/** What the alias should run, given how this process was launched. */
export function aliasTarget(entry: string, which: (cmd: string) => string | null = Bun.which): string {
  const onPath = which("open-claude")
  if (onPath && !/node_modules|\/_npx\/|\/bunx-/.test(onPath)) return "open-claude"
  if (entry.includes("node_modules")) return entry.includes("/_npx/") ? `npx -y ${PKG}` : `bunx ${PKG}`
  return `bun "${entry}"`
}

/** Which rc file to append to, from $SHELL. null = shell we don't know how to edit. */
export function rcTarget(env: Env, home: string = homedir()): { shell: Shell; rc: string } | null {
  const shell = basename(env.SHELL || "")
  if (shell === "zsh") return { shell, rc: join(env.ZDOTDIR || home, ".zshrc") }
  if (shell === "bash") return { shell, rc: join(home, ".bashrc") }
  if (shell === "fish") return { shell, rc: join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "config.fish") }
  return null
}

export function aliasLine(shell: Shell, name: string, target: string): string {
  const quoted = `'${target.replaceAll("'", shell === "fish" ? "\\'" : `'\\''`)}'`
  return shell === "fish"
    ? `alias ${name} ${quoted} # added by open-claude`
    : `alias ${name}=${quoted} # added by open-claude`
}

export interface OfferOptions {
  env?: Env
  home?: string
  /** absolute path of the running entry script (default Bun.main) */
  entry?: string
  which?: (cmd: string) => string | null
  ask?: (message: string) => boolean
  /** override TTY detection (tests) */
  interactive?: boolean
}

/** Ask once per machine whether to save a launch alias. Must never throw: a broken
 *  state file, unwritable rc, or declined prompt all degrade to "just start the server". */
export async function offerAliasOnFirstRun(opts: OfferOptions = {}): Promise<void> {
  const env = opts.env ?? process.env
  const interactive = opts.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
  if (!interactive || process.platform === "win32" || env.OPENCLAUDE_NO_ALIAS_PROMPT) return

  const file = stateFile(env)
  let state: Record<string, unknown> = {}
  try {
    state = (await Bun.file(file).json()) as Record<string, unknown>
  } catch {
    /* missing or corrupt state — treat as first run */
  }
  if (state.aliasOffered) return
  const remember = async () => {
    try {
      await Bun.write(file, JSON.stringify({ ...state, aliasOffered: true }, null, 2) + "\n")
    } catch {
      /* re-asking next boot beats crashing this one */
    }
  }

  try {
    const name = DEFAULT_ALIAS
    const which = opts.which ?? Bun.which
    const rc = rcTarget(env, opts.home)
    const target = aliasTarget(opts.entry ?? Bun.main, which)
    const line = rc ? aliasLine(rc.shell, name, target) : `alias ${name}='${target}'`

    // Already taken (a real command, or an alias in the rc we'd be editing): stay quiet forever.
    const rcBody = rc ? await Bun.file(rc.rc).text().catch(() => "") : ""
    if (which(name) || new RegExp(`(^|\\n)\\s*alias ${name}[ =]`).test(rcBody)) {
      await remember()
      return
    }

    if (!rc) {
      console.log(`tip: add a shell alias to launch this quickly:  ${line}`)
      await remember()
      return
    }

    const ask = opts.ask ?? confirm
    if (ask(`First run — save \`${name}\` as a shell alias for open-claude? (appends one line to ${rc.rc})`)) {
      try {
        mkdirSync(dirname(rc.rc), { recursive: true })
        const sep = rcBody.length && !rcBody.endsWith("\n") ? "\n" : ""
        appendFileSync(rc.rc, `${sep}${line}\n`) // append, never rewrite: an rc file is not ours to risk
        console.log(`  added to ${rc.rc} — available in new shells (or now via: source ${rc.rc})`)
      } catch (err) {
        console.error(`  could not write ${rc.rc} (${err}) — add it manually:  ${line}`)
      }
    } else {
      console.log(`  ok — to add it later, append this to ${rc.rc}:  ${line}`)
    }
    await remember()
  } catch (err) {
    console.error("open-claude: alias offer failed (continuing):", err)
    await remember()
  }
}
