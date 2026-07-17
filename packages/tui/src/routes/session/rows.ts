import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode-ai/client"
import { Keyed, Transaction } from "effect-quark"
import { useValue } from "effect-quark/solid"
import { batch, createEffect, on, onCleanup, type Accessor } from "solid-js"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"

export type PartRef = {
  readonly messageID: string
  readonly partID: string
}

export type SessionRow = { readonly id: string } & (
  | { type: "message"; messageID: string }
  | { type: "compaction-queued"; inputID: string }
  | { type: "part"; ref: PartRef }
  | {
      type: "group"
      kind: "reasoning"
      origin: PartRef
      refs: PartRef[]
      completed: boolean
    }
  | {
      type: "group"
      kind: "exploration"
      origin: PartRef
      refs: PartRef[]
      pending: PartRef[]
      completed: boolean
    }
  | { type: "assistant-footer"; messageID: string }
)

export function createSessionRows(sessionID: Accessor<string>, options?: { readonly metrics?: Keyed.Metrics }) {
  const data = useData()
  const client = useClient()
  const reportMetrics = process.env.OPENCODE_QUARK_METRICS === "1"
  const metrics = options?.metrics ?? (reportMetrics ? Keyed.metrics() : undefined)
  const state = Keyed.make({ key: rowKey, equivalent: sameRow, metrics })
  const seenParts = new Set<string>()
  const rows = {
    slots: useValue(state.slots),
    values: state.values,
  }
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID

  const setRows = (value: SessionRow[]) => {
    batch(() => {
      state.set(value)
      seenParts.clear()
      value.forEach((row) => {
        if (row.type === "part") {
          seenParts.add(row.id)
          return
        }
        if (row.type !== "group") return
        row.refs.forEach((ref) => seenParts.add(partRowID(ref)))
        if (row.kind === "exploration") row.pending.forEach((ref) => seenParts.add(partRowID(ref)))
      })
    })
  }
  const mutate = (f: () => void) => batch(() => Transaction.run(f))
  const insert = (current: readonly SessionRow[], index: number, row: SessionRow) =>
    state.insert(row, index === current.length ? "end" : { before: current[index].id })
  const complete = (current: readonly SessionRow[], index: number) => {
    const previous = current[index - 1]
    if (previous?.type === "group" && !previous.completed) state.update({ ...previous, completed: true })
  }

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const inputs = new Set(data.session.input.list(sessionID()))
    const boundary = revertBoundary()
    const rows = reduceSessionRows(boundary ? messages.filter((message) => message.id < boundary) : messages, inputs)
    partitionPending(rows, pendingPermissions())
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
    mutate(() => {
      state.values().forEach((row) => {
        if (row.type !== "group" || row.kind !== "exploration") return
        const changed =
          row.refs.some((ref) => pending.has(ref.partID)) || row.pending.some((ref) => !pending.has(ref.partID))
        if (!changed) return
        const refs = [...row.refs, ...row.pending]
        state.update({
          ...row,
          refs: refs.filter((ref) => !pending.has(ref.partID)),
          pending: refs.filter((ref) => pending.has(ref.partID)),
        })
      })
    })
  })

  createEffect(
    on([sessionID, () => client.connection.status()], ([id, status]) => {
      if (status !== "connected") return
      setRows(reduce())
      void data.session.pending.sync(id).catch(() => undefined)
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
                  },
                ]
              : [],
        ),
      () => setRows(reduce()),
    ),
  )

  const appendMessage = (messageID: string) =>
    mutate(() => {
      if (state.has(messageRowID(messageID))) return
      const current = state.values()
      const pending = isPending(messageID)
      const message = data.session.message.get(sessionID(), messageID)
      const index =
        message?.type === "compaction" && pending
          ? queuedStart(current)
          : pending
            ? current.length
            : queuedStart(current)
      if (!pending) complete(current, index)
      insert(current, index, messageRow(messageID))
    })

  const appendPart = (ref: PartRef, part: AppendPart) =>
    mutate(() => {
      const id = partRowID(ref)
      if (seenParts.has(id)) return
      const current = state.values()
      const index = queuedStart(current)
      const previous = current[index - 1]
      const decision = appendDecision(previous, ref, part)
      if (decision.type === "join") {
        state.update({ ...decision.group, refs: [...decision.group.refs, ref] })
        seenParts.add(id)
        return
      }
      complete(current, index)
      insert(current, index, decision.row)
      seenParts.add(id)
    })

  const appendFooter = (messageID: string) =>
    mutate(() => {
      if (state.has(footerRowID(messageID))) return
      const current = state.values()
      const index = queuedStart(current)
      complete(current, index)
      insert(current, index, footerRow(messageID))
    })

  const removeFooter = (messageID: string) =>
    mutate(() => {
      state.remove(footerRowID(messageID))
    })

  const isPending = (messageID: string) => {
    const message = data.session.message.get(sessionID(), messageID)
    if (message?.type === "user" || message?.type === "synthetic") return data.session.input.has(sessionID(), messageID)
    return message?.type === "compaction" && message.status === "running"
  }

  const queuedStart = (rows: readonly SessionRow[]) => {
    const index = rows.findIndex(
      (row) => row.type === "compaction-queued" || (row.type === "message" && isPending(row.messageID)),
    )
    return index === -1 ? rows.length : index
  }

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
      if (event.data.sessionID !== sessionID() || ["tool-calls", "unknown"].includes(event.data.finish)) return
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

