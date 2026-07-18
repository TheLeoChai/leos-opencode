import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode-ai/client"
import { Keyed, Layout, Transaction } from "effect-quark"

const PartRefLayout = Layout.struct({
  messageID: Layout.string,
  partID: Layout.string,
})

const SessionRowLayout = Layout.keyedUnion({
  key: Layout.key("id", Layout.string),
  tag: "type",
  variants: {
    message: Layout.struct({ messageID: Layout.string }),
    "compaction-queued": Layout.struct({ inputID: Layout.string }),
    part: Layout.struct({ ref: PartRefLayout }),
    group: Layout.union({
      tag: "kind",
      variants: {
        reasoning: Layout.struct({
          origin: Layout.immutable(PartRefLayout),
          refs: Layout.array(PartRefLayout),
          completed: Layout.boolean,
        }),
        exploration: Layout.struct({
          origin: Layout.immutable(PartRefLayout),
          refs: Layout.array(PartRefLayout),
          pending: Layout.array(PartRefLayout),
          completed: Layout.boolean,
        }),
      },
    }),
    "assistant-footer": Layout.struct({ messageID: Layout.string }),
  },
})

export type PartRef = Layout.Type<typeof PartRefLayout>
export type SessionRow = Layout.Type<typeof SessionRowLayout>
export type AppendPart = { type: "text" } | { type: "reasoning" } | { type: "tool"; name: string }

const SessionRows = Layout.collection(
  SessionRowLayout,
  ({ members }) => ({
    parts: members((row) => {
      if (row.type === "part") return [row.id]
      if (row.type !== "group") return []
      if (row.kind === "reasoning") return row.refs.map(partRowID)
      return [...row.refs, ...row.pending].map(partRowID)
    }),
  }),
  { backend: "generated" },
)

export namespace SessionTimeline {
  export function make(options?: { readonly metrics?: Keyed.Metrics }) {
    const state = SessionRows.make([], options)
    let activeGroupID: string | undefined
    let queuedBoundaryID: string | undefined
    const queuedRowIDs = new Set<string>()

    const insert = (row: SessionRow) => state.insert(row, queuedBoundaryID ? { before: queuedBoundaryID } : "end")

    const complete = () => {
      if (!activeGroupID) return
      state.modify(activeGroupID, (row) => (row.type === "group" ? { ...row, completed: true } : row))
      activeGroupID = undefined
    }

    const nextQueued = (key: string) => {
      const row = state.after(key)?.()
      return row && queuedRowIDs.has(row.id) ? row.id : undefined
    }

    const replace = (
      rows: readonly SessionRow[],
      isQueued: (messageID: string) => boolean,
      pending: ReadonlySet<string>,
    ) =>
      Transaction.run(() => {
        queuedBoundaryID = undefined
        activeGroupID = undefined
        queuedRowIDs.clear()
        state.set(
          rows.map((row) => {
            const next = partition(row, pending)
            const queued = next.type === "compaction-queued" || (next.type === "message" && isQueued(next.messageID))
            if (queued) {
              queuedRowIDs.add(next.id)
              queuedBoundaryID ??= next.id
              return next
            }
            if (queuedBoundaryID) return next
            activeGroupID = next.type === "group" && !next.completed ? next.id : undefined
            return next
          }),
        )
      })

    const appendMessage = (messageID: string, status: { readonly pending: boolean; readonly compaction: boolean }) => {
      const id = messageRowID(messageID)
      const exists = state.has(id)
      if (exists && (status.pending || !queuedRowIDs.has(id))) return
      Transaction.run(() => {
        const row = messageRow(messageID)
        if (status.pending) {
          queuedRowIDs.add(row.id)
          if (!status.compaction) {
            state.insert(row, "end")
            queuedBoundaryID ??= row.id
            return
          }
          insert(row)
          queuedBoundaryID = row.id
          return
        }
        if (!exists) {
          complete()
          insert(row)
          return
        }
        queuedRowIDs.delete(row.id)
        complete()
        if (queuedBoundaryID === row.id) {
          queuedBoundaryID = nextQueued(row.id)
          return
        }
        if (queuedBoundaryID) state.move(row.id, { before: queuedBoundaryID })
      })
    }

    const appendPart = (ref: PartRef, part: AppendPart) => {
      const id = partRowID(ref)
      if (state.hasMember("parts", id)) return
      Transaction.run(() => {
        const kind = groupKind(part)
        const active = activeGroupID ? state.get(activeGroupID)?.() : undefined
        if (kind && active?.type === "group" && active.kind === kind) {
          state.modify(active.id, (row) => (row.type === "group" ? { ...row, refs: [...row.refs, ref] } : row), {
            members: { parts: { add: [id] } },
          })
          return
        }
        complete()
        const row = kind ? groupRow(kind, ref) : partRow(ref)
        insert(row)
        activeGroupID = row.type === "group" ? row.id : undefined
      })
    }

    const appendFooter = (messageID: string) => {
      const id = footerRowID(messageID)
      if (state.has(id)) return
      Transaction.run(() => {
        const row = footerRow(messageID)
        complete()
        insert(row)
      })
    }

    const removeFooter = (messageID: string) => state.remove(footerRowID(messageID))

    const repartition = (pending: ReadonlySet<string>) =>
      Transaction.run(() => {
        state.values().forEach((row) => {
          if (row.type !== "group" || row.kind !== "exploration") return
          const next = partition(row, pending)
          if (next !== row) state.modify(row.id, () => next)
        })
      })

    return {
      slots: state.slots,
      values: state.values,
      replace,
      appendMessage,
      appendPart,
      appendFooter,
      removeFooter,
      repartition,
    }
  }
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
    if (isTerminalFinish(message.finish) || message.error || message.retry) {
      completePrevious(rows)
      rows.push(footerRow(message.id))
    }
    return rows
  }, [])
}

