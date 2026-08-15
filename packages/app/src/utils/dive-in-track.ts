import type {
  AgentPartInput,
  AssistantMessage,
  DiveInInfo,
  FilePart,
  FilePartInput,
  LlmToolContent,
  Message,
  Part,
  PromptAgentAttachment,
  PromptFileAttachment,
  PromptInput,
  PromptInputFileAttachment,
  PromptSource,
  Session,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageUser,
} from "@opencode-ai/sdk/v2/client"
import type { PromptRequestPart } from "@/components/prompt-input/build-request-parts"

export function findDiveInTrack(groups: readonly DiveInInfo[] | undefined, sessionID: string) {
  return groups?.flatMap((group) => group.tracks).find((track) => track.sessionID === sessionID)
}

export function isDiveInTrackSession(groups: readonly DiveInInfo[] | undefined, sessionID: string) {
  return !!findDiveInTrack(groups, sessionID)
}

export function isActiveDiveInTrackSession(groups: readonly DiveInInfo[] | undefined, sessionID: string) {
  return !!groups?.some(
    (group) =>
      group.status === "active" &&
      group.tracks.some((track) => track.sessionID === sessionID && track.status === "active"),
  )
}

export function diveInInitialPrompt(prompt: string, messageText: string) {
  const value = prompt.trim()
  if (!value || messageText.includes(value)) return
  return prompt
}

export function toPromptInput(parts: readonly PromptRequestPart[]): PromptInput {
  const files = parts.flatMap((part): PromptInputFileAttachment[] => {
    if (part.type !== "file") return []
    const source = toPromptSource(part.source)
    return [
      {
        uri: part.url,
        ...(part.filename === undefined ? {} : { name: part.filename }),
        ...(source ? { source } : {}),
      },
    ]
  })
  const agents = parts.flatMap((part): PromptAgentAttachment[] => {
    if (part.type !== "agent") return []
    return [
      {
        name: part.name,
        ...(part.source ? { source: toPromptSource(part.source) } : {}),
      },
    ]
  })

  return {
    text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
  }
}

export type TrackTimelineData = {
  messages: Message[]
  parts: Record<string, Part[]>
}

export function adaptTrackMessages(input: {
  sessionID: string
  messages: readonly SessionMessage[]
  session?: Session
}): TrackTimelineData {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}
  let parentID: string | undefined
  let agent = input.session?.agent ?? "build"
  let model = input.session?.model
    ? {
        providerID: input.session.model.providerID,
        modelID: input.session.model.id,
        variant: input.session.model.variant,
      }
    : { providerID: "", modelID: "" }

  for (const message of [...input.messages].sort(cmpMessage)) {
    if (message.type === "user") {
      parentID = message.id
      const info = legacyUserMessage(message, input.sessionID, agent, model)
      messages.push(info)
      parts[message.id] = legacyUserParts(message, input.sessionID)
      continue
    }

    if (message.type !== "assistant") continue

    agent = message.agent
    model = {
      providerID: message.model.providerID,
      modelID: message.model.id,
      variant: message.model.variant,
    }
    messages.push(legacyAssistantMessage(message, input.sessionID, input.session, parentID ?? message.id))
    parts[message.id] = legacyAssistantParts(message, input.sessionID)
  }

  return { messages, parts }
}

function toPromptSource(source: FilePartInput["source"] | AgentPartInput["source"]): PromptSource | undefined {
  if (!source) return
  if ("text" in source) {
    return { start: source.text.start, end: source.text.end, text: source.text.value }
  }
  return { start: source.start, end: source.end, text: source.value }
}

function cmpMessage(a: SessionMessage, b: SessionMessage) {
  return a.time.created - b.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function legacyUserMessage(
  message: SessionMessageUser,
  sessionID: string,
  agent: string,
  model: { providerID: string; modelID: string; variant?: string },
) {
  return {
    id: message.id,
    sessionID,
    role: "user" as const,
    time: message.time,
    agent,
    model,
  }
}

function legacyUserParts(message: SessionMessageUser, sessionID: string): Part[] {
  const text = message.text
    ? [
        {
          id: `${message.id}:text`,
          sessionID,
          messageID: message.id,
          type: "text" as const,
          text: message.text,
        },
      ]
    : []
  const files = (message.files ?? []).map((file, index) => legacyFilePart(file, sessionID, message.id, `file:${index}`))
  const agents = (message.agents ?? []).map((agent, index) => ({
    id: `${message.id}:agent:${index}`,
    sessionID,
    messageID: message.id,
    type: "agent" as const,
    name: agent.name,
    ...(agent.source
      ? { source: { value: agent.source.text, start: agent.source.start, end: agent.source.end } }
      : {}),
  }))
  return [...text, ...files, ...agents]
}

function legacyAssistantMessage(
  message: SessionMessageAssistant,
  sessionID: string,
  session: Session | undefined,
  parentID: string,
): AssistantMessage {
  const directory = session?.directory ?? ""
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    ...(message.error ? { error: { name: "UnknownError" as const, data: { message: message.error.message } } } : {}),
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: directory, root: directory },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.model.variant ? { variant: message.model.variant } : {}),
  }
}

function legacyAssistantParts(message: SessionMessageAssistant, sessionID: string): Part[] {
  return message.content.flatMap((content, index): Part[] => {
    if (content.type === "text") {
      return [
        {
          id: content.id,
          sessionID,
          messageID: message.id,
          type: "text" as const,
          text: content.text,
        },
      ]
    }

    if (content.type === "reasoning") {
      return [
        {
          id: content.id,
          sessionID,
          messageID: message.id,
          type: "reasoning" as const,
          text: content.text,
          time: {
            start: content.time?.created ?? message.time.created,
            ...(content.time?.completed ? { end: content.time.completed } : {}),
          },
        },
      ]
    }

    return [legacyToolPart(content, sessionID, message.id, index)]
  })
}

function legacyFilePart(file: PromptFileAttachment, sessionID: string, messageID: string, suffix: string): FilePart {
  return {
    id: `${messageID}:${suffix}`,
    sessionID,
    messageID,
    type: "file",
    mime: file.mime,
    url: file.uri,
    ...(file.name === undefined ? {} : { filename: file.name }),
  }
}

function legacyToolPart(
  content: SessionMessageAssistantTool,
  sessionID: string,
  messageID: string,
  index: number,
): Extract<Part, { type: "tool" }> {
  const base = {
    id: content.id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: content.id,
    tool: content.name,
  }
  const state = content.state
  if (state.status === "pending") {
    return { ...base, state: { status: "pending", input: {}, raw: state.input } }
  }

  if (state.status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: state.input,
        title: content.name,
        metadata: state.structured,
        time: { start: content.time.ran ?? content.time.created },
      },
    }
  }

  if (state.status === "completed") {
    return {
      ...base,
      state: {
        status: "completed",
        input: state.input,
        output: toolContentText(state.content),
        title: content.name,
        metadata: state.structured,
        time: {
          start: content.time.ran ?? content.time.created,
          end: content.time.completed ?? content.time.created,
        },
        ...(state.attachments
          ? {
              attachments: state.attachments.map((file, attachmentIndex) =>
                legacyFilePart(file, sessionID, messageID, `tool:${index}:${attachmentIndex}`),
              ),
            }
          : {}),
      },
    }
  }

  return {
    ...base,
    state: {
      status: "error",
      input: state.input,
      error: state.error.message,
      metadata: state.structured,
      time: {
        start: content.time.ran ?? content.time.created,
        end: content.time.completed ?? content.time.created,
      },
    },
  }
}

function toolContentText(content: readonly LlmToolContent[]) {
  return content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
}
