// Global launch defaults (model + agent/mode): persisted to settings.json at the data
// root, served back by GET /config (model) and GET /agent (order). The TUI never
// persists either selection itself — config.model outranks its recent-models file and
// agents().at(0) is the boot mode — so this is what makes the pair survive restarts.
// Everything here is engine-less: the /model command intercept and noReply messages
// exercise the noting path without ever spawning the Claude CLI.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AGENTS, orderedAgents, validModelRef } from "../src/catalog"
import { createApp } from "../src/server"
import { Store } from "../src/store"

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), name))
}

/** Every test runs under its own XDG_DATA_HOME (settings.json is global state). */
async function withTempXdg<T>(fn: (xdg: string) => Promise<T>): Promise<T> {
  const prev = process.env.XDG_DATA_HOME
  const xdg = tmp("ocd-xdg-")
  process.env.XDG_DATA_HOME = xdg
  try {
    return await fn(xdg)
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prev
  }
}

/** noteDefaults is fire-and-forget from the routes; an empty merge on the same store
 *  rides the serialized writer chain, so awaiting it flushes everything queued before. */
const settle = (store: Store) => store.noteDefaults({})

test("validModelRef: catalog refs pass, dated ids canon, junk drops", () => {
  expect(validModelRef("anthropic/claude-fable-5")).toBe("anthropic/claude-fable-5")
  expect(validModelRef("anthropic/claude-sonnet-5-20260201")).toBe("anthropic/claude-sonnet-5")
  expect(validModelRef("openai/gpt-6")).toBeUndefined()
  expect(validModelRef("claude-fable-5")).toBeUndefined() // no provider segment
  expect(validModelRef("/claude-fable-5")).toBeUndefined()
  expect(validModelRef(undefined)).toBeUndefined()
})

test("orderedAgents: requested agent first, unknown/absent keep stock order, no mutation", () => {
  expect(orderedAgents().map((a) => a.name)).toEqual(["build", "plan", "auto"])
  expect(orderedAgents("auto").map((a) => a.name)).toEqual(["auto", "build", "plan"])
  expect(orderedAgents("plan").map((a) => a.name)).toEqual(["plan", "build", "auto"])
  expect(orderedAgents("nope").map((a) => a.name)).toEqual(["build", "plan", "auto"])
  expect(AGENTS.map((a) => a.name)).toEqual(["build", "plan", "auto"]) // source untouched
  // colors are pinned so reordering can never rotate the styling between launches
  expect(AGENTS.map((a) => a.color)).toEqual(["secondary", "accent", "success"])
})

test("noteDefaults/globalDefaults: roundtrip, half-merges, restart survival", async () => {
  await withTempXdg(async () => {
    const store = await Store.load(tmp("ocd-dir-"))
    expect(await store.globalDefaults()).toEqual({ model: undefined, agent: undefined })

    await store.noteDefaults({ model: "anthropic/claude-fable-5" })
    expect(await store.globalDefaults()).toEqual({ model: "anthropic/claude-fable-5", agent: undefined })

    await store.noteDefaults({ agent: "auto" }) // must not clobber the stored model
    expect(await store.globalDefaults()).toEqual({ model: "anthropic/claude-fable-5", agent: "auto" })

    // a second Store (fresh boot, another project) reads the same global file
    const other = await Store.load(tmp("ocd-dir-"))
    expect(await other.globalDefaults()).toEqual({ model: "anthropic/claude-fable-5", agent: "auto" })
  })
})

test("noteDefaults: preserves foreign settings keys, skips no-op writes, heals corrupt files", async () => {
  await withTempXdg(async () => {
    const store = await Store.load(tmp("ocd-dir-"))
    const file = Store.settingsFile()

    // foreign top-level keys survive a defaults write
    writeFileSync(file, JSON.stringify({ future: { flag: true }, defaults: { agent: "plan" } }))
    await store.noteDefaults({ model: "anthropic/claude-opus-4-8" })
    const after = JSON.parse(readFileSync(file, "utf8"))
    expect(after.future).toEqual({ flag: true })
    expect(after.defaults).toEqual({ agent: "plan", model: "anthropic/claude-opus-4-8" })

    // unchanged values skip the write: seed a byte-distinct (compact) file with the same
    // values — a rewrite would pretty-print it, a skip leaves it byte-identical
    const compact = JSON.stringify({ defaults: { model: "anthropic/claude-opus-4-8", agent: "plan" } })
    writeFileSync(file, compact)
    await store.noteDefaults({ model: "anthropic/claude-opus-4-8", agent: "plan" })
    expect(readFileSync(file, "utf8")).toBe(compact)

    // corrupt file: reads degrade to empty, the next note heals it
    writeFileSync(file, "{ not json")
    expect(await store.globalDefaults()).toEqual({ model: undefined, agent: undefined })
    await store.noteDefaults({ agent: "build" })
    expect(await store.globalDefaults()).toEqual({ model: undefined, agent: "build" })
  })
})

