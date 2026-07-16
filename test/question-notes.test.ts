import { test, expect } from "bun:test"
import { splitNotes } from "../src/engine"

test("plain labels pass through untouched", () => {
  expect(splitNotes(["Apples", "Bananas"])).toEqual({ answers: ["Apples", "Bananas"], note: "" })
})

test("answer // note splits into both", () => {
  expect(splitNotes(["Apples // only organic"])).toEqual({ answers: ["Apples"], note: "only organic" })
})

test("entry starting with '// ' is a pure note", () => {
  expect(splitNotes(["Coffee", "// decaf please"])).toEqual({ answers: ["Coffee"], note: "decaf please" })
})

test("picked option labels bypass parsing even when they contain the delimiter", () => {
  const labels = new Set(["Use // comments", "// TODO style"])
  expect(splitNotes(["Use // comments", "// TODO style"], labels)).toEqual({
    answers: ["Use // comments", "// TODO style"],
    note: "",
  })
})

test("typed custom text is still parsed when labels are present", () => {
  expect(splitNotes(["Apples // organic"], new Set(["Apples", "Bananas"]))).toEqual({ answers: ["Apples"], note: "organic" })
})

test("URLs survive: no space-padded delimiter inside them", () => {
  expect(splitNotes(["check https://example.com/a//b"])).toEqual({ answers: ["check https://example.com/a//b"], note: "" })
})

test("protocol-relative URL answers are not swallowed as notes", () => {
  expect(splitNotes(["//cdn.example.com/lib.js"])).toEqual({ answers: ["//cdn.example.com/lib.js"], note: "" })
})

test("URL answer with a real note still splits", () => {
  expect(splitNotes(["https://example.com // use the staging host"])).toEqual({
    answers: ["https://example.com"],
    note: "use the staging host",
  })
})

test("splits only at the first delimiter — note text may contain another", () => {
  expect(splitNotes(["A // first // second"])).toEqual({ answers: ["A"], note: "first // second" })
})

test("multiple notes join with newlines", () => {
  expect(splitNotes(["A // one", "// two"])).toEqual({ answers: ["A"], note: "one\ntwo" })
})

test("empty answer side keeps only the note", () => {
  expect(splitNotes([" // just the note"])).toEqual({ answers: [], note: "just the note" })
})

test("bare or empty note markers vanish", () => {
  expect(splitNotes(["//", "A // ", "  //  "])).toEqual({ answers: ["A"], note: "" })
})

test("multiline note text is preserved", () => {
  expect(splitNotes(["A // line one\nline two"])).toEqual({ answers: ["A"], note: "line one\nline two" })
})
