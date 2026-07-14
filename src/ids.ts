// opencode-compatible identifier generation.
// Contract: docs/contract/05-data-model.md §1. Format is
//   <prefix>_<12 lowercase hex><14 base62>, where the hex encodes the low 48 bits of
//   (timestamp_ms * 4096 + counter). "descending" bit-inverts so newer sorts smaller.
// The TUI binary-searches messages/parts/sessions by raw id string, so the encoding and
// direction must match opencode exactly or ordering breaks.

const LENGTH = 26
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let counter = 0

function randomBase62(n: number): string {
  let out = ""
  for (let i = 0; i < n; i++) {
    out += BASE62[Math.floor(Math.random() * BASE62.length)]
  }
  return out
}

function create(prefix: string, direction: "ascending" | "descending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++
  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
  if (direction === "descending") now = ~now
  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }
  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}

export const Id = {
  session: () => create("ses", "descending"),
  message: () => create("msg", "ascending"),
  part: () => create("prt", "ascending"),
  event: () => create("evt", "ascending"),
  permission: () => create("per", "ascending"),
  question: () => create("que", "ascending"),
  project: () => create("prj", "ascending"),
}
