import { Keyed } from "@opencode-ai/quark"
import { useValue } from "@opencode-ai/quark/solid"
import { batch, createEffect, on, onCleanup, type Accessor } from "solid-js"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"
import {
  SessionTimeline,
  compactionQueuedRow,
  isTerminalFinish,
  reduceSessionRows,
  type AppendPart,
  type PartRef,
  type SessionRow,
} from "./timeline"

export function createSessionRows(sessionID: Accessor<string>, options?: { readonly metrics?: Keyed.Metrics }) {
  const data = useData()
  const client = useClient()
  const reportMetrics = process.env.OPENCODE_QUARK_METRICS === "1"
  const metrics = options?.metrics ?? (reportMetrics ? Keyed.metrics() : undefined)
  const state = SessionTimeline.make({ metrics })
  const rows = {
    slots: useValue(state.slots),
    values: state.values,
  }
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID

  const isPending = (messageID: string) => {
    const message = data.session.message.get(sessionID(), messageID)
    if (message?.type === "user" || message?.type === "synthetic") return data.session.input.has(sessionID(), messageID)
    return message?.type === "compaction" && message.status === "running"
  }

  const setRows = (value: SessionRow[]) => {
    batch(() => {
      state.replace(value, isPending, pendingPermissions())
    })
  }
  const mutate = (f: () => void) => batch(f)

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const inputs = new Set(data.session.input.list(sessionID()))
    const boundary = revertBoundary()
    const rows = reduceSessionRows(
      boundary ? messages.filter((message) => message.id < boundary) : messages,
      inputs,
      (message) => data.session.message.parts(sessionID(), message.id).values(),
    )
    const position = rows.findIndex((row) => row.type === "message" && inputs.has(row.messageID))
    rows.splice(
      position === -1 ? rows.length : position,
      0,
      ...data.session.pending
        .list(sessionID())
        .filter((item) => item.type === "compaction")
        .map((item) => compactionQueuedRow(item.id)),
    )
    return rows
  }

  function pendingPermissions() {
    return new Set(
      (data.session.permission.list(sessionID()) ?? []).flatMap((request) =>
        request.source?.type === "tool" ? [request.source.callID] : [],
      ),
    )
  }

  createEffect(() => {
    const pending = pendingPermissions()
    mutate(() => state.repartition(pending))
  })

  createEffect(
    on([sessionID, () => client.connection.status()], ([id, status]) => {
      if (status !== "connected") return
      setRows(reduce())
      void data.session.message.sync(id).then(
        () => {
          if (sessionID() !== id) return
          setRows(reduce())
        },
        () => undefined,
      )
    }),
  )

  // Re-reduce when the revert boundary changes (stage/clear/commit).
  createEffect(
    on(revertBoundary, () => {
      setRows(reduce())
    }),
  )

  createEffect(
    on(
      () =>
        data.session.pending
          .list(sessionID())
          .filter((item) => item.type === "compaction")
          .map((item) => item.id),
      () => setRows(reduce()),
    ),
  )

  createEffect(
    on(
      () =>
        data.session.message.list(sessionID()).flatMap((message) =>
          message.type === "user" || message.type === "synthetic"
            ? [
                {
                  id: message.id,
                  created: message.time.created,
                  input: data.session.input.has(sessionID(), message.id),
                },
              ]
            : message.type === "compaction"
              ? [
                  {
                    id: message.id,
                    created: message.time.created,
                    input: false,
                    status: message.status,
                  },
                ]
              : [],
        ),
      () => setRows(reduce()),
    ),
  )

  const appendMessage = (messageID: string) =>
    mutate(() => {
      const pending = isPending(messageID)
      const message = data.session.message.get(sessionID(), messageID)
      state.appendMessage(messageID, { pending, compaction: message?.type === "compaction" })
    })

  const appendPart = (ref: PartRef, part: AppendPart) => mutate(() => state.appendPart(ref, part))

  const appendFooter = (messageID: string) => mutate(() => state.appendFooter(messageID))

  const removeFooter = (messageID: string) => mutate(() => state.removeFooter(messageID))

  const message = (event: { id: string; data: { sessionID: string } }) => {
    if (event.data.sessionID === sessionID()) appendMessage(event.id.replace(/^evt_/, "msg_"))
  }
  const input = (event: {
    data: {
      sessionID: string
      inputID: string
      input: { type: "user" } | { type: "synthetic"; data: { description?: string } }
    }
  }) => {
    if (
      event.data.sessionID === sessionID() &&
      (event.data.input.type === "user" || event.data.input.data.description?.trim())
    )
      appendMessage(event.data.inputID)
  }
  const subscriptions = [
    data.on("session.input.admitted", input),
    data.on("session.compaction.started", (event) => {
      if (event.data.sessionID === sessionID()) appendMessage(event.data.inputID ?? event.id.replace(/^evt_/, "msg_"))
    }),
    data.on("session.instructions.updated", message),
    data.on("session.synthetic", (event) => {
      if (event.data.sessionID === sessionID() && event.data.description?.trim())
        appendMessage(event.id.replace(/^evt_/, "msg_"))
    }),
    data.on("session.shell.started", message),
    data.on("session.agent.selected", message),
    data.on("session.model.selected", message),
    data.on("session.text.delta", (event) => {
      if (event.data.sessionID === sessionID() && event.data.delta.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` }, { type: "text" })
    }),
    data.on("session.text.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` }, { type: "text" })
    }),
    data.on("session.reasoning.delta", (event) => {
      if (event.data.sessionID === sessionID() && event.data.delta.trim())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` },
          { type: "reasoning" },
        )
    }),
    data.on("session.reasoning.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` },
          { type: "reasoning" },
        )
    }),
    data.on("session.tool.input.started", (event) => {
      if (event.data.sessionID === sessionID())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: event.data.callID },
          { type: "tool", name: event.data.name },
        )
    }),
    data.on("session.retry.scheduled", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.started", (event) => {
      if (event.data.sessionID === sessionID()) removeFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.ended", (event) => {
      if (event.data.sessionID !== sessionID() || !isTerminalFinish(event.data.finish)) return
      appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.failed", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
  ]
  onCleanup(() => subscriptions.forEach((unsubscribe) => unsubscribe()))
  onCleanup(() => {
    if (reportMetrics && metrics) console.error(`QUARK_TIMELINE_METRICS ${sessionID()} ${JSON.stringify(metrics)}`)
  })

  return rows
}
