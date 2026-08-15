import { expect, test } from "bun:test"
import type {
  DiveInInfo,
  SessionMessageAssistant,
  SessionMessageUser,
} from "@opencode-ai/sdk/v2/client"
import type { PromptRequestPart } from "@/components/prompt-input/build-request-parts"
import {
  adaptTrackMessages,
  diveInInitialPrompt,
  findDiveInTrack,
  isActiveDiveInTrackSession,
  toPromptInput,
} from "./dive-in-track"

test("finds only sessions listed in DiveIn tracks", () => {
  const groups = [
    {
      id: "dive_1",
      sessionID: "ses_parent",
      title: "Plan",
      status: "active",
      tracks: [
        {
          id: "dtrk_1",
          sessionID: "ses_track",
          position: 0,
          title: "Track",
          summary: "",
          reasoning: "",
          prompt: "",
          status: "active",
          time: { created: 1, updated: 1 },
        },
      ],
      time: { created: 1, updated: 1 },
    },
  ] as unknown as DiveInInfo[]

  expect(findDiveInTrack(groups, "ses_track")?.id).toBe("dtrk_1")
  expect(findDiveInTrack(groups, "ses_parent")).toBeUndefined()
  expect(isActiveDiveInTrackSession(groups, "ses_track")).toBe(true)
  groups[0]!.tracks[0]!.status = "closed"
  expect(findDiveInTrack(groups, "ses_track")?.id).toBe("dtrk_1")
  expect(isActiveDiveInTrackSession(groups, "ses_track")).toBe(false)
  groups[0]!.tracks[0]!.status = "active"
  groups[0]!.status = "closed"
  expect(isActiveDiveInTrackSession(groups, "ses_track")).toBe(false)
})

test("converts built request parts to the V2 prompt shape", () => {
  const parts = [
    { id: "prt_text", type: "text", text: "Inspect " },
    {
      id: "prt_file",
      type: "file",
      mime: "text/plain",
      url: "file:///repo/example.ts",
      filename: "example.ts",
      source: {
        type: "file",
        path: "/repo/example.ts",
        text: { value: "const value = 1", start: 0, end: 15 },
      },
    },
    {
      id: "prt_agent",
      type: "agent",
      name: "explore",
      source: { value: "@explore", start: 0, end: 8 },
    },
  ] satisfies PromptRequestPart[]

  expect(toPromptInput(parts)).toEqual({
    text: "Inspect ",
    files: [
      {
        uri: "file:///repo/example.ts",
        name: "example.ts",
        source: { text: "const value = 1", start: 0, end: 15 },
      },
    ],
    agents: [{ name: "explore", source: { text: "@explore", start: 0, end: 8 } }],
  })
})

test("does not duplicate a planner prompt already present in the V2 wrapper", () => {
  expect(diveInInitialPrompt("inspect the auth flow", "Planner wrapper: inspect the auth flow")).toBeUndefined()
  expect(diveInInitialPrompt("inspect the auth flow", "A different initial prompt")).toBe("inspect the auth flow")
  expect(diveInInitialPrompt("   ", "Planner wrapper")).toBeUndefined()
})

test("projects V2 user and assistant messages into the existing timeline shape", () => {
  const user = {
    id: "msg_user",
    type: "user",
    time: { created: 1 },
    text: "Investigate this",
    files: [],
    agents: [],
  } satisfies SessionMessageUser
  const assistant = {
    id: "msg_assistant",
    type: "assistant",
    time: { created: 2, completed: 3 },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    content: [{ id: "prt_answer", type: "text", text: "Found it" }],
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } satisfies SessionMessageAssistant

  const result = adaptTrackMessages({ sessionID: "ses_track", messages: [assistant, user] })

  expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  expect(result.messages[1]).toMatchObject({ id: "msg_assistant", parentID: "msg_user", providerID: "provider" })
  expect(result.parts.msg_user).toMatchObject([{ type: "text", text: "Investigate this" }])
  expect(result.parts.msg_assistant).toMatchObject([{ type: "text", text: "Found it" }])
})
