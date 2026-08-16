import { describe, expect, test } from "bun:test"
import type { DiveInInfo, Message, PromptInput, SessionMessage } from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../../src/prompt/history"
import {
  adaptDiveInMessages,
  findDiveInTrack,
  isActiveDiveInTrack,
  mergeDiveInMessages,
  submitDiveInPrompt,
  trackInitialPrompt,
  toDiveInPrompt,
} from "../../src/util/dive-in"

const track = (sessionID: string): DiveInInfo["tracks"][number] => ({
  id: "dtrk_test",
  sessionID,
  position: 0,
  title: "Track",
  summary: "Summary",
  reasoning: "Reasoning",
  prompt: "Initial prompt",
  status: "active",
  time: { created: 1, updated: 1 },
})

describe("util.dive-in", () => {
  test("finds only the track for the active session", () => {
    const groups: DiveInInfo[] = [
      {
        id: "dive_test",
        sessionID: "ses_parent",
        title: "DiveIn",
        status: "active",
        tracks: [track("ses_other"), track("ses_track")],
        time: { created: 1, updated: 1 },
      },
    ]

    expect(findDiveInTrack(groups, "ses_track")?.sessionID).toBe("ses_track")
    expect(findDiveInTrack(groups, "ses_missing")).toBeUndefined()
  })

  test("allows follow-ups only for active tracks", () => {
    expect(isActiveDiveInTrack(track("ses_active"))).toBeTrue()
    expect(isActiveDiveInTrack({ ...track("ses_completed"), status: "completed" })).toBeFalse()
    expect(isActiveDiveInTrack({ ...track("ses_closed"), status: "closed" })).toBeFalse()
    expect(isActiveDiveInTrack(undefined)).toBeFalse()
  })

  test("does not duplicate the raw prompt when the wrapped prompt is visible", () => {
    expect(trackInitialPrompt("inspect the auth flow", "Focused task: inspect the auth flow")).toBeUndefined()
    expect(trackInitialPrompt("inspect the auth flow", "A different prompt")).toBe("inspect the auth flow")
  })

  test("converts editor text and supported file and agent parts", () => {
    const parts: PromptInfo["parts"] = [
      {
        type: "file",
        mime: "text/plain",
        filename: "src/index.ts",
        url: "file:///workspace/src/index.ts",
        source: {
          type: "file",
          path: "src/index.ts",
          text: { start: 2, end: 8, value: "@src/index.ts#2" },
        },
      },
      {
        type: "agent",
        name: "review",
        source: { start: 9, end: 16, value: "@review" },
      },
    ]

    expect(toDiveInPrompt({ text: "Please review this", editorText: "Editor context\n", parts })).toEqual({
      text: "Editor context\nPlease review this",
      files: [
        {
          uri: "file:///workspace/src/index.ts",
          name: "src/index.ts",
          source: { start: 2, end: 8, text: "@src/index.ts#2" },
        },
      ],
      agents: [{ name: "review", source: { start: 9, end: 16, text: "@review" } }],
    })
  })

  test("submits a fresh steered durable input", async () => {
    const calls: Array<{
      input: { sessionID: string; id?: string; prompt?: PromptInput; delivery?: "steer" | "queue" }
      options?: { throwOnError?: boolean }
    }> = []
    const client = {
      prompt(
        input: { sessionID: string; id?: string; prompt?: PromptInput; delivery?: "steer" | "queue" },
        options?: { throwOnError?: boolean },
      ) {
        calls.push({ input, options })
        return Promise.resolve()
      },
    }

    await submitDiveInPrompt(client, "ses_track", { text: "first" })
    await submitDiveInPrompt(client, "ses_track", { text: "second" })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toMatchObject({
      sessionID: "ses_track",
      prompt: { text: "first" },
      delivery: "steer",
    })
    expect(calls[0]?.options).toEqual({ throwOnError: true })
    expect(calls[0]?.input.id).toStartWith("msg_")
    expect(calls[1]?.input.id).toStartWith("msg_")
    expect(calls[0]?.input.id).not.toBe(calls[1]?.input.id)
  })

  test("projects V2 messages into the existing chronological timeline shape", () => {
    const messages: SessionMessage[] = [
      {
        id: "msg_assistant",
        type: "assistant",
        time: { created: 2, completed: 3 },
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ id: "text", type: "text", text: "Done" }],
        cost: 0,
      },
      {
        id: "msg_user",
        type: "user",
        time: { created: 1 },
        text: "Start",
      },
    ]

    const result = adaptDiveInMessages({ sessionID: "ses_track", messages })

    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(result.messages[0]).toMatchObject({ id: "msg_user", sessionID: "ses_track" })
    expect(result.parts.msg_user?.[0]).toMatchObject({ type: "text", text: "Start", sessionID: "ses_track" })
    expect(result.parts.msg_assistant?.[0]).toMatchObject({ type: "text", text: "Done" })
    expect(result.messages[1]).toMatchObject({ parentID: "msg_user", modelID: "model", providerID: "provider" })
  })

  test("keeps legacy track messages alongside the V2 projection", () => {
    const user = (id: string, created: number): Message => ({
      id,
      sessionID: "ses_track",
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    })
    const assistant: Message = {
      id: "shared",
      sessionID: "ses_track",
      role: "assistant",
      time: { created: 4, completed: 4 },
      parentID: "shared",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const legacy = [user("legacy", 1), user("shared", 2)]
    const projected = [user("projected", 3), assistant]

    expect(mergeDiveInMessages(legacy, projected).map((message) => message.id)).toEqual([
      "legacy",
      "projected",
      "shared",
    ])
    expect(mergeDiveInMessages(legacy, projected).find((message) => message.id === "shared")).toMatchObject({
      role: "assistant",
    })
  })
})
