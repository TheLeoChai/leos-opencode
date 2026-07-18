import { Keyed } from "@opencode-ai/quark"
import { createStore, produce } from "solid-js/store"
import { SessionTimeline, type PartRef } from "../src/routes/session/timeline"
import { createHarness, type Workload } from "../../quark/bench/harness"

type Group = {
  readonly id: "group"
  readonly type: "group"
  readonly refs: readonly PartRef[]
}

const bench = createHarness({ warmup: 500 })

function timelineAppend(): Workload {
  const timeline = SessionTimeline.make()
  let ordinal = 0
  return {
    run() {
      timeline.appendPart({ messageID: "assistant", partID: `reasoning:${ordinal++}` }, { type: "reasoning" })
    },
    consume: () => {
      const row = timeline.values()[0]
      return row?.type === "group" ? row.refs.length : 0
    },
  }
}

function keyedAppend(): Workload {
  const seen = new Set<string>()
  const rows = Keyed.make<Group, Group["id"]>({
    key: (row) => row.id,
    equivalent: (left, right) =>
      left.refs.length === right.refs.length &&
      left.refs.every(
        (ref, index) => ref.messageID === right.refs[index].messageID && ref.partID === right.refs[index].partID,
      ),
  })
  rows.set([{ id: "group", type: "group", refs: [] }])
  let ordinal = 0
  return {
    run() {
      const ref = { messageID: "assistant", partID: `reasoning:${ordinal++}` }
      if (seen.has(ref.partID)) return
      rows.modify("group", (group) => ({ ...group, refs: [...group.refs, ref] }))
      seen.add(ref.partID)
    },
    consume: () => rows.get("group")!().refs.length,
  }
}

function solidAppend(): Workload {
  const [rows, setRows] = createStore<Array<{ type: "group"; refs: PartRef[] }>>([{ type: "group", refs: [] }])
  let ordinal = 0
  return {
    run() {
      const ref = { messageID: "assistant", partID: `reasoning:${ordinal++}` }
      setRows(
        produce((draft) => {
          if (draft[0].refs.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)) return
          draft[0].refs.push(ref)
        }),
      )
    },
    consume: () => rows[0].refs.length,
  }
}

function timelineDuplicate(size: number): Workload {
  const timeline = SessionTimeline.make()
  Array.from({ length: size }, (_, ordinal) =>
    timeline.appendPart({ messageID: "assistant", partID: `reasoning:${ordinal}` }, { type: "reasoning" }),
  )
  const duplicate = { messageID: "assistant", partID: `reasoning:${size - 1}` }
  return {
    run: () => timeline.appendPart(duplicate, { type: "reasoning" }),
    consume: () => timeline.values().length,
  }
}

function solidDuplicate(size: number): Workload {
  const refs = Array.from(
    { length: size },
    (_, ordinal): PartRef => ({ messageID: "assistant", partID: `reasoning:${ordinal}` }),
  )
  const [rows, setRows] = createStore([{ type: "group" as const, refs }])
  const duplicate = refs.at(-1)!
  return {
    run() {
      setRows(
        produce((draft) => {
          if (draft[0].refs.some((item) => item.messageID === duplicate.messageID && item.partID === duplicate.partID))
            return
          draft[0].refs.push(duplicate)
        }),
      )
    },
    consume: () => rows.length,
  }
}

console.log(`Session timeline benchmark (${bench.samples} samples)\n`)

const append = bench.compare(2_000, [
  { name: "SessionTimeline grouped append", make: timelineAppend },
  { name: "Handwritten Keyed + Set append", make: keyedAppend },
  { name: "Solid Store produce append", make: solidAppend },
])
const duplicate = bench.compare(10_000, [
  { name: "SessionTimeline duplicate 1000", make: () => timelineDuplicate(1_000) },
  { name: "Solid Store duplicate 1000", make: () => solidDuplicate(1_000) },
])

console.log("\nRatios (lower is faster)")
console.log(`Timeline / handwritten append: ${append.ratio(0, 1).toFixed(3)}x`)
console.log(`Timeline / Solid append:       ${append.ratio(0, 2).toFixed(3)}x`)
console.log(`Timeline / Solid duplicate:    ${duplicate.ratio(0, 1).toFixed(3)}x`)
console.log(`METRIC timeline_handwritten_append_ratio=${append.ratio(0, 1).toFixed(6)}`)
console.log(`METRIC timeline_solid_append_ratio=${append.ratio(0, 2).toFixed(6)}`)
console.log(`METRIC timeline_solid_duplicate_ratio=${duplicate.ratio(0, 1).toFixed(6)}`)
bench.finish()
