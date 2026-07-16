import { test, expect } from "bun:test"
import { foldPreview } from "../src/engine"

test("short preview folds under the description with quote bars", () => {
  const out = foldPreview("Red fruit", "line 1\nline 2", 24)
  expect(out).toBe("Red fruit\n│ line 1\n│ line 2")
})

test("preview longer than the budget truncates with a counted marker", () => {
  const preview = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n")
  const out = foldPreview("desc", preview, 24)
  const lines = out.split("\n")
  expect(lines[0]).toBe("desc")
  const quoted = lines.slice(1)
  expect(quoted.length).toBe(24) // 23 content lines + marker
  expect(quoted[0]).toBe("│ L1")
  expect(quoted[22]).toBe("│ L23")
  expect(quoted[23]).toBe("│ … (+7 more preview lines)")
})

test("exact-budget preview is not truncated", () => {
  const preview = Array.from({ length: 24 }, (_, i) => `L${i + 1}`).join("\n")
  const out = foldPreview("desc", preview, 24)
  expect(out.split("\n").length).toBe(25)
  expect(out).not.toContain("more preview lines")
})

test("empty description yields only quoted preview lines", () => {
  expect(foldPreview("", "only line", 24)).toBe("│ only line")
})

test("trailing whitespace in the preview is trimmed before folding", () => {
  expect(foldPreview("d", "a\nb\n\n  \n", 24)).toBe("d\n│ a\n│ b")
})

test("budget of 3 keeps at least two content lines plus the marker", () => {
  const out = foldPreview("d", "a\nb\nc\nd\ne", 3)
  const quoted = out.split("\n").slice(1)
  expect(quoted).toEqual(["│ a", "│ b", "│ … (+3 more preview lines)"])
})
