import { describe, expect, it } from "bun:test"
import { Keyed } from "../src/keyed"
import { Computed } from "../src/reactivity"

interface Item {
  readonly id: number
  readonly label: string
}

const item = (id: number, label: string): Item => ({ id, label })

describe("Keyed", () => {
  it("keeps slot identity across value updates and reorders", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two"), item(3, "three")])
    const [one, two, three] = keyed.slots()

    keyed.set([item(3, "THREE"), item(1, "ONE"), item(2, "TWO")])

    expect(keyed.slots()).toEqual([three, one, two])
    expect(keyed.slots()[0]).toBe(three)
    expect(keyed.slots()[1]).toBe(one)
    expect(keyed.slots()[2]).toBe(two)
    expect(one()).toEqual(item(1, "ONE"))
    expect(two()).toEqual(item(2, "TWO"))
    expect(three()).toEqual(item(3, "THREE"))
  })

  it("does not publish structural changes for value-only updates or identical sets", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const initial = keyed.slots()
    const structures: Array<readonly number[]> = []
    const dispose = keyed.slots.subscribe((slots) => structures.push(slots.map((slot) => slot().id)))

    keyed.set([item(1, "ONE"), item(2, "TWO")])
    expect(keyed.slots()).toBe(initial)

    keyed.set([item(1, "ONE"), item(2, "TWO")])
    expect(keyed.slots()).toBe(initial)

    keyed.set([item(2, "TWO"), item(1, "ONE")])

    expect(structures).toEqual([[2, 1]])
    dispose()
  })

  it("reacts to aggregate value updates while preserving unchanged aggregate snapshots", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    const one = item(1, "one")
    const two = item(2, "two")
    keyed.set([one, two])
    const initial = keyed.values()
    const snapshots: Array<readonly Item[]> = []
    const dispose = keyed.values.subscribe((values) => snapshots.push(values))

    keyed.set([one, item(2, "TWO")])
    const updated = keyed.values()
    expect(updated).not.toBe(initial)
    expect(updated).toEqual([one, item(2, "TWO")])

    keyed.set([one, updated[1]])

    expect(keyed.values()).toBe(updated)
    expect(snapshots).toEqual([[one, item(2, "TWO")]])
    dispose()
  })

  it("uses custom equivalence to cut off slot and aggregate updates", () => {
    const keyed = Keyed.make<Item, number>({
      key: (value) => value.id,
      equivalent: (left, right) => left.id === right.id && left.label.toLowerCase() === right.label.toLowerCase(),
    })
    const original = item(1, "one")
    keyed.set([original])
    const slot = keyed.slots()[0]
    const aggregate = keyed.values()
    const slotValues: Item[] = []
    const aggregateValues: Array<readonly Item[]> = []
    const disposeSlot = slot.subscribe((value) => slotValues.push(value))
    const disposeAggregate = keyed.values.subscribe((values) => aggregateValues.push(values))

    keyed.set([item(1, "ONE")])

    expect(slot()).toBe(original)
    expect(keyed.values()).toBe(aggregate)
    expect(slotValues).toEqual([])
    expect(aggregateValues).toEqual([])

    keyed.set([item(1, "changed")])

    expect(slot()).toEqual(item(1, "changed"))
    expect(slotValues).toEqual([item(1, "changed")])
    expect(aggregateValues).toEqual([[item(1, "changed")]])
    disposeSlot()
    disposeAggregate()
  })

  it("uses SameValueZero semantics for primitive slot values", () => {
    const keyed = Keyed.make<number, string>({ key: () => "value" })
    keyed.set([-0])

    expect(keyed.update(0)).toBe(false)
    expect(Object.is(keyed.get("value")?.(), -0)).toBe(true)
  })

  it("creates slots for inserts and fresh slots after remove and reinsert", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one")])
    const removed = keyed.slots()[0]
    const removedValues: Item[] = []
    const dispose = removed.subscribe((value) => removedValues.push(value))

    keyed.set([item(2, "two")])
    const inserted = keyed.slots()[0]
    keyed.set([item(1, "new one"), item(2, "new two")])
    const [reinserted, retained] = keyed.slots()

    expect(reinserted).not.toBe(removed)
    expect(reinserted()).toEqual(item(1, "new one"))
    expect(retained).toBe(inserted)
    expect(retained()).toEqual(item(2, "new two"))
    expect(removed()).toEqual(item(1, "one"))
    expect(removedValues).toEqual([])
    dispose()
  })

  it("rejects duplicate keys before making any partial update", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const slots = keyed.slots()
    const values = keyed.values()
    const notifications: string[] = []
    const disposeOne = slots[0].subscribe(() => notifications.push("one"))
    const disposeTwo = slots[1].subscribe(() => notifications.push("two"))
    const disposeSlots = keyed.slots.subscribe(() => notifications.push("slots"))
    const disposeValues = keyed.values.subscribe(() => notifications.push("values"))

    expect(() => keyed.set([item(1, "changed"), item(1, "duplicate")])).toThrow("Keyed values must have unique keys")

    expect(keyed.slots()).toBe(slots)
    expect(keyed.values()).toBe(values)
    expect(keyed.values()).toEqual([item(1, "one"), item(2, "two")])
    expect(notifications).toEqual([])
    disposeOne()
    disposeTwo()
    disposeSlots()
    disposeValues()
  })

  it("uses SameValueZero equality for zero keys", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(-0, "negative zero")])
    const zero = keyed.slots()[0]

    keyed.set([item(0, "zero")])

    expect(keyed.slots()[0]).toBe(zero)
    expect(zero()).toEqual(item(0, "zero"))
    expect(() => keyed.set([item(0, "zero"), item(-0, "negative zero")])).toThrow("Keyed values must have unique keys")
    expect(keyed.slots()).toEqual([zero])
    expect(keyed.values()).toEqual([item(0, "zero")])
  })

  it("uses SameValueZero equality for NaN keys", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(Number.NaN, "first")])
    const nan = keyed.slots()[0]

    keyed.set([item(Number.NaN, "updated")])

    expect(keyed.slots()[0]).toBe(nan)
    expect(nan()).toEqual(item(Number.NaN, "updated"))
    expect(() => keyed.set([item(Number.NaN, "one"), item(Number.NaN, "two")])).toThrow(
      "Keyed values must have unique keys",
    )
    expect(keyed.slots()).toEqual([nan])
    expect(keyed.values()).toEqual([item(Number.NaN, "updated")])
  })

  it("publishes one glitch-free aggregate when slots and structure change together", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two"), item(3, "three")])
    const observations: string[] = []
    const summary = Computed.make(() => {
      const slotKeys = keyed
        .slots()
        .map((slot) => slot().id)
        .join(",")
      const values = keyed
        .values()
        .map((value) => `${value.id}:${value.label}`)
        .join(",")
      return `${slotKeys}|${values}`
    })
    const dispose = summary.subscribe((value) => observations.push(value))

    keyed.set([item(3, "THREE"), item(2, "TWO"), item(4, "four")])

    expect(observations).toEqual(["3,2,4|3:THREE,2:TWO,4:four"])
    dispose()
  })

  it("stops slot, structural, and aggregate notifications after disposal", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one")])
    const notifications: string[] = []
    const disposeSlot = keyed.slots()[0].subscribe(() => notifications.push("slot"))
    const disposeSlots = keyed.slots.subscribe(() => notifications.push("slots"))
    const disposeValues = keyed.values.subscribe(() => notifications.push("values"))

    disposeSlot()
    disposeSlots()
    disposeValues()
    keyed.set([item(2, "two")])
    keyed.set([item(2, "TWO")])

    expect(notifications).toEqual([])
  })

  it("supports empty sets and repeated clears without redundant publication", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    expect(keyed.slots()).toEqual([])
    expect(keyed.values()).toEqual([])
    const structures: Array<readonly unknown[]> = []
    const aggregates: Array<readonly Item[]> = []
    const disposeSlots = keyed.slots.subscribe((slots) => structures.push(slots))
    const disposeValues = keyed.values.subscribe((values) => aggregates.push(values))

    keyed.set([])
    keyed.set([item(1, "one")])
    keyed.set([])
    const clearedSlots = keyed.slots()
    const clearedValues = keyed.values()
    keyed.set([])

    expect(keyed.slots()).toBe(clearedSlots)
    expect(keyed.values()).toBe(clearedValues)
    expect(structures.map((slots) => slots.length)).toEqual([1, 0])
    expect(aggregates).toEqual([[item(1, "one")], []])
    disposeSlots()
    disposeValues()
  })

  it("updates one existing slot without publishing structure", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const structure = keyed.slots()
    const two = keyed.slots()[1]
    const structures: Array<readonly unknown[]> = []
    const dispose = keyed.slots.subscribe((slots) => structures.push(slots))

    const updated = item(2, "TWO")
    expect(keyed.update(updated)).toBe(true)
    expect(keyed.update(updated)).toBe(false)

    expect(keyed.slots()).toBe(structure)
    expect(keyed.slots()[1]).toBe(two)
    expect(two()).toEqual(item(2, "TWO"))
    expect(structures).toEqual([])
    expect(keyed.update(item(3, "three"))).toBe(false)
    dispose()
  })

  it("modifies one existing slot while preserving its key", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one")])
    const slot = keyed.slots()[0]

    expect(keyed.modify(1, (value) => ({ ...value, label: "ONE" }))).toBe(true)
    expect(keyed.modify(1, (value) => value)).toBe(false)

    expect(keyed.slots()[0]).toBe(slot)
    expect(slot()).toEqual(item(1, "ONE"))
    expect(() => keyed.modify(1, (value) => ({ ...value, id: 2 }))).toThrow("Keyed modify must preserve the value key")
    expect(keyed.modify(2, (value) => value)).toBe(false)
  })

  it("checks key membership without reading the aggregate", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one")])

    expect(keyed.has(1)).toBe(true)
    expect(keyed.has(2)).toBe(false)
    expect(keyed.get(1)).toBe(keyed.slots()[0])
    expect(keyed.get(2)).toBeUndefined()
    expect(keyed.before(1)).toBeUndefined()
    expect(keyed.after(1)).toBeUndefined()
    keyed.remove(1)
    expect(keyed.has(1)).toBe(false)
    expect(keyed.get(1)).toBeUndefined()
  })

  it("inserts, removes, and moves stable slots", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(3, "three")])
    const one = keyed.slots()[0]
    const three = keyed.slots()[1]

    const two = keyed.insert(item(2, "two"), { before: 3 })
    expect(keyed.slots()).toEqual([one, two, three])
    const four = keyed.insert(item(4, "four"), { after: 3 })
    expect(keyed.slots()).toEqual([one, two, three, four])
    expect(keyed.before(3)).toBe(two)
    expect(keyed.after(3)).toBe(four)
    expect(keyed.move(3, { before: 1 })).toBe(true)
    expect(keyed.slots()).toEqual([three, one, two, four])
    expect(keyed.move(3, { before: 1 })).toBe(false)
    expect(keyed.move(3, { after: 2 })).toBe(true)
    expect(keyed.slots()).toEqual([one, two, three, four])
    expect(keyed.move(3, "end")).toBe(true)
    expect(keyed.slots()).toEqual([one, two, four, three])
    expect(keyed.remove(2)).toBe(true)
    expect(keyed.remove(2)).toBe(false)
    expect(keyed.slots()).toEqual([one, four, three])
    expect(() => keyed.insert(item(1, "duplicate"))).toThrow("Keyed value already exists: 1")
    expect(() => keyed.insert(item(2, "two"), { before: 5 })).toThrow("Keyed value does not exist: 5")
    expect(keyed.move(5)).toBe(false)
  })

  it("counts publications and equivalence suppressions when instrumented", () => {
    const metrics = Keyed.metrics()
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id, metrics })

    keyed.set([item(1, "one")])
    keyed.update(item(1, "ONE"))
    const current = keyed.slots()[0]()
    keyed.update(current)
    keyed.insert(item(2, "two"))
    keyed.move(2, { before: 1 })
    keyed.remove(2)

    expect(metrics).toEqual({
      slotPublications: 1,
      structuralPublications: 4,
      equivalenceSuppressions: 1,
    })
  })
})
