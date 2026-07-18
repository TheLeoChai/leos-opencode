import { describe, expect, it } from "bun:test"
import { Layout } from "../src"

const Item = Layout.struct({
  id: Layout.key(Layout.number),
  label: Layout.string,
})

const Job = Layout.struct({
  id: Layout.key(Layout.string),
  labels: Layout.array(Layout.string),
  status: Layout.string,
})

const Jobs = Layout.collection(Job, ({ members, first }) => ({
  labels: members(["labels"], (job) => job.labels),
  nextRetry: first(["status"], (job) => job.status === "retrying"),
}))

describe("Layout", () => {
  it("compiles a keyed collection from trusted structural metadata", () => {
    const plan = Layout.compile(Item)
    const original = { id: 1, label: "one" }
    const values = plan.make([original])
    const slot = values.slots()[0]

    expect(plan.key).toBe("id")
    expect(plan.fields).toBe(Item.fields)
    expect(values.update({ id: 1, label: "one" })).toBe(false)
    expect(slot()).toBe(original)
    expect(values.update({ id: 1, label: "ONE" })).toBe(true)
    expect(slot()).toEqual({ id: 1, label: "ONE" })
  })

  it("requires exactly one key field", () => {
    expect(() => Layout.compile(Layout.struct({ value: Layout.number }))).toThrow(
      "Keyed layout must declare exactly one key field",
    )
    expect(() =>
      Layout.compile(
        Layout.struct({
          left: Layout.key(Layout.number),
          right: Layout.key(Layout.number),
        }),
      ),
    ).toThrow("Keyed layout must declare exactly one key field")
  })

  it("generates the same trusted equivalence as the closure backend", () => {
    const closure = Layout.compile(Item, { backend: "closure" })
    const generated = Layout.compile(Item, { backend: "generated" })
    const values = [
      { id: 1, label: "one" },
      { id: 1, label: "ONE" },
      { id: 2, label: "one" },
    ]

    values.forEach((left) => {
      values.forEach((right) => {
        expect(generated.equivalent(left, right)).toBe(closure.equivalent(left, right))
        expect(generated.diff(left, right) === 0).toBe(generated.equivalent(left, right))
        expect(closure.diff(left, right) === 0).toBe(closure.equivalent(left, right))
      })
    })
  })

  it("honors custom primitive comparators in generated plans", () => {
    const CaseInsensitive = {
      ...Layout.string,
      foldCase: true,
      equivalent(left: string, right: string) {
        return this.foldCase ? left.toLowerCase() === right.toLowerCase() : left === right
      },
    }
    const Value = Layout.struct({ id: Layout.key(Layout.number), value: CaseInsensitive })
    const closure = Layout.compile(Value, { backend: "closure" })
    const generated = Layout.compile(Value, { backend: "generated" })
    const left = { id: 1, value: "same" }
    const right = { id: 1, value: "SAME" }

    expect(closure.equivalent(left, right)).toBe(true)
    expect(generated.equivalent(left, right)).toBe(true)
    expect(generated.diff(left, right)).toBe(0)
  })

  it("keeps generated nested keyed unions independent when they share variants", () => {
    const variants = {
      yes: Layout.struct({ value: Layout.string }),
      no: Layout.struct({ value: Layout.string }),
    }
    const Left = Layout.keyedUnion({
      key: Layout.key("leftID", Layout.number),
      tag: "leftType",
      variants,
    })
    const Right = Layout.keyedUnion({
      key: Layout.key("rightID", Layout.number),
      tag: "rightType",
      variants,
    })
    const Root = Layout.struct({
      id: Layout.key(Layout.number),
      left: Left,
      right: Right,
    })
    const value: Layout.Type<typeof Root> = {
      id: 1,
      left: { leftID: 1, leftType: "yes", value: "same" },
      right: { rightID: 1, rightType: "yes", value: "same" },
    }
    const copy = structuredClone(value)
    const closure = Layout.compile(Root, { backend: "closure" })
    const generated = Layout.compile(Root, { backend: "generated" })

    expect(closure.equivalent(value, copy)).toBe(true)
    expect(generated.equivalent(value, copy)).toBe(true)
    expect(generated.diff(value, copy)).toBe(0)
  })

  it("compiles nested discriminated unions and skips immutable fields", () => {
    const Ref = Layout.struct({
      messageID: Layout.string,
      partID: Layout.string,
    })
    const Row = Layout.keyedUnion({
      key: Layout.key("id", Layout.string),
      tag: "type",
      variants: {
        message: Layout.struct({ messageID: Layout.string }),
        group: Layout.union({
          tag: "kind",
          variants: {
            reasoning: Layout.struct({
              origin: Layout.immutable(Ref),
              refs: Layout.array(Ref),
              completed: Layout.boolean,
            }),
            exploration: Layout.struct({
              origin: Layout.immutable(Ref),
              refs: Layout.array(Ref),
              pending: Layout.array(Ref),
              completed: Layout.boolean,
            }),
          },
        }),
      },
    })
    const plan = Layout.compile(Row, { backend: "closure" })
    const generated = Layout.compile(Row, { backend: "generated" })
    const group = {
      id: "group-1",
      type: "group" as const,
      kind: "exploration" as const,
      origin: { messageID: "assistant-1", partID: "read-1" },
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
      pending: [] as Array<{ messageID: string; partID: string }>,
      completed: false,
    }

    expect(
      plan.equivalent(group, {
        ...group,
        origin: { messageID: "ignored", partID: "ignored" },
      }),
    ).toBe(true)
    expect(plan.equivalent(group, { ...group, completed: true })).toBe(false)
    expect(
      plan.equivalent(group, {
        ...group,
        pending: [{ messageID: "assistant-1", partID: "read-1" }],
      }),
    ).toBe(false)
    expect(
      plan.equivalent(group, {
        id: "group-1",
        type: "group",
        kind: "reasoning",
        origin: group.origin,
        refs: group.refs,
        completed: false,
      }),
    ).toBe(false)
    const candidates = [
      group,
      { ...group, origin: { messageID: "ignored", partID: "ignored" } },
      { ...group, completed: true },
      { ...group, pending: [{ messageID: "assistant-1", partID: "read-1" }] },
      {
        id: "group-1",
        type: "group" as const,
        kind: "reasoning" as const,
        origin: group.origin,
        refs: group.refs,
        completed: false,
      },
    ]
    candidates.forEach((left) => {
      candidates.forEach((right) => expect(generated.equivalent(left, right)).toBe(plan.equivalent(left, right)))
    })
  })

  it("includes nested keys in structural equivalence", () => {
    const Child = Layout.struct({
      id: Layout.key(Layout.number),
      value: Layout.string,
    })
    const Parent = Layout.struct({
      id: Layout.key(Layout.number),
      child: Child,
    })
    const parent = Layout.compile(Parent)

    expect(
      parent.equivalent({ id: 1, child: { id: 1, value: "same" } }, { id: 1, child: { id: 2, value: "same" } }),
    ).toBe(false)
  })

  it("composes indexed collections without domain-specific behavior", () => {
    const jobs = Jobs.make([
      { id: "one", labels: ["billing", "urgent"], status: "running" },
      { id: "two", labels: ["billing"], status: "retrying" },
      { id: "three", labels: [], status: "retrying" },
    ])

    expect(jobs.hasMember("labels", "billing")).toBe(true)
    expect(jobs.hasMember("labels", "missing")).toBe(false)
    expect(jobs.first("nextRetry")?.().id).toBe("two")
    expect(jobs.before("two")?.().id).toBe("one")
    expect(jobs.after("two")?.().id).toBe("three")

    jobs.modify("one", (job) => ({ ...job, labels: [], status: "retrying" }))
    expect(jobs.hasMember("labels", "urgent")).toBe(false)
    expect(jobs.hasMember("labels", "billing")).toBe(true)
    expect(jobs.first("nextRetry")?.().id).toBe("one")

    jobs.remove("two")
    expect(jobs.hasMember("labels", "billing")).toBe(false)
    jobs.move("three", { before: "one" })
    expect(jobs.first("nextRetry")?.().id).toBe("three")
  })

  it("keeps indexes synchronized across inserts, updates, and replacement", () => {
    const jobs = Jobs.make([{ id: "one", labels: ["one"], status: "running" }])

    jobs.insert({ id: "three", labels: ["shared"], status: "retrying" })
    jobs.insert({ id: "two", labels: ["shared"], status: "retrying" }, { before: "three" })
    expect(jobs.first("nextRetry")?.().id).toBe("two")

    jobs.update({ id: "two", labels: [], status: "done" })
    expect(jobs.first("nextRetry")?.().id).toBe("three")
    expect(jobs.hasMember("labels", "shared")).toBe(true)

    jobs.remove("three")
    expect(jobs.first("nextRetry")).toBeUndefined()
    expect(jobs.hasMember("labels", "shared")).toBe(false)

    jobs.set([
      { id: "four", labels: ["replacement"], status: "retrying" },
      { id: "five", labels: [], status: "running" },
    ])
    expect(jobs.hasMember("labels", "replacement")).toBe(true)
    expect(jobs.hasMember("labels", "one")).toBe(false)
    expect(jobs.first("nextRetry")?.().id).toBe("four")
  })

  it("skips index projection when the change is disjoint from its declared fields", () => {
    let extractions = 0
    let matchChecks = 0
    const IndexedJobs = Layout.collection(Job, ({ members, first }) => ({
      labels: members(["labels"], (job) => {
        extractions++
        return job.labels
      }),
      nextRetry: first(["status"], (job) => {
        matchChecks++
        return job.status === "retrying"
      }),
    }))
    const jobs = IndexedJobs.make([{ id: "one", labels: ["billing"], status: "running" }])
    const labels = jobs.get("one")!().labels
    const baseline = { extractions, matchChecks }

    // Status-only change: labels extraction reads only `labels`, so it skips.
    jobs.update({ id: "one", labels, status: "retrying" })
    expect(extractions).toBe(baseline.extractions)
    expect(matchChecks).toBe(baseline.matchChecks + 1)
    expect(jobs.first("nextRetry")?.().id).toBe("one")

    // Labels-only change: the first-match check reads only `status`, so it skips.
    jobs.update({ id: "one", labels: ["urgent"], status: "retrying" })
    expect(extractions).toBe(baseline.extractions + 1)
    expect(matchChecks).toBe(baseline.matchChecks + 1)
    expect(jobs.hasMember("labels", "urgent")).toBe(true)
    expect(jobs.hasMember("labels", "billing")).toBe(false)

    // Equivalent update: nothing runs.
    jobs.update({ id: "one", labels: ["urgent"], status: "retrying" })
    expect(extractions).toBe(baseline.extractions + 1)
    expect(matchChecks).toBe(baseline.matchChecks + 1)
  })

  it("normalizes numeric dependency names", () => {
    let extractions = 0
    const Numeric = Layout.collection(
      Layout.struct({ id: Layout.key(Layout.string), 0: Layout.string, other: Layout.string }),
      ({ members }) => ({
        zero: members([0], (value) => {
          extractions++
          return [value[0]]
        }),
      }),
    )
    const values = Numeric.make([{ id: "one", 0: "zero", other: "before" }])
    const baseline = extractions

    values.update({ id: "one", 0: "zero", other: "after" })

    expect(extractions).toBe(baseline)
    expect(values.hasMember("zero", "zero")).toBe(true)
  })

  it("reuses precomputed field diffs during direct collection mutations", () => {
    let comparisons = 0
    const counted: Layout.Field<string> = {
      equivalent(left, right) {
        comparisons++
        return left === right
      },
    }
    const CountedJob = Layout.struct({
      id: Layout.key(Layout.string),
      value: counted,
      status: Layout.string,
    })
    const CountedJobs = Layout.collection(CountedJob, ({ first }) => ({
      changed: first(["value"], (job) => job.value === "after"),
    }))
    const one = { id: "one", value: "before", status: "idle" }
    const two = { id: "two", value: "before", status: "idle" }
    const jobs = CountedJobs.make([one, two])
    comparisons = 0

    jobs.set([
      { ...one },
      { ...two, value: "after" },
    ])

    expect(comparisons).toBe(4)
    expect(jobs.get("one")?.()).toBe(one)
    expect(jobs.first("changed")?.().id).toBe("two")

    comparisons = 0
    jobs.update({ ...jobs.get("one")!(), status: "busy" })
    expect(comparisons).toBe(1)

    comparisons = 0
    jobs.modify("two", (job) => ({ ...job, value: "done" }))
    expect(comparisons).toBe(1)
    expect(jobs.first("changed")).toBeUndefined()
  })

  it("refreshes indexes that read a changed union discriminant", () => {
    const Row = Layout.keyedUnion({
      key: Layout.key("id", Layout.number),
      tag: "type",
      variants: {
        waiting: Layout.struct({ value: Layout.string }),
        ready: Layout.struct({ value: Layout.string }),
      },
    })
    const Rows = Layout.collection(Row, ({ members, first }) => ({
      types: members(["type"], (row) => [row.type]),
      firstReady: first(["type"], (row) => row.type === "ready"),
    }))
    const rows = Rows.make([{ id: 1, type: "waiting", value: "same" }])

    rows.update({ id: 1, type: "ready", value: "same" })

    expect(rows.get(1)?.().type).toBe("ready")
    expect(rows.hasMember("types", "waiting")).toBe(false)
    expect(rows.hasMember("types", "ready")).toBe(true)
    expect(rows.first("firstReady")?.().type).toBe("ready")
  })

  it("tracks lazy member iterables while they are consumed", () => {
    const LazyJobs = Layout.collection(Job, ({ members }) => ({
      statuses: members(function* (job) {
        yield job.status
      }),
    }))
    const jobs = LazyJobs.make([{ id: "one", labels: [], status: "running" }])

    expect(jobs.hasMember("statuses", "running")).toBe(true)
    jobs.update({ id: "one", labels: [], status: "retrying" })
    expect(jobs.hasMember("statuses", "running")).toBe(false)
    expect(jobs.hasMember("statuses", "retrying")).toBe(true)
  })

  it("passes actual frozen values to identity and reflection projections", () => {
    const actual = Object.freeze({ id: "one", labels: [] as readonly string[], status: "running" })
    const accepted = new WeakSet<object>([actual])
    const EnumeratedJobs = Layout.collection(Job, ({ members, first }) => ({
      properties: members((job) => Object.keys(job)),
      selves: members((job) => [job]),
      frozen: members((job) => [Object.isFrozen(job)]),
      accepted: first((job) => accepted.has(job)),
    }))
    const jobs = EnumeratedJobs.make([actual])

    expect(jobs.hasMember("properties", "id")).toBe(true)
    expect(jobs.hasMember("properties", "labels")).toBe(true)
    expect(jobs.hasMember("properties", "status")).toBe(true)
    expect(jobs.hasMember("selves", actual)).toBe(true)
    expect(jobs.hasMember("frozen", true)).toBe(true)
    expect(jobs.first("accepted")?.()).toBe(actual)
  })

  it("applies explicit member deltas without re-extracting unchanged membership", () => {
    let extractions = 0
    const IndexedJobs = Layout.collection(Job, ({ members }) => ({
      labels: members((job) => {
        extractions++
        return job.labels
      }),
    }))
    const jobs = IndexedJobs.make([
      { id: "one", labels: ["billing"], status: "running" },
      { id: "two", labels: ["billing"], status: "running" },
    ])
    const before = extractions

    jobs.modify("one", (job) => ({ ...job, labels: ["urgent"] }), {
      members: { labels: { add: ["urgent"], remove: ["billing"] } },
    })

    expect(extractions).toBe(before)
    expect(jobs.hasMember("labels", "billing")).toBe(true)
    expect(jobs.hasMember("labels", "urgent")).toBe(true)

    jobs.modify("two", (job) => ({ ...job, labels: [] }), {
      members: { labels: { remove: ["billing"] } },
    })
    expect(jobs.hasMember("labels", "billing")).toBe(false)

    if (false) {
      jobs.modify("one", (job) => job, {
        members: {
          labels: {
            // @ts-expect-error Member deltas require arrays so strings are not split into characters.
            add: "urgent",
          },
        },
      })
    }
  })

  it("does not commit mutations when an index callback throws", () => {
    const ThrowingJobs = Layout.collection(Job, ({ members, first }) => ({
      labels: members((job) => {
        if (job.labels.includes("boom")) throw new Error("boom")
        return job.labels
      }),
      nextRetry: first((job) => job.status === "retrying"),
    }))
    const jobs = ThrowingJobs.make([{ id: "one", labels: ["safe"], status: "running" }])

    expect(() => jobs.update({ id: "one", labels: ["boom"], status: "retrying" })).toThrow("boom")
    expect(() => jobs.set([{ id: "two", labels: ["boom"], status: "retrying" }])).toThrow("boom")

    expect(jobs.values()).toEqual([{ id: "one", labels: ["safe"], status: "running" }])
    expect(jobs.hasMember("labels", "safe")).toBe(true)
    expect(jobs.hasMember("labels", "boom")).toBe(false)
    expect(jobs.first("nextRetry")).toBeUndefined()

    expect(() => jobs.insert({ id: "two", labels: ["boom"], status: "retrying" }, { before: "missing" })).toThrow(
      "Keyed value does not exist: missing",
    )
  })

  it("restores pending comparison state when publication throws", () => {
    const LabeledJob = Layout.struct({
      id: Layout.key(Layout.string),
      label: Layout.string,
      status: Layout.string,
    })
    const IndexedJobs = Layout.collection(LabeledJob, ({ first }) => ({
      retry: first(["status"], (job) => job.status === "retrying"),
    }))
    const jobs = IndexedJobs.make([{ id: "one", label: "before", status: "running" }])
    const slot = jobs.get("one")!
    const dispose = slot.subscribe(() => {
      throw new Error("listener failed")
    })

    expect(() => jobs.update({ id: "one", label: "after", status: "running" })).toThrow("listener failed")
    dispose()
    const equivalent = { ...slot() }

    expect(jobs.set([equivalent])).toBe(false)
    expect(slot()).not.toBe(equivalent)
  })

  it("does not leak a pending comparison into reentrant publication", () => {
    const LabeledJob = Layout.struct({
      id: Layout.key(Layout.string),
      label: Layout.string,
      status: Layout.string,
    })
    const IndexedJobs = Layout.collection(LabeledJob, ({ first }) => ({
      retry: first(["status"], (job) => job.status === "retrying"),
    }))
    const jobs = IndexedJobs.make([{ id: "one", label: "before", status: "running" }])
    const slot = jobs.get("one")!
    let reentered = false
    let changed: boolean | undefined
    const dispose = slot.subscribe(() => {
      if (reentered) return
      reentered = true
      changed = jobs.set([{ ...slot() }])
    })

    jobs.update({ id: "one", label: "after", status: "running" })

    expect(changed).toBe(false)
    dispose()
  })

  it("tracks first matches whose key is undefined", () => {
    const undefinedField: Layout.Field<undefined> = { equivalent: Object.is }
    const OptionalJobs = Layout.collection(
      Layout.struct({ id: Layout.key(undefinedField), status: Layout.string }),
      ({ first }) => ({ retry: first(["status"], (job) => job.status === "retrying") }),
    )
    const jobs = OptionalJobs.make([{ id: undefined, status: "running" }])

    jobs.update({ id: undefined, status: "retrying" })

    expect(jobs.first("retry")?.()).toEqual({
      id: undefined,
      status: "retrying",
    })
  })
})
