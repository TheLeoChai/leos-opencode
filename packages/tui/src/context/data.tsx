// Client data layer: apply server events and cache API reads into a Solid store.
// Prefer straightforward projection. API reads replace cached state, except admitted
// inputs survive history refresh until the server projects them. Reconnect invalidates
// cached reads; active UI owners decide what to sync again.

import type {
  AgentInfo,
  CommandInfo,
  FormInfo,
  IntegrationInfo,
  LocationRef,
  LocationGetOutput,
  McpResource,
  McpServer,
  ModelInfo,
  PermissionSavedInfo,
  PermissionV2Request,
  ProviderV2Info,
  ReferenceInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionInfo,
  SessionPendingInfo,
  ShellInfo,
  SkillInfo,
  OpenCodeEvent,
} from "@opencode-ai/client"
import type { Plugin } from "@opencode-ai/plugin/v2/tui"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { SessionContent } from "../routes/session/content"

export type DataSessionStatus = "idle" | "running"

const messageIDFromEvent = (eventID: string) => eventID.replace(/^evt_/, "msg_")

// Global MCP elicitations temporarily use "global" instead of a real session ID, so the
// server cannot recover their Location when settling them. Preserve the event Location
// until MCP elicitations carry session ownership.
export type FormWithLocation = FormInfo & { readonly location?: LocationRef }

type LocationData = {
  info?: LocationGetOutput
  agent?: AgentInfo[]
  command?: CommandInfo[]
  integration?: IntegrationInfo[]
  mcp?: {
    server?: McpServer[]
    resource?: McpResource[]
  }
  model?: ModelInfo[]
  provider?: ProviderV2Info[]
  reference?: ReferenceInfo[]
  // Currently running shell commands for this location, keyed by shell id. Entries are removed
  // once the command exits or is deleted, so this only ever holds in-flight shells.
  shell?: Record<string, ShellInfo>
  skill?: SkillInfo[]
}

