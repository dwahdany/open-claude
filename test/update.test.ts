import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkForUpdate, isNewer, updateCommand } from "../src/update"

describe("isNewer", () => {
  test("newer patch/minor/major", () => {
    expect(isNewer("0.3.1", "0.3.2")).toBe(true)
    expect(isNewer("0.3.1", "0.4.0")).toBe(true)
    expect(isNewer("0.3.1", "1.0.0")).toBe(true)
  })
  test("equal or older", () => {
    expect(isNewer("0.3.1", "0.3.1")).toBe(false)
    expect(isNewer("0.3.1", "0.3.0")).toBe(false)
    expect(isNewer("1.0.0", "0.9.9")).toBe(false)
  })
  test("numeric segments, not lexicographic", () => {
    expect(isNewer("0.9.9", "0.10.0")).toBe(true)
    expect(isNewer("0.3.1", "0.3.10")).toBe(true)
  })
  test("length mismatch treats missing segments as 0", () => {
    expect(isNewer("1.0", "1.0.1")).toBe(true)
    expect(isNewer("1.0.0", "1.0")).toBe(false)
  })
})

describe("updateCommand", () => {
  test("durable bun global install", () => {
    expect(updateCommand("/whatever/index.ts", () => "/Users/x/.bun/bin/open-claude")).toBe(
      "bun add -g @dwahdany/open-claude@latest",
    )
  })
  test("durable npm global install", () => {
    expect(updateCommand("/whatever/index.ts", () => "/usr/local/bin/open-claude")).toBe(
      "npm i -g @dwahdany/open-claude@latest",
    )
  })
  test("bunx cache", () => {
    expect(updateCommand("/Users/x/.bun/install/cache/node_modules/@dwahdany/open-claude/index.ts", () => null)).toBe(
      "bunx @dwahdany/open-claude@latest",
    )
  })
  test("npx cache", () => {
    expect(updateCommand("/Users/x/.npm/_npx/abc123/node_modules/@dwahdany/open-claude/index.ts", () => null)).toBe(
      "npx -y @dwahdany/open-claude@latest",
    )
  })
  test("source checkout", () => {
    expect(updateCommand("/Users/x/git/open-claude/index.ts", () => null)).toBe('git -C "/Users/x/git/open-claude" pull')
  })
})

function opts(over: Partial<Parameters<typeof checkForUpdate>[0]> = {}) {
  const dataHome = mkdtempSync(join(tmpdir(), "oc-update-"))
  return {
    env: { XDG_DATA_HOME: dataHome } as Record<string, string | undefined>,
    entry: "/Users/x/git/open-claude/index.ts",
    which: () => null,
    interactive: true,
    currentVersion: "0.3.1",
    fetchLatest: async () => "0.4.0",
    ...over,
  }
}

describe("checkForUpdate", () => {
  test("notice carries versions and the mode-matched command", async () => {
    const line = await checkForUpdate(opts())
    expect(line).toContain("0.4.0")
    expect(line).toContain("0.3.1")
    expect(line).toContain('git -C "/Users/x/git/open-claude" pull')
  })
  test("second check within a day is throttled", async () => {
    const o = opts()
    expect(await checkForUpdate(o)).not.toBeNull()
    expect(await checkForUpdate({ ...o, fetchLatest: async () => "9.9.9" })).toBeNull()
  })
  test("check after the throttle window runs again", async () => {
    const o = opts({ now: 1_000_000_000_000 })
    expect(await checkForUpdate(o)).not.toBeNull()
    expect(await checkForUpdate({ ...o, now: 1_000_000_000_000 + 25 * 60 * 60 * 1000 })).not.toBeNull()
  })
  test("up to date → null", async () => {
    expect(await checkForUpdate(opts({ fetchLatest: async () => "0.3.1" }))).toBeNull()
  })
  test("opt-outs and failures → null", async () => {
    expect(await checkForUpdate(opts({ interactive: false }))).toBeNull()
    const noCheck = opts()
    noCheck.env.OPENCLAUDE_NO_UPDATE_CHECK = "1"
    expect(await checkForUpdate(noCheck)).toBeNull()
    const ci = opts()
    ci.env.CI = "true"
    expect(await checkForUpdate(ci)).toBeNull()
    expect(
      await checkForUpdate(
        opts({
          fetchLatest: async () => {
            throw new Error("offline")
          },
        }),
      ),
    ).toBeNull()
  })
  test("throttle stamp is written even when the fetch fails", async () => {
    const o = opts({
      fetchLatest: async () => {
        throw new Error("offline")
      },
    })
    expect(await checkForUpdate(o)).toBeNull()
    // registry back up, but within the window: still throttled
    expect(await checkForUpdate({ ...o, fetchLatest: async () => "9.9.9" })).toBeNull()
  })
})
