import { describe, expect, it } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import { Computed, Keyed, State, Transaction, type Readable } from "../src"
import { useSlot, useValue } from "../src/solid"

describe("Solid adapter", () => {
  it("bridges Quark values into Solid ownership", () => {
    const left = State.make(1)
    const right = State.make(2)
    const total = Computed.make(() => left() + right())
    const values: number[] = []

    createRoot((dispose) => {
      const value = useValue(total)
      createComputed(() => values.push(value()))

      Transaction.run(() => {
        left.set(2)
        right.set(3)
      })
      dispose()
    })

    left.set(4)
    expect(values).toEqual([3, 5])
  })

  it("preserves function values", () => {
    const first = () => 1
    const second = () => 2
    const state = State.make(first)
    let value = first

    createRoot((dispose) => {
      const current = useValue(state)
      createComputed(() => value = current())
      state.set(second)
      dispose()
    })

    expect(value).toBe(second)
  })

  it("switches keyed slots and releases obsolete subscriptions", () => {
    const keyed = Keyed.make<{ readonly id: number; readonly value: string }, number>({ key: (value) => value.id })
    keyed.set([
      { id: 1, value: "one" },
      { id: 2, value: "two" },
    ])
    const active = [0, 0]
    track(keyed.get(1)!, 0)
    track(keyed.get(2)!, 1)
    const values: Array<string | undefined> = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal(1)
      const value = useSlot(keyed, key)
      createComputed(() => values.push(value()?.value))

      keyed.modify(1, (item) => ({ ...item, value: "ONE" }))
      keyed.insert({ id: 3, value: "three" })
      setKey(2)
      keyed.modify(1, (item) => ({ ...item, value: "ignored" }))
      keyed.modify(2, (item) => ({ ...item, value: "TWO" }))

      expect(active).toEqual([0, 1])
      dispose()
    })

    expect(active).toEqual([0, 0])
    expect(values).toEqual(["one", "ONE", "two", "TWO"])

    function track(slot: Readable<{ readonly id: number; readonly value: string }>, index: number) {
      const subscribe = slot.subscribe.bind(slot)
      slot.subscribe = (listener) => {
        active[index]++
        const dispose = subscribe(listener)
        return () => {
          active[index]--
          dispose()
        }
      }
    }
  })
})
