import { Identifier } from "@opencode-ai/core/id/id"
import type {
  AgentPart,
  AssistantMessage,
  DiveInInfo,
  FilePart,
  LlmToolContent,
  Message,
  Part,
  PromptInput,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageUser,
  SessionV2Info,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../prompt/history"

export function findDiveInTrack(groups: DiveInInfo[], sessionID: string) {
  return groups.flatMap((group) => group.tracks).find((track) => track.sessionID === sessionID)
}

export function isActiveDiveInTrack(track: DiveInInfo["tracks"][number] | undefined) {
  return track?.status === "active"
}

export function createDiveInPromptID() {
  return Identifier.ascending("message")
}

export function toDiveInPrompt(input: { text: string; editorText?: string; parts: PromptInfo["parts"] }): PromptInput {
  const files = input.parts.flatMap((part) => {
    if (part.type !== "file") return []
    return [
      {
        uri: part.url,
        ...(part.filename ? { name: part.filename } : {}),
        ...(part.source
          ? {
              source: {
                start: part.source.text.start,
                end: part.source.text.end,
                text: part.source.text.value,
              },
            }
          : {}),
      },
    ]
  })
  const agents = input.parts.flatMap((part) => {
    if (part.type !== "agent") return []
    return [
      {
        name: part.name,
        ...(part.source
          ? {
              source: {
                start: part.source.start,
                end: part.source.end,
                text: part.source.value,
              },
            }
          : {}),
      },
    ]
  })

  return {
    text: `${input.editorText ?? ""}${input.text}`,
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
  }
}

export function toDiveInPendingMessage(id: string, prompt: PromptInput, parts: PromptInfo["parts"]): SessionMessageUser {
  const files = prompt.files?.map((file) => {
    const source = parts.find((part) => part.type === "file" && part.url === file.uri)
    return {
      ...file,
      mime: source?.type === "file" ? source.mime : "application/octet-stream",
    }
  })

  return {
    id,
    type: "user",
    text: prompt.text,
    files,
    agents: prompt.agents,
    time: { created: Date.now() },
  }
}

type DiveInPromptClient = {
  prompt: (
    input: {
      sessionID: string
      id?: string
      prompt?: PromptInput
      delivery?: "steer" | "queue"
    },
    options?: { throwOnError?: boolean },
  ) => Promise<unknown>
}

export function submitDiveInPrompt(
  client: DiveInPromptClient,
  sessionID: string,
  prompt: PromptInput,
  id = createDiveInPromptID(),
) {
  return client.prompt(
    {
      sessionID,
      id,
      prompt,
      delivery: "steer",
    },
    { throwOnError: true },
  )
}

export function adaptDiveInMessages(input: {
  sessionID: string
  messages: SessionMessage[]
  session?: SessionV2Info
}): { messages: Message[]; parts: Record<string, Part[]> } {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}
  const chronological = input.messages.toReversed()

  chronological.forEach((message, index) => {
    if (message.type === "user") {
      const info = toUserMessage(message, input.sessionID, input.session)
      messages.push(info)
      parts[message.id] = toUserParts(message, input.sessionID)
      return
    }
    if (message.type !== "assistant") return

    const parentID = chronological
      .slice(0, index)
      .findLast((item): item is SessionMessageUser => item.type === "user")?.id
    const info = toAssistantMessage(message, input.sessionID, parentID)
    messages.push(info)
    parts[message.id] = toAssistantParts(message, input.sessionID)
  })

  return { messages, parts }
}

function toUserMessage(message: SessionMessageUser, sessionID: string, session: SessionV2Info | undefined): UserMessage {
  const model = session?.model
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: message.time,
    agent: session?.agent ?? "",
    model: {
      providerID: model?.providerID ?? "",
      modelID: model?.id ?? "",
      variant: model?.variant,
    },
  }
}

function toUserParts(message: SessionMessageUser, sessionID: string): Part[] {
  const text: Part = {
    id: `${message.id}:text`,
    sessionID,
    messageID: message.id,
    type: "text",
    text: message.text,
  }
  const files = (message.files ?? []).map(
    (file, index): FilePart => ({
      id: `${message.id}:file:${index}`,
      sessionID,
      messageID: message.id,
      type: "file",
      mime: file.mime,
      filename: file.name,
      url: file.uri,
    }),
  )
  const agents = (message.agents ?? []).map(
    (agent, index): AgentPart => ({
      id: `${message.id}:agent:${index}`,
      sessionID,
      messageID: message.id,
      type: "agent",
      name: agent.name,
      ...(agent.source
        ? {
            source: {
              value: agent.source.text,
              start: agent.source.start,
              end: agent.source.end,
            },
          }
        : {}),
    }),
  )
  return [text, ...files, ...agents]
}

function toAssistantMessage(
  message: SessionMessageAssistant,
  sessionID: string,
  parentID: string | undefined,
): AssistantMessage {
  const tokens = message.tokens ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    ...(message.error ? { error: { name: "UnknownError", data: { message: message.error.message } } } : {}),
    parentID: parentID ?? "",
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens,
    finish: message.finish,
  }
}

function toAssistantParts(message: SessionMessageAssistant, sessionID: string): Part[] {
  return message.content.flatMap((part): Part[] => {
    if (part.type === "text") {
      return [
        {
          id: part.id,
          sessionID,
          messageID: message.id,
          type: "text" as const,
          text: part.text,
        },
      ]
    }
    if (part.type === "reasoning") {
      return [
        {
          id: part.id,
          sessionID,
          messageID: message.id,
          type: "reasoning" as const,
          text: part.text,
          time: {
            start: part.time?.created ?? message.time.created,
            end: part.time?.completed,
          },
        },
      ]
    }
    return [toToolPart(message.id, sessionID, part)]
  })
}

function toToolPart(messageID: string, sessionID: string, part: SessionMessageAssistantTool): ToolPart {
  const start = part.time.ran ?? part.time.created
  const end = part.time.completed ?? part.time.created
  const state = part.state

  if (state.status === "pending") {
    return {
      id: part.id,
      sessionID,
      messageID,
      type: "tool",
      callID: part.id,
      tool: part.name,
      state: { status: "pending", input: {}, raw: state.input },
    }
  }

  if (state.status === "running") {
    return {
      id: part.id,
      sessionID,
      messageID,
      type: "tool",
      callID: part.id,
      tool: part.name,
      state: {
        status: "running",
        input: state.input,
        title: part.name,
        metadata: state.structured,
        time: { start },
      },
    }
  }

  if (state.status === "completed") {
    return {
      id: part.id,
      sessionID,
      messageID,
      type: "tool",
      callID: part.id,
      tool: part.name,
      state: {
        status: "completed",
        input: state.input,
        output: toolOutput(state.content),
        title: part.name,
        metadata: state.structured,
        time: { start, end },
        attachments: state.attachments?.map((file, index) => ({
          id: `${part.id}:file:${index}`,
          sessionID,
          messageID,
          type: "file" as const,
          mime: file.mime,
          filename: file.name,
          url: file.uri,
        })),
      },
    }
  }

  return {
    id: part.id,
    sessionID,
    messageID,
    type: "tool",
    callID: part.id,
    tool: part.name,
    state: {
      status: "error",
      input: state.input,
      error: state.error.message,
      metadata: state.structured,
      time: { start, end },
    },
  }
}

function toolOutput(content: LlmToolContent[]) {
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
}
