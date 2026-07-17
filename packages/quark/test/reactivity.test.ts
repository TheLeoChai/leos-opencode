import { describe, expect, it } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { State } from "../src"
import { useValue } from "../src/solid"

describe("Quark", () => {
  it("does not track state read by subscription listeners", () => {
    const source = State.make(1)
    const unrelated = State.make(1)
    const values: number[] = []
    const dispose = source.subscribe((value) => {
      unrelated()
      values.push(value)
    })

    source.set(2)
    unrelated.set(2)

    expect(values).toEqual([2])
    dispose()
  })

  it("bridges values into a Solid owner and disposes with it", () => {
    const source = State.make(1)
    const values: number[] = []
    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      const value = useValue(source)
      createEffect(() => values.push(value()))
    })

    source.set(2)
    dispose()
    source.set(3)

    expect(values).toEqual([1, 2])
  })
})
