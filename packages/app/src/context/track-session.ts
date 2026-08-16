import type {
  DiveInInfo,
  Event,
  Message,
  OpencodeClient,
  Part,
  Session,
  SessionMessage,
} from "@opencode-ai/sdk/v2/client"
import { onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { adaptTrackMessages, isDiveInTrackSession } from "@/utils/dive-in-track"

type OptimisticItem = { message: Message; parts: Part[] }
type RefreshSchedule = {
  timer?: ReturnType<typeof setTimeout>
  pending: boolean
  force: boolean
  lastStarted: number
}

export const TRACK_EVENT_REFRESH_INTERVAL_MS = 200

export function mergeTrackMessages(legacy: readonly Message[] | undefined, projected: readonly Message[] | undefined) {
  const messages = new Map((legacy ?? []).map((message) => [message.id, message]))
  for (const message of projected ?? []) messages.set(message.id, message)
  return [...messages.values()].sort(cmpMessage)
}

export function createTrackSessionSync(input: {
  client: OpencodeClient
  tracks: () => readonly DiveInInfo[] | undefined
  session: (sessionID: string) => Session | undefined
  listen: (listener: (event: Event) => void) => VoidFunction
}) {
  const [data, setData] = createStore({
    messages: {} as Record<string, Message[] | undefined>,
    parts: {} as Record<string, Part[] | undefined>,
    messageSession: {} as Record<string, string | undefined>,
    loaded: {} as Record<string, boolean | undefined>,
  })
  const fetched = new Map<string, ReturnType<typeof adaptTrackMessages>>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const inflight = new Map<string, Promise<void>>()
  const schedules = new Map<string, RefreshSchedule>()

  const isSession = (sessionID: string) => isDiveInTrackSession(input.tracks(), sessionID)

  const write = (sessionID: string) => {
    const current = fetched.get(sessionID)
    const currentParts = current?.parts ?? {}
    const items = new Map(
      (current?.messages ?? []).map((message) => [message.id, { message, parts: currentParts[message.id] ?? [] }]),
    )
    const pending = optimistic.get(sessionID)
    for (const [messageID, item] of pending ?? []) {
      if (items.has(messageID)) {
        pending?.delete(messageID)
        continue
      }
      items.set(messageID, item)
    }

    const next = [...items.values()].sort((a, b) => cmpMessage(a.message, b.message))
    setData(
      produce((draft) => {
        for (const [messageID, owner] of Object.entries(draft.messageSession)) {
          if (owner === sessionID) {
            delete draft.messageSession[messageID]
            delete draft.parts[messageID]
          }
        }
        draft.messages[sessionID] = next.map((item) => item.message)
        for (const item of next) {
          draft.messageSession[item.message.id] = sessionID
          draft.parts[item.message.id] = item.parts
        }
      }),
    )
  }

  const fetch = async (sessionID: string) => {
    const messages: SessionMessage[] = []
    let cursor: string | undefined
    do {
      const response = await input.client.v2.session.messages({
        sessionID,
        limit: 200,
        ...(cursor ? { cursor } : { order: "asc" }),
      })
      messages.push(...(response.data?.data ?? []))
      cursor = response.data?.cursor?.next
    } while (cursor)
    return adaptTrackMessages({ sessionID, messages, session: input.session(sessionID) })
  }

  const refreshNow = (sessionID: string) => {
    if (!isSession(sessionID)) return Promise.resolve()
    const current = inflight.get(sessionID)
    if (current) return current

    const promise = fetch(sessionID)
      .then((next) => {
        fetched.set(sessionID, next)
        write(sessionID)
        setData("loaded", sessionID, true)
      })
      .finally(() => {
        if (inflight.get(sessionID) === promise) inflight.delete(sessionID)
      })
    inflight.set(sessionID, promise)
    return promise
  }

  const refresh = async (sessionID: string) => {
    if (!isSession(sessionID)) return Promise.resolve()
    const state = schedules.get(sessionID) ?? { pending: false, force: false, lastStarted: 0 }
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    state.pending = false
    state.force = false
    state.lastStarted = Date.now()
    schedules.set(sessionID, state)
    const current = inflight.get(sessionID)
    if (current) await current.catch(() => {})
    state.lastStarted = Date.now()
    await refreshNow(sessionID)
  }

  const ensure = (sessionID: string) => {
    if (!isSession(sessionID) || data.loaded[sessionID]) return
    void refresh(sessionID).catch(() => {})
  }

  const schedule = (sessionID: string, force = false) => {
    if (!isSession(sessionID)) return
    const state = schedules.get(sessionID) ?? { pending: false, force: false, lastStarted: 0 }
    state.pending = true
    state.force ||= force
    schedules.set(sessionID, state)
    if (state.timer) {
      if (!force) return
      clearTimeout(state.timer)
      state.timer = undefined
    }

    const delay = state.force
      ? 0
      : Math.max(0, TRACK_EVENT_REFRESH_INTERVAL_MS - (Date.now() - state.lastStarted))
    state.timer = setTimeout(() => {
      state.timer = undefined
      const current = inflight.get(sessionID)
      if (current) {
        void current
          .finally(() => {
            if (state.pending) schedule(sessionID, state.force)
          })
          .catch(() => {})
        return
      }

      state.pending = false
      state.force = false
      state.lastStarted = Date.now()
      void refreshNow(sessionID)
        .catch(() => {})
        .finally(() => {
          if (state.pending) schedule(sessionID, state.force)
        })
    }, delay)
  }

  const sessionIDFromEvent = (event: Event) => {
    if (!event.properties || typeof event.properties !== "object") return
    const properties = event.properties as Record<string, unknown>
    return typeof properties.sessionID === "string" ? properties.sessionID : undefined
  }

  const stop = input.listen((event) => {
    if (
      !event.type.startsWith("session.next.") &&
      event.type !== "session.status" &&
      event.type !== "session.idle" &&
      event.type !== "session.error" &&
      event.type !== "session.compacted" &&
      event.type !== "message.updated" &&
      event.type !== "message.removed" &&
      event.type !== "message.part.updated" &&
      event.type !== "message.part.removed" &&
      event.type !== "message.part.delta"
    )
      return
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID || !isSession(sessionID)) return
    const force =
      event.type === "session.status" ||
      event.type === "session.idle" ||
      event.type === "session.error" ||
      event.type === "session.compacted"
    schedule(sessionID, force)
  })

  onCleanup(() => {
    stop()
    for (const state of schedules.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    schedules.clear()
    inflight.clear()
  })

  return {
    isSession,
    ensure,
    refresh,
    loaded: (sessionID: string) => !!data.loaded[sessionID],
    isProjected: (sessionID: string, messageID: string) =>
      fetched.get(sessionID)?.messages.some((message) => message.id === messageID) ?? false,
    messages: (sessionID: string) => data.messages[sessionID],
    messageSession: (messageID: string) => data.messageSession[messageID],
    parts: (messageID: string) => data.parts[messageID],
    optimistic: {
      add(input: { sessionID: string; message: Message; parts: Part[] }) {
        const items = optimistic.get(input.sessionID) ?? new Map<string, OptimisticItem>()
        items.set(input.message.id, { message: input.message, parts: input.parts })
        optimistic.set(input.sessionID, items)
        write(input.sessionID)
      },
      remove(input: { sessionID: string; messageID: string }) {
        optimistic.get(input.sessionID)?.delete(input.messageID)
        write(input.sessionID)
      },
    },
  }
}

function cmpMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
