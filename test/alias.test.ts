// Unit tests for the first-run alias offer (src/alias.ts). Everything environmental is
// injected (env, home, entry, which, ask) so these run headless; the interactive PTY
// path is covered by test/pty_alias.py.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { aliasLine, aliasTarget, DEFAULT_ALIAS, offerAliasOnFirstRun, rcTarget, stateFile } from "../src/alias"

const BUNX_SHIM = "/var/folders/np/T/bunx-501-@dwahdany/open-claude@0.3.0/node_modules/.bin/open-claude"

test("aliasTarget prefers a durable open-claude on PATH", () => {
  expect(aliasTarget("/whatever/node_modules/pkg/index.ts", () => "/Users/x/.bun/bin/open-claude")).toBe("open-claude")
})

test("aliasTarget rejects ephemeral bunx/npx PATH shims", () => {
  expect(aliasTarget("/tmp/bunx-501-@dwahdany/node_modules/@dwahdany/open-claude/index.ts", () => BUNX_SHIM)).toBe(
    "bunx @dwahdany/open-claude",
  )
  expect(aliasTarget("/Users/x/.npm/_npx/abc123/node_modules/@dwahdany/open-claude/index.ts", () => null)).toBe(
    "npx -y @dwahdany/open-claude",
  )
})

test("aliasTarget falls back to bun + entry for a source checkout", () => {
  expect(aliasTarget("/Users/x/git/open-claude/index.ts", () => null)).toBe('bun "/Users/x/git/open-claude/index.ts"')
})

test("rcTarget picks the rc file from $SHELL", () => {
  expect(rcTarget({ SHELL: "/bin/zsh" }, "/h")).toEqual({ shell: "zsh", rc: "/h/.zshrc" })
  expect(rcTarget({ SHELL: "/bin/zsh", ZDOTDIR: "/zd" }, "/h")).toEqual({ shell: "zsh", rc: "/zd/.zshrc" })
  expect(rcTarget({ SHELL: "/opt/homebrew/bin/bash" }, "/h")).toEqual({ shell: "bash", rc: "/h/.bashrc" })
  expect(rcTarget({ SHELL: "/usr/bin/fish" }, "/h")).toEqual({ shell: "fish", rc: "/h/.config/fish/config.fish" })
  expect(rcTarget({ SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: "/xc" }, "/h")).toEqual({
    shell: "fish",
    rc: "/xc/fish/config.fish",
  })
  expect(rcTarget({ SHELL: "/usr/bin/nu" }, "/h")).toBeNull()
  expect(rcTarget({}, "/h")).toBeNull()
})

test("aliasLine quotes per shell", () => {
  expect(aliasLine("zsh", "oclaude", "open-claude")).toBe("alias oclaude='open-claude' # added by open-claude")
  expect(aliasLine("fish", "oclaude", 'bun "/p/index.ts"')).toBe(
    `alias oclaude 'bun "/p/index.ts"' # added by open-claude`,
  )
  // a single quote in the target must not break out of the quoting
  expect(aliasLine("bash", "oclaude", "bun \"/o'brien/index.ts\"")).toBe(
    `alias oclaude='bun "/o'\\''brien/index.ts"' # added by open-claude`,
  )
  expect(aliasLine("fish", "oclaude", "bun \"/o'brien/index.ts\"")).toBe(
    `alias oclaude 'bun "/o\\'brien/index.ts"' # added by open-claude`,
  )
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "oc-alias-"))
  const env = { XDG_DATA_HOME: join(root, "data"), SHELL: "/bin/zsh", ZDOTDIR: join(root, "home") }
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  return { root, env, home, rc: join(home, ".zshrc") }
}

const base = { entry: "/Users/x/git/open-claude/index.ts", which: () => null, interactive: true as const }

test("first run: accepting appends the alias and marks state", async () => {
  const s = scratch()
  writeFileSync(s.rc, "export FOO=1") // no trailing newline on purpose
  let asked = ""
  await offerAliasOnFirstRun({ ...base, env: s.env, home: s.home, ask: (m) => ((asked = m), true) })

  expect(asked).toContain(DEFAULT_ALIAS)
  expect(readFileSync(s.rc, "utf8")).toBe(
    `export FOO=1\nalias oclaude='bun "/Users/x/git/open-claude/index.ts"' # added by open-claude\n`,
  )
  expect(await Bun.file(stateFile(s.env)).json()).toEqual({ aliasOffered: true })

  // second run: never asks again, never appends again
  await offerAliasOnFirstRun({
    ...base,
    env: s.env,
    home: s.home,
    ask: () => {
      throw new Error("asked twice")
    },
  })
  expect(readFileSync(s.rc, "utf8")).toContain("alias oclaude")
})

test("declining marks state without touching the rc", async () => {
  const s = scratch()
  await offerAliasOnFirstRun({ ...base, env: s.env, home: s.home, ask: () => false })
  expect(existsSync(s.rc)).toBe(false)
  expect(await Bun.file(stateFile(s.env)).json()).toEqual({ aliasOffered: true })
})

test("an alias already in the rc suppresses the prompt", async () => {
  const s = scratch()
  writeFileSync(s.rc, "alias oclaude='something-else'\n")
  await offerAliasOnFirstRun({
    ...base,
    env: s.env,
    home: s.home,
    ask: () => {
      throw new Error("should not ask")
    },
  })
  expect(readFileSync(s.rc, "utf8")).toBe("alias oclaude='something-else'\n")
  expect(await Bun.file(stateFile(s.env)).json()).toEqual({ aliasOffered: true })
})

test("an existing oclaude command on PATH suppresses the prompt", async () => {
  const s = scratch()
  await offerAliasOnFirstRun({
    ...base,
    env: s.env,
    home: s.home,
    which: (cmd) => (cmd === DEFAULT_ALIAS ? "/usr/local/bin/oclaude" : null),
    ask: () => {
      throw new Error("should not ask")
    },
  })
  expect(existsSync(s.rc)).toBe(false)
  expect(await Bun.file(stateFile(s.env)).json()).toEqual({ aliasOffered: true })
})

test("unknown shell prints a tip and marks state without asking", async () => {
  const s = scratch()
  await offerAliasOnFirstRun({
    ...base,
    env: { ...s.env, SHELL: "/usr/bin/nu" },
    home: s.home,
    ask: () => {
      throw new Error("should not ask")
    },
  })
  expect(await Bun.file(stateFile(s.env)).json()).toEqual({ aliasOffered: true })
})

test("OPENCLAUDE_NO_ALIAS_PROMPT disables the offer entirely", async () => {
  const s = scratch()
  await offerAliasOnFirstRun({
    ...base,
    env: { ...s.env, OPENCLAUDE_NO_ALIAS_PROMPT: "1" },
    home: s.home,
    ask: () => {
      throw new Error("should not ask")
    },
  })
  expect(existsSync(stateFile(s.env))).toBe(false)
})
