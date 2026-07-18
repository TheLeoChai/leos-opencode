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
  labels: members((job) => job.labels),
  nextRetry: first((job) => job.status === "retrying"),
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
      Layout.compile(Layout.struct({ left: Layout.key(Layout.number), right: Layout.key(Layout.number) })),
    ).toThrow("Keyed layout must declare exactly one key field")
  })

  it("generates the same trusted equivalence as the closure backend", () => {
    const closure = Layout.compile(Item)
    const generated = Layout.compile(Item, { backend: "generated" })
    const values = [
      { id: 1, label: "one" },
      { id: 1, label: "ONE" },
      { id: 2, label: "one" },
    ]

    values.forEach((left) => {
      values.forEach((right) => {
        expect(generated.equivalent(left, right)).toBe(closure.equivalent(left, right))
      })
    })
  })

  it("compiles nested discriminated unions and skips immutable fields", () => {
    const Ref = Layout.struct({ messageID: Layout.string, partID: Layout.string })
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
    const plan = Layout.compile(Row)
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

    expect(plan.equivalent(group, { ...group, origin: { messageID: "ignored", partID: "ignored" } })).toBe(true)
    expect(plan.equivalent(group, { ...group, completed: true })).toBe(false)
    expect(plan.equivalent(group, { ...group, pending: [{ messageID: "assistant-1", partID: "read-1" }] })).toBe(false)
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
    const Child = Layout.struct({ id: Layout.key(Layout.number), value: Layout.string })
    const Parent = Layout.struct({ id: Layout.key(Layout.number), child: Child })
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

    jobs.modify("two", (job) => ({ ...job, labels: [] }), { members: { labels: { remove: ["billing"] } } })
    expect(jobs.hasMember("labels", "billing")).toBe(false)

    if (false) {
      // @ts-expect-error Member deltas require arrays so string members are not split into characters.
      jobs.modify("one", (job) => job, { members: { labels: { add: "urgent" } } })
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

  it("tracks first matches whose key is undefined", () => {
    const undefinedField: Layout.Field<undefined> = { equivalent: Object.is }
    const OptionalJobs = Layout.collection(
      Layout.struct({ id: Layout.key(undefinedField), status: Layout.string }),
      ({ first }) => ({ retry: first((job) => job.status === "retrying") }),
    )
    const jobs = OptionalJobs.make([{ id: undefined, status: "running" }])

    jobs.update({ id: undefined, status: "retrying" })

    expect(jobs.first("retry")?.()).toEqual({ id: undefined, status: "retrying" })
  })
})