type Store = {
  session: {
    info: Record<string, SessionInfo>
    // Family index keyed by a family's root (or furthest-known-ancestor when the
    // true root is not yet loaded). The value is a flat deduplicated list of every
    // session ID in that family, including the key itself once its info arrives.
    family: Record<string, string[]>
    active: Record<string, DataSessionStatus>
    message: Record<string, SessionMessageInfo[]>
    pending: Record<string, SessionPendingInfo[]>
    permission: Record<string, PermissionV2Request[]>
    // Pending forms keyed by owner: a session ID or the temporary "global" elicitation sentinel.
    form: Record<string, FormWithLocation[]>
  }
  project: {
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

type PendingOperation =
  | { type: "admitted"; item: SessionPendingInfo }
  | { type: "promoted"; inputID: string }
  | { type: "reverted"; to: string }

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

function createSync() {
  const state = new Map<string, true | Promise<void>>()
  return {
    run(key: string, load: () => Promise<void>) {
      const active = state.get(key)
      if (active === true) return Promise.resolve()
      if (active) return active
      const pending = load()
        .then(() => {
          if (state.get(key) === pending) state.set(key, true)
        })
        .finally(() => {
          if (state.get(key) === pending) state.delete(key)
        })
      state.set(key, pending)
      return pending
    },
    complete(key: string) {
      if (state.has(key)) return
      state.set(key, true)
    },
    invalidate(key?: string) {
      if (key) {
        state.delete(key)
        return
      }
      state.clear()
    },
  }
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Store>({
      session: {
        info: {},
        family: {},
        active: {},
        message: {},
        pending: {},
        permission: {},
        form: {},
      },
      project: {
        permission: {},
      },
      location: {},
    })

    const client = useClient()
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: process.cwd(),
    })
    const messageIndex = new Map<string, Map<string, number>>()
    // Assistant content lives in per-message keyed part slots, not the Solid
    // store: streaming deltas publish one slot instead of reconciling arrays.
    const content = SessionContent.make()
    const sync = createSync()
    const pendingOperations = new Map<string, PendingOperation[]>()

    function setSessionActive(sessionID: string, status: DataSessionStatus) {
      setStore("session", "active", sessionID, status)
    }

    function addPending(item: SessionPendingInfo) {
      pendingOperations.get(item.sessionID)?.push({ type: "admitted", item })
      if (store.session.pending[item.sessionID]?.some((pending) => pending.id === item.id)) return
      setStore("session", "pending", item.sessionID, [...(store.session.pending[item.sessionID] ?? []), item])
    }

    function removePending(sessionID: string, inputID?: string) {
      if (!inputID) return
      pendingOperations.get(sessionID)?.push({ type: "promoted", inputID })
      setStore(
        "session",
        "pending",
        sessionID,
        (store.session.pending[sessionID] ?? []).filter((item) => item.id !== inputID),
      )
    }

    function pendingInputs(sessionID: string) {
      return (store.session.pending[sessionID] ?? []).filter((item) => item.type !== "compaction")
    }

    function syncPending(sessionID: string) {
      return sync.run(`session.pending:${sessionID}`, async () => {
        const operations = pendingOperations.get(sessionID) ?? []
        pendingOperations.set(sessionID, operations)
        try {
          const pending = new Map((await client.api.session.pending.list({ sessionID })).map((item) => [item.id, item]))
          operations.forEach((operation) => {
            if (operation.type === "admitted") {
              pending.set(operation.item.id, operation.item)
              return
            }
            if (operation.type === "promoted") {
              pending.delete(operation.inputID)
              return
            }
            pending.forEach((_, id) => {
              if (id >= operation.to) pending.delete(id)
            })
          })
          setStore("session", "pending", sessionID, reconcile([...pending.values()]))
        } finally {
          if (pendingOperations.get(sessionID) === operations) pendingOperations.delete(sessionID)
        }
      })
    }

    const message = {
      update(sessionID: string, fn: (messages: SessionMessageInfo[], index: Map<string, number>) => void) {
        setStore(
          "session",
          "message",
          produce((draft) => {
            fn((draft[sessionID] ??= []), index(sessionID))
          }),
        )
      },
      append(messages: SessionMessageInfo[], index: Map<string, number>, item: SessionMessageInfo) {
        if (index.has(item.id)) return
        index.set(item.id, messages.length)
        messages.push(item)
      },
      activeAssistant(messages: SessionMessageInfo[]) {
        const item = messages.findLast((item) => item.type === "assistant" && !item.time.completed)
        return item?.type === "assistant" ? item : undefined
      },
      assistant(messages: SessionMessageInfo[], index: Map<string, number>, messageID: string) {
        const position = index.get(messageID)
        const item = position === undefined ? undefined : messages[position]
        return item?.type === "assistant" ? item : undefined
      },
      shell(messages: SessionMessageInfo[], shellID: string) {
        const item = messages.findLast((item) => item.type === "shell" && item.shellID === shellID)
        return item?.type === "shell" ? item : undefined
      },
      compaction(messages: SessionMessageInfo[]) {
        const item = messages.findLast((item) => item.type === "compaction" && item.status === "running")
        return item?.type === "compaction" ? item : undefined
      },
      fromPending(item: SessionPendingInfo): SessionMessageInfo {
        if (item.type === "user")
          return {
            id: item.id,
            type: "user",
            ...item.data,
            time: { created: item.timeCreated },
          }
        if (item.type === "synthetic")
          return {
            id: item.id,
            type: "synthetic",
            ...item.data,
            time: { created: item.timeCreated },
          }
        return {
          id: item.id,
          type: "compaction",
          status: "running",
          reason: "manual",
          summary: "",
          recent: "",
          time: { created: item.timeCreated },
        }
      },
    }

    function index(sessionID: string) {
      const existing = messageIndex.get(sessionID)
      if (existing) return existing
      const created = new Map<string, number>()
      messageIndex.set(sessionID, created)
      return created
    }

    // Walk parentID upward through loaded session info to the family root. When a
    // parent's info is missing, that missing ID is the furthest-known ancestor and
    // is returned so orphan subtrees group under it until the parent arrives. A
    // seen set guards against parent cycles, stopping at the last non-repeating
    // ancestor.
    function resolveRoot(sessionID: string) {
      let current = sessionID
      let parentID = store.session.info[sessionID]?.parentID
      const seen = new Set([sessionID])
      while (parentID) {
        if (seen.has(parentID)) break
        seen.add(parentID)
        current = parentID
        parentID = store.session.info[parentID]?.parentID
      }
      return current
    }

    // Register one session into the family index. Idempotent: syncing an
    // existing session never duplicates its ID. When a tentative family keyed by
    // sessionID exists (descendants arrived while sessionID's own info was
    // absent) but sessionID turns out to have a parent, fold the orphan subtree
    // into the resolved root's family and drop the tentative entry.
    function registerSession(sessionID: string) {
      const info = store.session.info[sessionID]
      if (!info) return
      const rootID = resolveRoot(sessionID)
      setStore(
        "session",
        "family",
        produce((draft) => {
          if (sessionID !== rootID && draft[sessionID]) {
            const members = (draft[rootID] ??= [])
            for (const id of draft[sessionID]) {
              if (!members.includes(id)) members.push(id)
            }
            delete draft[sessionID]
          }
          const family = (draft[rootID] ??= [])
          if (!family.includes(sessionID)) family.push(sessionID)
        }),
      )
    }

    function removeSession(sessionID: string) {
      messageIndex.delete(sessionID)
      content.drop(sessionID)
      pendingOperations.delete(sessionID)
      sync.invalidate(`session:${sessionID}`)
      sync.invalidate(`session.pending:${sessionID}`)
      sync.invalidate(`session.message:${sessionID}`)
      sync.invalidate(`session.permission:${sessionID}`)
      sync.invalidate(`session.form:${sessionID}:`)
      setStore(
        "session",
        produce((draft) => {
          delete draft.info[sessionID]
          delete draft.active[sessionID]
          delete draft.message[sessionID]
          delete draft.pending[sessionID]
          delete draft.permission[sessionID]
          delete draft.form[sessionID]
          for (const [rootID, family] of Object.entries(draft.family)) {
            const next = family.filter((id) => id !== sessionID)
            if (next.length === 0) delete draft.family[rootID]
            else draft.family[rootID] = next
          }
        }),
      )
    }

    function handleEvent(event: OpenCodeEvent) {
      switch (event.type) {
        case "session.created":
          result.session.invalidate(event.data.sessionID)
          void result.session.sync(event.data.sessionID)
          break
        case "session.deleted":
          removeSession(event.data.sessionID)
          break
        case "session.usage.updated":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, {
              cost: event.data.cost,
              tokens: event.data.tokens,
            })
          break
        case "catalog.updated":
          result.location.model.invalidate(event.location)
          result.location.provider.invalidate(event.location)
          void Promise.all([result.location.model.sync(event.location), result.location.provider.sync(event.location)])
          break
        case "agent.updated":
          result.location.agent.invalidate(event.location)
          void result.location.agent.sync(event.location)
          break
        case "command.updated":
          result.location.command.invalidate(event.location)
          void result.location.command.sync(event.location)
          break
        case "skill.updated":
          result.location.skill.invalidate(event.location)
          void result.location.skill.sync(event.location)
          break
        case "session.agent.selected":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "agent", event.data.agent)
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "agent-switched",
              agent: event.data.agent,
              time: { created: event.created },
            })
          })
          break
        case "session.model.selected":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "model", event.data.model)
          if (!store.session.message[event.data.sessionID]) break
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "model-switched",
              model: event.data.model,
              time: { created: event.created },
            })
          })
          void client.api.session
            .message({ sessionID: event.data.sessionID, messageID: messageIDFromEvent(event.id) })
            .then((item) => {
              if (item.type === "assistant") content.seed(event.data.sessionID, item.id, item.content)
              message.update(event.data.sessionID, (draft, index) => {
                const position = index.get(item.id)
                if (position === undefined) return message.append(draft, index, item)
                draft[position] = item
              })
            })
            .catch((error) => console.error("Failed to load projected model switch message", error))
          break
        case "session.renamed":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "title", event.data.title)
          break
        case "session.moved":
          if (store.session.info[event.data.sessionID]) {
            setStore("session", "info", event.data.sessionID, "location", event.data.location)
            if (event.data.projectID)
              setStore("session", "info", event.data.sessionID, "projectID", event.data.projectID)
            setStore("session", "info", event.data.sessionID, "subpath", event.data.subpath)
          }
          break
        case "session.input.promoted": {
          const pending = store.session.pending[event.data.sessionID]?.some((item) => item.id === event.data.inputID)
          removePending(event.data.sessionID, event.data.inputID)
          message.update(event.data.sessionID, (draft, index) => {
            const position = index.get(event.data.inputID)
            if (position === undefined) return
            const existing = draft[position]
            if (!existing || !pending) return
            existing.time.created = event.created
            draft.splice(position, 1)
            draft.push(existing)
            index.clear()
            draft.forEach((message, indexValue) => index.set(message.id, indexValue))
          })
          break
        }
        case "session.input.admitted": {
          const pending: SessionPendingInfo = {
            id: event.data.inputID,
            sessionID: event.data.sessionID,
            admittedSeq: event.durable.seq,
            timeCreated: event.created,
            ...event.data.input,
          }
          addPending(pending)
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, message.fromPending(pending))
          })
          break
        }
        case "session.instructions.updated":
          const instructions = event.metadata?.instructions
          if (
            typeof instructions === "object" &&
            instructions !== null &&
            "initial" in instructions &&
            instructions.initial === true
          )
            break
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "system",
              text: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
              metadata: event.metadata,
              time: { created: event.created },
            })
          })
          break
        case "session.synthetic":
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "synthetic",
              text: event.data.text,
              description: event.data.description,
              metadata: event.data.metadata,
              time: { created: event.created },
            })
          })
          break
        case "session.shell.started":
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "shell",
              shellID: event.data.shell.id,
              command: event.data.shell.command,
              status: event.data.shell.status,
              exit: event.data.shell.exit,
              metadata: event.metadata,
              time: { created: event.created },
            })
          })
          break
        case "session.shell.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.shell(draft, event.data.shell.id)
            if (!match) return
            match.status = event.data.shell.status
            match.exit = event.data.shell.exit
            match.output = event.data.output
            match.time.completed = event.created
          })
          break
        case "session.step.started":
          message.update(event.data.sessionID, (draft, index) => {
            const position = index.get(event.data.assistantMessageID)
            const existing = position === undefined ? undefined : draft[position]
            if (existing?.type === "assistant") {
              existing.agent = event.data.agent
              existing.model = event.data.model
              existing.retry = undefined
              existing.error = undefined
              existing.finish = undefined
              existing.time.completed = undefined
              if (event.data.snapshot) existing.snapshot = { ...existing.snapshot, start: event.data.snapshot }
              return
            }
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) {
              currentAssistant.retry = undefined
              currentAssistant.time.completed = event.created
            }
            message.append(draft, index, {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              metadata: event.metadata,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.created },
            })
          })
          break
        case "session.step.ended": {
          message.update(event.data.sessionID, (draft, index) => {
            const currentAssistant = message.assistant(draft, index, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.created
            currentAssistant.finish = event.data.finish
            currentAssistant.cost = event.data.cost
            currentAssistant.tokens = event.data.tokens
            if (event.data.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.data.snapshot }
          })
          break
        }
        case "session.step.failed":
          message.update(event.data.sessionID, (draft, index) => {
            const currentAssistant = message.assistant(draft, index, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.created
            currentAssistant.finish = "error"
            currentAssistant.error = event.data.error
            currentAssistant.retry = undefined
            if (event.data.cost !== undefined && event.data.tokens !== undefined) {
              currentAssistant.cost = event.data.cost
              currentAssistant.tokens = event.data.tokens
            }
          })
          break
        case "session.text.started": {
          const parts = content.ensure(event.data.sessionID, event.data.assistantMessageID)
          const partID = SessionContent.textID(event.data.ordinal)
          if (!parts.has(partID)) parts.insert({ type: "text", text: "", partID })
          break
        }
        case "session.text.delta":
          content
            .get(event.data.sessionID, event.data.assistantMessageID)
            ?.modify(SessionContent.textID(event.data.ordinal), (part) =>
              part.type === "text" ? { ...part, text: part.text + event.data.delta } : part,
            )
          break
        case "session.text.ended":
          content
            .get(event.data.sessionID, event.data.assistantMessageID)
            ?.modify(SessionContent.textID(event.data.ordinal), (part) =>
              part.type === "text" ? { ...part, text: event.data.text } : part,
            )
          break
        case "session.tool.input.started": {
          const parts = content.ensure(event.data.sessionID, event.data.assistantMessageID)
          if (!parts.has(event.data.callID))
            parts.insert({
              type: "tool",
              id: event.data.callID,
              name: event.data.name,
              time: { created: event.created },
              state: { status: "streaming", input: "" },
              partID: event.data.callID,
            })
          break
        }
        case "session.tool.input.delta":
          content.get(event.data.sessionID, event.data.assistantMessageID)?.modify(event.data.callID, (part) => {
            if (part.type !== "tool" || part.state.status !== "streaming") return part
            return { ...part, state: { ...part.state, input: part.state.input + event.data.delta } }
          })
          break
        case "session.tool.input.ended":
          content.get(event.data.sessionID, event.data.assistantMessageID)?.modify(event.data.callID, (part) => {
            if (part.type !== "tool" || part.state.status !== "streaming") return part
            return { ...part, state: { ...part.state, input: event.data.text } }
          })
          break
        case "session.tool.called":
          content.get(event.data.sessionID, event.data.assistantMessageID)?.modify(event.data.callID, (part) => {
            if (part.type !== "tool") return part
            return {
              ...part,
              time: { ...part.time, ran: event.created },
              executed: event.data.executed,
              providerState: event.data.state,
              state: { status: "running", input: event.data.input, structured: {}, content: [] },
            }
          })
          break
        case "session.tool.progress":
          content.get(event.data.sessionID, event.data.assistantMessageID)?.modify(event.data.callID, (part) => {
            if (part.type !== "tool" || part.state.status !== "running") return part
            return {
              ...part,
              state: { ...part.state, structured: event.data.structured, content: [...event.data.content] },
            }
          })
          break
        case "session.tool.success":
          content.get(event.data.sessionID, event.data.assistantMessageID)?.modify(event.data.callID, (part) => {
            if (part.type !== "tool" || part.state.status !== "running") return part
            return {
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                structured: event.data.structured,
                content: [...event.data.content],
                result: event.data.result,
              },
              executed: event.data.executed || part.executed === true,
              providerResultState: event.data.resultState,
              time: { ...part.time, completed: event.created },
            }
          })
          break
        case "session.tool.failed":
          content.get(event.data.sessionID, event.data.assistantMessageID)?.modify(event.data.callID, (part) => {
            if (part.type !== "tool" || (part.state.status !== "streaming" && part.state.status !== "running"))
              return part
            return {
              ...part,
              state: {
                status: "error",
                error: event.data.error,
                input: typeof part.state.input === "string" ? {} : part.state.input,
                structured: part.state.status === "running" ? part.state.structured : {},
                content: part.state.status === "running" ? part.state.content : [],
                result: event.data.result,
              },
              executed: event.data.executed || part.executed === true,
              providerResultState: event.data.resultState,
              time: { ...part.time, completed: event.created },
            }
          })
          break
        case "session.reasoning.started": {
          const parts = content.ensure(event.data.sessionID, event.data.assistantMessageID)
          const partID = SessionContent.reasoningID(event.data.ordinal)
          if (!parts.has(partID))
            parts.insert({
              type: "reasoning",
              text: "",
              state: event.data.state,
              time: { created: event.created },
              partID,
            })
          break
        }
        case "session.reasoning.delta":
          content
            .get(event.data.sessionID, event.data.assistantMessageID)
            ?.modify(SessionContent.reasoningID(event.data.ordinal), (part) =>
              part.type === "reasoning" ? { ...part, text: part.text + event.data.delta } : part,
            )
          break
        case "session.reasoning.ended":
          content
            .get(event.data.sessionID, event.data.assistantMessageID)
            ?.modify(SessionContent.reasoningID(event.data.ordinal), (part) => {
              if (part.type !== "reasoning") return part
              return {
                ...part,
                text: event.data.text,
                time: { created: part.time?.created ?? event.created, completed: event.created },
                state: event.data.state !== undefined ? event.data.state : part.state,
              }
            })
          break
        case "session.retry.scheduled":
          message.update(event.data.sessionID, (draft, index) => {
            const currentAssistant = message.assistant(draft, index, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.retry = {
              attempt: event.data.attempt,
              at: event.data.at,
              error: event.data.error,
            }
          })
          break
        case "session.execution.started":
          setSessionActive(event.data.sessionID, "running")
          break
        case "session.compaction.admitted":
          addPending({
            id: event.data.inputID,
            sessionID: event.data.sessionID,
            admittedSeq: event.durable.seq,
            timeCreated: event.created,
            type: "compaction",
          })
          break
        case "session.compaction.started":
          removePending(event.data.sessionID, event.data.inputID)
          message.update(event.data.sessionID, (draft, index) => {
            message.append(draft, index, {
              id: event.data.inputID ?? messageIDFromEvent(event.id),
              type: "compaction",
              status: "running",
              reason: event.data.reason,
              summary: "",
              recent: event.data.recent ?? "",
              time: { created: event.created },
            })
          })
          break
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          setSessionActive(event.data.sessionID, "idle")
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) currentAssistant.retry = undefined
          })
          break
        case "session.revert.staged":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "revert", event.data.revert)
          break
        case "session.revert.cleared":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "revert", undefined)
          break
        case "session.revert.committed":
          if (store.session.info[event.data.sessionID]) {
            setStore("session", "info", event.data.sessionID, "revert", undefined)
          }
          pendingOperations.get(event.data.sessionID)?.push({ type: "reverted", to: event.data.to })
          setStore(
            "session",
            "pending",
            event.data.sessionID,
            (store.session.pending[event.data.sessionID] ?? []).filter((item) => item.id < event.data.to),
          )
          message.update(event.data.sessionID, (draft, index) => {
            const position = draft.findIndex((item) => item.id >= event.data.to)
            if (position === -1) return
            for (const item of draft.splice(position)) {
              index.delete(item.id)
              content.drop(event.data.sessionID, item.id)
            }
          })
          break
        case "session.compaction.delta":
          message.update(event.data.sessionID, (draft) => {
            const current = message.compaction(draft)
            if (current?.status === "running") current.summary += event.data.text
          })
          break
        case "session.compaction.ended":
          message.update(event.data.sessionID, (draft, index) => {
            const position = draft.findLastIndex((item) => item.type === "compaction" && item.status === "running")
            const current = draft[position]
            if (current?.type === "compaction") {
              Object.assign(current, {
                status: "completed",
                reason: event.data.reason,
                summary: event.data.text,
                recent: event.data.recent,
              })
              return
            }
            message.append(draft, index, {
              id: messageIDFromEvent(event.id),
              type: "compaction",
              status: "completed",
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              time: { created: event.created },
            })
          })
          break
        case "session.compaction.failed":
          removePending(event.data.sessionID, event.data.inputID)
          message.update(event.data.sessionID, (draft, index) => {
            const position = draft.findLastIndex((item) => item.type === "compaction" && item.status === "running")
            const current = draft[position]
            const failed: Extract<SessionMessageInfo, { type: "compaction"; status: "failed" }> = {
              id: current?.id ?? event.data.inputID ?? messageIDFromEvent(event.id),
              type: "compaction",
              status: "failed",
              reason: event.data.reason ?? "manual",
              error: event.data.error ?? {
                type: "compaction.failed",
                message: "Compaction failed before recording an error",
              },
              metadata: current?.type === "compaction" ? current.metadata : event.metadata,
              time: current?.type === "compaction" ? current.time : { created: event.created },
            }
            if (current?.type === "compaction") {
              draft[position] = failed
              return
            }
            message.append(draft, index, failed)
          })
          break
        case "permission.v2.asked":
          if (store.session.permission[event.data.sessionID]?.some((request) => request.id === event.data.id)) break
          setStore("session", "permission", event.data.sessionID, [
            ...(store.session.permission[event.data.sessionID] ?? []),
            event.data,
          ])
          break
        case "permission.v2.replied":
          setStore(
            "session",
            "permission",
            event.data.sessionID,
            (store.session.permission[event.data.sessionID] ?? []).filter(
              (request) => request.id !== event.data.requestID,
            ),
          )
          break
        case "form.created":
          if (store.session.form[event.data.form.sessionID]?.some((form) => form.id === event.data.form.id)) break
          setStore("session", "form", event.data.form.sessionID, [
            ...(store.session.form[event.data.form.sessionID] ?? []),
            event.data.form.sessionID === "global" ? { ...event.data.form, location: event.location } : event.data.form,
          ])
          break
        case "form.replied":
        case "form.cancelled":
          setStore(
            "session",
            "form",
            event.data.sessionID,
            (store.session.form[event.data.sessionID] ?? []).filter((form) => form.id !== event.data.id),
          )
          break
        case "shell.created":
          setStore("location", locationKey(event.location ?? defaultLocation()), (data) => ({
            ...data,
            shell: { ...data?.shell, [event.data.info.id]: event.data.info },
          }))
          break
        case "shell.exited":
        case "shell.deleted":
          if (event.location) {
            setStore("location", locationKey(event.location), (data) => ({
              ...data,
              shell: Object.fromEntries(Object.entries(data?.shell ?? {}).filter(([id]) => id !== event.data.id)),
            }))
            break
          }
          setStore(
            "location",
            produce((draft) => {
              for (const data of Object.values(draft)) delete data.shell?.[event.data.id]
            }),
          )
          break
        case "reference.updated":
          result.location.reference.invalidate()
          void result.location.reference.sync()
          break
        case "integration.updated":
          result.location.integration.invalidate(event.location)
          result.location.model.invalidate(event.location)
          result.location.provider.invalidate(event.location)
          void Promise.all([
            result.location.integration.sync(event.location),
            result.location.model.sync(event.location),
            result.location.provider.sync(event.location),
          ])
          break
        // Authenticating an MCP integration reconnects its server, which emits mcp.status.changed,
        // so the mcp list syncs here rather than off integration.updated.
        case "mcp.status.changed":
          result.location.mcp.server.invalidate(event.location)
          void result.location.mcp.server.sync(event.location)
          break
        case "mcp.resources.changed":
          result.location.mcp.resource.invalidate(event.location)
          void result.location.mcp.resource.sync(event.location)
          break
      }
    }

    const result = {
      on: client.event.on,
      listen: client.event.listen,
      session: {
        list() {
          return Object.values(store.session.info).toSorted((a, b) => b.time.updated - a.time.updated)
        },
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        root(sessionID: string) {
          return resolveRoot(sessionID)
        },
        family(sessionID: string) {
          return store.session.family[resolveRoot(sessionID)] ?? []
        },
        cost(sessionID: string) {
          const session = store.session.info[sessionID]
          if (!session) return 0
          if (session.parentID) return session.cost
          return (store.session.family[sessionID] ?? [sessionID]).reduce(
            (total, id) => total + (store.session.info[id]?.cost ?? 0),
            0,
          )
        },
        status(sessionID: string) {
          return store.session.active[sessionID] ?? "idle"
        },
        input: {
          list(sessionID: string) {
            return pendingInputs(sessionID).map((item) => item.id)
          },
          has(sessionID: string, inputID: string) {
            return pendingInputs(sessionID).some((item) => item.id === inputID)
          },
        },
        pending: {
          list(sessionID: string) {
            return store.session.pending[sessionID] ?? []
          },
          sync(sessionID: string) {
            return syncPending(sessionID)
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.pending:${sessionID}`)
          },
        },
        sync(sessionID: string) {
          return sync.run(`session:${sessionID}`, async () => {
            setStore("session", "info", sessionID, await client.api.session.get({ sessionID }))
            registerSession(sessionID)
          })
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session:${sessionID}`)
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID] ?? []
          },
          get(sessionID: string, messageID: string) {
            const messages = store.session.message[sessionID]
            const position = messageIndex.get(sessionID)?.get(messageID)
            return position === undefined ? undefined : messages?.[position]
          },
          sync(sessionID: string) {
            return sync.run(`session.message:${sessionID}`, async () => {
              await syncPending(sessionID)
              const localInputs = pendingInputs(sessionID).map((item) => item.id)
              const pendingMessages = [...(store.session.pending[sessionID] ?? [])].map(message.fromPending)
              const projected = await client.api.message.list({ sessionID, limit: 200, order: "desc" })
              const next = projected.data.toReversed()
              const index = new Map(next.map((message, index) => [message.id, index]))
              const localInputIDs = new Set([...localInputs, ...pendingInputs(sessionID).map((item) => item.id)])
              localInputIDs.forEach((messageID) => {
                const position = messageIndex.get(sessionID)?.get(messageID)
                const item = position === undefined ? undefined : store.session.message[sessionID]?.[position]
                if (item) message.append(next, index, item)
              })
              pendingMessages.forEach((item) => message.append(next, index, item))
              messageIndex.set(sessionID, index)
              // Reseed part collections in place from the final hydrated list;
              // prune only collections whose messages are truly gone.
              content.prune(sessionID, new Set(next.map((message) => message.id)))
              for (const item of next) {
                if (item.type === "assistant") content.seed(sessionID, item.id, item.content)
              }
              setStore("session", "message", sessionID, reconcile(next))
            })
          },
          parts(sessionID: string, messageID: string) {
            return content.ensure(sessionID, messageID)
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.message:${sessionID}`)
          },
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          sync(sessionID: string) {
            return sync.run(`session.permission:${sessionID}`, async () => {
              setStore("session", "permission", sessionID, await client.api.permission.list({ sessionID }))
            })
          },
          invalidate(sessionID: string) {
            sync.invalidate(`session.permission:${sessionID}`)
          },
        },
        form: {
          list(sessionID: string, ref?: LocationRef) {
            const forms = store.session.form[sessionID]
            if (sessionID !== "global") return forms
            if (!ref) return
            const key = locationKey(ref)
            return forms?.filter((form) => form.location && locationKey(form.location) === key)
          },
          sync(sessionID: string, ref?: LocationRef) {
            const key = `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`
            return sync.run(key, async () => {
              if (sessionID === "global") {
                const response = await client.api.form.request.list({
                  location: locationQuery(ref ?? defaultLocation()),
                })
                const location = {
                  directory: response.location.directory,
                  workspaceID: response.location.workspaceID,
                }
                const locationID = locationKey(location)
                setStore("session", "form", sessionID, [
                  ...(store.session.form[sessionID] ?? []).filter(
                    (form) => form.location && locationKey(form.location) !== locationID,
                  ),
                  ...response.data.filter((form) => form.sessionID === "global").map((form) => ({ ...form, location })),
                ])
                return
              }
              setStore("session", "form", sessionID, await client.api.form.list({ sessionID }))
            })
          },
          invalidate(sessionID: string, ref?: LocationRef) {
            sync.invalidate(
              `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`,
            )
          },
        },
      },
      project: {
        permission: {
          list(projectID: string) {
            return store.project.permission[projectID]
          },
          sync(projectID: string) {
            return sync.run(`project.permission:${projectID}`, async () => {
              setStore("project", "permission", projectID, await client.api.permission.saved.list({ projectID }))
            })
          },
          invalidate(projectID: string) {
            sync.invalidate(`project.permission:${projectID}`)
          },
        },
      },
      shell: {
        list(location?: LocationRef) {
          return Object.values(store.location[locationKey(location ?? defaultLocation())]?.shell ?? {})
        },
        get(id: string) {
          return Object.values(store.location)
            .map((data) => data.shell?.[id])
            .find((shell) => shell !== undefined)
        },
        sync(ref?: LocationRef) {
          const id = locationKey(ref ?? defaultLocation())
          return sync.run(`location.shell:${id}`, async () => {
            const response = await client.api.shell.list({ location: locationQuery(ref ?? defaultLocation()) })
            const key = locationKey(response.location)
            setStore("location", key, {
              ...store.location[key],
              shell: Object.fromEntries(response.data.map((info) => [info.id, info])),
            })
          })
        },
        invalidate(ref?: LocationRef) {
          sync.invalidate(`location.shell:${locationKey(ref ?? defaultLocation())}`)
        },
      },
      location: {
        info(ref?: LocationRef) {
          return store.location[locationKey(ref ?? defaultLocation())]?.info
        },
        default() {
          return defaultLocation()
        },
        async sync(ref?: LocationRef) {
          const current = ref ?? defaultLocation()
          await sync.run(`location:${locationKey(current)}`, async () => {
            const location = await client.api.location.get({ location: locationQuery(current) })
            const key = locationKey(location)
            if (!store.location[key]) setStore("location", key, {})
            setStore("location", key, "info", location)
            if (!ref) {
              setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
            }
          })
          const location = ref ?? defaultLocation()
          await Promise.all([
            result.location.agent.sync(location),
            result.location.command.sync(location),
            result.location.integration.sync(location),
            result.location.mcp.server.sync(location),
            result.location.mcp.resource.sync(location),
            result.location.model.sync(location),
            result.location.provider.sync(location),
            result.location.reference.sync(location),
            result.location.skill.sync(location),
            result.shell.sync(location),
            result.session.form.sync("global", location),
          ])
        },
        invalidate(ref?: LocationRef) {
          const location = ref ?? defaultLocation()
          sync.invalidate(`location:${locationKey(location)}`)
          result.location.agent.invalidate(location)
          result.location.command.invalidate(location)
          result.location.integration.invalidate(location)
          result.location.mcp.server.invalidate(location)
          result.location.mcp.resource.invalidate(location)
          result.location.model.invalidate(location)
          result.location.provider.invalidate(location)
          result.location.reference.invalidate(location)
          result.location.skill.invalidate(location)
          result.shell.invalidate(location)
          result.session.form.invalidate("global", location)
        },
        agent: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.agent
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.agent:${id}`, async () => {
              const response = await client.api.agent.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], agent: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.agent:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        command: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.command
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.command:${id}`, async () => {
              const response = await client.api.command.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], command: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.command:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        integration: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.integration
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.integration:${id}`, async () => {
              const response = await client.api.integration.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], integration: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.integration:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        mcp: {
          server: {
            list(location?: LocationRef) {
              return store.location[locationKey(location ?? defaultLocation())]?.mcp?.server
            },
            sync(ref?: LocationRef) {
              const id = locationKey(ref ?? defaultLocation())
              return sync.run(`location.mcp.server:${id}`, async () => {
                const response = await client.api.mcp.list({ location: locationQuery(ref ?? defaultLocation()) })
                const key = locationKey(response.location)
                setStore("location", key, {
                  ...store.location[key],
                  mcp: { ...store.location[key]?.mcp, server: response.data },
                })
              })
            },
            invalidate(ref?: LocationRef) {
              sync.invalidate(`location.mcp.server:${locationKey(ref ?? defaultLocation())}`)
            },
          },
          resource: {
            list(location?: LocationRef) {
              return store.location[locationKey(location ?? defaultLocation())]?.mcp?.resource
            },
            sync(ref?: LocationRef) {
              const id = locationKey(ref ?? defaultLocation())
              return sync.run(`location.mcp.resource:${id}`, async () => {
                const response = await client.api.mcp.resource.catalog({
                  location: locationQuery(ref ?? defaultLocation()),
                })
                const key = locationKey(response.location)
                setStore("location", key, {
                  ...store.location[key],
                  mcp: { ...store.location[key]?.mcp, resource: response.data.resources },
                })
              })
            },
            invalidate(ref?: LocationRef) {
              sync.invalidate(`location.mcp.resource:${locationKey(ref ?? defaultLocation())}`)
            },
          },
        },
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.model:${id}`, async () => {
              const response = await client.api.model.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], model: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.model:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        provider: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.provider
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.provider:${id}`, async () => {
              const response = await client.api.provider.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], provider: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.provider:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.reference:${id}`, async () => {
              const response = await client.api.reference.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], reference: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.reference:${locationKey(ref ?? defaultLocation())}`)
          },
        },
        skill: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.skill
          },
          sync(ref?: LocationRef) {
            const id = locationKey(ref ?? defaultLocation())
            return sync.run(`location.skill:${id}`, async () => {
              const response = await client.api.skill.list({ location: locationQuery(ref ?? defaultLocation()) })
              const key = locationKey(response.location)
              setStore("location", key, { ...store.location[key], skill: response.data })
            })
          },
          invalidate(ref?: LocationRef) {
            sync.invalidate(`location.skill:${locationKey(ref ?? defaultLocation())}`)
          },
        },
      },
    }
    result satisfies Plugin.Context["data"]

    createEffect(() => {
      if (client.connection.status() === "connected") return
      sync.invalidate()
    })

    onCleanup(
      client.event.listen(({ details }) => {
        if (details.type === "server.connected") {
          void client.api.session
            .active()
            .then((active) => {
              setStore(
                "session",
                "active",
                reconcile(Object.fromEntries(Object.keys(active).map((sessionID) => [sessionID, "running" as const]))),
              )
            })
            .catch(() => undefined)
          void client.api.location
            .get({ location: locationQuery(defaultLocation()) })
            .then((location) => {
              const key = locationKey(location)
              setStore("location", key, { ...store.location[key], info: location })
              return client.api.session.list({
                project: location.project.id,
                limit: 50,
                order: "desc",
              })
            })
            .then((response) => {
              setStore(
                "session",
                "info",
                produce((draft) => {
                  for (const session of response.data) draft[session.id] = session
                }),
              )
              for (const session of response.data) {
                sync.complete(`session:${session.id}`)
                registerSession(session.id)
              }
            })
            .catch((error) => console.error("Failed to preload sessions", error))
          return
        }
        handleEvent(details)
      }),
    )

    return result
  },
})
