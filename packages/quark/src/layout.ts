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
  type Value<StructFields> = { readonly [Key in keyof StructFields]: Type<StructFields[Key]> }
  type KeyName<StructFields> = {
    readonly [Key in keyof StructFields]: StructFields[Key] extends KeyField<unknown> ? Key : never
  }[keyof StructFields]
  type Variant<Tag extends PropertyKey, Variants> = {
    readonly [Name in keyof Variants & string]: { readonly [Key in Tag]: Name } & Type<Variants[Name]>
  }[keyof Variants & string]
  type KeyedVariant<Name extends PropertyKey, A, Tag extends PropertyKey, Variants> = {
    readonly [Key in Name]: A
  } & Variant<Tag, Variants>

  export interface Struct<StructFields extends Fields> extends Field<Value<StructFields>> {
    readonly type: "struct"
    readonly fields: StructFields
  }

  export interface Union<Tag extends PropertyKey, Variants extends Readonly<Record<string, Field<unknown>>>>
    extends Field<Variant<Tag, Variants>> {
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
    readonly keyOf: (value: A) => Key
    make(initial?: readonly A[], options?: { readonly metrics?: Keyed.Metrics }): Keyed.Keyed<A, Key>
  }

  export interface MembersIndex<A, Member> {
    readonly type: "members"
    readonly extract: (value: A) => Iterable<Member>
  }

  export interface FirstIndex<A> {
    readonly type: "first"
    readonly matches: (value: A) => boolean
  }

  export type Index<A> = MembersIndex<A, unknown> | FirstIndex<A>
  type Indexes<A> = Readonly<Record<PropertyKey, Index<A>>>
  type MembersNames<Definitions> = {
    readonly [Name in keyof Definitions]: Definitions[Name] extends { readonly type: "members" } ? Name : never
  }[keyof Definitions]
  type FirstNames<Definitions> = {
    readonly [Name in keyof Definitions]: Definitions[Name] extends { readonly type: "first" } ? Name : never
  }[keyof Definitions]
  type Member<Definition> = Definition extends { readonly extract: (value: never) => Iterable<infer A> } ? A : never
  type MemberChanges<Definitions> = {
    readonly [Name in MembersNames<Definitions>]?: {
      readonly add?: readonly Member<Definitions[Name]>[]
      readonly remove?: readonly Member<Definitions[Name]>[]
    }
  }

  export interface IndexBuilder<A> {
    members<Member>(extract: (value: A) => Iterable<Member>): MembersIndex<A, Member>
    first(matches: (value: A) => boolean): FirstIndex<A>
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

  export function array<A>(item: Field<A>): Field<readonly A[]> {
    return make((left, right) => {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index++) {
        if (!item.equivalent(left[index], right[index])) return false
      }
      return true
    })
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
    options?: { readonly backend?: "closure" | "generated" },
  ): Plan<Value<StructFields>, Value<StructFields>[KeyName<StructFields>]>
  export function compile<
    const Name extends PropertyKey,
    A,
    const Tag extends PropertyKey,
    const Variants extends Readonly<Record<string, Field<unknown>>>,
  >(
    layout: KeyedUnion<Name, A, Tag, Variants>,
    options?: { readonly backend?: "closure" | "generated" },
  ): Plan<KeyedVariant<Name, A, Tag, Variants>, A>
  export function compile(input: unknown, options: { readonly backend?: "closure" | "generated" } = {}): unknown {
    const layout = input as
      | Struct<Fields>
      | KeyedUnion<PropertyKey, unknown, PropertyKey, Readonly<Record<string, Field<unknown>>>>
    if (layout.type === "keyed-union") {
      return makePlan(
        layout.key.name,
        (value: unknown) => (value as Record<PropertyKey, unknown>)[layout.key.name],
        (options.backend === "generated"
          ? generateUnion(layout.tag, layout.variants)
          : compileUnion(layout.tag, layout.variants)) as (left: unknown, right: unknown) => boolean,
      )
    }

    const keys = Reflect.ownKeys(layout.fields).filter((name) => layout.fields[name].isKey)
    if (keys.length !== 1) throw new Error("Keyed layout must declare exactly one key field")
    const key = keys[0]
    const fields = Reflect.ownKeys(layout.fields)
      .filter((name) => name !== key && !layout.fields[name].immutable)
      .map((name) => ({ name, field: layout.fields[name] }))
    const equivalent =
      options.backend === "generated"
        ? generateEquivalent<unknown>(generated(fields))
        : compileEquivalent<unknown>(fields)
    return {
      fields: layout.fields,
      ...makePlan(key, (value: unknown) => (value as Record<PropertyKey, unknown>)[key], equivalent),
    }
  }

  export function collection<const StructFields extends Fields, const Definitions extends Indexes<Value<StructFields>>>(
    layout: Struct<StructFields>,
    define: (index: IndexBuilder<Value<StructFields>>) => Definitions,
    options?: { readonly backend?: "closure" | "generated" },
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
    options?: { readonly backend?: "closure" | "generated" },
  ): CollectionPlan<KeyedVariant<Name, A, Tag, Variants>, A, Definitions>
  export function collection(
    input: unknown,
    define: unknown,
    options?: { readonly backend?: "closure" | "generated" },
  ): unknown {
    const plan = compile(input as never, options) as Plan<unknown, unknown>
    const definitions = (define as (index: IndexBuilder<unknown>) => Indexes<unknown>)({
      members: (extract) => ({ type: "members", extract }),
      first: (matches) => ({ type: "first", matches }),
    })
    return {
      ...plan,
      make(initial: readonly unknown[] = [], makeOptions?: { readonly metrics?: Keyed.Metrics }) {
        return makeCollection(plan, definitions, initial, makeOptions)
      },
    }
  }

  function makePlan<A, Key>(key: PropertyKey, getKey: (value: A) => Key, equivalent: (left: A, right: A) => boolean) {
    return {
      key,
      equivalent,
      keyOf: getKey,
      make(initial: readonly A[] = [], options?: { readonly metrics?: Keyed.Metrics }) {
        const values = Keyed.make({ key: getKey, equivalent, metrics: options?.metrics })
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
    const values = plan.make([], options)
    type MemberEntry = {
      readonly type: "members"
      readonly name: PropertyKey
      readonly extract: (value: A) => Iterable<unknown>
      readonly counts: Map<unknown, number>
      readonly byKey: Map<Key, { readonly source: Iterable<unknown>; readonly members: Set<unknown> }>
    }
    type FirstEntry = {
      readonly type: "first"
      readonly name: PropertyKey
      readonly matches: (value: A) => boolean
      readonly matching: Set<Key>
      slot?: Readable<A>
    }
    type Entry = MemberEntry | FirstEntry
    type Inspection =
      | {
          readonly type: "members"
          readonly value: { readonly source: Iterable<unknown>; readonly members: Set<unknown> }
        }
      | { readonly type: "members-change"; readonly add: readonly unknown[]; readonly remove: readonly unknown[] }
      | { readonly type: "first"; readonly value: boolean }
    const entries: Entry[] = Reflect.ownKeys(definitions).map((name) => {
      const definition = definitions[name]
      if (definition.type === "members") {
        return { type: "members", name, extract: definition.extract, counts: new Map(), byKey: new Map() }
      }
      return { type: "first", name, matches: definition.matches, matching: new Set() }
    })
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    const emptyMembers: readonly unknown[] = []

    const collection: Collection<A, Key, Definitions> = {
      ...values,
      set(next) {
        const keys = next.map(plan.keyOf)
        if (new Set(keys).size !== keys.length) return values.set(next)
        const prepared = new Map(
          next.map((value, index) => {
            const key = keys[index]
            const previous = values.get(key)?.()
            return [key, previous && plan.equivalent(previous, value) ? current(key) : inspect(value, key)]
          }),
        )
        return Transaction.run(() => {
          const changed = values.set(next)
          if (!changed) return false
          entries.forEach(clear)
          values.slots().forEach((slot) => {
            const key = plan.keyOf(slot())
            const inspection = prepared.get(key)!
            entries.forEach((entry, index) => add(entry, key, slot, inspection[index]))
          })
          entries.forEach((entry) => entry.type === "first" && findFirst(entry))
          return true
        })
      },
      update(value) {
        const key = plan.keyOf(value)
        const slot = values.get(key)
        if (!slot) throw new Error(`Keyed value does not exist: ${String(key)}`)
        const inspection = inspect(value, key)
        return Transaction.run(() => {
          const changed = values.update(value)
          if (changed) entries.forEach((entry, index) => replace(entry, key, slot, inspection[index]))
          return changed
        })
      },
      modify(key, f, changes) {
        const slot = values.get(key)
        if (!slot) throw new Error(`Keyed value does not exist: ${String(key)}`)
        let inspection: readonly Inspection[] | undefined
        return Transaction.run(() => {
          const changed = values.modify(key, (previous) => {
            const value = f(previous)
            if (values.get(plan.keyOf(value)) !== slot) throw new Error("Keyed modify must preserve the value key")
            inspection = inspect(value, key, changes?.members)
            return value
          })
          if (changed) entries.forEach((entry, index) => replace(entry, key, slot, inspection![index]))
          return changed
        })
      },
      insert(value, position) {
        const key = plan.keyOf(value)
        if (values.has(key)) return values.insert(value, position)
        requirePosition(position)
        const inspection = inspect(value, key)
        return Transaction.run(() => {
          const slot = values.insert(value, position)
          entries.forEach((entry, index) => add(entry, key, slot, inspection[index]))
          entries.forEach((entry) => entry.type === "first" && updateFirstAfterPlacement(entry, slot))
          return slot
        })
      },
      remove(key) {
        const slot = values.get(key)
        if (!slot) return false
        return Transaction.run(() => {
          const removed = values.remove(key)
          entries.forEach((entry) => remove(entry, key))
          entries.forEach((entry) => entry.type === "first" && entry.slot === slot && findFirst(entry))
          return removed
        })
      },
      move(key, position) {
        const slot = values.get(key)
        if (!slot) throw new Error(`Keyed value does not exist: ${String(key)}`)
        return Transaction.run(() => {
          const moved = values.move(key, position)
          if (moved) entries.forEach((entry) => entry.type === "first" && updateFirstAfterPlacement(entry, slot))
          return moved
        })
      },
      hasMember(name, member) {
        const entry = byName.get(normalizeName(name))
        return entry?.type === "members" && entry.counts.has(member)
      },
      first(name) {
        const entry = byName.get(normalizeName(name))
        return entry?.type === "first" ? entry.slot : undefined
      },
    }
    collection.set(initial)
    return collection

    function inspect(value: A, key: Key, changes?: Readonly<Record<PropertyKey, unknown>>): readonly Inspection[] {
      return entries.map((entry) =>
        entry.type === "members"
          ? (() => {
              const change = changes?.[entry.name] as
                | { readonly add?: readonly unknown[]; readonly remove?: readonly unknown[] }
                | undefined
              if (change)
                return {
                  type: "members-change" as const,
                  add: change.add ?? emptyMembers,
                  remove: change.remove ?? emptyMembers,
                }
              const source = entry.extract(value)
              const previous = entry.byKey.get(key)
              return {
                type: "members" as const,
                value: { source, members: source === previous?.source ? previous.members : new Set(source) },
              }
            })()
          : { type: "first", value: entry.matches(value) },
      )
    }

    function current(key: Key): readonly Inspection[] {
      return entries.map((entry) => {
        if (entry.type === "members") return { type: "members", value: entry.byKey.get(key)! }
        return { type: "first", value: entry.matching.has(key) }
      })
    }

    function clear(entry: Entry) {
      if (entry.type === "members") entry.byKey.clear()
      if (entry.type === "first") entry.matching.clear()
      if (entry.type === "members") entry.counts.clear()
      if (entry.type === "first") entry.slot = undefined
    }

    function add(entry: Entry, key: Key, slot: Readable<A>, inspection: Inspection) {
      if (entry.type === "members" && inspection.type === "members") {
        entry.byKey.set(key, inspection.value)
        inspection.value.members.forEach((member) => entry.counts.set(member, (entry.counts.get(member) ?? 0) + 1))
        return
      }
      if (entry.type === "first" && inspection.type === "first" && inspection.value) entry.matching.add(key)
    }

    function remove(entry: Entry, key: Key) {
      if (entry.type === "first") {
        entry.matching.delete(key)
        return
      }
      entry.byKey.get(key)?.members.forEach((member) => adjust(entry.counts, member, -1))
      entry.byKey.delete(key)
    }

    function replace(entry: Entry, key: Key, slot: Readable<A>, inspection: Inspection) {
      if (entry.type === "members" && inspection.type === "members-change") {
        const current = entry.byKey.get(key)!
        const members = current.members
        inspection.remove.forEach((member) => {
          if (!members.delete(member)) return
          adjust(entry.counts, member, -1)
        })
        inspection.add.forEach((member) => {
          if (members.has(member)) return
          members.add(member)
          adjust(entry.counts, member, 1)
        })
        entry.byKey.set(key, { source: members, members })
        return
      }
      if (entry.type === "members" && inspection.type === "members") {
        const previous = entry.byKey.get(key)!.members
        if (previous === inspection.value.members) {
          entry.byKey.set(key, inspection.value)
          return
        }
        inspection.value.members.forEach((member) => !previous.has(member) && adjust(entry.counts, member, 1))
        previous.forEach((member) => !inspection.value.members.has(member) && adjust(entry.counts, member, -1))
        entry.byKey.set(key, inspection.value)
        return
      }
      if (entry.type !== "first" || inspection.type !== "first") return
      const previous = entry.matching.has(key)
      if (inspection.value) entry.matching.add(key)
      if (!inspection.value) entry.matching.delete(key)
      if (entry.slot === slot && !inspection.value) findFirst(entry)
      if (entry.slot !== slot && !previous && inspection.value) updateFirstAfterPlacement(entry, slot)
    }

    function adjust(counts: Map<unknown, number>, member: unknown, amount: 1 | -1) {
      const count = (counts.get(member) ?? 0) + amount
      if (count === 0) counts.delete(member)
      if (count > 0) counts.set(member, count)
    }

    function updateFirstAfterPlacement(entry: FirstEntry, slot: Readable<A>) {
      if (!entry.matching.has(plan.keyOf(slot()))) return
      if (!entry.slot) {
        entry.slot = slot
        return
      }
      if (entry.slot === slot) return findFirst(entry)
      const slots = values.slots()
      if (slots.indexOf(slot) < slots.indexOf(entry.slot)) entry.slot = slot
    }

    function findFirst(entry: FirstEntry) {
      entry.slot = values.slots().find((slot) => entry.matching.has(plan.keyOf(slot())))
    }

    function requirePosition(position?: Keyed.Position<Key>) {
      if (!position || position === "end") return
      const key = "before" in position ? position.before : position.after
      if (!values.has(key)) throw new Error(`Keyed value does not exist: ${String(key)}`)
    }

    function normalizeName(name: PropertyKey) {
      return typeof name === "number" ? String(name) : name
    }
  }

  function make<A>(equivalent: (left: A, right: A) => boolean): Field<A> {
    return { equivalent }
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

  function generateEquivalent<A>(
    fields: ReadonlyArray<{ readonly name: PropertyKey; readonly field: Field<unknown> }>,
  ) {
    if (fields.some((field) => typeof field.name === "symbol")) return compileEquivalent<A>(fields)
    const custom: Array<Field<unknown>["equivalent"]> = []
    const comparisons = fields.map((field) => {
      const name = JSON.stringify(String(field.name))
      if (field.field.primitive) return `Object.is(left[${name}], right[${name}])`
      const index = custom.push(field.field.equivalent) - 1
      return `custom[${index}](left[${name}], right[${name}])`
    })
    const factory = Function("custom", `return (left, right) => ${comparisons.join(" && ") || "true"}`) as (
      custom: ReadonlyArray<Field<unknown>["equivalent"]>,
    ) => (left: A, right: A) => boolean
    return factory(custom)
  }

  function generateUnion<Tag extends PropertyKey, Variants extends Readonly<Record<string, Field<unknown>>>>(
    tag: Tag,
    variants: Variants,
  ) {
    if (typeof tag === "symbol") return compileUnion(tag, variants)
    const names = Object.keys(variants)
    const custom = names.map((name) => generateField(variants[name]))
    const cases = names
      .map((name, index) => `case ${JSON.stringify(name)}: return custom[${index}](left, right)`)
      .join(";")
    const property = JSON.stringify(String(tag))
    const factory = Function(
      "custom",
      `return (left, right) => { if (left[${property}] !== right[${property}]) return false; switch (left[${property}]) { ${cases}; default: return false } }`,
    ) as (custom: ReadonlyArray<Field<unknown>["equivalent"]>) => (left: unknown, right: unknown) => boolean
    return factory(custom)
  }

  function generateField(field: Field<unknown>): Field<unknown>["equivalent"] {
    if (field.immutable) return () => true
    const layout = field as Field<unknown> & {
      readonly type?: "struct" | "union" | "keyed-union"
      readonly fields?: Fields
      readonly tag?: PropertyKey
      readonly variants?: Readonly<Record<string, Field<unknown>>>
      readonly key?: NamedKey<PropertyKey, unknown>
    }
    if (layout.type === "struct") {
      const fields = Reflect.ownKeys(layout.fields!)
        .filter((name) => !layout.fields![name].immutable)
        .map((name) => ({ name, field: layout.fields![name] }))
      return generateEquivalent(generated(fields))
    }
    if (layout.type === "union") return generateUnion(layout.tag!, layout.variants!)
    if (layout.type !== "keyed-union") return field.equivalent
    const equivalent = generateUnion(layout.tag!, layout.variants!) as (left: unknown, right: unknown) => boolean
    return (left, right) => {
      const a = left as Record<PropertyKey, unknown>
      const b = right as Record<PropertyKey, unknown>
      return layout.key!.field.equivalent(a[layout.key!.name], b[layout.key!.name]) && equivalent(left, right)
    }
  }

  function generated(fields: ReadonlyArray<{ readonly name: PropertyKey; readonly field: Field<unknown> }>) {
    return fields.map((field) => ({ ...field, field: { ...field.field, equivalent: generateField(field.field) } }))
  }

  function compileEquivalent<A>(fields: ReadonlyArray<{ readonly name: PropertyKey; readonly field: Field<unknown> }>) {
    const value = (input: A) => input as Record<PropertyKey, unknown>
    if (fields.length === 0) return (_left: A, _right: A) => true
    if (fields.length === 1) {
      const first = fields[0]
      return (left: A, right: A) => first.field.equivalent(value(left)[first.name], value(right)[first.name])
    }
    if (fields.length === 2) {
      const first = fields[0]
      const second = fields[1]
      return (left: A, right: A) => {
        const a = value(left)
        const b = value(right)
        return (
          first.field.equivalent(a[first.name], b[first.name]) &&
          second.field.equivalent(a[second.name], b[second.name])
        )
      }
    }
    if (fields.length === 3) {
      const first = fields[0]
      const second = fields[1]
      const third = fields[2]
      return (left: A, right: A) => {
        const a = value(left)
        const b = value(right)
        return (
          first.field.equivalent(a[first.name], b[first.name]) &&
          second.field.equivalent(a[second.name], b[second.name]) &&
          third.field.equivalent(a[third.name], b[third.name])
        )
      }
    }
    if (fields.length === 4) {
      const first = fields[0]
      const second = fields[1]
      const third = fields[2]
      const fourth = fields[3]
      return (left: A, right: A) => {
        const a = value(left)
        const b = value(right)
        return (
          first.field.equivalent(a[first.name], b[first.name]) &&
          second.field.equivalent(a[second.name], b[second.name]) &&
          third.field.equivalent(a[third.name], b[third.name]) &&
          fourth.field.equivalent(a[fourth.name], b[fourth.name])
        )
      }
    }
    return (left: A, right: A) => {
      const a = value(left)
      const b = value(right)
      return fields.every((field) => field.field.equivalent(a[field.name], b[field.name]))
    }
  }
}
