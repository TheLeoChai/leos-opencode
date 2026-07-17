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
    set(values: readonly A[]): void
    update(value: A): boolean
    insert(value: A, position?: Position<Key>): Readable<A>
    remove(key: Key): boolean
    move(key: Key, position?: Position<Key>): boolean
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

        Transaction.run(() => {
          const previous = slots()
          const reconciled = next.map((value, index) => {
            const key = keys[index]
            const slot = byKey.get(key)
            if (!slot) {
              const created = State.make(value)
              byKey.set(key, created)
              return created
            }
            if (!equivalent(slot(), value)) {
              slot.set(value)
              if (options.metrics) options.metrics.slotPublications++
            } else if (options.metrics) {
              options.metrics.equivalenceSuppressions++
            }
            return slot
          })
          byKey.forEach((_slot, key) => {
            if (!retained.has(key)) byKey.delete(key)
          })
          if (!same(previous, reconciled)) {
            slots.set(reconciled)
            if (options.metrics) options.metrics.structuralPublications++
          }
        })
      },
      update(value) {
        const key = options.key(value)
        const slot = byKey.get(key)
        if (!slot) throw new Error(`Keyed value does not exist: ${String(key)}`)
        if (equivalent(slot(), value)) {
          if (options.metrics) options.metrics.equivalenceSuppressions++
          return false
        }
        slot.set(value)
        if (options.metrics) options.metrics.slotPublications++
        return true
      },
      insert(value, position) {
        const key = options.key(value)
        if (byKey.has(key)) throw new Error(`Keyed value already exists: ${String(key)}`)
        const current = slots()
        const index = positionIndex(current, position)
        const slot = State.make(value)
        Transaction.run(() => {
          byKey.set(key, slot)
          slots.set(current.toSpliced(index, 0, slot))
          if (options.metrics) options.metrics.structuralPublications++
        })
        return slot
      },
      remove(key) {
        const slot = byKey.get(key)
        if (!slot) return false
        Transaction.run(() => {
          byKey.delete(key)
          slots.set(slots().filter((candidate) => candidate !== slot))
          if (options.metrics) options.metrics.structuralPublications++
        })
        return true
      },
      move(key, position) {
        const slot = byKey.get(key)
        if (!slot) throw new Error(`Keyed value does not exist: ${String(key)}`)
        const current = slots()
        const from = current.indexOf(slot)
        const target = positionIndex(current, position)
        const to = from < target ? target - 1 : target
        if (from === to) return false
        slots.set(current.toSpliced(from, 1).toSpliced(to, 0, slot))
        if (options.metrics) options.metrics.structuralPublications++
        return true
      },
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
  }

  export function metrics(): Metrics {
    return { slotPublications: 0, structuralPublications: 0, equivalenceSuppressions: 0 }
  }

  function same<A>(left: readonly A[] | undefined, right: readonly A[]) {
    return left?.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  }
}
