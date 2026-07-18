import { Keyed } from "./keyed"
import { Transaction, type Readable } from "./reactivity"

export namespace Layout {
  export interface Field<A> {
    readonly isKey?: true
    readonly primitive?: true
    readonly immutable?: true
    equivalent(left: A, right: A): boolean
  }

  export interface KeyField<A> extends Field<A> {
    readonly isKey: true
  }

  export interface NamedKey<Name extends PropertyKey, A> {
    readonly name: Name
    readonly field: Field<A>
  }

  export type Type<Field> = Field extends Layout.Field<infer A> ? A : never

  type Fields = Readonly<Record<PropertyKey, Field<unknown>>>
  type Value<StructFields> = {
    readonly [Key in keyof StructFields]: Type<StructFields[Key]>
  }
  type KeyName<StructFields> = {
    readonly [Key in keyof StructFields]: StructFields[Key] extends KeyField<unknown> ? Key : never
  }[keyof StructFields]
  type Variant<Tag extends PropertyKey, Variants> = {
    readonly [Name in keyof Variants & string]: {
      readonly [Key in Tag]: Name
    } & Type<Variants[Name]>
  }[keyof Variants & string]
  type KeyedVariant<Name extends PropertyKey, A, Tag extends PropertyKey, Variants> = {
    readonly [Key in Name]: A
  } & Variant<Tag, Variants>

  export interface Struct<StructFields extends Fields> extends Field<Value<StructFields>> {
    readonly type: "struct"
    readonly fields: StructFields
  }

  export interface Union<
    Tag extends PropertyKey,
    Variants extends Readonly<Record<string, Field<unknown>>>,
  > extends Field<Variant<Tag, Variants>> {
    readonly type: "union"
    readonly tag: Tag
    readonly variants: Variants
  }

  export interface KeyedUnion<
    Name extends PropertyKey,
    A,
    Tag extends PropertyKey,
    Variants extends Readonly<Record<string, Field<unknown>>>,
  > extends Field<KeyedVariant<Name, A, Tag, Variants>> {
    readonly type: "keyed-union"
    readonly key: NamedKey<Name, A>
    readonly tag: Tag
    readonly variants: Variants
  }

  export interface Plan<A, Key> {
    readonly key: PropertyKey
    readonly fields?: Fields
    readonly equivalent: (left: A, right: A) => boolean
    /** Bitmask of changed top-level fields; 0 means equivalent. Consistent with `equivalent`. */
    readonly diff: (left: A, right: A) => number
    /** Every known top-level property name to its change bit; immutable and key names map to 0. */
    readonly bits: ReadonlyMap<PropertyKey, number>
    readonly keyOf: (value: A) => Key
    make(initial?: readonly A[], options?: { readonly metrics?: Keyed.Metrics }): Keyed.Keyed<A, Key>
  }

  type IndexField<A> = A extends unknown ? keyof A : never

  export interface MembersIndex<A, Member> {
    readonly type: "members"
    readonly fields?: readonly IndexField<A>[]
    readonly extract: (value: A) => Iterable<Member>
  }

  export interface FirstIndex<A> {
    readonly type: "first"
    readonly fields?: readonly IndexField<A>[]
    readonly matches: (value: A) => boolean
  }

  export type Index<A> = MembersIndex<A, unknown> | FirstIndex<A>
  type Indexes<A> = Readonly<Record<PropertyKey, Index<A>>>
  type MembersNames<Definitions> = {
    readonly [Name in keyof Definitions]: Definitions[Name] extends {
      readonly type: "members"
    }
      ? Name
      : never
  }[keyof Definitions]
  type FirstNames<Definitions> = {
    readonly [Name in keyof Definitions]: Definitions[Name] extends {
      readonly type: "first"
    }
      ? Name
      : never
  }[keyof Definitions]
  type Member<Definition> = Definition extends {
    readonly extract: (value: never) => Iterable<infer A>
  }
    ? A
    : never
  type MemberChanges<Definitions> = {
    readonly [Name in MembersNames<Definitions>]?: {
      readonly add?: readonly Member<Definitions[Name]>[]
      readonly remove?: readonly Member<Definitions[Name]>[]
    }
  }

  /**
   * Comparator backend. "generated" (the default) compiles one specialized
   * Function per plan operation; "closure" is the compatibility fallback for
   * environments that forbid runtime code generation (CSP).
   */
  export interface CompileOptions {
    readonly backend?: "closure" | "generated"
  }