export function reduceSessionRows(messages: SessionMessageInfo[], inputs = new Set<string>()) {
  const isInput = (message: SessionMessageInfo) => inputs.has(message.id)
  const pendingCompactions = messages.filter((message) => message.type === "compaction" && message.status === "running")
  const pending = new Set([...pendingCompactions.map((message) => message.id), ...inputs])
  return [
    ...messages.filter((message) => !pending.has(message.id)),
    ...pendingCompactions,
    ...messages.filter(isInput),
  ].reduce<SessionRow[]>((rows, message) => {
    if (message.type !== "assistant") {
      if (message.type === "synthetic" && !message.description?.trim()) return rows
      if (!pending.has(message.id)) completePrevious(rows)
      rows.push(messageRow(message.id))
      return rows
    }
    const ordinals = { text: 0, reasoning: 0 }
    message.content.forEach((part) => {
      const partID = part.type === "tool" ? part.id : `${part.type}:${ordinals[part.type]++}`
      if ((part.type === "text" || part.type === "reasoning") && !part.text.trim()) return
      append(rows, { messageID: message.id, partID }, part)
    })
    if ((message.finish && !["tool-calls", "unknown"].includes(message.finish)) || message.error || message.retry) {
      completePrevious(rows)
      rows.push(footerRow(message.id))
    }
    return rows
  }, [])
}

type BoundaryRow =
  | Pick<Extract<SessionRow, { type: "message" }>, "type" | "messageID">
  | Pick<Extract<SessionRow, { type: "compaction-queued" }>, "type">
  | Pick<Extract<SessionRow, { type: "part" }>, "type" | "ref">
  | Pick<Extract<SessionRow, { type: "group" }>, "type" | "origin">
  | Pick<Extract<SessionRow, { type: "assistant-footer" }>, "type" | "messageID">

export function messageBoundaryIDs(rows: readonly BoundaryRow[], messages: SessionMessageInfo[]) {
  const byID = new Map(messages.map((message) => [message.id, message]))
  const seen = new Set<string>()
  return rows.map((row) => {
    const id = rowBoundaryMessageID(row, byID)
    if (!id || seen.has(id)) return undefined
    seen.add(id)
    return id
  })
}

function rowBoundaryMessageID(row: BoundaryRow, messages: Map<string, SessionMessageInfo>) {
  if (row.type === "message") {
    const message = messages.get(row.messageID)
    if (message?.type === "user" && message.text.trim()) return message.id
    return undefined
  }
  const messageID =
    row.type === "part"
      ? row.ref.messageID
      : row.type === "group"
        ? row.origin.messageID
        : row.type === "assistant-footer"
          ? row.messageID
          : undefined
  if (!messageID) return undefined
  const message = messages.get(messageID)
  if (message?.type === "assistant") return message.id
}

