import { For, from, type Accessor, type JSX } from "solid-js"
import type { Readable } from "./reactivity"

export function useValue<A>(readable: Readable<A>): Accessor<A> {
  return from(readable, readable())
}

export function KeyedFor<A>(props: {
  readonly each: Accessor<readonly Readable<A>[]>
  readonly fallback?: JSX.Element
  readonly children: (value: Accessor<A>, index: Accessor<number>) => JSX.Element
}) {
  return For({
    get each() {
      return props.each()
    },
    get fallback() {
      return props.fallback
    },
    children: (slot, index) => props.children(useValue(slot), index),
  })
}