  export interface IndexBuilder<A> {
    members<Member>(extract: (value: A) => Iterable<Member>): MembersIndex<A, Member>
    members<Member>(fields: readonly IndexField<A>[], extract: (value: A) => Iterable<Member>): MembersIndex<A, Member>
    first(matches: (value: A) => boolean): FirstIndex<A>
    first(fields: readonly IndexField<A>[], matches: (value: A) => boolean): FirstIndex<A>
  }

  export interface Collection<A, Key, Definitions extends Indexes<A>> extends Keyed.Keyed<A, Key> {
    modify(key: Key, f: (value: A) => A, changes?: { readonly members?: MemberChanges<Definitions> }): boolean
    hasMember<Name extends MembersNames<Definitions>>(name: Name, member: Member<Definitions[Name]>): boolean
    first<Name extends FirstNames<Definitions>>(name: Name): Readable<A> | undefined
  }

  export interface CollectionPlan<A, Key, Definitions extends Indexes<A>> extends Plan<A, Key> {
    make(initial?: readonly A[], options?: { readonly metrics?: Keyed.Metrics }): Collection<A, Key, Definitions>
  }

  export const string: Field<string> = primitive()
  export const number: Field<number> = primitive()
  export const boolean: Field<boolean> = primitive()

  interface ArrayField<A> extends Field<readonly A[]> {
    readonly type: "array"
    readonly item: Field<A>
  }

  export function array<A>(item: Field<A>): Field<readonly A[]> {
    const field: ArrayField<A> = {
      type: "array",
      item,
      equivalent(left, right) {
        if (left === right) return true
        if (left.length !== right.length) return false
        for (let index = 0; index < left.length; index++) {
          if (!item.equivalent(left[index], right[index])) return false
        }
        return true
      },
    }
    return field
  }

  export function immutable<A>(field: Field<A>): Field<A> {
    return { ...field, immutable: true, equivalent: () => true }
  }

  export function key<A>(field: Field<A>): KeyField<A>
  export function key<const Name extends PropertyKey, A>(name: Name, field: Field<A>): NamedKey<Name, A>
  export function key<A>(name: Field<A> | PropertyKey, field?: Field<A>): KeyField<A> | NamedKey<PropertyKey, A> {
    if (field) return { name: name as PropertyKey, field }
    return { ...(name as Field<A>), isKey: true }
  }

  export function struct<const StructFields extends Fields>(fields: StructFields): Struct<StructFields> {
    return {
      type: "struct",
      fields,
      equivalent: compileFields<Value<StructFields>>(fields),
    }
  }

  export function union<
    const Tag extends PropertyKey,
    const Variants extends Readonly<Record<string, Field<unknown>>>,
  >(options: { readonly tag: Tag; readonly variants: Variants }): Union<Tag, Variants> {
    const equivalent = compileUnion<Tag, Variants>(options.tag, options.variants)
    return { type: "union", ...options, equivalent }
  }

  export function keyedUnion<
    const Name extends PropertyKey,
    A,
    const Tag extends PropertyKey,
    const Variants extends Readonly<Record<string, Field<unknown>>>,
  >(options: {
    readonly key: NamedKey<Name, A>
    readonly tag: Tag
    readonly variants: Variants
  }): KeyedUnion<Name, A, Tag, Variants> {
    const equivalentVariant = compileUnion<Tag, Variants>(options.tag, options.variants)
    const key = (value: KeyedVariant<Name, A, Tag, Variants>) => value[options.key.name]
    const equivalent = (left: KeyedVariant<Name, A, Tag, Variants>, right: KeyedVariant<Name, A, Tag, Variants>) =>
      options.key.field.equivalent(key(left), key(right)) && equivalentVariant(left, right)
    return { type: "keyed-union", ...options, equivalent }
  }

