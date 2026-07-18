import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode-ai/client"
import {
  SessionTimeline,
  messageBoundaryIDs,
  reduceSessionRows,
  type SessionRow,
} from "../../../src/routes/session/timeline"

const withoutIDs = (rows: ReturnType<typeof reduceSessionRows>) =>
  rows.map(({ id: _id, ...row }) => {
    if (row.type !== "group") return row
    const { origin: _origin, ...group } = row
    return group
  })

test("assigns assistant boundaries to the first rendered row instead of the first text row", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Question", time: { created: 0 } },
    assistant("assistant-1", [
      { type: "reasoning", text: "Thinking" },
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]),
  ]
  const rows = reduceSessionRows(messages)

  expect(messageBoundaryIDs(rows, messages)).toEqual(["user-1", "assistant-1", undefined, undefined])
})

test("keeps a group boundary at its immutable origin while visible refs repartition", () => {
  const messages = [assistant("assistant-1", []), assistant("assistant-2", [])]
  const origin = { messageID: "assistant-1", partID: "read-1" }
  const group: SessionRow = {
    id: "group",
    type: "group",
    kind: "exploration",
    origin,
    refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    pending: [origin],
    completed: false,
  }

  expect(messageBoundaryIDs([group], messages)).toEqual(["assistant-1"])
})

test("groups exploration parts across assistant messages until a delimiter", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Explore", time: { created: 0 } },
    assistant("assistant-1", [
      { type: "text", text: "Looking" },
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
      { type: "tool", id: "glob-1", name: "glob", state: pending(), time: { created: 3 } },
    ]),
    assistant("assistant-2", [
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 5 } },
      { type: "text", text: "Done" },
    ]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    { type: "message", messageID: "user-1" },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [
        { messageID: "assistant-1", partID: "read-1" },
        { messageID: "assistant-1", partID: "glob-1" },
        { messageID: "assistant-2", partID: "grep-1" },
      ],
    },
    { type: "part", ref: { messageID: "assistant-2", partID: "text:0" } },
  ])
})

test("keeps non-exploration tools as individual part rows", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } },
      { type: "tool", id: "reasoning:0", name: "bash", state: pending(), time: { created: 2 } },
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    ]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "reasoning:0" } },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [{ messageID: "assistant-1", partID: "grep-1" }],
    },
  ])
})

test("assigns stable kind ordinals within an assistant message", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "text", text: "First" },
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Second" },
      { type: "reasoning", text: "Check" },
    ]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "reasoning:0" }],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:1" } },
    {
      type: "group",
      kind: "reasoning",
      completed: false,
      refs: [{ messageID: "assistant-1", partID: "reasoning:1" }],
    },
  ])
})

test("groups adjacent reasoning parts until a visible boundary", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "reasoning", text: "First" },
      { type: "reasoning", text: "Second" },
      { type: "text", text: "Visible" },
      { type: "reasoning", text: "Third" },
    ]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [
        { messageID: "assistant-1", partID: "reasoning:0" },
        { messageID: "assistant-1", partID: "reasoning:1" },
      ],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "reasoning",
      completed: false,
      refs: [{ messageID: "assistant-1", partID: "reasoning:2" }],
    },
  ])
})

test("groups across empty assistant reasoning parts", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "reasoning", text: "Looking" },
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
    ]),
    assistant("assistant-2", [
      { type: "reasoning", text: "" },
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    ]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "reasoning:0" }],
    },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [
        { messageID: "assistant-1", partID: "read-1" },
        { messageID: "assistant-2", partID: "grep-1" },
      ],
    },
  ])
})

test("completes exploration groups when another row follows", () => {
  const finished = assistant("assistant-2", [
    { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
  ])
  finished.finish = "stop"
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    { type: "user", id: "user-1", text: "Continue", time: { created: 2 } },
    finished,
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "message", messageID: "user-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    },
    { type: "assistant-footer", messageID: "assistant-2" },
  ])
})