test("GET /config + /agent serve persisted defaults; /model command notes them engine-lessly", async () => {
  await withTempXdg(async () => {
    const store = await Store.load(tmp("ocd-dir-"))
    const app = createApp(store)
    const get = async (path: string): Promise<any> => (await app.fetch(new Request(`http://x${path}`))).json()

    // fresh state: stock catalog defaults
    expect(await get("/config")).toEqual({ model: "anthropic/claude-sonnet-5" })
    expect((await get("/agent")).map((a: any) => a.name)).toEqual(["build", "plan", "auto"])

    // the TUI re-sends its picker model + current agent on every command; the /model
    // intercept answers without an engine but still records the pair
    const session = store.createSession({})
    const res = await app.fetch(
      new Request(`http://x/session/${session.id}/command`, {
        method: "POST",
        body: JSON.stringify({ command: "model", model: "anthropic/claude-fable-5", agent: "auto" }),
      }),
    )
    expect(res.status).toBe(200)
    await settle(store)

    expect(await get("/config")).toEqual({ model: "anthropic/claude-fable-5" })
    const agents = await get("/agent")
    expect(agents.map((a: any) => a.name)).toEqual(["auto", "build", "plan"])
    expect(agents[0].color).toBe("success") // pinned — order changed, colors did not

    // restart: a fresh Store + app boots straight into the saved pair
    const store2 = await Store.load(tmp("ocd-dir-"))
    const app2 = createApp(store2)
    const cfg = await (await app2.fetch(new Request("http://x/config"))).json()
    expect(cfg).toEqual({ model: "anthropic/claude-fable-5" })
    const agents2: any = await (await app2.fetch(new Request("http://x/agent"))).json()
    expect(agents2.map((a: any) => a.name)).toEqual(["auto", "build", "plan"])
  })
})

test("noting: noReply messages count, child sessions and invalid values do not", async () => {
  await withTempXdg(async () => {
    const store = await Store.load(tmp("ocd-dir-"))
    const app = createApp(store)
    const post = (path: string, body: unknown) => app.fetch(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }))

    // noReply persists a user message without running the engine — still a client-sent pair
    const session = store.createSession({})
    const res = await post(`/session/${session.id}/message`, {
      noReply: true,
      parts: [{ type: "text", text: "seed" }],
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" },
      agent: "plan",
    })
    expect(res.status).toBe(200)
    await settle(store)
    expect(await store.globalDefaults()).toEqual({ model: "anthropic/claude-haiku-4-5-20251001", agent: "plan" })

    // a child (subagent) session must not steer the launch defaults
    const child = store.createSession({ parentID: session.id })
    await post(`/session/${child.id}/message`, {
      noReply: true,
      parts: [{ type: "text", text: "child" }],
      model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
      agent: "build",
    })
    await settle(store)
    expect(await store.globalDefaults()).toEqual({ model: "anthropic/claude-haiku-4-5-20251001", agent: "plan" })

    // junk from an arbitrary API client is dropped, valid halves still land
    await post(`/session/${session.id}/command`, { command: "model", model: "openai/gpt-6", agent: "root" })
    await settle(store)
    expect(await store.globalDefaults()).toEqual({ model: "anthropic/claude-haiku-4-5-20251001", agent: "plan" })

    await post(`/session/${session.id}/command`, { command: "model", model: "anthropic/claude-sonnet-5-20260201", agent: "root" })
    await settle(store)
    // dated id canons to the catalog row; unknown agent ignored
    expect(await store.globalDefaults()).toEqual({ model: "anthropic/claude-sonnet-5", agent: "plan" })
  })
})

test("GET /config re-reads the file per request (sibling instances stay coherent)", async () => {
  await withTempXdg(async () => {
    const store = await Store.load(tmp("ocd-dir-"))
    const app = createApp(store)
    expect(await (await app.fetch(new Request("http://x/config"))).json()).toEqual({ model: "anthropic/claude-sonnet-5" })

    // another instance (or the user) edits the global file while this server runs
    writeFileSync(Store.settingsFile(), JSON.stringify({ defaults: { model: "anthropic/claude-opus-4-8", agent: "plan" } }))
    expect(await (await app.fetch(new Request("http://x/config"))).json()).toEqual({ model: "anthropic/claude-opus-4-8" })
    const agents: any = await (await app.fetch(new Request("http://x/agent"))).json()
    expect(agents.map((a: any) => a.name)).toEqual(["plan", "build", "auto"])

    // hand-edited junk degrades to stock, never breaks bootstrap
    writeFileSync(Store.settingsFile(), JSON.stringify({ defaults: { model: "anthropic/claude-9", agent: "yolo" } }))
    expect(await (await app.fetch(new Request("http://x/config"))).json()).toEqual({ model: "anthropic/claude-sonnet-5" })
    const stock: any = await (await app.fetch(new Request("http://x/agent"))).json()
    expect(stock.map((a: any) => a.name)).toEqual(["build", "plan", "auto"])
  })
})