  export function compile<const StructFields extends Fields>(
    layout: Struct<StructFields>,
    options?: CompileOptions,
  ): Plan<Value<StructFields>, Value<StructFields>[KeyName<StructFields>]>
  export function compile<
    const Name extends PropertyKey,
    A,
    const Tag extends PropertyKey,
    const Variants extends Readonly<Record<string, Field<unknown>>>,
  >(layout: KeyedUnion<Name, A, Tag, Variants>, options?: CompileOptions): Plan<KeyedVariant<Name, A, Tag, Variants>, A>
  export function compile(input: unknown, options: CompileOptions = {}): unknown {
    const layout = input as
      Struct<Fields> | KeyedUnion<PropertyKey, unknown, PropertyKey, Readonly<Record<string, Field<unknown>>>>
    if (layout.type === "keyed-union") {
      const model = unionDiffModel(layout.key.name, layout.tag, layout.variants)
      return makePlan(
        layout.key.name,
        (value: unknown) => (value as Record<PropertyKey, unknown>)[layout.key.name],
        (options.backend !== "closure"
          ? generateUnion(layout.tag, layout.variants)
          : compileUnion(layout.tag, layout.variants)) as (left: unknown, right: unknown) => boolean,
        options.backend !== "closure"
          ? generateUnionDiff(layout.tag, layout.variants, model)
          : compileUnionDiff(layout.tag, layout.variants, model),
        model.bits,
      )
    }

    const keys = Reflect.ownKeys(layout.fields).filter((name) => layout.fields[name].isKey)
    if (keys.length !== 1) throw new Error("Keyed layout must declare exactly one key field")
    const key = keys[0]
    const fields = Reflect.ownKeys(layout.fields)
      .filter((name) => name !== key && !layout.fields[name].immutable)
      .map((name, index) => ({ name, field: layout.fields[name], bit: 1 << Math.min(index, 30) }))
    const bits = new Map<PropertyKey, number>()
    Reflect.ownKeys(layout.fields).forEach((name) => bits.set(name, 0))
    fields.forEach((field) => bits.set(field.name, field.bit))
    const equivalent =
      options.backend !== "closure" ? generateEquivalent<unknown>(fields) : compileEquivalent<unknown>(fields)
    const diff = options.backend !== "closure" ? generateDiff<unknown>(fields) : compileDiff<unknown>(fields)
    return {
      fields: layout.fields,
      ...makePlan(key, (value: unknown) => (value as Record<PropertyKey, unknown>)[key], equivalent, diff, bits),
    }
  }

  export function collection<const StructFields extends Fields, const Definitions extends Indexes<Value<StructFields>>>(
    layout: Struct<StructFields>,
    define: (index: IndexBuilder<Value<StructFields>>) => Definitions,
    options?: CompileOptions,
  ): CollectionPlan<Value<StructFields>, Value<StructFields>[KeyName<StructFields>], Definitions>
  export function collection<
    const Name extends PropertyKey,
    A,
    const Tag extends PropertyKey,
    const Variants extends Readonly<Record<string, Field<unknown>>>,
    const Definitions extends Indexes<KeyedVariant<Name, A, Tag, Variants>>,
  >(
    layout: KeyedUnion<Name, A, Tag, Variants>,
    define: (index: IndexBuilder<KeyedVariant<Name, A, Tag, Variants>>) => Definitions,
    options?: CompileOptions,
  ): CollectionPlan<KeyedVariant<Name, A, Tag, Variants>, A, Definitions>
  export function collection(input: unknown, define: unknown, options?: CompileOptions): unknown {
    const plan = compile(input as never, options) as Plan<unknown, unknown>
    const definitions = (define as (index: IndexBuilder<unknown>) => Indexes<unknown>)({
      members: ((fieldsOrExtract: readonly PropertyKey[] | ((value: unknown) => Iterable<unknown>), extract?: (value: unknown) => Iterable<unknown>) =>
        typeof fieldsOrExtract === "function"
          ? { type: "members", extract: fieldsOrExtract }
          : { type: "members", fields: fieldsOrExtract, extract: extract! }) as IndexBuilder<unknown>["members"],
      first: ((fieldsOrMatches: readonly PropertyKey[] | ((value: unknown) => boolean), matches?: (value: unknown) => boolean) =>
        typeof fieldsOrMatches === "function"
          ? { type: "first", matches: fieldsOrMatches }
          : { type: "first", fields: fieldsOrMatches, matches: matches! }) as IndexBuilder<unknown>["first"],
    })
    return {
      ...plan,
      make(initial: readonly unknown[] = [], makeOptions?: { readonly metrics?: Keyed.Metrics }) {
        return makeCollection(plan, definitions, initial, makeOptions)
      },
    }
  }

  function makePlan<A, Key>(
    key: PropertyKey,
    getKey: (value: A) => Key,
    equivalent: (left: A, right: A) => boolean,
    diff: (left: A, right: A) => number,
    bits: ReadonlyMap<PropertyKey, number>,
  ) {
    return {
      key,
      equivalent,
      diff,
      bits,
      keyOf: getKey,
      make(initial: readonly A[] = [], options?: { readonly metrics?: Keyed.Metrics }) {
        const values = Keyed.make({
          key: getKey,
          equivalent,
          metrics: options?.metrics,
        })
        values.set(initial)
        return values
      },
    }
  }

