// Unit tests for the read-only /model bridge (src/model-view.ts) and the catalog id
// canonicalization the engine's drift tracking rides on (src/catalog.ts canonModelID).
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { canonModelID } from "../src/catalog"
import { modelView, renderModelView, resolveModelArg } from "../src/model-view"
import { Store } from "../src/store"

test("canonModelID: exact catalog ids pass through", () => {
  expect(canonModelID("claude-sonnet-5")).toBe("claude-sonnet-5")
  expect(canonModelID("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001")
})

test("canonModelID: dated variants map to the catalog id, both directions", () => {
  expect(canonModelID("claude-sonnet-5-20260201")).toBe("claude-sonnet-5") // CLI dated → catalog bare
  expect(canonModelID("claude-haiku-4-5")).toBe("claude-haiku-4-5-20251001") // CLI bare → catalog dated
})

test("canonModelID: unknown and non-date suffixes pass through raw", () => {
  expect(canonModelID("claude-sonnet-5-5")).toBe("claude-sonnet-5-5") // "5" is not a date
  expect(canonModelID("<synthetic>")).toBe("<synthetic>")
  expect(canonModelID("gpt-6")).toBe("gpt-6")
})

test("resolveModelArg: CLI aliases, ids, dated ids, [1m] forms", () => {
  expect(resolveModelArg("sonnet")).toBe("claude-sonnet-5")
  expect(resolveModelArg("OPUS")).toBe("claude-opus-4-8")
  expect(resolveModelArg("haiku")).toBe("claude-haiku-4-5-20251001")
  expect(resolveModelArg("fable[1m]")).toBe("claude-fable-5")
  expect(resolveModelArg("claude-sonnet-5")).toBe("claude-sonnet-5")
  expect(resolveModelArg("claude-sonnet-5-20260201")).toBe("claude-sonnet-5")
  expect(resolveModelArg("opusplan")).toBeUndefined()
  expect(resolveModelArg("best")).toBeUndefined()
})

const CURRENT = { providerID: "anthropic", modelID: "claude-fable-5", variant: "xhigh" }

test("renderModelView bare: current model, variant, catalog list with marker", () => {
  const text = renderModelView(CURRENT, "")
  expect(text).toContain("Current model: Claude Fable 5 (anthropic/claude-fable-5 · variant xhigh)")
  expect(text).toContain("/models")
  expect(text).toContain("→ Claude Fable 5")
  expect(text).toContain("  Claude Sonnet 5")
  expect(text.split("\n").filter((l) => l === "```").length).toBe(2)
})

test("renderModelView with resolvable arg: read-only note + picker pointer to the target", () => {
  const text = renderModelView(CURRENT, "sonnet")
  expect(text).toContain("read-only")
  expect(text).toContain("To switch to Claude Sonnet 5, pick it in the model list")
})

test("renderModelView with the current model as arg: already-on note", () => {
  expect(renderModelView(CURRENT, "fable")).toContain("You are already on Claude Fable 5.")
})

test("renderModelView with unknown arg: generic picker pointer", () => {
  const text = renderModelView(CURRENT, "opusplan")
  expect(text).toContain("read-only")
  expect(text).toContain("Switch models in the model list")
})

test("modelView emits a completed synthetic turn into the store", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "ocmv-xdg-"))
  try {
    const store = await Store.load(mkdtempSync(join(tmpdir(), "ocmv-dir-")))
    const session = store.createSession({})
    const wp = modelView(store, session.id, CURRENT, "build", "sonnet")

    expect(wp.info.role).toBe("assistant")
    if (wp.info.role === "assistant") {
      expect(wp.info.time.completed).toBeGreaterThan(0)
      expect(wp.info.finish).toBe("stop")
      expect(wp.info.modelID).toBe("claude-fable-5")
    }
    const messages = store.messages(session.id)
    expect(messages.length).toBe(2)
    expect(messages[0]?.parts[0]?.type === "text" && messages[0].parts[0].text).toBe("/model sonnet")
    expect(wp.parts[0]?.type === "text" && wp.parts[0].text).toContain("read-only")
    expect(store.isBusy(session.id)).toBe(false)
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})