test("hides synthetic messages without descriptions", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    {
      type: "synthetic",
      id: "synthetic-1",
      text: "internal context",
      time: { created: 2 },
    },
    assistant("assistant-2", [{ type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } }]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [
        { messageID: "assistant-1", partID: "read-1" },
        { messageID: "assistant-2", partID: "grep-1" },
      ],
    },
  ])
})

test("renders synthetic messages with descriptions", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    {
      type: "synthetic",
      id: "synthetic-1",
      text: "internal context",
      description: "Explicit notice",
      time: { created: 2 },
    },
    assistant("assistant-2", [{ type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } }]),
  ]

  expect(withoutIDs(reduceSessionRows(messages))).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "message", messageID: "synthetic-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    },
  ])
})

test("renders a footer for a pre-output retry assistant after replay", () => {
  const message = assistant("assistant-retry", [])
  message.retry = {
    attempt: 2,
    at: 2_000,
    error: { type: "provider.transport", message: "Disconnected" },
  }

  expect(withoutIDs(reduceSessionRows([message]))).toEqual([{ type: "assistant-footer", messageID: "assistant-retry" }])
})

test("places a running compaction barrier before every queued user message", () => {
  const queued = (id: string, text: string, created: number): SessionMessageInfo => ({
    type: "user",
    id,
    text,
    time: { created },
  })
  const messages: SessionMessageInfo[] = [
    queued("user-before", "Before", 1),
    {
      type: "compaction",
      id: "compaction",
      status: "running",
      reason: "manual",
      summary: "",
      recent: "",
      time: { created: 2 },
    },
    queued("user-after", "After", 3),
  ]

  expect(withoutIDs(reduceSessionRows(messages, new Set(["user-before", "user-after"])))).toEqual([
    { type: "message", messageID: "compaction" },
    { type: "message", messageID: "user-before" },
    { type: "message", messageID: "user-after" },
  ])
})

test("matches snapshot reduction through direct timeline operations", () => {
  const timeline = SessionTimeline.make()
  const response = assistant("assistant-1", [
    { type: "reasoning", text: "First" },
    { type: "reasoning", text: "Second" },
    { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
    { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    { type: "text", text: "Done" },
  ])
  response.finish = "stop"
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Explore", time: { created: 0 } },
    response,
    { type: "user", id: "user-queued", text: "Continue", time: { created: 4 } },
  ]

  timeline.appendMessage("user-1", { pending: false, compaction: false })
  timeline.appendPart({ messageID: "assistant-1", partID: "reasoning:0" }, { type: "reasoning" })
  timeline.appendPart({ messageID: "assistant-1", partID: "reasoning:1" }, { type: "reasoning" })
  timeline.appendPart({ messageID: "assistant-1", partID: "read-1" }, { type: "tool", name: "read" })
  timeline.appendPart({ messageID: "assistant-1", partID: "grep-1" }, { type: "tool", name: "grep" })
  timeline.appendPart({ messageID: "assistant-1", partID: "text:0" }, { type: "text" })
  timeline.appendFooter("assistant-1")
  timeline.appendMessage("user-queued", { pending: true, compaction: false })

  expect(timeline.values()).toEqual(reduceSessionRows(messages, new Set(["user-queued"])))
})

test("ignores a duplicate part through the parts membership index", () => {
  const timeline = SessionTimeline.make()
  const ref = { messageID: "assistant-1", partID: "read-1" }
  timeline.appendPart(ref, { type: "tool", name: "read" })
  const values = timeline.values()
  const slots = timeline.slots()

  timeline.appendPart(ref, { type: "text" })

  expect(timeline.values()).toBe(values)
  expect(timeline.slots()).toBe(slots)
})

test("inserts output before the earliest queued compaction and prompt", () => {
  const timeline = SessionTimeline.make()
  timeline.appendPart({ messageID: "assistant-1", partID: "read-1" }, { type: "tool", name: "read" })
  timeline.appendMessage("user-1", { pending: true, compaction: false })
  timeline.appendMessage("user-2", { pending: true, compaction: false })
  timeline.appendMessage("compaction-1", { pending: true, compaction: true })
  timeline.appendPart({ messageID: "assistant-1", partID: "text:0" }, { type: "text" })

  expect(withoutIDs([...timeline.values()])).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    { type: "message", messageID: "compaction-1" },
    { type: "message", messageID: "user-1" },
    { type: "message", messageID: "user-2" },
  ])
})