  function makeCollection<A, Key, Definitions extends Indexes<A>>(
    plan: Plan<A, Key>,
    definitions: Definitions,
    initial: readonly A[],
    options?: { readonly metrics?: Keyed.Metrics },
  ): Collection<A, Key, Definitions> {
    // `pending` hands a diff the collection already computed for a staged
    // mutation to the comparator, so equivalence costs one comparison, not two.
    let pending: { readonly previous: A; readonly next: A; readonly mask: number } | undefined
    const values = Keyed.make<A, Key>({
      key: plan.keyOf,
      equivalent(left, right) {
        if (pending && pending.previous === left && pending.next === right) {
          const mask = pending.mask
          pending = undefined
          return mask === 0
        }
        return plan.diff(left, right) === 0
      },
      metrics: options?.metrics,
    })

    function dependencyMask(fields: readonly PropertyKey[] | undefined) {
      return fields?.reduce<number>((mask, field) => mask | (plan.bits.get(normalizeName(field)) ?? -1), 0) ?? -1
    }

    // Each index entry stages user-code projections before any state mutation
    // (a throwing callback must not desynchronize values and indexes) and
    // returns a commit applied after publication succeeds.
    type Commit = (slot: Readable<A>) => void
    type MemberChange = { readonly add?: readonly unknown[]; readonly remove?: readonly unknown[] }
    interface Entry {
      readonly name: PropertyKey
      readonly reads: number
      stage(key: Key, value: A, mode: "add" | "replace"): Commit
      applyDelta?(key: Key, change: MemberChange): void
      remove(key: Key, slot?: Readable<A>): void
      afterPlacement?(slot: Readable<A>): void
      afterRebuild?(): void
      member?(candidate: unknown): boolean
      firstSlot?(): Readable<A> | undefined
    }

    function membersEntry(
      name: PropertyKey,
      fields: readonly PropertyKey[] | undefined,
      extract: (value: A) => Iterable<unknown>,
    ): Entry {
      const counts = new Map<unknown, number>()
      const byKey = new Map<Key, { readonly source: Iterable<unknown>; readonly members: Set<unknown> }>()

      function adjust(member: unknown, amount: 1 | -1) {
        const count = (counts.get(member) ?? 0) + amount
        if (count === 0) {
          counts.delete(member)
          return
        }
        counts.set(member, count)
      }

      return {
        name,
        reads: dependencyMask(fields),
        stage(key, value) {
          const previous = byKey.get(key)
          const source = extract(value)
          const members = source === previous?.source ? previous.members : new Set(source)
          return () => {
            if (!previous) members.forEach((member) => adjust(member, 1))
            if (previous && previous.members !== members) {
              members.forEach((member) => !previous.members.has(member) && adjust(member, 1))
              previous.members.forEach((member) => !members.has(member) && adjust(member, -1))
            }
            byKey.set(key, { source, members })
          }
        },
        applyDelta(key, change) {
          const members = byKey.get(key)!.members
          change.remove?.forEach((member) => {
            if (members.delete(member)) adjust(member, -1)
          })
          change.add?.forEach((member) => {
            if (members.has(member)) return
            members.add(member)
            adjust(member, 1)
          })
          // The set was mutated in place, so poison the source-identity check.
          byKey.set(key, { source: members, members })
        },
        remove(key) {
          byKey.get(key)?.members.forEach((member) => adjust(member, -1))
          byKey.delete(key)
        },
        member: (candidate) => counts.has(candidate),
      }
    }

    function firstEntry(
      name: PropertyKey,
      fields: readonly PropertyKey[] | undefined,
      matches: (value: A) => boolean,
    ): Entry {
      const matching = new Set<Key>()
      let slot: Readable<A> | undefined

      function findFirst() {
        slot = values.slots().find((candidate) => matching.has(plan.keyOf(candidate())))
      }

      function afterPlacement(candidate: Readable<A>) {
        if (!matching.has(plan.keyOf(candidate()))) return
        if (!slot) {
          slot = candidate
          return
        }
        if (slot === candidate) {
          findFirst()
          return
        }
        // Single pass: whichever of the two slots appears first wins.
        for (const current of values.slots()) {
          if (current === candidate) {
            slot = candidate
            return
          }
          if (current === slot) return
        }
      }

      return {
        name,
        reads: dependencyMask(fields),
        stage(key, value, mode) {
          const matched = matches(value)
          return (valueSlot) => {
            const previous = matching.has(key)
            if (matched) matching.add(key)
            if (!matched) matching.delete(key)
            if (mode === "add") return
            if (slot === valueSlot && !matched) {
              findFirst()
              return
            }
            if (slot !== valueSlot && !previous && matched) afterPlacement(valueSlot)
          }
        },
        remove(key, removedSlot) {
          matching.delete(key)
          if (removedSlot && slot === removedSlot) findFirst()
        },
        afterPlacement,
        afterRebuild: findFirst,
        firstSlot: () => slot,
      }
    }

    const entries: Entry[] = Reflect.ownKeys(definitions).map((name) => {
      const definition = definitions[name]
      if (definition.type === "members") return membersEntry(name, definition.fields, definition.extract)
      return firstEntry(name, definition.fields, definition.matches)
    })
    const byName = new Map(entries.map((entry) => [entry.name, entry]))

    // Stage refresh work for one changed value: explicit member deltas win,
    // then projections whose declared fields are disjoint from the change are
    // skipped entirely. Returns undefined when no index work is required.
    function stageRefresh(key: Key, value: A, mask: number, changes?: unknown) {
      const record = changes as Readonly<Record<PropertyKey, MemberChange | undefined>> | undefined
      let staged: Commit[] | undefined
      for (const entry of entries) {
        const change = record?.[entry.name]
        if (change && entry.applyDelta) {
          const delta = entry.applyDelta
          ;(staged ??= []).push(() => delta(key, change))
          continue
        }
        if ((mask & entry.reads) === 0) continue
        ;(staged ??= []).push(entry.stage(key, value, "replace"))
      }
      return staged
    }

    function publishStaged(
      previous: A,
      value: A,
      mask: number,
      staged: readonly Commit[] | undefined,
      slot: Readable<A>,
    ) {
      // Indexes are plain data, not reactive state; the transaction exists so
      // subscribers cannot observe published values with stale indexes. With
      // no staged commits there is nothing to observe out of order.
      if (!staged) return publishValue()
      return Transaction.run(() => {
        const changed = publishValue()
        if (changed) staged.forEach((commit) => commit(slot))
        return changed
      })

      function publishValue() {
        pending = { previous, next: value, mask }
        try {
          return values.update(value)
        } finally {
          pending = undefined
        }
      }
    }

    const collection: Collection<A, Key, Definitions> = {
      ...values,
      set(next) {
        const keys = next.map(plan.keyOf)
        const retained = new Set(keys)
        if (retained.size !== keys.length) throw new Error("Keyed values must have unique keys")
        const existing = new Map<Key, A>()
        values.slots().forEach((slot) => {
          const value = slot()
          existing.set(plan.keyOf(value), value)
        })
        // Stage user-code projections for new and changed values only;
        // retained equivalent values keep their index state and reads.
        const staged: Array<{ readonly key: Key; readonly commits: readonly Commit[] }> = []
        next.forEach((value, index) => {
          const key = keys[index]
          if (!existing.has(key)) {
            staged.push({ key, commits: entries.map((entry) => entry.stage(key, value, "add")) })
            return
          }
          const previous = existing.get(key)!
          if (previous === value) return
          const mask = plan.diff(previous, value)
          if (mask === 0) return
          const commits = stageRefresh(key, value, mask)
          if (commits) staged.push({ key, commits })
        })
        const structure = values.slots()
        return Transaction.run(() => {
          const changed = values.set(next)
          if (!changed) return false
          const structural = structure !== values.slots()
          if (structural)
            existing.forEach((_value, key) => {
              if (!retained.has(key)) entries.forEach((entry) => entry.remove(key))
            })
          staged.forEach((item) => {
            const slot = values.get(item.key)!
            item.commits.forEach((commit) => commit(slot))
          })
          if (structural) entries.forEach((entry) => entry.afterRebuild?.())
          return true
        })
      },
      update(value) {
        const key = plan.keyOf(value)
        const slot = values.get(key)
        if (!slot) return false
        const previous = slot()
        if (previous === value) return false
        const mask = plan.diff(previous, value)
        const staged = mask === 0 ? undefined : stageRefresh(key, value, mask)
        return publishStaged(previous, value, mask, staged, slot)
      },
      modify(key, f, changes) {
        const slot = values.get(key)
        if (!slot) return false
        const previous = slot()
        const value = f(previous)
        // Publication below targets the slot for the value's own key, so the
        // modify key-preservation invariant must be enforced here.
        if (values.get(plan.keyOf(value)) !== slot) throw new Error("Keyed modify must preserve the value key")
        if (previous === value) return false
        const mask = plan.diff(previous, value)
        const staged = mask === 0 ? undefined : stageRefresh(key, value, mask, changes?.members)
        return publishStaged(previous, value, mask, staged, slot)
      },
      insert(value, position) {
        const key = plan.keyOf(value)
        if (values.has(key)) throw new Error(`Keyed value already exists: ${String(key)}`)
        requirePosition(position)
        const staged = entries.map((entry) => entry.stage(key, value, "add"))
        return Transaction.run(() => {
          const slot = values.insert(value, position)
          staged.forEach((commit) => commit(slot))
          entries.forEach((entry) => entry.afterPlacement?.(slot))
          return slot
        })
      },
      remove(key) {
        const slot = values.get(key)
        if (!slot) return false
        return Transaction.run(() => {
          const removed = values.remove(key)
          entries.forEach((entry) => entry.remove(key, slot))
          return removed
        })
      },
      move(key, position) {
        const slot = values.get(key)
        if (!slot) return false
        return Transaction.run(() => {
          const moved = values.move(key, position)
          if (moved) entries.forEach((entry) => entry.afterPlacement?.(slot))
          return moved
        })
      },
      hasMember(name, member) {
        return byName.get(normalizeName(name))?.member?.(member) ?? false
      },
      first(name) {
        return byName.get(normalizeName(name))?.firstSlot?.()
      },
    }
    collection.set(initial)
    return collection

    function requirePosition(position?: Keyed.Position<Key>) {
      if (!position || position === "end") return
      const key = "before" in position ? position.before : position.after
      if (!values.has(key)) throw new Error(`Keyed value does not exist: ${String(key)}`)
    }

    function normalizeName(name: PropertyKey) {
      return typeof name === "number" ? String(name) : name
    }
  }