export function messageBoundaryIDs(rows: readonly SessionRow[], messages: SessionMessageInfo[]) {
  const byID = new Map(messages.map((message) => [message.id, message]))
  const seen = new Set<string>()
  return rows.map((row) => {
    const id = rowBoundaryMessageID(row, byID)
    if (!id || seen.has(id)) return undefined
    seen.add(id)
    return id
  })
}

function rowBoundaryMessageID(row: SessionRow, messages: Map<string, SessionMessageInfo>) {
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

export function isTerminalFinish(finish: string | undefined) {
  return !!finish && !["tool-calls", "unknown"].includes(finish)
}

function append(rows: SessionRow[], ref: PartRef, part: AppendPart, index = rows.length) {
  const previous = rows[index - 1]
  const kind = groupKind(part)
  if (kind && previous?.type === "group" && previous.kind === kind) {
    rows[index - 1] = { ...previous, refs: [...previous.refs, ref] }
    return
  }
  completePrevious(rows, index)
  rows.splice(index, 0, kind ? groupRow(kind, ref) : partRow(ref))
}

function groupKind(part: AppendPart) {
  if (part.type === "reasoning") return "reasoning" as const
  if (part.type === "tool" && exploration(part.name)) return "exploration" as const
}

function completePrevious(rows: SessionRow[], index = rows.length) {
  const previous = rows[index - 1]
  if (previous?.type === "group") rows[index - 1] = { ...previous, completed: true }
}

function partition(row: SessionRow, pending: ReadonlySet<string>): SessionRow {
  if (row.type !== "group" || row.kind !== "exploration") return row
  const changed = row.refs.some((ref) => pending.has(ref.partID)) || row.pending.some((ref) => !pending.has(ref.partID))
  if (!changed) return row
  const refs = [...row.refs, ...row.pending]
  return {
    ...row,
    refs: refs.filter((ref) => !pending.has(ref.partID)),
    pending: refs.filter((ref) => pending.has(ref.partID)),
  }
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

export function compactionQueuedRow(inputID: string): SessionRow {
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
