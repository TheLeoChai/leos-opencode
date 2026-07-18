import { describe, expect, it } from "bun:test"
import { Computed, State, Transaction, type Readable } from "../src/reactivity"

describe("reactivity", () => {
  it("keeps computed values lazy", () => {
    const source = State.make(1)
    let evaluations = 0
    const doubled = Computed.make(() => {
      evaluations++
      return source() * 2
    })

    expect(evaluations).toBe(0)
    expect(doubled()).toBe(2)
    expect(doubled()).toBe(2)
    expect(evaluations).toBe(1)

    source.set(2)
    expect(evaluations).toBe(1)
    expect(doubled()).toBe(4)
    expect(evaluations).toBe(2)
  })

  it("propagates a diamond without glitches", () => {
    const source = State.make(1)
    const left = Computed.make(() => source() * 2)
    const right = Computed.make(() => source() * 3)
    const total = Computed.make(() => left() + right())
    const values: Array<number> = []
    const dispose = total.subscribe((value) => values.push(value))

    source.set(2)

    expect(values).toEqual([10])
    dispose()
  })

  it("tracks dynamic dependencies", () => {
    const enabled = State.make(true)
    const left = State.make(1)
    const right = State.make(10)
    const selected = Computed.make(() => (enabled() ? left() : right()))
    const values: Array<number> = []
    const dispose = selected.subscribe((value) => values.push(value))

    left.set(2)
    enabled.set(false)
    left.set(3)
    right.set(11)

    expect(values).toEqual([2, 10, 11])
    dispose()
  })

  it("batches transactions", () => {
    const left = State.make(1)
    const right = State.make(2)
    const total = Computed.make(() => left() + right())
    const values: Array<number> = []
    const dispose = total.subscribe((value) => values.push(value))

    Transaction.run(() => {
      left.set(2)
      right.set(3)
    })

    expect(values).toEqual([5])
    dispose()
  })

  it("cuts off unchanged derived values", () => {
    const source = State.make(1)
    let parityEvaluations = 0
    let labelEvaluations = 0
    const parity = Computed.make(() => {
      parityEvaluations++
      return source() % 2
    })
    const label = Computed.make(() => {
      labelEvaluations++
      return parity() === 0 ? "even" : "odd"
    })
    const dispose = label.subscribe(() => {})

    source.set(3)

    expect(parityEvaluations).toBe(2)
    expect(labelEvaluations).toBe(1)
    dispose()
  })

  it("disposes subscriptions", () => {
    const source = State.make(1)
    const values: Array<number> = []
    const dispose = source.subscribe((value) => values.push(value))

    source.set(2)
    dispose()
    source.set(3)

    expect(values).toEqual([2])
  })

  it("does not track state read by subscription listeners", () => {
    const source = State.make(1)
    const unrelated = State.make(1)
    const values: Array<number> = []
    const dispose = source.subscribe((value) => {
      unrelated()
      values.push(value)
    })

    source.set(2)
    unrelated.set(2)

    expect(values).toEqual([2])
    dispose()
  })

  it("does not track the state read by update", () => {
    const trigger = State.make(0)
    const updated = State.make(0)
    let runs = 0
    const dispose = trigger.subscribe(() => {
      runs++
      updated.update((value) => value + 1)
    })

    trigger.set(1)
    updated.set(10)

    expect(runs).toBe(1)
    expect(updated()).toBe(10)
    dispose()
  })

  it("delivers the previous value to computed evaluation", () => {
    const source = State.make(1)
    const previousValues: Array<number | undefined> = []
    const running = Computed.make<number>((previous) => {
      previousValues.push(previous)
      return (previous ?? 0) + source()
    })

    expect(running()).toBe(1)
    source.set(2)
    expect(running()).toBe(3)
    source.set(3)
    expect(running()).toBe(6)
    expect(previousValues).toEqual([undefined, 1, 3])
  })

  it("detaches and reattaches dynamic dependencies", () => {
    const enabled = State.make(true)
    const left = State.make(1)
    const right = State.make(10)
    let evaluations = 0
    const selected = Computed.make(() => {
      evaluations++
      return enabled() ? left() : right()
    })
    const dispose = selected.subscribe(() => {})

    expect(evaluations).toBe(1)
    enabled.set(false)
    expect(evaluations).toBe(2)

    // Detached: left writes must not re-evaluate the computed.
    left.set(2)
    left.set(3)
    expect(evaluations).toBe(2)

    // Reattached: left writes re-evaluate, right writes no longer do.
    enabled.set(true)
    expect(evaluations).toBe(3)
    expect(selected()).toBe(3)
    right.set(11)
    expect(evaluations).toBe(3)
    left.set(4)
    expect(evaluations).toBe(4)
    expect(selected()).toBe(4)
    dispose()
  })

  it("notifies a diamond subscriber exactly once per write", () => {
    const source = State.make(1)
    const left = Computed.make(() => source() * 2)
    const right = Computed.make(() => source() * 3)
    const total = Computed.make(() => left() + right())
    let notifications = 0
    const dispose = total.subscribe(() => notifications++)

    source.set(2)
    source.set(3)

    expect(notifications).toBe(2)
    dispose()
  })

  it("batches nested transactions until the outermost ends", () => {
    const left = State.make(1)
    const right = State.make(2)
    const total = Computed.make(() => left() + right())
    const values: Array<number> = []
    const dispose = total.subscribe((value) => values.push(value))

    Transaction.run(() => {
      left.set(2)
      Transaction.run(() => {
        right.set(3)
      })
      expect(values).toEqual([])
      left.set(3)
    })

    expect(values).toEqual([6])
    dispose()
  })

  it("restores batch state when a transaction throws", () => {
    const source = State.make(1)
    const values: Array<number> = []
    const dispose = source.subscribe((value) => values.push(value))

    expect(() =>
      Transaction.run(() => {
        source.set(2)
        throw new Error("boom")
      }),
    ).toThrow("boom")

    // The write that happened before the throw still flushes once the
    // transaction unwinds, and later writes are not batched.
    expect(values).toEqual([2])
    source.set(3)
    expect(values).toEqual([2, 3])
    dispose()
  })

  it("supports disposing another subscription during notification", () => {
    const source = State.make(1)
    const first: Array<number> = []
    const second: Array<number> = []
    let disposeSecond = () => {}
    const disposeFirst = source.subscribe((value) => {
      first.push(value)
      disposeSecond()
    })
    disposeSecond = source.subscribe((value) => second.push(value))

    source.set(2)
    source.set(3)

    expect(first).toEqual([2, 3])
    expect(second).toEqual([])
    disposeFirst()
  })

  it("does not deliver to a watcher disposed during revalidation", () => {
    const source = State.make(0)
    let dispose = () => {}
    const gate = Computed.make(() => {
      const value = source()
      if (value > 0) dispose()
      return value
    })
    const values: Array<number> = []
    dispose = gate.subscribe((value) => values.push(value))

    // Revalidating the watcher re-evaluates gate, whose evaluation disposes
    // the subscription before the value could be delivered.
    source.set(1)
    source.set(2)

    expect(values).toEqual([])
  })

  it("supports a subscription disposing itself during notification", () => {
    const source = State.make(1)
    const values: Array<number> = []
    let dispose = () => {}
    dispose = source.subscribe((value) => {
      values.push(value)
      dispose()
    })

    source.set(2)
    source.set(3)

    expect(values).toEqual([2])
  })

  it("does not track State.update reading its own value", () => {
    const counter = State.make(0)
    const source = State.make(1)
    let evaluations = 0
    const tracked = Computed.make(() => {
      evaluations++
      counter.update((value) => value)
      return source()
    })
    const dispose = tracked.subscribe(() => {})

    expect(evaluations).toBe(1)
    counter.set(5)
    expect(evaluations).toBe(1)
    source.set(2)
    expect(evaluations).toBe(2)
    dispose()
  })

  it("recovers tracking after a computed evaluation throws", () => {
    const shouldThrow = State.make(true)
    const source = State.make(1)
    const throwing = Computed.make(() => {
      if (shouldThrow()) throw new Error("computed boom")
      return source()
    })

    expect(() => throwing()).toThrow("computed boom")

    // The failed evaluation must restore the active observer so unrelated
    // graphs keep tracking correctly afterwards.
    const other = State.make(1)
    const doubled = Computed.make(() => other() * 2)
    const values: Array<number> = []
    const dispose = doubled.subscribe((value) => values.push(value))
    other.set(2)
    expect(values).toEqual([4])
    dispose()

    shouldThrow.set(false)
    expect(throwing()).toBe(1)
    source.set(2)
    expect(throwing()).toBe(2)
  })

  it("keeps notifying other subscribers after a listener throws", () => {
    const source = State.make(1)
    const values: Array<number> = []
    const disposeThrowing = source.subscribe(() => {
      throw new Error("listener boom")
    })
    const dispose = source.subscribe((value) => values.push(value))

    expect(() => source.set(2)).toThrow("listener boom")
    disposeThrowing()
    source.set(3)

    expect(values).toContain(3)
    dispose()
  })

  it("leaves no dependency links behind when subscription initialization fails", () => {
    const source = State.make(1)
    const throwing = Computed.make(() => {
      if (source() === 1) throw new Error("init boom")
      return source()
    })
    const values: Array<number> = []

    expect(() => throwing.subscribe((value) => values.push(value))).toThrow("init boom")

    // The failed subscription must not stay linked to the graph.
    source.set(2)
    source.set(3)
    expect(values).toEqual([])

    // The computed itself remains usable.
    expect(throwing()).toBe(3)
  })

  it("propagates deep chains without recursive stack growth", () => {
    // A cold pull of an unevaluated chain necessarily nests user getter
    // frames, so each layer is evaluated as it is built. The kernel-owned
    // paths under test are dirty propagation and revalidation, which must
    // walk the full depth iteratively.
    const depth = 100_000
    const source = State.make(0)
    const chain = Array.from({ length: depth }).reduce<Readable<number>>((current) => {
      const next = Computed.make(() => current() + 1)
      next()
      return next
    }, source)

    expect(chain()).toBe(depth)
    const values: Array<number> = []
    const dispose = chain.subscribe((value) => values.push(value))
    source.set(1)
    expect(values).toEqual([depth + 1])
    dispose()
  })

  it("propagates wide fan-out without recursive stack growth", () => {
    const width = 50_000
    const source = State.make(0)
    const nodes = Array.from({ length: width }, () => Computed.make(() => source() + 1))
    const total = Computed.make(() => nodes.reduce((sum, node) => sum + node(), 0))
    let sink = 0
    const dispose = total.subscribe((value) => {
      sink = value
    })

    source.set(1)
    expect(sink).toBe(width * 2)
    dispose()
  })

  it("fails deterministically on cyclic computed dependencies", () => {
    // Regression for stackblitz/alien-signals#123: mutually dependent
    // computed graphs must throw a stable error instead of looping or
    // exhausting memory.
    const fieldA = State.make(false)
    const fieldB = State.make(false)
    const a: Readable<boolean | null> = Computed.make(() => (b() !== true ? fieldA() : null))
    const b: Readable<boolean | null> = Computed.make(() => (a() !== true ? fieldB() : null))

    // Every read that reaches the cycle fails the same way; a failed
    // evaluation stays dirty and retries instead of serving a stale value.
    expect(() => a()).toThrow(/cycle/i)
    expect(() => b()).toThrow(/cycle/i)

    fieldA.set(true)

    expect(() => a()).toThrow(/cycle/i)
  })
})