  function primitive<A>(): Field<A> {
    return { primitive: true, equivalent: Object.is }
  }

  function compileUnion<Tag extends PropertyKey, Variants extends Readonly<Record<string, Field<unknown>>>>(
    tag: Tag,
    variants: Variants,
  ) {
    type A = Variant<Tag, Variants>
    return (left: A, right: A) => {
      const name = left[tag]
      if (name !== right[tag] || typeof name !== "string") return false
      const variant = variants[name]
      return variant ? variant.equivalent(left, right) : false
    }
  }

  function compileFields<A>(fields: Fields) {
    return compileEquivalent<A>(
      Reflect.ownKeys(fields)
        .filter((name) => !fields[name].immutable)
        .map((name) => ({ name, field: fields[name] })),
    )
  }

  // Field diff: a bitmask of changed top-level fields, 0 meaning equivalent.
  // Bits are assigned per mutable field name; names beyond 31 share the top
  // bit conservatively. The diff is consistent with `equivalent` by
  // construction: both compare the same fields with the same field comparators.
  type DiffField = { readonly name: PropertyKey; readonly field: Field<unknown>; readonly bit: number }

  function compileDiff<A>(fields: ReadonlyArray<DiffField>) {
    return (left: A, right: A) => {
      const a = left as Record<PropertyKey, unknown>
      const b = right as Record<PropertyKey, unknown>
      let changed = 0
      for (const field of fields) if (!field.field.equivalent(a[field.name], b[field.name])) changed |= field.bit
      return changed
    }
  }

