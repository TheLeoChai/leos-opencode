import type { DiveInInfo, SessionStatus } from "@opencode-ai/sdk/v2/client"

export type DiveInTrackState = "working" | "retrying" | "queued" | "ready" | "done" | "closed"

export function diveInTrackCanComplete(state: DiveInTrackState) {
  return state === "ready" || state === "queued"
}

export function diveInTrackState(
  track: DiveInInfo["tracks"][number],
  status: SessionStatus | undefined,
): DiveInTrackState {
  if (track.status === "completed") return "done"
  if (track.status === "closed") return "closed"
  if (status?.type === "busy") return "working"
  if (status?.type === "retry") return "retrying"
  if (status?.type === "idle") return "ready"
  return "queued"
}