test("keeps a group slot stable through join, repartition, and completion", () => {
  const timeline = SessionTimeline.make()
  timeline.appendPart({ messageID: "assistant-1", partID: "read-1" }, { type: "tool", name: "read" })
  const slot = timeline.slots()[0]

  timeline.appendPart({ messageID: "assistant-2", partID: "grep-1" }, { type: "tool", name: "grep" })
  expect(timeline.slots()[0]).toBe(slot)

  timeline.repartition(new Set(["read-1"]))
  expect(timeline.slots()[0]).toBe(slot)
  expect(slot()).toMatchObject({
    refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    pending: [{ messageID: "assistant-1", partID: "read-1" }],
    completed: false,
  })

  timeline.appendMessage("user-queued", { pending: true, compaction: false })
  expect(slot()).toMatchObject({ completed: false })
  timeline.appendMessage("user-queued", { pending: false, compaction: false })

  expect(timeline.slots()[0]).toBe(slot)
  expect(slot()).toMatchObject({ completed: true })
})

test("does not complete an active group for duplicate messages or footers", () => {
  const timeline = SessionTimeline.make()
  timeline.appendMessage("user-1", { pending: false, compaction: false })
  timeline.appendPart({ messageID: "assistant-1", partID: "reasoning:0" }, { type: "reasoning" })
  const first = timeline.slots()[1]

  timeline.appendMessage("user-1", { pending: false, compaction: false })
  expect(first()).toMatchObject({ completed: false })

  timeline.appendFooter("assistant-1")
  timeline.appendPart({ messageID: "assistant-2", partID: "reasoning:0" }, { type: "reasoning" })
  const second = timeline.slots()[3]
  timeline.appendFooter("assistant-1")

  expect(second()).toMatchObject({ completed: false })
})

test("moves a promoted queued message before the remaining queue", () => {
  const timeline = SessionTimeline.make()
  timeline.appendPart({ messageID: "assistant-1", partID: "reasoning:0" }, { type: "reasoning" })
  timeline.appendMessage("user-1", { pending: true, compaction: false })
  timeline.appendMessage("user-2", { pending: true, compaction: false })

  timeline.appendMessage("user-2", { pending: false, compaction: false })
  timeline.appendPart({ messageID: "assistant-2", partID: "text:0" }, { type: "text" })

  expect(withoutIDs([...timeline.values()])).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "reasoning:0" }],
    },
    { type: "message", messageID: "user-2" },
    { type: "part", ref: { messageID: "assistant-2", partID: "text:0" } },
    { type: "message", messageID: "user-1" },
  ])
})

test("advances the queue boundary when a running compaction completes", () => {
  const timeline = SessionTimeline.make()
  timeline.appendPart({ messageID: "assistant-1", partID: "read-1" }, { type: "tool", name: "read" })
  timeline.appendMessage("compaction-1", { pending: true, compaction: true })
  timeline.appendMessage("user-1", { pending: true, compaction: false })

  timeline.appendMessage("compaction-1", { pending: false, compaction: true })
  timeline.appendPart({ messageID: "assistant-2", partID: "grep-1" }, { type: "tool", name: "grep" })

  expect(withoutIDs([...timeline.values()])).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "message", messageID: "compaction-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    },
    { type: "message", messageID: "user-1" },
  ])
})

function assistant(id: string, content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
    time: { created: 1 },
  }
}

function pending() {
  return { status: "streaming" as const, input: "" }
}