  function generateDiff<A>(fields: ReadonlyArray<DiffField>) {
    if (fields.some((field) => typeof field.name === "symbol")) return compileDiff<A>(fields)
    const emitter: Emitter = { custom: [], declarations: [], names: new Map() }
    const statements = fields.map((field) => {
      const property = JSON.stringify(String(field.name))
      return `if (!(${expression(emitter, field.field, `left[${property}]`, `right[${property}]`)})) changed |= ${field.bit}`
    })
    const factory = Function(
      "custom",
      `${emitter.declarations.join("\n")}\nreturn (left, right) => { let changed = 0\n${statements.join("\n")}\nreturn changed }`,
    ) as (custom: ReadonlyArray<Field<unknown>>) => (left: A, right: A) => number
    return factory(emitter.custom)
  }

  type UnionDiffModel = {
    readonly bits: ReadonlyMap<PropertyKey, number>
    readonly perVariant: ReadonlyMap<string, ReadonlyArray<DiffField> | undefined>
  }

  function unionDiffModel(
    keyName: PropertyKey,
    tag: PropertyKey,
    variants: Readonly<Record<string, Field<unknown>>>,
  ): UnionDiffModel {
    const bits = new Map<PropertyKey, number>()
    bits.set(tag, 1)
    bits.set(keyName, 0)
    const assigned = new Map<PropertyKey, number>()
    const perVariant = new Map<string, ReadonlyArray<DiffField> | undefined>()
    let count = 0
    for (const variantName of Object.keys(variants)) {
      const variant = variants[variantName] as Field<unknown> & { readonly type?: string; readonly fields?: Fields }
      if (variant.type !== "struct") {
        perVariant.set(variantName, undefined)
        continue
      }
      const fields: DiffField[] = []
      for (const name of Reflect.ownKeys(variant.fields!)) {
        const field = variant.fields![name]
        if (field.immutable) {
          if (!assigned.has(name) && !bits.has(name)) bits.set(name, 0)
          continue
        }
        const bit = assigned.get(name) ?? 1 << Math.min(count++ + 1, 30)
        assigned.set(name, bit)
        bits.set(name, bit)
        fields.push({ name, field, bit })
      }
      perVariant.set(variantName, fields)
    }
    return { bits, perVariant }
  }

