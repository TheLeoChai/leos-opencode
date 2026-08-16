import { createRoot } from "solid-js"
import { expect, test } from "bun:test"
import type {
  DiveInInfo,
  Event,
  Message,
  OpencodeClient,
  SessionMessage,
} from "@opencode-ai/sdk/v2/client"
import { createTrackSessionSync, mergeTrackMessages, TRACK_EVENT_REFRESH_INTERVAL_MS } from "./track-session"

test("merges legacy and projected track messages without dropping either transcript", () => {
  const user = (id: string, created: number): Message => ({
    id,
    sessionID: "ses_track",
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  })
  const assistant = (id: string, created: number): Message => ({
    id,
    sessionID: "ses_track",
    role: "assistant",
    time: { created, completed: created },
    parentID: "shared",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const legacy = [user("legacy", 1), user("shared", 2)]
  const projected = [user("projected", 3), assistant("shared", 4)]

  expect(mergeTrackMessages(legacy, projected).map((message) => message.id)).toEqual([
    "legacy",
    "projected",
    "shared",
  ])
  expect(mergeTrackMessages(legacy, projected).find((message) => message.id === "shared")).toMatchObject({
    role: "assistant",
  })
})

test("refreshes a track projection when a V2 session event arrives", async () => {
  const user: SessionMessage = {
    id: "msg_user",
    type: "user",
    time: { created: 1 },
    text: "Investigate this",
  }
  const assistant: SessionMessage = {
    id: "msg_assistant",
    type: "assistant",
    time: { created: 2 },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    content: [{ id: "prt_answer", type: "text", text: "Found it" }],
  }
  let version = 0
  let fetches = 0
  let paginate = false
  let paginationPage = 0
  const requests: Array<Record<string, unknown>> = []
  let listener: ((event: Event) => void) | undefined
  const client = {
    v2: {
      session: {
        messages: async (request: Record<string, unknown>) => {
          fetches += 1
          requests.push(request)
          const page = paginationPage++
          return {
            data: {
              data: paginate ? (page === 0 ? [user] : [assistant]) : version === 0 ? [user] : [user, assistant],
              cursor: paginate && page === 0 ? { next: "cursor-1" } : {},
            },
          }
        },
      },
    },
  } as unknown as OpencodeClient
  const tracks = [
    {
      tracks: [{ sessionID: "ses_track" }],
    },
  ] as unknown as DiveInInfo[]

  const root = createRoot((dispose) => ({
    dispose,
    sync: createTrackSessionSync({
      client,
      tracks: () => tracks,
      session: () => undefined,
      listen: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
    }),
  }))

  await root.sync.refresh("ses_track")
  expect(root.sync.messages("ses_track")).toHaveLength(1)
  expect(root.sync.isProjected("ses_track", "msg_user")).toBe(true)
  expect(root.sync.isProjected("ses_track", "legacy-user")).toBe(false)
  expect(fetches).toBe(1)

  version = 1
  const liveEvents = ["session.next.text.delta", "session.next.reasoning.delta", "session.next.tool.input.delta"]
  for (let index = 0; index < 4; index++) {
    listener?.({
      id: `event-${index}`,
      type: liveEvents[index % liveEvents.length]!,
      properties: {
        sessionID: "ses_track",
        assistantMessageID: "msg_assistant",
        textID: "prt_answer",
        delta: "Found it",
      },
    } as Event)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise((resolve) => setTimeout(resolve, TRACK_EVENT_REFRESH_INTERVAL_MS + 30))

  expect(fetches).toBe(2)
  expect(root.sync.messages("ses_track")).toHaveLength(2)

  listener?.({ id: "event-idle", type: "session.idle", properties: { sessionID: "ses_track" } } as Event)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(fetches).toBe(3)

  requests.length = 0
  paginate = true
  paginationPage = 0
  await root.sync.refresh("ses_track")
  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({ order: "asc", limit: 200 })
  expect(requests[1]).toMatchObject({ cursor: "cursor-1", limit: 200 })
  expect(requests[1]).not.toHaveProperty("order")
  root.dispose()
})
