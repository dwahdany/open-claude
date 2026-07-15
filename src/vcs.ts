// Git plumbing for the /move surface: worktree copies, real vcs status, uncommitted-change
// transfer, Claude transcript relocation, and copy-name generation.
// Contract: docs/contract/08-move-session.md (§3.3-3.8, §5).
//
// SECURITY: request-supplied paths are NEVER interpolated into shell strings — every git
// invocation is an argv array via Bun.spawn.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { munge } from "./store"

export interface GitResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/** Run git with an argv array (no shell). `stdin`, when given, is piped and closed. */
export async function git(args: string[], stdin?: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { ok: code === 0, code, stdout, stderr }
}

/** Resolved repo root for a directory (canonical — git resolves symlinks), or null when
 *  the directory is missing or not inside a git repo. Backs GET /path's worktree field. */
export async function gitToplevel(dir: string): Promise<string | null> {
  const res = await git(["-C", dir, "rev-parse", "--show-toplevel"])
  return res.ok ? res.stdout.trim() || null : null
}

/** `git worktree list --porcelain` paths, in porcelain order: first entry is the MAIN
 *  checkout, the rest are linked worktrees (doc 08 §3.3). [] when not a repo. */
export async function worktreeList(primary: string): Promise<string[]> {
  const res = await git(["-C", primary, "worktree", "list", "--porcelain"])
  if (!res.ok) return []
  const out: string[] = []
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) out.push(line.slice("worktree ".length))
  }
  return out
}

/** Detached-HEAD worktree copy, run in the primary repo (doc 08 §3.4: no branch). */
export function worktreeAdd(primary: string, copyDir: string): Promise<GitResult> {
  return git(["-C", primary, "worktree", "add", "--detach", copyDir, "HEAD"])
}

export function worktreeRemove(primary: string, dir: string, force: boolean): Promise<GitResult> {
  return git(["-C", primary, "worktree", "remove", ...(force ? ["--force"] : []), dir])
}

/** Dirty-worktree detection on a failed non-forced remove (doc 08 §3.5 → forceRequired). */
export const isDirtyWorktreeError = (stderr: string): boolean => /contains modified or untracked files|is dirty/i.test(stderr)

export interface VcsFileStatus {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

/** Real GET /vcs/status (doc 08 §3.8): porcelain status joined with `diff --numstat HEAD`
 *  counts (0/0 where unknown — untracked or binary), sorted by file. Non-git dir → []. */
export async function vcsStatus(dir: string): Promise<VcsFileStatus[]> {
  if (!existsSync(dir)) return []
  const st = await git(["-C", dir, "status", "--porcelain"])
  if (!st.ok) return []
  const counts = new Map<string, { additions: number; deletions: number }>()
  const num = await git(["-C", dir, "diff", "--numstat", "HEAD"]) // fails on a repo with no commits → all 0/0
  if (num.ok) {
    for (const line of num.stdout.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (m) counts.set(m[3]!, { additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) })
    }
  }
  const out: VcsFileStatus[] = []
  for (const line of st.stdout.split("\n")) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let file = line.slice(3)
    const arrow = file.indexOf(" -> ") // rename lines: report the NEW path
    if (arrow >= 0) file = file.slice(arrow + 4)
    if (file.startsWith('"') && file.endsWith('"')) {
      try {
        file = JSON.parse(file) // git C-quotes exotic paths; JSON covers the common escapes
      } catch {
        /* keep quoted form */
      }
    }
    const status: VcsFileStatus["status"] = xy === "??" || xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified"
    const c = counts.get(file)
    out.push({ file, additions: c?.additions ?? 0, deletions: c?.deletions ?? 0, status })
  }
  out.sort((a, b) => a.file.localeCompare(b.file))
  return out
}

/** Capture uncommitted changes at the source (doc 08 §3.1 step 3 / core git.ts:729-787):
 *  `diff --binary HEAD -- <scope>` for tracked changes plus one `diff --binary --no-index
 *  -- /dev/null <file>` per untracked file. `--binary` hunks are base85 ASCII — text-safe. */
export async function captureChanges(root: string, scope: string): Promise<{ ok: true; patch: string } | { ok: false; message: string }> {
  const tracked = await git(["-C", root, "diff", "--binary", "HEAD", "--", scope])
  if (!tracked.ok) return { ok: false, message: tracked.stderr.trim() || "git diff failed" }
  let patch = tracked.stdout
  const untracked = await git(["-C", root, "ls-files", "--others", "--exclude-standard", "--", scope])
  if (!untracked.ok) return { ok: false, message: untracked.stderr.trim() || "git ls-files failed" }
  for (const file of untracked.stdout.split("\n").filter(Boolean)) {
    const d = await git(["-C", root, "diff", "--binary", "--no-index", "--", "/dev/null", file])
    // --no-index exits 1 when the inputs differ — that IS the patch; >1 is a real error.
    if (d.code > 1) return { ok: false, message: d.stderr.trim() || `git diff --no-index failed for ${file}` }
    patch += d.stdout
  }
  return { ok: true, patch }
}