  function compileUnionDiff(
    tag: PropertyKey,
    variants: Readonly<Record<string, Field<unknown>>>,
    model: UnionDiffModel,
  ) {
    return (left: unknown, right: unknown) => {
      const a = left as Record<PropertyKey, unknown>
      const b = right as Record<PropertyKey, unknown>
      const name = a[tag]
      if (name !== b[tag] || typeof name !== "string") return -1
      const fields = model.perVariant.get(name)
      if (!fields) {
        const variant = variants[name]
        return variant && variant.equivalent(left, right) ? 0 : -1
      }
      let changed = 0
      for (const field of fields) if (!field.field.equivalent(a[field.name], b[field.name])) changed |= field.bit
      return changed
    }
  }

  function generateUnionDiff(
    tag: PropertyKey,
    variants: Readonly<Record<string, Field<unknown>>>,
    model: UnionDiffModel,
  ) {
    const symbols = [...model.perVariant.values()].some((fields) =>
      fields?.some((field) => typeof field.name === "symbol"),
    )
    if (typeof tag === "symbol" || symbols) return compileUnionDiff(tag, variants, model)
    const emitter: Emitter = { custom: [], declarations: [], names: new Map() }
    const property = JSON.stringify(String(tag))
    const cases = Object.keys(variants).map((name) => {
      const label = JSON.stringify(name)
      const fields = model.perVariant.get(name)
      if (!fields) {
        const variant = variants[name]
        const index = emitter.custom.push(variant) - 1
        return `case ${label}: return custom[${index}].equivalent(left, right) ? 0 : -1`
      }
      const statements = fields.map((field) => {
        const fieldProperty = JSON.stringify(String(field.name))
        return `if (!(${expression(emitter, field.field, `left[${fieldProperty}]`, `right[${fieldProperty}]`)})) changed |= ${field.bit}`
      })
      return `case ${label}: { let changed = 0\n${statements.join("\n")}\nreturn changed }`
    })
    const factory = Function(
      "custom",
      `${emitter.declarations.join("\n")}\nreturn (left, right) => { if (left[${property}] !== right[${property}]) return -1; switch (left[${property}]) { ${cases.join("\n")}\ndefault: return -1 } }`,
    ) as (custom: ReadonlyArray<Field<unknown>>) => (left: unknown, right: unknown) => number
    return factory(emitter.custom)
  }

  // Whole-tree generation: one Function() per plan operation whose source
  // inlines struct comparisons, emits real loops for arrays, and hoists unions
  // into named inner functions the engine can inline. User-supplied equivalence
  // functions remain indirect calls through the `custom` array; everything
  // structural compiles to direct code with no interior closure boundaries.
  type Emitter = {
    readonly custom: Field<unknown>[]
    readonly declarations: string[]
    readonly names: Map<unknown, string>
  }

  function generateEquivalent<A>(
    fields: ReadonlyArray<{
      readonly name: PropertyKey
      readonly field: Field<unknown>
    }>,
  ) {
    // Symbol names cannot appear in generated source; degrade to the closure backend.
    if (fields.some((field) => typeof field.name === "symbol")) return compileEquivalent<A>(fields)
    const emitter: Emitter = { custom: [], declarations: [], names: new Map() }
    const comparisons = fields
      .map((field) => {
        const property = JSON.stringify(String(field.name))
        return expression(emitter, field.field, `left[${property}]`, `right[${property}]`)
      })
      .filter((comparison) => comparison !== "true")
    return assemble<A>(emitter, comparisons.join(" && ") || "true")
  }

  function generateUnion<Tag extends PropertyKey, Variants extends Readonly<Record<string, Field<unknown>>>>(
    tag: Tag,
    variants: Variants,
  ) {
    if (typeof tag === "symbol") return compileUnion(tag, variants)
    const emitter: Emitter = { custom: [], declarations: [], names: new Map() }
    const root = declareUnion(emitter, { tag, variants }, tag, variants)
    return assemble<Variant<Tag, Variants>>(emitter, `${root}(left, right)`)
  }

