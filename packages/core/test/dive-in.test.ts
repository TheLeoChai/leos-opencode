import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Layer, Schema, Stream } from "effect"
import { LLMClient, LLMEvent, LLMResponse } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ID, Info, TrackID } from "@opencode-ai/schema/dive-in"
import { Session } from "@opencode-ai/schema/session"
import { Database } from "@opencode-ai/core/database/database"
import { DiveIn, DiveInTable, DiveInTrackTable } from "@opencode-ai/core/dive-in"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import {
  MessageTable,
  PartTable,
  SessionInputCancellationTable,
  SessionInputTable,
  SessionMessageTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LayerNodePlatform.llmClient,
      DiveIn.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const plannerResponses: LLMResponse[] = []
const plannerClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () => Stream.die("unused"),
    generate: () => {
      const response = plannerResponses.shift()
      if (!response) return Effect.die("missing planner response")
      return Effect.succeed(response)
    },
  }),
)
const plannerModel = OpenAIChat.route.model({ id: "fake-model" })
const plannerModels = SessionRunnerModel.layerWith(() => Effect.succeed(plannerModel))
const plannerIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LayerNodePlatform.llmClient,
      DiveIn.node,
    ]),
    [
      [ProjectV2.node, projects],
      [LayerNodePlatform.llmClient, plannerClient],
      [SessionRunnerModel.node, plannerModels],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const plannerLocation = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

const plannerResponse = (titles: readonly string[]) => {
  const response = LLMResponse.fromEvents([
    LLMEvent.toolCall({
      id: "planner-call",
      name: "generate_object",
      input: {
        title: "Independent investigations",
        tracks: titles.map((title) => ({
          title,
          summary: `Investigate ${title}.`,
          reasoning: `This keeps ${title} independently useful.`,
          prompt: `Investigate ${title} and report a concrete conclusion.`,
        })),
      },
    }),
    LLMEvent.finish({ reason: "stop" }),
  ])
  if (!response) throw new Error("failed to construct planner response")
  return response
}

describe("DiveIn", () => {
  it.effect("builds and acquires the service with its LLM client dependency", () =>
    Effect.gen(function* () {
      const diveIn = yield* DiveIn.Service
      const llm = yield* LLMClient.Service

      expect(typeof diveIn.list).toBe("function")
      expect(typeof diveIn.start).toBe("function")
      expect(typeof llm.generate).toBe("function")
    }),
  )

  it.effect("rejects starting DiveIn from a child session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const diveIn = yield* DiveIn.Service
      const result = yield* diveIn.start({ sessionID: child.id }).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (!Exit.isFailure(result)) return
      expect(Cause.squash(result.cause)).toBeInstanceOf(DiveIn.InvalidStateError)
    }),
  )

  it.effect("loads legacy transcript context when the V2 projection is empty", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const store = yield* SessionStore.Service
      const session = yield* sessions.create({ location })
      const now = Date.now()
      const userID = SessionV1.MessageID.ascending()
      const assistantID = SessionV1.MessageID.ascending()
      const model = {
        providerID: ProviderV2.ID.make("openai"),
        modelID: ModelV2.ID.make("gpt-5.6-sol"),
      }

      yield* database.db
        .insert(MessageTable)
        .values([
          {
            id: userID,
            session_id: session.id,
            time_created: now,
            time_updated: now,
            data: {
              role: "user",
              time: { created: now },
              agent: "build",
              model,
            } as Omit<SessionV1.User, "id" | "sessionID">,
          },
          {
            id: assistantID,
            session_id: session.id,
            time_created: now + 1,
            time_updated: now + 2,
            data: {
              role: "assistant",
              time: { created: now + 1, completed: now + 2 },
              parentID: userID,
              modelID: model.modelID,
              providerID: model.providerID,
              mode: "build",
              agent: "build",
              path: { cwd: "/project", root: "/project" },
              cost: 0,
              tokens: { total: 1, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            } as Omit<SessionV1.Assistant, "id" | "sessionID">,
          },
        ])
        .run()

      yield* database.db
        .insert(PartTable)
        .values([
          {
            id: SessionV1.PartID.ascending(),
            message_id: userID,
            session_id: session.id,
            time_created: now,
            time_updated: now,
            data: {
              type: "text",
              text: "Split this concrete problem into independent investigations.",
            } as Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID">,
          },
          {
            id: SessionV1.PartID.ascending(),
            message_id: assistantID,
            session_id: session.id,
            time_created: now + 1,
            time_updated: now + 2,
            data: { type: "text", text: "I will investigate the main issue." } as Omit<
              SessionV1.TextPart,
              "id" | "sessionID" | "messageID"
            >,
          },
        ])
        .run()

      const context = yield* store.context(session.id)
      expect(
        context.map((message) =>
          message.type === "user"
            ? message.text
            : message.type === "assistant"
              ? message.content
                  .filter((part): part is SessionMessage.AssistantText => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
              : "",
        ),
      ).toEqual(["Split this concrete problem into independent investigations.", "I will investigate the main issue."])
    }),
  )

  plannerIt.effect("preserves an explicit nine-item outline in persisted tracks", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({
        location: plannerLocation,
        model: {
          id: ModelV2.ID.make("fake-model"),
          providerID: ProviderV2.ID.make("fake"),
        },
      })
      const titles = [
        "Stop questions from automatically changing a person's goals",
        "Decide what to do before deciding what to say",
        "Give the language model a clear communication plan",
        "Check meaning, not just words",
        "Test canned backup responses separately",
        "Replace the POC's fixed psychology before treating it as a real person",
        "Redesign the human evaluation",
        "Fix the World test's expensive checking before choosing a scheduler",
        "Correct the project's status documents",
      ]
      const message = SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: titles.map((title, index) => `## ${index + 1}. ${title}`).join("\n\n"),
        files: [],
        agents: [],
        time: { created: DateTime.makeUnsafe(Date.now()) },
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id: _, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: message.id,
          session_id: parent.id,
          type,
          seq: 1,
          time_created: Date.now(),
          data,
        })
        .run()

      const latestModel = {
        id: ModelV2.ID.make("latest-model"),
        providerID: ProviderV2.ID.make("latest-provider"),
      }
      const assistantID = SessionMessage.ID.create()
      const assistant = Schema.encodeSync(SessionMessage.Message)(
        SessionMessage.Assistant.make({
          id: assistantID,
          type: "assistant",
          agent: "build",
          model: latestModel,
          content: [],
          finish: "stop",
          time: {
            created: DateTime.makeUnsafe(Date.now() + 1),
            completed: DateTime.makeUnsafe(Date.now() + 2),
          },
        }),
      )
      const { id: _assistantEncodedID, type: assistantType, ...assistantData } = assistant
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: assistantID,
          session_id: parent.id,
          type: assistantType,
          seq: 2,
          time_created: Date.now() + 1,
          data: assistantData,
        })
        .run()

      plannerResponses.splice(0, plannerResponses.length, plannerResponse(titles.slice(0, 6)), plannerResponse(titles))
      const diveIn = yield* DiveIn.Service
      const info = yield* diveIn.start({ sessionID: parent.id })

      expect(info.tracks).toHaveLength(titles.length)
      expect(info.tracks.map((track) => track.title)).toEqual(titles)
      expect(
        yield* db.select({ id: DiveInTrackTable.id }).from(DiveInTrackTable).where(eq(DiveInTrackTable.dive_in_id, info.id)).all(),
      ).toHaveLength(titles.length)
      const children = yield* Effect.forEach(info.tracks, (track) => sessions.get(track.sessionID))
      expect(children.every((child) => child.model?.id === latestModel.id)).toBe(true)
      expect(children.every((child) => child.model?.providerID === latestModel.providerID)).toBe(true)
      expect(plannerResponses).toHaveLength(0)
      expect((yield* sessions.get(parent.id)).id).toBe(parent.id)
    }),
  )

  it.effect("creates and validates domain IDs", () =>
    Effect.sync(() => {
      expect(ID.create()).toMatch(/^dive_/)
      expect(TrackID.create()).toMatch(/^dtrk_/)
      expect(() => Schema.decodeUnknownSync(ID)("track_invalid")).toThrow()
    }),
  )

  it.effect("round-trips optional track and group fields", () =>
    Effect.sync(() => {
      const info = Schema.decodeUnknownSync(Info)({
        id: ID.create(),
        sessionID: Session.ID.create(),
        title: "Investigate",
        status: "active",
        tracks: [
          {
            id: TrackID.create(),
            sessionID: Session.ID.create(),
            position: 0,
            title: "Trace the failure",
            summary: "Find the failing boundary",
            reasoning: "This isolates the likely cause",
            prompt: "Trace the failure and report the boundary",
            status: "active",
            time: { created: 1, updated: 1 },
          },
        ],
        time: { created: 1, updated: 1 },
      })
      const encoded = Schema.encodeSync(Info)(info)

      expect(encoded).not.toHaveProperty("guidance")
      expect(encoded.tracks[0]).not.toHaveProperty("satisfied")
      expect(encoded.tracks[0]).not.toHaveProperty("conclusion")
    }),
  )

  it.effect("requires a stopped assistant turn before recording a track conclusion", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const secondChild = yield* sessions.create({ location, parentID: parent.id })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()
      const secondTrackID = TrackID.create()
      const model = {
        id: ModelV2.ID.make(`model_${parent.id}`),
        providerID: ProviderV2.ID.make(`provider_${parent.id}`),
      }
      const encodeMessage = Schema.encodeSync(SessionMessage.Message)
      const assistantRow = (input: {
        sessionID?: Session.ID
        id: SessionMessage.ID
        seq: number
        finish: string
        text: string
        time: { created: DateTime.Utc; completed: DateTime.Utc }
      }) => {
        const {
          id: _,
          type,
          ...data
        } = encodeMessage(
          SessionMessage.Assistant.make({
            id: input.id,
            type: "assistant",
            agent: "build",
            model,
            content: [{ type: "text", id: `text_${input.id}`, text: input.text }],
            finish: input.finish,
            time: input.time,
          }),
        )
        return {
          id: input.id,
          session_id: input.sessionID ?? child.id,
          type,
          seq: input.seq,
          time_created: DateTime.toEpochMillis(input.time.created),
          data,
        }
      }

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Trace the failure",
          summary: "Find the failing boundary",
          reasoning: "This isolates the likely cause",
          prompt: "Trace the failure",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()

      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: secondTrackID,
          dive_in_id: diveInID,
          session_id: secondChild.id,
          position: 1,
          title: "Check the boundary",
          summary: "Validate the boundary",
          reasoning: "This confirms the result independently",
          prompt: "Check the boundary",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()

      yield* db
        .insert(SessionMessageTable)
        .values(
          assistantRow({
            id: SessionMessage.ID.create(),
            seq: 1,
            finish: "tool-calls",
            text: "The tool call completed, but the branch has no conclusion yet.",
            time: {
              created: DateTime.makeUnsafe(now),
              completed: DateTime.makeUnsafe(now + 1),
            },
          }),
        )
        .run()

      yield* db
        .insert(SessionMessageTable)
        .values(
          assistantRow({
            sessionID: secondChild.id,
            id: SessionMessage.ID.create(),
            seq: 1,
            finish: "stop",
            text: "The boundary is valid.",
            time: {
              created: DateTime.makeUnsafe(now + 2),
              completed: DateTime.makeUnsafe(now + 3),
            },
          }),
        )
        .run()

      const diveIn = yield* DiveIn.Service
      const input = { diveInID, sessionID: parent.id, trackID, satisfied: true as const }
      const missing = yield* diveIn.complete(input).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
      if (Exit.isFailure(missing)) {
        const error = Cause.squash(missing.cause)
        expect(error).toBeInstanceOf(DiveIn.TrackConclusionMissingError)
        expect(error).toMatchObject({ trackID })
      }
      expect(
        yield* db
          .select({ status: DiveInTrackTable.status })
          .from(DiveInTrackTable)
          .where(eq(DiveInTrackTable.id, trackID))
          .get(),
      ).toEqual({ status: "active" })

      yield* db
        .insert(SessionMessageTable)
        .values(
          assistantRow({
            id: SessionMessage.ID.create(),
            seq: 2,
            finish: "stop",
            text: "The branch conclusion is complete.",
            time: {
              created: DateTime.makeUnsafe(now + 2),
              completed: DateTime.makeUnsafe(now + 3),
            },
          }),
        )
        .run()

      const newer = yield* sessions.prompt({
        sessionID: child.id,
        prompt: { text: "newer work" },
        delivery: "steer",
        resume: false,
      })
      const staleStop = yield* diveIn.complete(input).pipe(Effect.exit)
      expect(Exit.isFailure(staleStop)).toBe(true)
      if (Exit.isFailure(staleStop)) {
        const error = Cause.squash(staleStop.cause)
        expect(error).toBeInstanceOf(DiveIn.TrackConclusionMissingError)
        expect(error).toMatchObject({ trackID })
      }
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, newer.id)).run().pipe(Effect.orDie)

      const firstCompleted = yield* diveIn.complete(input)
      expect(firstCompleted.status).toBe("active")
      expect(firstCompleted.tracks).toEqual([
        expect.objectContaining({ id: trackID, status: "completed" }),
        expect.objectContaining({ id: secondTrackID, status: "active" }),
      ])

      const completed = yield* diveIn.complete({ ...input, trackID: secondTrackID })
      expect(completed.status).toBe("active")
      expect(completed.tracks).toEqual([
        expect.objectContaining({
          id: trackID,
          status: "completed",
          conclusion: "The branch conclusion is complete.",
        }),
        expect.objectContaining({
          id: secondTrackID,
          status: "completed",
          conclusion: "The boundary is valid.",
        }),
      ])
      expect(
        yield* db
          .select({ delivery: SessionInputTable.delivery })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, parent.id))
          .all(),
      ).toEqual([])
      expect(
        yield* db
          .select({ delivery: SessionInputTable.delivery })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, child.id))
          .all(),
      ).toEqual([{ delivery: "steer" }])
    }),
  )

  it.effect("automatically completes a track after its final assistant step", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()
      const assistantID = SessionMessage.ID.create()
      const model = {
        id: ModelV2.ID.make(`model_${parent.id}`),
        providerID: ProviderV2.ID.make(`provider_${parent.id}`),
      }
      const encodeMessage = Schema.encodeSync(SessionMessage.Message)
      const assistant = encodeMessage(
        SessionMessage.Assistant.make({
          id: assistantID,
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", id: `text_${assistantID}`, text: "The branch is complete." }],
          finish: "stop",
          time: {
            created: DateTime.makeUnsafe(now),
            completed: DateTime.makeUnsafe(now + 1),
          },
        }),
      )
      const { id: _, type, ...assistantData } = assistant

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Trace the failure",
          summary: "Find the failing boundary",
          reasoning: "This isolates the likely cause",
          prompt: "Trace the failure",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: assistantID,
          session_id: child.id,
          type,
          seq: 1,
          time_created: now,
          data: assistantData,
        })
        .run()

      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: child.id,
        timestamp: DateTime.makeUnsafe(now + 1),
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      })

      const diveIn = yield* DiveIn.Service
      const completed = yield* diveIn.get(diveInID)
      expect(completed.status).toBe("active")
      expect(completed.tracks).toEqual([
        expect.objectContaining({
          id: trackID,
          status: "completed",
          conclusion: "The branch is complete.",
        }),
      ])
      expect(
        yield* db
          .select({ delivery: SessionInputTable.delivery })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, parent.id))
          .all(),
      ).toEqual([])
      expect(
        yield* db
          .select({ delivery: SessionInputTable.delivery })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, child.id))
          .all(),
      ).toEqual([{ delivery: "steer" }])
    }),
  )

  it.effect("allows manually completing a queued track", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Queued branch",
          summary: "Use the planned branch summary.",
          reasoning: "The branch is still queued.",
          prompt: "Investigate the queued branch.",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* sessions.prompt({
        sessionID: child.id,
        prompt: { text: "queued branch" },
        delivery: "steer",
        resume: false,
      })

      const completed = yield* (yield* DiveIn.Service).complete({
        diveInID,
        sessionID: parent.id,
        trackID,
        satisfied: true,
      })
      expect(completed.status).toBe("active")
      expect(completed.tracks).toEqual([
        expect.objectContaining({
          id: trackID,
          status: "completed",
          conclusion: "Manually completed before execution.\n\nUse the planned branch summary.",
        }),
      ])
      expect(
        yield* db
          .select({ delivery: SessionInputTable.delivery })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, child.id))
          .all(),
      ).toHaveLength(2)
      expect(
        yield* db
          .select({ id: SessionInputCancellationTable.id })
          .from(SessionInputCancellationTable)
          .where(eq(SessionInputCancellationTable.session_id, child.id))
          .all(),
      ).toHaveLength(1)
    }),
  )

  it.effect("recovers an active DiveIn with a completed track", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Trace the failure",
          summary: "Find the failing boundary",
          reasoning: "This isolates the likely cause",
          prompt: "Trace the failure",
          status: "completed",
          satisfied: true,
          conclusion: "The branch conclusion is complete.",
          time_created: now,
          time_updated: now,
          time_completed: now,
        })
        .run()

      const diveIn = yield* DiveIn.Service
      const recovered = yield* diveIn.start({ sessionID: parent.id })
      expect(recovered.status).toBe("active")
      expect(recovered.tracks).toEqual([
        expect.objectContaining({
          id: trackID,
          status: "completed",
          conclusion: "The branch conclusion is complete.",
        }),
      ])
    }),
  )

  it.effect("records a child handoff before queueing parent synthesis", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()
      const handoffID = SessionMessage.ID.make(`msg_divein_handoff_${trackID}`)
      const assistantID = SessionMessage.ID.create()
      const model = {
        id: ModelV2.ID.make(`model_${parent.id}`),
        providerID: ProviderV2.ID.make(`provider_${parent.id}`),
      }
      const encoded = Schema.encodeSync(SessionMessage.Message)
      const assistant = encoded(
        SessionMessage.Assistant.make({
          id: assistantID,
          type: "assistant",
          agent: "build",
          model,
          content: [
            {
              type: "text",
              id: `text_${assistantID}`,
              text: "## Finding\nThe boundary is valid.\n\n## Evidence\nThe test passes.\n\n## Recommendation\nKeep the boundary.\n\n## Open Questions\nNone.",
            },
          ],
          finish: "stop",
          time: { created: DateTime.makeUnsafe(now + 2), completed: DateTime.makeUnsafe(now + 3) },
        }),
      )
      const { id: _, type, ...assistantData } = assistant

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Trace the boundary",
          summary: "Validate the boundary.",
          reasoning: "The result is independently useful.",
          prompt: "Validate the boundary.",
          status: "completed",
          satisfied: true,
          conclusion: "The boundary is valid.",
          handoff_prompt_id: handoffID,
          time_created: now,
          time_updated: now,
          time_completed: now,
        })
        .run()
      yield* sessions.prompt({
        id: handoffID,
        sessionID: child.id,
        prompt: { text: "Prepare the handoff." },
        delivery: "steer",
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, child.id, Number.MAX_SAFE_INTEGER)
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: assistantID,
          session_id: child.id,
          type,
          seq: 3,
          time_created: now + 2,
          data: assistantData,
        })
        .run()

      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: child.id,
        timestamp: DateTime.makeUnsafe(now + 3),
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const completed = yield* (yield* DiveIn.Service).get(diveInID)
      expect(completed.status).toBe("completed")
      expect(completed.tracks[0]).toEqual(
        expect.objectContaining({ id: trackID, status: "closed", handoff: expect.stringContaining("## Finding") }),
      )
      expect(
        yield* db
          .select({ delivery: SessionInputTable.delivery, promotedSeq: SessionInputTable.promoted_seq })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, parent.id))
          .all(),
      ).toEqual([{ delivery: "queue", promotedSeq: null }])
    }),
  )

  it.effect("reopens a completed track while its handoff is still pending", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()
      const handoffID = SessionMessage.ID.make(`msg_divein_handoff_${trackID}`)

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Reopen this branch",
          summary: "Continue the branch.",
          reasoning: "The branch needs another pass.",
          prompt: "Continue the branch.",
          status: "completed",
          satisfied: true,
          conclusion: "The first pass was incomplete.",
          handoff_prompt_id: handoffID,
          time_created: now,
          time_updated: now,
          time_completed: now,
        })
        .run()
      yield* sessions.prompt({
        id: handoffID,
        sessionID: child.id,
        prompt: { text: "Prepare the handoff." },
        delivery: "steer",
        resume: false,
      })

      const reopened = yield* (yield* DiveIn.Service).reopen({ diveInID, sessionID: parent.id, trackID })
      expect(reopened.status).toBe("active")
      expect(reopened.tracks[0]).toEqual(
        expect.objectContaining({ id: trackID, status: "active", conclusion: undefined, handoff: undefined }),
      )
      const inputs = yield* db
        .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, child.id))
        .all()
      expect(inputs).toHaveLength(2)
      expect(inputs.map((input) => input.id)).toContain(handoffID)
      const reopenedTrack = yield* db
        .select({ investigationPromptID: DiveInTrackTable.investigation_prompt_id })
        .from(DiveInTrackTable)
        .where(eq(DiveInTrackTable.id, trackID))
        .get()
      expect(reopenedTrack?.investigationPromptID).toBeDefined()
      expect(reopenedTrack?.investigationPromptID).not.toBe(handoffID)
      if (!reopenedTrack?.investigationPromptID) return yield* Effect.die("Reopened investigation prompt was not persisted")
      expect(inputs.map((input) => input.id)).toContain(reopenedTrack.investigationPromptID)
      expect(yield* SessionInput.find(db, handoffID)).toBeUndefined()
      expect(
        yield* db
          .select({ id: SessionInputCancellationTable.id })
          .from(SessionInputCancellationTable)
          .where(eq(SessionInputCancellationTable.id, handoffID))
          .get(),
      ).toEqual({ id: handoffID })
    }),
  )

  it.effect("cancels a DiveIn and removes its child track sessions", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id, title: "Trace the failure" })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Trace the failure",
          summary: "Find the failing boundary",
          reasoning: "This isolates the likely cause",
          prompt: "Trace the failure",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()

      const diveIn = yield* DiveIn.Service
      yield* diveIn.cancel({ diveInID, sessionID: parent.id })

      expect(
        yield* db.select({ id: DiveInTable.id }).from(DiveInTable).where(eq(DiveInTable.id, diveInID)).get(),
      ).toBeUndefined()
      expect(
        yield* db.select({ id: DiveInTrackTable.id }).from(DiveInTrackTable).where(eq(DiveInTrackTable.id, trackID)).get(),
      ).toBeUndefined()
      expect(Exit.isFailure(yield* sessions.get(child.id).pipe(Effect.exit))).toBe(true)
      expect((yield* sessions.get(parent.id)).id).toBe(parent.id)
    }),
  )

  it.effect("allows completed rows to coexist while limiting active rows per session", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const now = Date.now()
      const shared = {
        session_id: session.id,
        title: "Investigate",
        guidance: null,
        time_created: now,
        time_updated: now,
      }

      yield* db
        .insert(DiveInTable)
        .values({ ...shared, id: ID.create(), status: "active" })
        .run()
      const duplicateActive = yield* db
        .insert(DiveInTable)
        .values({ ...shared, id: ID.create(), status: "active" })
        .run()
        .pipe(Effect.exit)
      expect(Exit.isFailure(duplicateActive)).toBe(true)

      yield* db
        .insert(DiveInTable)
        .values({ ...shared, id: ID.create(), status: "completed", time_completed: now })
        .run()
      yield* db
        .insert(DiveInTable)
        .values({ ...shared, id: ID.create(), status: "completed", time_completed: now + 1 })
        .run()

      const rows = yield* db
        .select({ status: DiveInTable.status })
        .from(DiveInTable)
        .where(eq(DiveInTable.session_id, session.id))
        .all()
      expect(rows.filter((row) => row.status === "active")).toHaveLength(1)
      expect(rows.filter((row) => row.status === "completed")).toHaveLength(2)
    }),
  )

  it.effect("enforces unique track sessions and rejects tracks outside their DiveIn parent", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: parent.id })
      const foreign = yield* sessions.create({ location })
      const now = Date.now()
      const diveInID = ID.create()
      const trackID = TrackID.create()

      yield* db
        .insert(DiveInTable)
        .values({
          id: diveInID,
          session_id: parent.id,
          title: "Investigate",
          guidance: null,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: trackID,
          dive_in_id: diveInID,
          session_id: child.id,
          position: 0,
          title: "Trace the failure",
          summary: "Find the failing boundary",
          reasoning: "This isolates the likely cause",
          prompt: "Trace the failure",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()

      const duplicateTrackSession = yield* db
        .insert(DiveInTrackTable)
        .values({
          id: TrackID.create(),
          dive_in_id: diveInID,
          session_id: child.id,
          position: 1,
          title: "Duplicate",
          summary: "Duplicate",
          reasoning: "Duplicate",
          prompt: "Duplicate",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.exit)
      expect(Exit.isFailure(duplicateTrackSession)).toBe(true)

      const foreignTrackID = TrackID.create()
      yield* db
        .insert(DiveInTrackTable)
        .values({
          id: foreignTrackID,
          dive_in_id: diveInID,
          session_id: foreign.id,
          position: 1,
          title: "Foreign",
          summary: "Foreign",
          reasoning: "Foreign",
          prompt: "Foreign",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()

      const diveIn = yield* DiveIn.Service
      const ownership = yield* diveIn
        .complete({ diveInID, sessionID: parent.id, trackID: foreignTrackID, satisfied: true })
        .pipe(Effect.exit)
      expect(Exit.isFailure(ownership)).toBe(true)
      if (Exit.isFailure(ownership)) expect(ownership.cause.toString()).toContain("does not belong to its parent session")

      const cancelOwnership = yield* diveIn.cancel({ diveInID, sessionID: parent.id }).pipe(Effect.exit)
      expect(Exit.isFailure(cancelOwnership)).toBe(true)
      expect(yield* sessions.get(foreign.id)).toMatchObject({ id: foreign.id })
    }),
  )

  it.effect("applies the durable DiveIn tables", () =>
    Database.Service.use(({ db }) =>
      Effect.gen(function* () {
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dive_in'`)).toEqual({
          name: "dive_in",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dive_in_track'`),
        ).toEqual({ name: "dive_in_track" })
        const indexes = yield* db.all(sql`PRAGMA index_list('dive_in')`)
        expect(
          indexes.some((index) => {
            if (typeof index !== "object" || index === null) return false
            if (!("name" in index) || !("unique" in index) || !("partial" in index)) return false
            return index.name === "dive_in_active_session_idx" && index.unique === 1 && index.partial === 1
          }),
        ).toBe(true)
      }).pipe(Effect.orDie),
    ),
  )
})