/** Apply a captured patch at the destination root, patch on stdin (git.ts:789-814). */
export function applyChanges(root: string, patch: string): Promise<GitResult> {
  return git(["-C", root, "apply", "-"], patch)
}

/** Discard the moved changes at the source — ONLY after a successful apply AND after the
 *  move events are published (doc 08 §3.1 step 5). Best-effort: checkout keeps the index. */
export async function cleanupSource(root: string, scope: string): Promise<void> {
  await git(["-C", root, "checkout", "--", scope])
  await git(["-C", root, "clean", "-fd", "--", scope])
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** How a transcript travels on move. A session and its not-yet-prompted forks share ONE
 *  Claude uuid (store.forkSession) until the fork's first init re-uuids it, so:
 *  - "move": sole owner — DELETE the source copies after copying (leaving both alive
 *    causes a silent divergent fork, probe header).
 *  - "copy": the live OWNER moves while a fork still inherits its uuid — keep the source
 *    as the fork's resume seed; the destination (at worst a stale seed) is overwritten.
 *  - "seed": a forkPending session moves — the uuid belongs to its SOURCE, so keep the
 *    source and never clobber an existing destination file (it may be the owner's LIVE
 *    transcript); the seed is read once by resume+forkSession, then abandoned. */
export type RelocateMode = "move" | "copy" | "seed"

/** Relocate the Claude transcript between munged project dirs (probe-cross-cwd-resume
 *  header): copy <uuid>.jsonl (+ the <uuid>/ sibling dir — subagent transcripts) into
 *  ~/.claude/projects/<munge(realpath(newDir))>/; source/destination handling per `mode`.
 *  Missing transcript is NOT an error (the resume-not-found self-heal starts fresh);
 *  returns false and logs instead. */
export function relocateTranscript(uuid: string, oldDir: string, newDir: string, mode: RelocateMode = "move"): boolean {
  try {
    const projects = join(homedir(), ".claude", "projects")
    let srcDir = join(projects, munge(real(oldDir)))
    if (!existsSync(join(srcDir, `${uuid}.jsonl`))) {
      srcDir = "" // fall back to one bounded scan of ~/.claude/projects/*/
      try {
        for (const d of readdirSync(projects)) {
          if (existsSync(join(projects, d, `${uuid}.jsonl`))) {
            srcDir = join(projects, d)
            break
          }
        }
      } catch {
        /* no projects dir at all */
      }
      if (!srcDir) {
        console.error(`open-claude: transcript ${uuid}.jsonl not found — session starts fresh after move`)
        return false
      }
    }
    const dstDir = join(projects, munge(real(newDir)))
    if (srcDir === dstDir) return true
    if (mode === "seed" && existsSync(join(dstDir, `${uuid}.jsonl`))) return true // never clobber
    mkdirSync(dstDir, { recursive: true })
    copyFileSync(join(srcDir, `${uuid}.jsonl`), join(dstDir, `${uuid}.jsonl`))
    const sibling = join(srcDir, uuid)
    if (existsSync(sibling)) {
      rmSync(join(dstDir, uuid), { recursive: true, force: true }) // replace, never merge stale
      cpSync(sibling, join(dstDir, uuid), { recursive: true })
      if (mode === "move") rmSync(sibling, { recursive: true, force: true })
    }
    if (mode === "move") rmSync(join(srcDir, `${uuid}.jsonl`), { force: true })
    return true
  } catch (err) {
    console.error(`open-claude: transcript relocation for ${uuid} failed (continuing):`, err)
    return false
  }
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

// Copy-name generation (doc 08 §3.6): the reference asks the provider's small model and
// falls back to a random slug on ANY failure, always 200. The shim skips the LLM entirely —
// a readable adjective-noun slug seeded off the context hash, random when no context.
const ADJECTIVES = ["brave", "calm", "clever", "eager", "fuzzy", "gentle", "happy", "jolly", "keen", "lively", "mellow", "nimble", "proud", "quick", "royal", "shiny", "spry", "sturdy", "sunny", "swift", "tidy", "vivid", "witty", "zesty"]
const NOUNS = ["otter", "falcon", "maple", "harbor", "comet", "meadow", "ridge", "cedar", "dolphin", "ember", "fjord", "garnet", "heron", "island", "jasper", "kestrel", "lagoon", "marmot", "nectar", "onyx", "pebble", "quartz", "reef", "sparrow", "tundra", "willow"]

export function generateCopyName(context?: string): string {
  const trimmed = context?.trim()
  if (trimmed) {
    // FNV-1a over the context: same task text → same suggestion, no LLM round-trip.
    let h = 2166136261
    for (let i = 0; i < trimmed.length; i++) {
      h ^= trimmed.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h >>>= 0
    return `${ADJECTIVES[h % ADJECTIVES.length]}-${NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]}`
  }
  return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`
}