  function assemble<A>(emitter: Emitter, body: string) {
    const factory = Function("custom", `${emitter.declarations.join("\n")}\nreturn (left, right) => ${body}`) as (
      custom: ReadonlyArray<Field<unknown>>,
    ) => (left: A, right: A) => boolean
    return factory(emitter.custom)
  }

  function expression(emitter: Emitter, field: Field<unknown>, left: string, right: string): string {
    if (field.immutable) return "true"
    if (field.primitive && field.equivalent === Object.is) return `Object.is(${left}, ${right})`
    const layout = field as Field<unknown> & {
      readonly type?: "struct" | "union" | "keyed-union" | "array"
      readonly fields?: Fields
      readonly item?: Field<unknown>
      readonly tag?: PropertyKey
      readonly variants?: Readonly<Record<string, Field<unknown>>>
      readonly key?: NamedKey<PropertyKey, unknown>
    }
    if (layout.type === "struct" && Reflect.ownKeys(layout.fields!).every((name) => typeof name !== "symbol")) {
      const comparisons = Reflect.ownKeys(layout.fields!)
        .filter((name) => !layout.fields![name].immutable)
        .map((name) => {
          const property = JSON.stringify(String(name))
          return expression(emitter, layout.fields![name], `${left}[${property}]`, `${right}[${property}]`)
        })
        .filter((comparison) => comparison !== "true")
      if (comparisons.length === 0) return "true"
      // Shared-reference fast path: immutable updates reuse untouched sub-objects.
      return `(${left} === ${right} || (${comparisons.join(" && ")}))`
    }
    if (layout.type === "array") {
      const name = declare(emitter, layout, (fn) => {
        const item = expression(emitter, layout.item!, "l[i]", "r[i]")
        return `function ${fn}(l, r) { if (l === r) return true; if (l.length !== r.length) return false; for (let i = 0; i < l.length; i++) if (!(${item})) return false; return true }`
      })
      return `${name}(${left}, ${right})`
    }
    if (layout.type === "union" && typeof layout.tag !== "symbol") {
      return `${declareUnion(emitter, layout, layout.tag!, layout.variants!)}(${left}, ${right})`
    }
    if (layout.type === "keyed-union" && typeof layout.tag !== "symbol" && typeof layout.key!.name !== "symbol") {
      const name = declare(emitter, layout, (fn) => {
        const property = JSON.stringify(String(layout.key!.name))
        const key = expression(emitter, layout.key!.field, `l[${property}]`, `r[${property}]`)
        const union = declareUnion(emitter, {}, layout.tag!, layout.variants!)
        return `function ${fn}(l, r) { return ${key === "true" ? "" : `${key} && `}${union}(l, r) }`
      })
      return `${name}(${left}, ${right})`
    }
    const index = emitter.custom.push(field) - 1
    return `custom[${index}].equivalent(${left}, ${right})`
  }

  function declareUnion(
    emitter: Emitter,
    identity: unknown,
    tag: PropertyKey,
    variants: Readonly<Record<string, Field<unknown>>>,
  ) {
    return declare(emitter, identity, (fn) => {
      const property = JSON.stringify(String(tag))
      const cases = Object.keys(variants)
        .map((name) => `case ${JSON.stringify(name)}: return ${expression(emitter, variants[name], "l", "r")}`)
        .join("; ")
      return `function ${fn}(l, r) { if (l[${property}] !== r[${property}]) return false; switch (l[${property}]) { ${cases}; default: return false } }`
    })
  }

  function declare(emitter: Emitter, identity: unknown, build: (name: string) => string) {
    const existing = emitter.names.get(identity)
    if (existing) return existing
    const name = `q${emitter.names.size}`
    emitter.names.set(identity, name)
    // Reserve declaration order before build runs: build may recurse into
    // declare for nested layouts, and the reserved slot keeps this function
    // textually before its dependents without infinite recursion.
    const index = emitter.declarations.push("") - 1
    emitter.declarations[index] = build(name)
    return name
  }

  // Compatibility comparator for the closure backend: a simple monomorphic
  // loop. The generated backend is the performance path.
  function compileEquivalent<A>(
    fields: ReadonlyArray<{
      readonly name: PropertyKey
      readonly field: Field<unknown>
    }>,
  ) {
    if (fields.length === 0) return (_left: A, _right: A) => true
    return (left: A, right: A) => {
      const a = left as Record<PropertyKey, unknown>
      const b = right as Record<PropertyKey, unknown>
      for (const field of fields) if (!field.field.equivalent(a[field.name], b[field.name])) return false
      return true
    }
  }
}
