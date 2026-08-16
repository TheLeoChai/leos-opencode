import { describe, expect, test } from "bun:test"
import type { DiveInTrack, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { diveInTrackCanComplete, diveInTrackState } from "./dive-in-status"

const track = (status: DiveInTrack["status"]): DiveInTrack => ({
  id: "dtrk_test",
  sessionID: "ses_test",
  position: 0,
  title: "Track",
  summary: "Summary",
  reasoning: "Reasoning",
  prompt: "Prompt",
  status,
  time: { created: 0, updated: 0 },
})

describe("diveInTrackState", () => {
  test.each([
    ["busy", "working"],
    ["retry", "retrying"],
    ["idle", "ready"],
  ] as const)("maps an active track with %s session status", (type, expected) => {
    expect(diveInTrackState(track("active"), { type } as SessionStatus)).toBe(expected)
  })

  test("maps persisted terminal states before session status", () => {
    expect(diveInTrackState(track("completed"), { type: "busy" })).toBe("done")
    expect(diveInTrackState(track("closed"), { type: "busy" })).toBe("closed")
  })

  test("keeps an active track visibly queued until its session reports a status", () => {
    expect(diveInTrackState(track("active"), undefined)).toBe("queued")
  })

  test.each([
    ["ready", true],
    ["queued", true],
    ["working", false],
    ["retrying", false],
    ["done", false],
    ["closed", false],
  ] as const)("allows completion only for %s tracks", (state, expected) => {
    expect(diveInTrackCanComplete(state)).toBe(expected)
  })
})