export function resolvePart(message: SessionMessageAssistant, partID: string) {
  const tool = message.content.find((part) => part.type === "tool" && part.id === partID)
  if (tool) return tool
  const match = /^(text|reasoning):(\d+)$/.exec(partID)
  if (!match) return
  const ordinal = Number(match[2])
  return message.content.filter((part) => part.type === match[1])[ordinal]
}

type AppendPart = { type: "text" } | { type: "reasoning" } | { type: "tool"; name: string }

function append(rows: SessionRow[], ref: PartRef, part: AppendPart, index = rows.length) {
  const previous = rows[index - 1]
  const decision = appendDecision(previous, ref, part)
  if (decision.type === "join") {
    decision.group.refs.push(ref)
    return
  }
  completePrevious(rows, index)
  rows.splice(index, 0, decision.row)
}

function appendDecision(previous: SessionRow | undefined, ref: PartRef, part: AppendPart) {
  const kind = groupKind(part)
  if (kind && previous?.type === "group" && previous.kind === kind) return { type: "join" as const, group: previous }
  return { type: "insert" as const, row: kind ? groupRow(kind, ref) : partRow(ref) }
}

function groupKind(part: AppendPart) {
  if (part.type === "reasoning") return "reasoning" as const
  if (part.type === "tool" && exploration(part.name)) return "exploration" as const
}

function completePrevious(rows: SessionRow[], index = rows.length) {
  const previous = rows[index - 1]
  if (previous?.type === "group") previous.completed = true
}

function partitionPending(rows: SessionRow[], pending: Set<string>) {
  rows.forEach((row) => {
    if (row.type !== "group" || row.kind !== "exploration") return
    const refs = [...row.refs, ...row.pending]
    row.refs = refs.filter((ref) => !pending.has(ref.partID))
    row.pending = refs.filter((ref) => pending.has(ref.partID))
  })
}

function exploration(name: string) {
  return ["read", "glob", "grep"].includes(name.toLowerCase())
}

function messageRow(messageID: string): SessionRow {
  return { id: messageRowID(messageID), type: "message", messageID }
}

function messageRowID(messageID: string) {
  return `m${segment(messageID)}`
}

function compactionQueuedRow(inputID: string): SessionRow {
  return { id: `c${segment(inputID)}`, type: "compaction-queued", inputID }
}

function partRow(ref: PartRef): SessionRow {
  return { id: partRowID(ref), type: "part", ref }
}

function partRowID(ref: PartRef) {
  return `p${segment(ref.messageID)}${segment(ref.partID)}`
}

function groupRow(kind: "reasoning" | "exploration", ref: PartRef): SessionRow {
  const id = `g${kind === "reasoning" ? "r" : "e"}${segment(ref.messageID)}${segment(ref.partID)}`
  if (kind === "reasoning") return { id, type: "group", kind, origin: ref, refs: [ref], completed: false }
  return { id, type: "group", kind, origin: ref, refs: [ref], pending: [], completed: false }
}

function footerRow(messageID: string): SessionRow {
  return { id: footerRowID(messageID), type: "assistant-footer", messageID }
}

function footerRowID(messageID: string) {
  return `f${segment(messageID)}`
}

function segment(value: string) {
  return `${value.length}:${value}`
}

function rowKey(row: SessionRow) {
  return row.id
}

function sameRow(left: SessionRow, right: SessionRow) {
  if (left.type !== right.type) return false
  if (left.type === "message" && right.type === "message") return left.messageID === right.messageID
  if (left.type === "compaction-queued" && right.type === "compaction-queued") return left.inputID === right.inputID
  if (left.type === "part" && right.type === "part") return sameRef(left.ref, right.ref)
  if (left.type === "assistant-footer" && right.type === "assistant-footer") return left.messageID === right.messageID
  if (left.type !== "group" || right.type !== "group") return false
  if (left.kind !== right.kind || left.completed !== right.completed || !sameRefs(left.refs, right.refs)) return false
  if (left.kind === "reasoning" || right.kind === "reasoning") return true
  return sameRefs(left.pending, right.pending)
}

function sameRefs(left: PartRef[], right: PartRef[]) {
  return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index]))
}

function sameRef(left: PartRef, right: PartRef) {
  return left.messageID === right.messageID && left.partID === right.partID
}
