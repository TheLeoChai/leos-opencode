import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Button } from "@opencode-ai/ui/button"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { diveInTrackState, type DiveInTrackState } from "@/pages/layout/dive-in-status"

const trackStatusLabel = (language: ReturnType<typeof useLanguage>, state: DiveInTrackState) => {
  if (state === "working") return language.t("divein.status.working")
  if (state === "retrying") return language.t("divein.status.retrying")
  if (state === "ready") return language.t("divein.status.ready")
  if (state === "done") return language.t("divein.status.done")
  if (state === "closed") return language.t("divein.status.closed")
  return language.t("divein.status.queued")
}

const TrackStateIcon = (props: { state: DiveInTrackState }) => (
  <Switch>
    <Match when={props.state === "working"}>
      <Spinner class="size-3.5 shrink-0 text-text-interactive-base" />
    </Match>
    <Match when={props.state === "retrying"}>
      <Spinner class="size-3.5 shrink-0 text-icon-warning-base" />
    </Match>
    <Match when={props.state === "done"}>
      <Icon name="check-small" size="small" class="shrink-0 text-icon-success-base" />
    </Match>
    <Match when={props.state === "closed"}>
      <div class="size-1.5 shrink-0 rounded-full bg-icon-weak-base" />
    </Match>
    <Match when={props.state === "ready"}>
      <div class="size-1.5 shrink-0 rounded-full bg-icon-success-base" />
    </Match>
    <Match when={props.state === "queued"}>
      <div class="size-1.5 shrink-0 rounded-full bg-text-weaker" />
    </Match>
  </Switch>
)

export function DiveInHeader() {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const { params } = useSessionLayout()

  const groups = createMemo(() => (sync().data.dive_in ?? []).filter((group) => group.sessionID === params.id))
  const tracks = createMemo(() => groups().flatMap((group) => group.tracks))
  const working = createMemo(() =>
    tracks().some((track) => {
      const state = diveInTrackState(track, serverSync().session.data.session_status[track.sessionID])
      return state === "working" || state === "retrying"
    }),
  )

  createEffect(() => {
    const sessionID = params.id
    const directory = sdk().directory
    if (!sessionID || !directory) return
    void serverSync().loadDiveIns(directory)
  })

  return (
    <Show when={groups().length > 0}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={Button}
          variant="ghost"
          size="small"
          class="h-6 shrink-0 gap-1 px-1.5 data-[expanded]:bg-surface-raised-base-active"
          aria-label={language.t("divein.open")}
          data-component="dive-in-switcher"
        >
          <Show when={working()} fallback={<Icon name="branch" size="small" class="text-icon-weak" />}>
            <Spinner class="size-3.5 text-text-interactive-base" />
          </Show>
          <span class="text-12-medium text-text-base">{language.t("divein.title")}</span>
          <span class="text-11-regular text-text-weak">{tracks().length}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="w-[min(360px,calc(100vw-1rem))] p-1">
            <For each={groups()}>
              {(group) => (
                <div class="flex flex-col gap-0.5">
                  <div class="flex items-center gap-2 px-2 pb-1 pt-1.5">
                    <Icon name="branch" size="small" class="shrink-0 text-icon-weak" />
                    <span class="min-w-0 flex-1 truncate text-12-medium text-text-base">{group.title}</span>
                    <span class="shrink-0 text-11-regular text-text-weak">
                      {language.plural("divein.trackCount", group.tracks.length, { count: group.tracks.length })}
                    </span>
                  </div>
                  <For each={group.tracks}>
                    {(track) => {
                      const state = () =>
                        diveInTrackState(track, serverSync().session.data.session_status[track.sessionID])
                      return (
                        <DropdownMenu.Item
                          class="items-start gap-2 px-2 py-1.5"
                          onSelect={() => navigate(`/${params.dir}/session/${track.sessionID}`)}
                          title={track.summary}
                        >
                          <div class="flex size-4 shrink-0 items-center justify-center pt-0.5">
                            <TrackStateIcon state={state()} />
                          </div>
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-12-regular text-text-base">{track.title}</div>
                            <div class="truncate text-11-regular text-text-weak">
                              {trackStatusLabel(language, state())}
                            </div>
                          </div>
                        </DropdownMenu.Item>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
