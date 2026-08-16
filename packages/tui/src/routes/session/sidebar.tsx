import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"
import { useSDK } from "../../context/sdk"
import { useEvent } from "../../context/event"
import { useRoute } from "../../context/route"
import type { DiveInInfo } from "@opencode-ai/sdk/v2"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useToast } from "../../ui/toast"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const sdk = useSDK()
  const event = useEvent()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const ownerSessionID = createMemo(() => session()?.parentID ?? props.sessionID)
  const [diveIn, setDiveIn] = createStore({ groups: [] as DiveInInfo[] })
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  const loadDiveIn = () => {
    const current = session()
    if (!current) return
    const location = current.workspaceID
      ? { directory: current.directory, workspace: current.workspaceID }
      : { directory: current.directory }
    void sdk.client.v2.diveIn
      .list({ location })
      .then((result) =>
        setDiveIn(
          "groups",
          (result.data ?? []).filter((group) => group.sessionID === ownerSessionID()),
        ),
      )
      .catch(() => {})
  }

  createEffect(() => {
    session()?.id
    loadDiveIn()
  })

  const unsubscribe = event.on("divein.updated", (_, metadata) => {
    if (metadata.directory !== session()?.directory) return
    loadDiveIn()
  })
  const unsubscribeDeleted = event.on("divein.deleted", (_, metadata) => {
    if (metadata.directory !== session()?.directory) return
    loadDiveIn()
  })
  onCleanup(() => {
    unsubscribe()
    unsubscribeDeleted()
  })

  const currentDiveIn = createMemo(() =>
    diveIn.groups.find((group) => group.tracks.some((track) => track.sessionID === props.sessionID)),
  )
  const trackStatus = (track: DiveInInfo["tracks"][number]) => {
    if (track.status === "completed") return "done"
    if (track.status === "closed") return "closed"
    const status = sync.data.session_status[track.sessionID]
    if (status?.type === "busy") return "working"
    if (status?.type === "retry") return "retrying"
    if (status?.type === "idle") return "ready"
    return "queued"
  }

  const completeDiveIn = async (group: DiveInInfo, track: DiveInInfo["tracks"][number]) => {
    const status = trackStatus(track)
    if (track.status !== "active" || (status !== "ready" && status !== "queued")) {
      toast.show({ message: "The DiveIn track is not ready to be marked complete", variant: "warning" })
      return
    }
    try {
      await sdk.client.v2.diveIn.complete(
        { sessionID: group.sessionID, diveInID: group.id, trackID: track.id, satisfied: true },
        { throwOnError: true },
      )
      toast.show({ message: "Track marked complete", variant: "success" })
      loadDiveIn()
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
    }
  }

  const reopenDiveIn = async (group: DiveInInfo, track: DiveInInfo["tracks"][number]) => {
    try {
      await sdk.client.v2.diveIn.reopen(
        { sessionID: group.sessionID, diveInID: group.id, trackID: track.id },
        { throwOnError: true },
      )
      toast.show({ message: "Track reopened", variant: "success" })
      loadDiveIn()
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
    }
  }

  const cancelDiveIn = async (group: DiveInInfo) => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Cancel DiveIn",
      `Remove the current ${group.tracks.length} tracks? The main session will be preserved.`,
    )
    if (confirmed !== true) return
    try {
      await sdk.client.v2.diveIn.cancel({ sessionID: group.sessionID, diveInID: group.id }, { throwOnError: true })
      toast.show({ message: "DiveIn cancelled", variant: "success" })
      loadDiveIn()
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
    }
  }

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
                <Show when={session()!.parentID}>
                  <box onMouseUp={() => route.navigate({ type: "session", sessionID: ownerSessionID() })}>
                    <text fg={theme.primary}>Back to main session</text>
                  </box>
                </Show>
                <Show when={diveIn.groups.length > 0}>
                  <box paddingTop={1} gap={1}>
                    <For each={diveIn.groups}>
                      {(group) => {
                        const current = () => currentDiveIn()?.id === group.id
                        return (
                          <box gap={1}>
                            <box flexDirection="row" justifyContent="space-between">
                              <text fg={current() ? theme.text : theme.textMuted}>
                                <Show when={current()} fallback={group.title}>
                                  <b>{group.title}</b>
                                </Show>{" "}
                                <span style={{ fg: theme.textMuted }}>({group.tracks.length} tracks)</span>
                              </text>
                              <Show when={group.status === "active"}>
                                <box onMouseUp={() => void cancelDiveIn(group)}>
                                  <text fg={theme.warning}>Cancel</text>
                                </box>
                              </Show>
                            </box>
                            <For each={group.tracks}>
                              {(track) => {
                                const status = () => trackStatus(track)
                                const currentTrack = () => track.sessionID === props.sessionID
                                return (
                                  <box
                                    flexDirection="row"
                                    gap={1}
                                    onMouseUp={() => route.navigate({ type: "session", sessionID: track.sessionID })}
                                  >
                                    <text
                                      fg={
                                        status() === "working" || status() === "retrying" ? theme.warning : theme.text
                                      }
                                    >
                                      {status() === "done"
                                        ? "+"
                                        : status() === "closed"
                                          ? "-"
                                          : status() === "working"
                                            ? "~"
                                            : "o"}
                                    </text>
                                    <text fg={currentTrack() ? theme.text : theme.textMuted}>
                                      <Show when={currentTrack()} fallback={track.title}>
                                        <b>{track.title}</b>
                                      </Show>{" "}
                                      <span style={{ fg: theme.textMuted }}>[{status()}]</span>
                                    </text>
                                    <Show
                                      when={
                                        track.status === "active" &&
                                        (status() === "ready" || status() === "queued")
                                      }
                                    >
                                      <box
                                        paddingLeft={1}
                                        onMouseUp={(event) => {
                                          event.stopPropagation()
                                          void completeDiveIn(group, track)
                                        }}
                                      >
                                        <text fg={theme.success}>Done</text>
                                      </box>
                                    </Show>
                                    <Show when={track.status === "completed" && group.status === "active"}>
                                      <box
                                        paddingLeft={1}
                                        onMouseUp={(event) => {
                                          event.stopPropagation()
                                          void reopenDiveIn(group, track)
                                        }}
                                      >
                                        <text fg={theme.warning}>Undo</text>
                                      </box>
                                    </Show>
                                  </box>
                                )
                              }}
                            </For>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
