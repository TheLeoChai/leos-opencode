import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { LLM } from "./llm"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Stream, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionOverflow } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const llm = yield* LLM.Service
    const status = yield* SessionStatus.Service
    const admission = yield* Semaphore.make(1)
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return SessionOverflow.isOverflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      context: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const target =
        (yield* estimate({ messages: input.context, model: input.model })) *
        (input.cfg.compaction?.keep_threshold ?? 0.35)
      // Tool calls and their results live inside a user turn. Only whole turns
      // are candidates; choose the boundary nearest the requested token split.
      const boundaries = input.messages.flatMap((message, start) =>
        start > 0 && message.info.role === "user" && !message.parts.some((part) => part.type === "compaction")
          ? [{ start, id: message.info.id }]
          : [],
      )
      const candidates = yield* Effect.forEach(boundaries, (boundary) =>
        estimate({ messages: input.messages.slice(boundary.start), model: input.model }).pipe(
          Effect.map((tokens) => ({ ...boundary, distance: Math.abs(tokens - target) })),
        ),
      )
      const keep = candidates.reduce<(typeof candidates)[number] | undefined>(
        (best, next) => (!best || next.distance < best.distance ? next : best),
        undefined,
      )
      // The end of history is also a safe boundary. Prefer it if retaining one
      // indivisible turn is further from the target than retaining nothing.
      if (!keep || keep.distance > target) return { head: input.messages, tail_start_id: undefined }
      return { head: input.messages.slice(0, keep.start), tail_start_id: keep.id }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart ? messages.filter((message) => message.info.id !== input.parentID) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
        context: history,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      const generate = Effect.fn("SessionCompaction.generate")(function* (prompt: string, shorten = false) {
        const chunks: string[] = []
        const error = yield* Effect.gen(function* () {
          chunks.length = 0
          yield* llm
            .stream({
              user: userMessage,
              // The compaction agent supplies permissions and settings, but its
              // configured model must never replace the session's current model.
              agent,
              sessionID: input.sessionID,
              tools: {},
              toolChoice: "none",
              retries: 0,
              maxOutputTokens: Math.max(1, Math.floor(model.limit.context * (shorten ? 0.1 : 0.05))),
              system: [],
              messages: [
                ...(shorten ? [] : structuredClone(modelMessages)),
                { role: "user", content: [{ type: "text", text: prompt }] },
              ],
              model,
            })
            .pipe(
              Stream.runForEach((event) => {
                if (LLMEvent.is.providerError(event)) return Effect.fail(new Error(event.message))
                if (LLMEvent.is.toolCall(event))
                  return Effect.fail(new Error("Tool call not allowed while generating summary"))
                if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
                if (LLMEvent.is.stepFinish(event) && event.usage) {
                  const usage = Session.getUsage({ model, usage: event.usage, metadata: event.providerMetadata })
                  msg.cost += usage.cost
                  msg.tokens.input += usage.tokens.input
                  msg.tokens.output += usage.tokens.output
                  msg.tokens.reasoning += usage.tokens.reasoning
                  msg.tokens.cache.read += usage.tokens.cache.read
                  msg.tokens.cache.write += usage.tokens.cache.write
                }
                return Effect.void
              }),
            )
        }).pipe(
          Effect.retry({
            times: shorten ? 0 : 2,
            schedule: SessionRetry.policy({
              provider: model.providerID,
              parse: (error) => MessageV2.fromError(error, { providerID: model.providerID }),
              set: (info) => status.set(input.sessionID, { type: "retry", ...info }),
            }),
          }),
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(MessageV2.fromError(error, { providerID: model.providerID }))),
        )
        return { text: chunks.join("").trim(), error }
      })
      // Neither pass publishes transcript messages. Both see the same frozen
      // head and prior canonical summary; only the assembled result is committed.
      const passes = yield* Effect.forEach(["high", "low"] as const, (pass) =>
        generate(
          buildPrompt({
            pass,
            window: model.limit.context,
            previousSummary,
            context: [...compacting.context, ...(compacting.prompt ? [compacting.prompt] : [])],
          }),
        ),
      )
      const combined = [
        passes[0].text ? `# High-level context\n\n${passes[0].text}` : "",
        passes[1].text ? `# Working detail\n\n${passes[1].text}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
      // Even if both providers fail without text, preserve the frozen source as
      // a last-resort summary so compaction cannot strand an active session.
      let best =
        combined || [previousSummary, "# Working detail", JSON.stringify(modelMessages)].filter(Boolean).join("\n\n")
      const maximum = Math.floor(model.limit.context * 0.1)
      for (let attempt = 0; best && Token.estimate(best) > maximum && attempt < 2; attempt++) {
        const shortened = yield* generate(
          `Shorten this canonical summary to at most ${maximum} tokens (aim for ${Math.floor(maximum * 0.8)}). ` +
            "Preserve the High-level context section, its still-valid rules, constraints, and decisions. " +
            "Condense working detail first. Keep the headings '# High-level context' and '# Working detail' in that order " +
            "when present. Return only the complete revised summary.\n\n" +
            best,
          true,
        )
        // A failed or structurally incomplete rewrite must not replace a usable summary.
        const high = shortened.text.indexOf("# High-level context")
        const low = shortened.text.indexOf("# Working detail")
        if (
          !shortened.error &&
          shortened.text &&
          (!passes[0].text || high >= 0) &&
          (!passes[1].text || low > high) &&
          Token.estimate(shortened.text) < Token.estimate(best)
        )
          best = shortened.text
      }
      // Install the boundary before marking the summary finished, so replay can
      // never observe a successful summary with a missing retained-tail boundary.
      yield* session.updateMessage(msg)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        text: best,
      })
      if (compactionPart) yield* session.updatePart({ ...compactionPart, tail_start_id: selected.tail_start_id })
      msg.finish = "stop"
      msg.time.completed = Date.now()
      yield* session.updateMessage(msg)
      if (input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      return "continue" as const
    })

    const create = Effect.fn("SessionCompaction.create")(
      function* (input: {
        sessionID: SessionID
        agent: string
        model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
        auto: boolean
        overflow?: boolean
      }) {
        const messages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
        const pending = MessageV2.latest(messages).tasks.find((part) => part.type === "compaction")
        if (pending) {
          if ((input.auto && !pending.auto) || (input.overflow && !pending.overflow)) {
            yield* session.updatePart({
              ...pending,
              auto: pending.auto || input.auto,
              overflow: pending.overflow || input.overflow,
            })
          }
          return
        }
        const msg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: input.model,
          sessionID: input.sessionID,
          agent: input.agent,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "compaction",
          auto: input.auto,
          overflow: input.overflow,
        })
      },
      (effect) => admission.withPermit(effect),
    )

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    LLM.node,
    SessionStatus.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
