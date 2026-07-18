import { computed, effect, endBatch, setActiveSub, signal, startBatch } from "alien-signals"

export interface Readable<A> {
  (): A
  subscribe(listener: (value: A) => void): () => void
}

export interface Writable<A> extends Readable<A> {
  set(value: A): void
  update(f: (value: A) => A): void
}

function subscribe<A>(read: () => A, listener: (value: A) => void) {
  let initialized = false
  return effect(() => {
    const value = read()
    if (!initialized) {
      initialized = true
      return
    }
    const active = setActiveSub()
    try {
      listener(value)
    } finally {
      setActiveSub(active)
    }
  })
}

export namespace State {
  export function make<A>(initial: A): Writable<A> {
    const state = signal(initial)
    const read = (() => state()) as Writable<A>
    read.set = (value) => state(value)
    read.update = (f) => {
      // Read untracked: calling update inside an effect must not make the
      // effect depend on (and re-trigger from) this signal.
      const active = setActiveSub()
      const current = state()
      setActiveSub(active)
      state(f(current))
    }
    read.subscribe = (listener) => subscribe(read, listener)
    return read
  }
}

export namespace Computed {
  export function make<A>(evaluate: (previous: A | undefined) => A): Readable<A> {
    const value = computed(evaluate)
    const read = (() => value()) as Readable<A>
    read.subscribe = (listener) => subscribe(read, listener)
    return read
  }
}

export namespace Transaction {
  export function run<A>(f: () => A): A {
    startBatch()
    try {
      return f()
    } finally {
      endBatch()
    }
  }
}
