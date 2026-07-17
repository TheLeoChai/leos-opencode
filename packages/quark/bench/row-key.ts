import { createHarness, type Workload } from "./harness"

type Row =
  | { readonly type: "message"; readonly messageID: string }
  | { readonly type: "part"; readonly messageID: string; readonly partID: string }
  | {
      readonly type: "group"
      readonly kind: "reasoning" | "exploration"
      readonly messageID: string
      readonly partID: string
    }

const size = 10_000
const iterations = 1_000_000
const rows = Array.from({ length: size }, (_, index): Row => {
  if (index % 3 === 0) return { type: "message", messageID: `message-${index}` }
  if (index % 3 === 1) return { type: "part", messageID: `message-${index >> 2}`, partID: `text:${index}` }
  return {
    type: "group",
    kind: index % 2 === 0 ? "reasoning" : "exploration",
    messageID: `message-${index >> 2}`,
    partID: `call-${index}`,
  }
})
const precomputed = rows.map((row) => ({ row, id: concatenate(row) }))
const bench = createHarness()

function workload(read: (index: number) => string): Workload {
  let sink = 0
  return {
    run(index) {
      sink += read(index % size).length
    },
    consume: () => sink,
  }
}

function json(row: Row) {
  if (row.type === "message") return JSON.stringify([row.type, row.messageID])
  if (row.type === "part") return JSON.stringify([row.type, row.messageID, row.partID])
  return JSON.stringify([row.type, row.kind, row.messageID, row.partID])
}

function concatenate(row: Row) {
  if (row.type === "message") return `m${row.messageID.length}:${row.messageID}`
  if (row.type === "part") return `p${row.messageID.length}:${row.messageID}${row.partID.length}:${row.partID}`
  return `g${row.kind === "reasoning" ? "r" : "e"}${row.messageID.length}:${row.messageID}${row.partID.length}:${row.partID}`
}

console.log(`Session row key benchmark (${size.toLocaleString()} rows, ${bench.samples} samples)\n`)

const result = bench.compare(iterations, [
  { name: "JSON tuple key", make: () => workload((index) => json(rows[index])) },
  { name: "Concatenated key", make: () => workload((index) => concatenate(rows[index])) },
  { name: "Precomputed key", make: () => workload((index) => precomputed[index].id) },
])

console.log("\nRatios to JSON tuple (lower is faster)")
console.log(`Concatenated: ${result.ratio(1, 0).toFixed(3)}x`)
console.log(`Precomputed:  ${result.ratio(2, 0).toFixed(3)}x`)
console.log(`METRIC concatenated_key_ratio=${result.ratio(1, 0).toFixed(6)}`)
console.log(`METRIC precomputed_key_ratio=${result.ratio(2, 0).toFixed(6)}`)
bench.finish()
