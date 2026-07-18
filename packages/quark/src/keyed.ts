import { Computed, State, Transaction, type Readable, type Writable } from "./reactivity"

export namespace Keyed {
  export type Position<Key> = "end" | { readonly before: Key } | { readonly after: Key }

  export interface Metrics {
    slotPublications: number
    structuralPublications: number
    equivalenceSuppressions: number
  }

  export interface Keyed<A, Key> {
    readonly slots: Readable<readonly Readable<A>[]>
    readonly values: Readable<readonly A[]>
    has(key: Key): boolean
    get(key: Key): Readable<A> | undefined
    set(values: readonly A[]): boolean
    update(value: A): boolean
    modify(key: Key, f: (value: A) => A): boolean
    insert(value: A, position?: Position<Key>): Readable<A>
    remove(key: Key): boolean
    move(key: Key, position?: Position<Key>): boolean
    before(key: Key): Readable<A> | undefined
    after(key: Key): Readable<A> | undefined
  }

  export function make<A, Key>(options: {
    readonly key: (value: A) => Key
    readonly equivalent?: (left: A, right: A) => boolean
    readonly metrics?: Metrics
  }): Keyed<A, Key> {
    const slots = State.make<readonly Writable<A>[]>([])
    const byKey = new Map<Key, Writable<A>>()
    const equivalent = options.equivalent ?? Object.is
    const values = Computed.make<readonly A[]>((previous) => {
      const next = slots().map((slot) => slot())
      return same(previous, next) ? previous! : next
    })

    return {
      slots,
      values,
      has: (key) => byKey.has(key),
      get: (key) => byKey.get(key),
      set(next) {
        const keys = next.map(options.key)
        const retained = new Set(keys)
        if (retained.size !== keys.length) throw new Error("Keyed values must have unique keys")

        return Transaction.run(() => {
          let changed = false
          const previous = slots()
          const reconciled = next.map((value, index) => {
            const key = keys[index]
            const slot = byKey.get(key)
            if (!slot) {
              const created = State.make(value)
              byKey.set(key, created)
              return created
            }
            if (publish(slot, value)) changed = true
            return slot
          })
          // After reconciliation byKey is a superset of retained; equal sizes
          // mean no stale keys and the sweep can be skipped.
          if (byKey.size !== retained.size)
            byKey.forEach((_slot, key) => {
              if (!retained.has(key)) byKey.delete(key)
            })
          if (!same(previous, reconciled)) {
            slots.set(reconciled)
            if (options.metrics) options.metrics.structuralPublications++
            changed = true
          }
          return changed
        })
      },
      update(value) {
        const slot = byKey.get(options.key(value))
        if (!slot) return false
        return publish(slot, value)
      },
      modify(key, f) {
        const slot = byKey.get(key)
        if (!slot) return false
        const value = f(slot())
        if (byKey.get(options.key(value)) !== slot) throw new Error("Keyed modify must preserve the value key")
        return publish(slot, value)
      },
      insert(value, position) {
        const key = options.key(value)
        if (byKey.has(key)) throw new Error(`Keyed value already exists: ${String(key)}`)
        const current = slots()
        const index = positionIndex(current, position)
        const slot = State.make(value)
        // byKey is not reactive and slots.set is a single publication, so no
        // transaction is required here; callers batch when they need to.
        byKey.set(key, slot)
        slots.set(current.toSpliced(index, 0, slot))
        if (options.metrics) options.metrics.structuralPublications++
        return slot
      },
      remove(key) {
        const slot = byKey.get(key)
        if (!slot) return false
        byKey.delete(key)
        slots.set(slots().filter((candidate) => candidate !== slot))
        if (options.metrics) options.metrics.structuralPublications++
        return true
      },
      move(key, position) {
        const slot = byKey.get(key)
        if (!slot) return false
        const current = slots()
        const from = current.indexOf(slot)
        const target = positionIndex(current, position)
        const to = from < target ? target - 1 : target
        if (from === to) return false
        const next = current.slice()
        next.splice(from, 1)
        next.splice(to, 0, slot)
        slots.set(next)
        if (options.metrics) options.metrics.structuralPublications++
        return true
      },
      before(key) {
        return neighbor(key, -1)
      },
      after(key) {
        return neighbor(key, 1)
      },
    }

    function publish(slot: Writable<A>, value: A) {
      const current = slot()
      if (current === value || equivalent(current, value)) {
        if (options.metrics) options.metrics.equivalenceSuppressions++
        return false
      }
      slot.set(value)
      if (options.metrics) options.metrics.slotPublications++
      return true
    }

    function positionIndex(current: readonly Writable<A>[], position?: Position<Key>) {
      if (position === undefined || position === "end") return current.length
      if ("before" in position) return indexOf(current, position.before)
      return indexOf(current, position.after) + 1
    }

    function indexOf(current: readonly Writable<A>[], key: Key) {
      const target = byKey.get(key)
      if (!target) throw new Error(`Keyed value does not exist: ${String(key)}`)
      return current.indexOf(target)
    }

    function neighbor(key: Key, offset: -1 | 1) {
      const slot = byKey.get(key)
      if (!slot) return undefined
      const current = slots()
      return current[current.indexOf(slot) + offset]
    }
  }

  export function metrics(): Metrics {
    return { slotPublications: 0, structuralPublications: 0, equivalenceSuppressions: 0 }
  }

  function same<A>(left: readonly A[] | undefined, right: readonly A[]) {
    return left?.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  }
}
