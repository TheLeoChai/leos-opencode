import { describe, expect, it } from "bun:test"
import { Computed, Keyed } from "../src"

type Item = {
  readonly id: number
  readonly label: string
}

const item = (id: number, label: string): Item => ({ id, label })

describe("Keyed", () => {
  it("keeps slots stable while publishing value and structural changes separately", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const [one, two] = keyed.slots()
    const structure = keyed.slots()
    const structures: number[][] = []
    const values: Item[][] = []
    const disposeSlots = keyed.slots.subscribe((slots) => structures.push(slots.map((slot) => slot().id)))
    const disposeValues = keyed.values.subscribe((next) => values.push([...next]))

    keyed.set([item(1, "ONE"), item(2, "TWO")])

    expect(keyed.slots()).toBe(structure)
    expect(keyed.slots()).toEqual([one, two])
    expect(values).toEqual([[item(1, "ONE"), item(2, "TWO")]])
    expect(structures).toEqual([])

    keyed.set([item(2, "TWO"), item(1, "ONE")])

    expect(keyed.slots()).toEqual([two, one])
    expect(structures).toEqual([[2, 1]])
    disposeSlots()
    disposeValues()
  })

  it("uses custom equivalence to cut off slot and aggregate updates", () => {
    const keyed = Keyed.make<Item, number>({
      key: (value) => value.id,
      equivalent: (left, right) => left.label.toLowerCase() === right.label.toLowerCase(),
    })
    const original = item(1, "one")
    keyed.set([original])
    const slot = keyed.slots()[0]
    const aggregate = keyed.values()

    keyed.set([item(1, "ONE")])

    expect(slot()).toBe(original)
    expect(keyed.values()).toBe(aggregate)
  })

  it("creates a fresh slot after removal and reinsertion", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const [removed, retained] = keyed.slots()

    keyed.set([item(2, "two")])
    keyed.set([item(1, "new"), item(2, "TWO")])

    expect(keyed.slots()[0]).not.toBe(removed)
    expect(keyed.slots()[1]).toBe(retained)
    expect(retained()).toEqual(item(2, "TWO"))
  })

  it("rejects duplicate keys without partially updating", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const slots = keyed.slots()
    const values = keyed.values()

    expect(() => keyed.set([item(1, "changed"), item(1, "duplicate")])).toThrow("Keyed values must have unique keys")
    expect(keyed.slots()).toBe(slots)
    expect(keyed.values()).toBe(values)
  })

  it("uses SameValueZero key equality", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(-0, "zero"), item(Number.NaN, "nan")])
    const [zero, nan] = keyed.slots()

    keyed.set([item(0, "ZERO"), item(Number.NaN, "NAN")])

    expect(keyed.slots()).toEqual([zero, nan])
    expect(() => keyed.set([item(0, "zero"), item(-0, "duplicate")])).toThrow("Keyed values must have unique keys")
    expect(() => keyed.set([item(Number.NaN, "nan"), item(Number.NaN, "duplicate")])).toThrow(
      "Keyed values must have unique keys",
    )
  })

  it("publishes one settled aggregate when values and structure change together", () => {
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id })
    keyed.set([item(1, "one"), item(2, "two")])
    const observations: string[] = []
    const summary = Computed.make(() => {
      const slots = keyed
        .slots()
        .map((slot) => `${slot().id}:${slot().label}`)
        .join(",")
      const values = keyed
        .values()
        .map((value) => `${value.id}:${value.label}`)
        .join(",")
      return `${slots}|${values}`
    })
    const dispose = summary.subscribe((value) => observations.push(value))

    keyed.set([item(2, "TWO"), item(3, "three")])

    expect(observations).toEqual(["2:TWO,3:three|2:TWO,3:three"])
    dispose()
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
    expect(() => keyed.update(item(3, "three"))).toThrow("Keyed value does not exist: 3")
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
    expect(() => keyed.modify(2, (value) => value)).toThrow("Keyed value does not exist: 2")
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

  it("publishes nothing for a full unchanged rebuild", () => {
    const metrics = Keyed.metrics()
    const keyed = Keyed.make<Item, number>({ key: (value) => value.id, metrics })
    const values = [item(1, "one"), item(2, "two")]
    keyed.set(values)
    const before = { ...metrics }

    keyed.set(values)

    expect(metrics.slotPublications).toBe(before.slotPublications)
    expect(metrics.structuralPublications).toBe(before.structuralPublications)
    expect(metrics.equivalenceSuppressions).toBe(before.equivalenceSuppressions + values.length)
  })
})
