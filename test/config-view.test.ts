// Unit tests for the read-only /config bridge (src/config-view.ts). File locations and
// home are injected (alias.ts pattern) so the reader tests are hermetic; configView() is
// exercised against a real Store with XDG_DATA_HOME redirected to a temp dir (its rows
// come from the machine's live config, so assertions there are structural only).
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configView, readConfigRows, renderConfigRows } from "../src/config-view"
import { Store } from "../src/store"

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), name))
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}

function fixtureProject(): string {
  const project = tmp("ocv-project-")
  mkdirSync(join(project, ".claude"), { recursive: true })
  writeJson(join(project, ".claude", "settings.local.json"), { outputStyle: "Explanatory", spinnerTipsEnabled: false })
  writeJson(join(project, ".claude", "settings.json"), { model: "sonnet" })
  return project
}

const USER_SETTINGS = {
  model: "opus",
  autoCompactEnabled: false,
  permissions: { defaultMode: "plan" },
  worktree: { baseRef: "head" },
}
const GLOBAL_CONFIG = { workflowSizeGuideline: "large", respectGitignore: false, teammateDefaultModel: "haiku" }

test("readConfigRows: precedence, renames, nested paths (home fallback layout)", async () => {
  const project = fixtureProject()
  const home = tmp("ocv-home-")
  writeJson(join(home, ".claude", "settings.json"), USER_SETTINGS)
  writeJson(join(home, ".claude.json"), GLOBAL_CONFIG)

  const rows = await readConfigRows(project, {}, home)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))

  // settings chain: local > project > user
  expect(byKey.outputStyle).toEqual({ key: "outputStyle", value: "Explanatory", source: ".claude/settings.local.json" })
  expect(byKey.tips).toEqual({ key: "tips", value: "false", source: ".claude/settings.local.json" })
  expect(byKey.model).toEqual({ key: "model", value: "sonnet", source: ".claude/settings.json" })
  // renamed + nested keys resolve from user settings, labeled with ~
  expect(byKey.autoCompact).toEqual({ key: "autoCompact", value: "false", source: "~/.claude/settings.json" })
  expect(byKey.permissionMode).toEqual({ key: "permissionMode", value: "plan", source: "~/.claude/settings.json" })
  expect(byKey.worktreeBaseRef).toEqual({ key: "worktreeBaseRef", value: "head", source: "~/.claude/settings.json" })
  // global-store keys come only from ~/.claude.json
  expect(byKey.workflowSizeGuideline).toEqual({ key: "workflowSizeGuideline", value: "large", source: "~/.claude.json" })
  expect(byKey.gitignore).toEqual({ key: "gitignore", value: "false", source: "~/.claude.json" })
  expect(byKey.teammateDefaultModel).toEqual({ key: "teammateDefaultModel", value: "haiku", source: "~/.claude.json" })
  // unset → no value/source
  expect(byKey.theme).toEqual({ key: "theme" })
  expect(byKey.verbose).toEqual({ key: "verbose" })
})

test("readConfigRows honors CLAUDE_CONFIG_DIR for user settings and global state", async () => {
  const project = tmp("ocv-project-")
  const home = tmp("ocv-home-")
  const configDir = tmp("ocv-config-")
  writeJson(join(configDir, "settings.json"), { theme: "light" })
  writeJson(join(configDir, ".claude.json"), { copyOnSelect: true })
  // decoys in the default locations must NOT be read
  writeJson(join(home, ".claude", "settings.json"), { theme: "dark" })
  writeJson(join(home, ".claude.json"), { copyOnSelect: false })

  const rows = await readConfigRows(project, { CLAUDE_CONFIG_DIR: configDir }, home)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  expect(byKey.theme).toEqual({ key: "theme", value: "light", source: join(configDir, "settings.json") })
  expect(byKey.copyOnSelect).toEqual({ key: "copyOnSelect", value: "true", source: join(configDir, ".claude.json") })
})

test("readConfigRows survives missing and malformed files", async () => {
  const project = tmp("ocv-project-")
  const home = tmp("ocv-home-")
  writeJson(join(home, ".claude.json"), GLOBAL_CONFIG)
  mkdirSync(join(project, ".claude"), { recursive: true })
  writeFileSync(join(project, ".claude", "settings.json"), "{ not json")

  const rows = await readConfigRows(project, {}, home)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  expect(byKey.model).toEqual({ key: "model" }) // malformed project file → skipped
  expect(byKey.workflowSizeGuideline?.value).toBe("large")
})

test("renderConfigRows aligns columns and marks unset keys", () => {
  const text = renderConfigRows([
    { key: "autoCompact", value: "false", source: "~/.claude/settings.json" },
    { key: "theme" },
  ])
  expect(text).toContain("`/config key=value`")
  expect(text).toContain("autoCompact  false      · ~/.claude/settings.json")
  expect(text).toContain("theme        (default)")
  expect(text.split("\n").filter((l) => l === "```").length).toBe(2)
})

test("configView emits a completed synthetic turn into the store", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp("ocv-xdg-")
  try {
    const store = await Store.load(tmp("ocv-dir-"))
    const session = store.createSession({})
    const model = { providerID: "anthropic", modelID: "claude-fable-5" }
    const wp = await configView(store, session.id, model, "build")

    expect(wp.info.role).toBe("assistant")
    if (wp.info.role === "assistant") {
      expect(wp.info.time.completed).toBeGreaterThan(0)
      expect(wp.info.finish).toBe("stop")
    }
    expect(wp.parts[0]?.type).toBe("text")
    const text = wp.parts[0]?.type === "text" ? wp.parts[0].text : ""
    expect(text).toContain("Claude Code settings")
    expect(text).toContain("workflowSizeGuideline")

    const messages = store.messages(session.id)
    expect(messages.length).toBe(2)
    expect(messages[0]?.info.role).toBe("user")
    expect(messages[0]?.parts[0]?.type === "text" && messages[0].parts[0].text).toBe("/config")
    expect(messages[1]?.info.id).toBe(wp.info.id)
    expect(store.isBusy(session.id)).toBe(false)
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})
