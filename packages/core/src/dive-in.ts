export * as DiveIn from "./dive-in"

import { and, asc, desc, eq, gt, isNotNull, isNull, notExists, sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema, Context } from "effect"
import { LLM, LLMClient, Message, type Model } from "@opencode-ai/llm"
import { ID, Info, Track, TrackID } from "@opencode-ai/schema/dive-in"
import { DiveInEvent } from "@opencode-ai/schema/dive-in-event"
import { Session } from "@opencode-ai/schema/session"
import { Location } from "@opencode-ai/schema/location"
import { Database } from "./database/database"
import { DiveInTable, DiveInTrackTable } from "./dive-in/sql"
import { SessionV2 } from "./session"
import { SessionInput } from "./session/input"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { SessionEvent } from "./session/event"
import { SessionRunnerModel } from "./session/runner/model"
import { toLLMMessages } from "./session/runner/to-llm-message"
import { makeGlobalNode } from "./effect/app-node"
import { llmClient } from "./effect/app-node-platform"
import { KeyedMutex } from "./effect/keyed-mutex"
import { SessionInputCancellationTable, SessionInputTable, SessionMessageTable, SessionTable } from "./session/sql"
import { LocationServiceMap } from "./location-service-map"
import { EventV2 } from "./event"
import { Token } from "./util/token"

const MAX_TRACKS = 12
const PLANNER_OUTPUT_TOKENS = 4_096
const PLANNER_CONTEXT_BUFFER = 16_000
const PLANNER_MAX_INPUT_TOKENS = 128_000
const SETUP_RESERVATION_STALE_AFTER = 10 * 60 * 1000

const PlannerOutput = Schema.Struct({
  title: Schema.String,
  tracks: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      summary: Schema.String,
      reasoning: Schema.String,
      prompt: Schema.String,
    }),
  ),
})

const PLANNER_SYSTEM = `You are the DiveIn planner for a coding assistant.

Split the current main-session problem into the smallest useful set of independent side tracks. Choose the number of tracks yourself, from one to ${MAX_TRACKS}. A track must have one clear scope and must be useful to the main session when it returns. If the conversation contains a numbered work outline, return exactly one track for every item in that outline, in the same order. Do not merge numbered items just because they are related. Only merge points that are genuinely duplicates or inseparable when no explicit outline is present.

Return only the requested structured result. For every track:
- title is short and specific;
- summary is a compact statement of the branch-specific context;
- reasoning explains why this branch deserves separate investigation;
- prompt is the exact focused task for the side-track agent.

Do not create a track for generic coordination, unrelated work, or a duplicate of another track. Keep all summaries and reasoning limited to the branch they describe.`

const plannerMessages = (context: readonly SessionMessage.Message[], model: Model) => {
  const contextLimit = model.route.defaults.limits?.context ?? PLANNER_MAX_INPUT_TOKENS + PLANNER_OUTPUT_TOKENS
  const budget = Math.max(
    0,
    Math.min(PLANNER_MAX_INPUT_TOKENS, contextLimit - PLANNER_OUTPUT_TOKENS - PLANNER_CONTEXT_BUFFER),
  )
  const selected: Message[] = []
  let used = 0
  for (let index = context.length - 1; index >= 0; index--) {
    const message = context[index]
    if (!message) continue
    const next = toLLMMessages([message], model)
    const tokens = Token.estimate(JSON.stringify(next))
    if (tokens > budget) continue
    if (used + tokens > budget) break
    selected.unshift(...next)
    used += tokens
  }
  return selected
}

const numberedOutline = (context: readonly SessionMessage.Message[]) => {
  const headings = context.flatMap((message) => {
    const text =
      message.type === "user"
        ? message.text
        : message.type === "assistant"
          ? message.content
              .filter((part): part is SessionMessage.AssistantText => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : ""
    return text.split("\n").flatMap((line) => {
      const match = /^\s*#{1,6}\s+(\d+)[.)]\s+(.+?)\s*$/.exec(line)
      if (!match) return []
      return [{ number: Number(match[1]), title: match[2] }]
    })
  })
  const outlines: string[][] = []
  let current: string[] = []
  for (const heading of headings) {
    if (heading.number === 1) {
      if (current.length > 1) outlines.push(current)
      current = [heading.title]
      continue
    }
    if (current.length === 0 || heading.number !== current.length + 1) {
      if (current.length > 1) outlines.push(current)
      current = []
      continue
    }
    current.push(heading.title)
  }
  if (current.length > 1) outlines.push(current)
  return outlines.at(-1) ?? []
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("DiveIn.NotFoundError", {
  diveInID: ID,
}) {}

export class TrackNotFoundError extends Schema.TaggedErrorClass<TrackNotFoundError>()("DiveIn.TrackNotFoundError", {
  diveInID: ID,
  trackID: TrackID,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("DiveIn.InvalidStateError", {
  message: Schema.String,
}) {}

export class TrackConclusionMissingError extends Schema.TaggedErrorClass<TrackConclusionMissingError>()(
  "DiveIn.TrackConclusionMissingError",
  {
    trackID: TrackID,
  },
) {}

export class PlanningError extends Schema.TaggedErrorClass<PlanningError>()("DiveIn.PlanningError", {
  message: Schema.String,
}) {}

export type Error = NotFoundError | TrackNotFoundError | InvalidStateError | TrackConclusionMissingError | PlanningError

type DatabaseService = Database.Interface["db"]

export interface Interface {
  readonly list: (location: Location.Ref) => Effect.Effect<Info[]>
  readonly get: (diveInID: ID) => Effect.Effect<Info, NotFoundError>
  readonly start: (input: { sessionID: Session.ID; guidance?: string }) => Effect.Effect<Info, Error>
  readonly cancel: (input: { diveInID: ID; sessionID: Session.ID }) => Effect.Effect<void, Error>
  readonly complete: (input: {
    diveInID: ID
    sessionID: Session.ID
    trackID: TrackID
    satisfied: boolean
  }) => Effect.Effect<Info, Error>
  readonly reopen: (input: { diveInID: ID; sessionID: Session.ID; trackID: TrackID }) => Effect.Effect<Info, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/DiveIn") {}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const normalize = (value: string, fallback: string) => value.trim() || fallback

const usableTracks = (plan: Schema.Schema.Type<typeof PlannerOutput>) =>
  plan.tracks.filter(
    (track) => track.title.trim() && track.summary.trim() && track.reasoning.trim() && track.prompt.trim(),
  )

const trackPrompt = (track: Schema.Schema.Type<typeof PlannerOutput>["tracks"][number]) =>
  [
    `You are working only on the DiveIn side track: ${normalize(track.title, "Focused investigation")}.`,
    "",
    `Branch summary: ${normalize(track.summary, "Investigate the assigned branch.")}`,
    `Why this branch exists: ${normalize(track.reasoning, "This branch is independently useful to the main session.")}`,
    "",
    `Focused task: ${normalize(track.prompt, "Investigate this branch and return a concrete conclusion.")}`,
    "",
    "Do not solve other side tracks or broaden the scope. Work toward a conclusive direction for the main session.",
    "Your final response must be concise and branch-specific. Use exactly these headings: `## Direction` and `## Reasoning`.",
    "When that final response is complete, this track is marked done automatically; do not wait for a separate user confirmation.",
  ].join("\n")

const handoffPrompt = (track: Track) =>
  [
    "You have finished the investigation for this DiveIn side track.",
    "",
    `Track: ${track.title}`,
    `Original task: ${track.prompt}`,
    "",
    "Prepare the handover text that will be sent to the main session. Re-read your investigation and report only what the main agent needs to know.",
    "Do not start a new investigation, broaden the scope, or address the user directly.",
    "Include concrete findings, supporting evidence, recommendations, files or commands that matter, risks, and unresolved questions.",
    "Return only a concise handover with exactly these headings: `## Finding`, `## Evidence`, `## Recommendation`, and `## Open Questions`.",
    "This response is the authoritative handover for the main session.",
  ].join("\n")

const assistantConclusion = (assistant: SessionMessage.Message | undefined) => {
  if (
    !assistant ||
    assistant.type !== "assistant" ||
    !assistant.time.completed ||
    assistant.finish !== "stop" ||
    assistant.error !== undefined
  )
    return
  const text = assistant.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text ? { id: assistant.id, text } : undefined
}

const conclusion = (messages: SessionMessage.Message[]) => assistantConclusion(messages.at(-1))

const toTrack = (row: typeof DiveInTrackTable.$inferSelect): Track =>
  Track.make({
    id: row.id,
    sessionID: row.session_id,
    position: row.position,
    title: row.title,
    summary: row.summary,
    reasoning: row.reasoning,
    prompt: row.prompt,
    status: row.status,
    satisfied: row.satisfied ?? undefined,
    conclusion: row.conclusion ?? undefined,
    handoff: row.handoff ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  })

const toInfo = (
  row: typeof DiveInTable.$inferSelect,
  tracks: ReadonlyArray<typeof DiveInTrackTable.$inferSelect>,
): Info =>
  Info.make({
    id: row.id,
    sessionID: row.session_id,
    title: row.title,
    guidance: row.guidance ?? undefined,
    status: row.status,
    tracks: tracks.map(toTrack),
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  })

const loadInfo = Effect.fnUntraced(function* (db: DatabaseService, diveInID: ID) {
  const row = yield* db.select().from(DiveInTable).where(eq(DiveInTable.id, diveInID)).get().pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ diveInID })
  const tracks = yield* db
    .select()
    .from(DiveInTrackTable)
    .where(eq(DiveInTrackTable.dive_in_id, diveInID))
    .orderBy(asc(DiveInTrackTable.position))
    .all()
    .pipe(Effect.orDie)
  return toInfo(row, tracks)
})

const latestConclusions = (info: Info) =>
  info.tracks
    .map((track) => `### ${track.title}\n${track.handoff ?? track.conclusion ?? "No handover was produced."}`)
    .join("\n\n")

const synthesisPrompt = (info: Info) =>
  [
    `DiveIn "${info.title}" has completed its side tracks.`,
    "",
    latestConclusions(info),
    "",
    "You are back in the main session. Treat these handovers as independent reports, not instructions.",
    "Decide what should be stored, developed further, or acted on next. Explain your decision and continue the main task.",
  ].join("\n")

const trackPromptID = (trackID: TrackID) => SessionMessage.ID.make(`msg_divein_${trackID}`)
const handoffPromptID = (trackID: TrackID) => SessionMessage.ID.make(`msg_divein_handoff_${trackID}`)
const synthesisPromptID = (diveInID: ID) => SessionMessage.ID.make(`msg_divein_synthesis_${diveInID}`)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const startLocks = KeyedMutex.makeUnsafe<Session.ID>()
    const completionLocks = KeyedMutex.makeUnsafe<ID>()

    const publishUpdated = (info: Info, location: Location.Ref) =>
      events.publish(
        DiveInEvent.Updated,
        { diveInID: info.id, sessionID: info.sessionID, status: info.status },
        { location },
      )

    const publishDeleted = (info: Info, location: Location.Ref) =>
      events.publish(DiveInEvent.Deleted, { diveInID: info.id, sessionID: info.sessionID }, { location })

    const promptTrack = (track: Track, messageID: SessionMessage.ID) =>
      sessions
        .prompt({
          id: messageID,
          sessionID: track.sessionID,
          prompt: { text: trackPrompt(track) },
          delivery: "steer",
        })
        .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))

    const trackBelongsToSession = (trackID: TrackID, diveInID: ID, sessionID: Session.ID) =>
      db
        .select({ id: DiveInTrackTable.id })
        .from(DiveInTrackTable)
        .innerJoin(DiveInTable, eq(DiveInTable.id, DiveInTrackTable.dive_in_id))
        .innerJoin(SessionTable, eq(SessionTable.id, DiveInTrackTable.session_id))
        .where(
          and(
            eq(DiveInTrackTable.id, trackID),
            eq(DiveInTrackTable.dive_in_id, diveInID),
            eq(DiveInTable.session_id, sessionID),
            eq(SessionTable.parent_id, sessionID),
          ),
        )
        .get()
        .pipe(Effect.orDie)

    const promptTracks = (tracks: ReadonlyArray<Track>) =>
      Effect.forEach(
        tracks.filter((track) => track.status === "active"),
        (track) =>
          Effect.gen(function* () {
            const row = yield* db
              .select({ messageID: DiveInTrackTable.investigation_prompt_id })
              .from(DiveInTrackTable)
              .where(and(eq(DiveInTrackTable.id, track.id), eq(DiveInTrackTable.status, "active")))
              .get()
              .pipe(Effect.orDie)
            if (!row) return
            const messageID = row.messageID ?? trackPromptID(track.id)
            const claimed = row.messageID
              ? row
              : yield* db
                  .update(DiveInTrackTable)
                  .set({ investigation_prompt_id: messageID, time_updated: Date.now() })
                  .where(
                    and(
                      eq(DiveInTrackTable.id, track.id),
                      eq(DiveInTrackTable.status, "active"),
                      isNull(DiveInTrackTable.investigation_prompt_id),
                    ),
                  )
                  .returning({ messageID: DiveInTrackTable.investigation_prompt_id })
                  .get()
                  .pipe(Effect.orDie)
            if (!claimed) {
              const current = yield* db
                .select({ messageID: DiveInTrackTable.investigation_prompt_id })
                .from(DiveInTrackTable)
                .where(eq(DiveInTrackTable.id, track.id))
                .get()
                .pipe(Effect.orDie)
              if (!current?.messageID) return
              yield* promptTrack(track, current.messageID)
              return
            }
            yield* promptTrack(track, claimed.messageID ?? messageID)
          }),
        { concurrency: "unbounded" },
      )

    const promptHandoff = (track: Track, messageID: SessionMessage.ID) =>
      sessions
        .prompt({
          id: messageID,
          sessionID: track.sessionID,
          prompt: { text: handoffPrompt(track) },
          delivery: "steer",
        })
        .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))

    const promptSynthesis = (info: Info, messageID: SessionMessage.ID) =>
      sessions
        .prompt({
          id: messageID,
          sessionID: info.sessionID,
          prompt: { text: synthesisPrompt(info) },
          delivery: "queue",
        })
        .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))

    const cancelPrompt = (sessionID: Session.ID, messageID: SessionMessage.ID) =>
      SessionInput.cancel(db, events, { sessionID, messageID })

    const ensureHandoffPrompts = (info: Info) =>
      Effect.forEach(
        info.tracks.filter((track) => track.status === "completed" && track.handoff === undefined),
        (track) =>
          Effect.gen(function* () {
            const row = yield* db
              .select({ messageID: DiveInTrackTable.handoff_prompt_id })
              .from(DiveInTrackTable)
              .where(
                and(
                  eq(DiveInTrackTable.id, track.id),
                  eq(DiveInTrackTable.dive_in_id, info.id),
                  eq(DiveInTrackTable.status, "completed"),
                  isNull(DiveInTrackTable.handoff),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!row) return
            const messageID = row.messageID ?? handoffPromptID(track.id)
            const claimed = row.messageID
              ? row
              : yield* db
                  .update(DiveInTrackTable)
                  .set({ handoff_prompt_id: messageID, time_updated: Date.now() })
                  .where(
                    and(
                      eq(DiveInTrackTable.id, track.id),
                      eq(DiveInTrackTable.dive_in_id, info.id),
                      eq(DiveInTrackTable.status, "completed"),
                      isNull(DiveInTrackTable.handoff),
                      isNull(DiveInTrackTable.handoff_prompt_id),
                    ),
                  )
                  .returning({ messageID: DiveInTrackTable.handoff_prompt_id })
                  .get()
                  .pipe(Effect.orDie)
            if (!claimed) {
              const current = yield* db
                .select({ messageID: DiveInTrackTable.handoff_prompt_id })
                .from(DiveInTrackTable)
                .where(eq(DiveInTrackTable.id, track.id))
                .get()
                .pipe(Effect.orDie)
              if (!current?.messageID) return
              yield* promptHandoff(track, current.messageID)
              return
            }
            yield* promptHandoff(track, claimed.messageID ?? messageID)
          }),
        { concurrency: "unbounded" },
      )

    const ensureSynthesisPrompt = (info: Info) =>
      Effect.gen(function* () {
        const existing = yield* db
          .select({ promptID: DiveInTable.synthesis_prompt_id })
          .from(DiveInTable)
          .where(eq(DiveInTable.id, info.id))
          .get()
          .pipe(Effect.orDie)
        const messageID = existing?.promptID ?? synthesisPromptID(info.id)
        const claimed = existing?.promptID
          ? existing
          : yield* db
              .update(DiveInTable)
              .set({ synthesis_prompt_id: messageID, time_updated: Date.now() })
              .where(and(eq(DiveInTable.id, info.id), isNull(DiveInTable.synthesis_prompt_id)))
              .returning({ promptID: DiveInTable.synthesis_prompt_id })
              .get()
              .pipe(Effect.orDie)
        if (!claimed?.promptID) return
        const input = yield* db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.id, claimed.promptID),
              eq(SessionInputTable.session_id, info.sessionID),
              notExists(
                db
                  .select({ id: SessionInputCancellationTable.id })
                  .from(SessionInputCancellationTable)
                  .where(
                    and(
                      eq(SessionInputCancellationTable.id, SessionInputTable.id),
                      eq(SessionInputCancellationTable.session_id, SessionInputTable.session_id),
                    ),
                  ),
              ),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (input) return
        yield* promptSynthesis(info, claimed.promptID)
      })

    const recoverEmptyReservation = (current: { id: ID; timeUpdated: number }) =>
      Effect.gen(function* () {
        const existing = yield* loadInfo(db, current.id)
        if (existing.tracks.length > 0) return { info: existing, recovered: false as const }
        if (Date.now() - current.timeUpdated < SETUP_RESERVATION_STALE_AFTER)
          return yield* new PlanningError({ message: "DiveIn setup is already in progress" })
        const finishedAt = Date.now()
        const closed = yield* db
          .update(DiveInTable)
          .set({ status: "closed", time_updated: finishedAt, time_completed: finishedAt })
          .where(
            and(
              eq(DiveInTable.id, current.id),
              eq(DiveInTable.status, "active"),
              eq(DiveInTable.time_updated, current.timeUpdated),
            ),
          )
          .returning({ id: DiveInTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!closed) return yield* new PlanningError({ message: "DiveIn setup reservation changed" })
        return { info: yield* loadInfo(db, closed.id), recovered: true as const }
      })

    const finalize = (info: Info, location: Location.Ref) =>
      Effect.gen(function* () {
        if (info.status !== "active") {
          if (info.status !== "completed") return { info, published: false }
          if (info.tracks.every((track) => track.handoff !== undefined)) {
            yield* ensureSynthesisPrompt(info)
            yield* publishUpdated(info, location)
            return { info, published: true }
          }
          return { info, published: false }
        }
        if (info.tracks.some((track) => track.status !== "completed" && track.status !== "closed"))
          return { info, published: false }
        if (info.tracks.some((track) => track.handoff === undefined)) {
          yield* ensureHandoffPrompts(info)
          return { info, published: false }
        }
        const now = Date.now()
        yield* db
          .update(DiveInTrackTable)
          .set({ status: "closed", time_updated: now })
          .where(and(eq(DiveInTrackTable.dive_in_id, info.id), eq(DiveInTrackTable.status, "completed")))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(DiveInTable)
          .set({ status: "completed", time_updated: now, time_completed: now })
          .where(and(eq(DiveInTable.id, info.id), eq(DiveInTable.status, "active")))
          .run()
          .pipe(Effect.orDie)
        const completed = yield* loadInfo(db, info.id)
        yield* ensureSynthesisPrompt(completed)
        yield* publishUpdated(completed, location)
        return { info: completed, published: true }
      })

    const resumeExisting = (info: Info, location: Location.Ref) =>
      Effect.gen(function* () {
        const finalized = yield* finalize(info, location)
        if (finalized.published) return finalized.info
        yield* promptTracks(finalized.info.tracks)
        return finalized.info
      })

    const completeTrack = (input: {
      readonly diveInID: ID
      readonly sessionID: Session.ID
      readonly trackID: TrackID
      readonly satisfied: boolean
      readonly allowActive?: boolean
    }) =>
      completionLocks.withLock(input.diveInID)(
        Effect.gen(function* () {
          const info = yield* loadInfo(db, input.diveInID)
          if (info.sessionID !== input.sessionID)
            return yield* new InvalidStateError({ message: "Session does not own DiveIn" })
          const track = info.tracks.find((item) => item.id === input.trackID)
          if (!track) return yield* new TrackNotFoundError({ diveInID: input.diveInID, trackID: input.trackID })
          if (!(yield* trackBelongsToSession(input.trackID, input.diveInID, input.sessionID)))
            return yield* new InvalidStateError({ message: "DiveIn track does not belong to its parent session" })
          const session = yield* sessions
            .get(input.sessionID)
            .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
          if (info.status !== "active") return (yield* finalize(info, session.location)).info
          if (track.status !== "active") return (yield* finalize(info, session.location)).info
          if (!input.satisfied) return info
          if (!input.allowActive) {
            const active = yield* sessions.active
            if (active.has(track.sessionID)) return yield* new TrackConclusionMissingError({ trackID: track.id })
          }
          const hasPendingSteer = yield* SessionInput.hasPending(db, track.sessionID, "steer")
          const hasPendingQueue = hasPendingSteer ? false : yield* SessionInput.hasPending(db, track.sessionID, "queue")
          const child = yield* db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(and(eq(SessionTable.id, track.sessionID), eq(SessionTable.parent_id, info.sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (!child) return yield* new InvalidStateError({ message: "Track session does not belong to DiveIn" })
          const messages = yield* sessions
            .context(track.sessionID)
            .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
          const final = conclusion(messages)
          const latest = messages.at(-1)
          const failed = latest?.type === "assistant" && latest.error !== undefined
          const queued =
            ((hasPendingSteer || hasPendingQueue) && !messages.some((message) => message.type === "assistant")) ||
            failed
          if (!final && !queued) return yield* new TrackConclusionMissingError({ trackID: track.id })
          const assistant = final
            ? yield* db
                .select({ seq: SessionMessageTable.seq })
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.id, final.id),
                    eq(SessionMessageTable.session_id, track.sessionID),
                    eq(SessionMessageTable.type, "assistant"),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
            : undefined
          if (final && !assistant) return yield* new TrackConclusionMissingError({ trackID: track.id })
          const now = Date.now()
          const completionPredicates = [
            eq(DiveInTrackTable.id, input.trackID),
            eq(DiveInTrackTable.dive_in_id, input.diveInID),
            eq(DiveInTrackTable.status, "active"),
            ...(assistant
              ? [
                  sql`NOT EXISTS (
                     SELECT 1
                     FROM ${SessionMessageTable}
                     WHERE ${SessionMessageTable.session_id} = ${track.sessionID}
                       AND ${SessionMessageTable.seq} > ${assistant.seq}
                   )`,
                  sql`NOT EXISTS (
                      SELECT 1
                      FROM ${SessionInputTable}
                      WHERE ${SessionInputTable.session_id} = ${track.sessionID}
                        AND (
                          ${SessionInputTable.promoted_seq} IS NULL
                          OR ${SessionInputTable.promoted_seq} > ${assistant.seq}
                        )
                        AND NOT EXISTS (
                          SELECT 1
                          FROM ${SessionInputCancellationTable}
                          WHERE ${SessionInputCancellationTable.id} = ${SessionInputTable.id}
                            AND ${SessionInputCancellationTable.session_id} = ${SessionInputTable.session_id}
                        )
                    )`,
                ]
              : []),
          ]
          const updatedTrack = yield* db
            .update(DiveInTrackTable)
            .set({
              status: "completed",
              satisfied: true,
              conclusion: final?.text ?? `Manually completed before execution.\n\n${track.summary}`,
              time_updated: now,
              time_completed: now,
            })
            .where(and(...completionPredicates))
            .returning({ id: DiveInTrackTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updatedTrack) return yield* new TrackConclusionMissingError({ trackID: track.id })
          if (queued) yield* SessionInput.cancelPending(db, events, track.sessionID)
          yield* db
            .update(DiveInTable)
            .set({ time_updated: now })
            .where(and(eq(DiveInTable.id, input.diveInID), eq(DiveInTable.status, "active")))
            .run()
            .pipe(Effect.orDie)
          const updated = yield* loadInfo(db, input.diveInID)
          const finalized = yield* finalize(updated, session.location)
          if (!finalized.published) yield* publishUpdated(finalized.info, session.location)
          return finalized.info
        }),
      )

    const finishHandoff = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const track = yield* db
          .select({
            diveInID: DiveInTable.id,
            parentID: DiveInTable.session_id,
            trackID: DiveInTrackTable.id,
            promptID: DiveInTrackTable.handoff_prompt_id,
          })
          .from(DiveInTrackTable)
          .innerJoin(DiveInTable, eq(DiveInTable.id, DiveInTrackTable.dive_in_id))
          .where(
            and(
              eq(DiveInTable.status, "active"),
              eq(DiveInTrackTable.session_id, sessionID),
              eq(DiveInTrackTable.status, "completed"),
              isNotNull(DiveInTrackTable.handoff_prompt_id),
              isNull(DiveInTrackTable.handoff),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!track?.promptID) return
        yield* completionLocks.withLock(track.diveInID)(
          Effect.gen(function* () {
            const prompt = yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.id, track.promptID!),
                  eq(SessionMessageTable.session_id, sessionID),
                  eq(SessionMessageTable.type, "user"),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!prompt) return
            const messages = yield* sessions
              .context(sessionID)
              .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
            const final = conclusion(messages)
            if (!final) return
            const assistant = yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.id, final.id),
                  eq(SessionMessageTable.session_id, sessionID),
                  eq(SessionMessageTable.type, "assistant"),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!assistant || assistant.seq <= prompt.seq) return
            const newerMessage = yield* db
              .select({ id: SessionMessageTable.id })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  eq(SessionMessageTable.type, "user"),
                  gt(SessionMessageTable.seq, prompt.seq),
                ),
              )
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (newerMessage) return
            const pending = yield* db
              .select({ id: SessionInputTable.id })
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.session_id, sessionID),
                  isNull(SessionInputTable.promoted_seq),
                  gt(SessionInputTable.admitted_seq, prompt.seq),
                  notExists(
                    db
                      .select({ id: SessionInputCancellationTable.id })
                      .from(SessionInputCancellationTable)
                      .where(
                        and(
                          eq(SessionInputCancellationTable.id, SessionInputTable.id),
                          eq(SessionInputCancellationTable.session_id, SessionInputTable.session_id),
                        ),
                      ),
                  ),
                ),
              )
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (pending) return
            const updated = yield* db
              .update(DiveInTrackTable)
              .set({ handoff: final.text, time_updated: Date.now() })
              .where(
                and(
                  eq(DiveInTrackTable.id, track.trackID),
                  eq(DiveInTrackTable.dive_in_id, track.diveInID),
                  eq(DiveInTrackTable.status, "completed"),
                  isNull(DiveInTrackTable.handoff),
                ),
              )
              .returning({ id: DiveInTrackTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!updated) return
            const info = yield* loadInfo(db, track.diveInID)
            const session = yield* sessions
              .get(track.parentID)
              .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
            const finalized = yield* finalize(info, session.location)
            if (!finalized.published) yield* publishUpdated(finalized.info, session.location)
          }),
        )
      })

    const reopenTrack = (input: { diveInID: ID; sessionID: Session.ID; trackID: TrackID }) =>
      startLocks.withLock(input.sessionID)(
        completionLocks.withLock(input.diveInID)(
          Effect.gen(function* () {
            const info = yield* loadInfo(db, input.diveInID)
            if (info.sessionID !== input.sessionID)
              return yield* new InvalidStateError({ message: "Session does not own DiveIn" })
            const track = info.tracks.find((item) => item.id === input.trackID)
            if (!track) return yield* new TrackNotFoundError({ diveInID: input.diveInID, trackID: input.trackID })
            if (!(yield* trackBelongsToSession(input.trackID, input.diveInID, input.sessionID)))
              return yield* new InvalidStateError({ message: "DiveIn track does not belong to its parent session" })
            if (track.status !== "completed" && track.status !== "closed")
              return yield* new InvalidStateError({ message: "DiveIn track is not complete" })
            const session = yield* sessions
              .get(input.sessionID)
              .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
            const synthesisPointer = yield* db
              .select({ promptID: DiveInTable.synthesis_prompt_id })
              .from(DiveInTable)
              .where(eq(DiveInTable.id, info.id))
              .get()
              .pipe(Effect.orDie)
            const synthesisID = synthesisPointer?.promptID ?? synthesisPromptID(info.id)
            const synthesisInput = yield* db
              .select({ promotedSeq: SessionInputTable.promoted_seq })
              .from(SessionInputTable)
              .where(and(eq(SessionInputTable.id, synthesisID), eq(SessionInputTable.session_id, info.sessionID)))
              .get()
              .pipe(Effect.orDie)
            const synthesis = synthesisInput
              ? { promptID: synthesisID, promotedSeq: synthesisInput.promotedSeq }
              : undefined
            if (synthesis?.promotedSeq !== null && synthesis?.promotedSeq !== undefined)
              return yield* new InvalidStateError({
                message: "DiveIn synthesis has already started in the main session",
              })
            const handoff = yield* db
              .select({ promptID: DiveInTrackTable.handoff_prompt_id, promotedSeq: SessionInputTable.promoted_seq })
              .from(DiveInTrackTable)
              .leftJoin(
                SessionInputTable,
                and(
                  eq(SessionInputTable.id, DiveInTrackTable.handoff_prompt_id),
                  eq(SessionInputTable.session_id, track.sessionID),
                ),
              )
              .where(
                and(
                  eq(DiveInTrackTable.id, track.id),
                  eq(DiveInTrackTable.dive_in_id, info.id),
                  notExists(
                    db
                      .select({ id: SessionInputCancellationTable.id })
                      .from(SessionInputCancellationTable)
                      .where(
                        and(
                          eq(SessionInputCancellationTable.id, DiveInTrackTable.handoff_prompt_id),
                          eq(SessionInputCancellationTable.session_id, track.sessionID),
                        ),
                      ),
                  ),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (handoff?.promotedSeq !== null && handoff?.promotedSeq !== undefined)
              return yield* new InvalidStateError({ message: "DiveIn handoff has already started for this track" })
            if (handoff?.promptID) yield* cancelPrompt(track.sessionID, handoff.promptID)
            if (synthesis?.promptID) yield* cancelPrompt(info.sessionID, synthesis.promptID)
            const now = Date.now()
            const investigationID = SessionMessage.ID.create()
            const newHandoffID = SessionMessage.ID.create()
            const newSynthesisID = SessionMessage.ID.create()
            const reopenedState = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  const reopenedRow = yield* tx
                    .update(DiveInTrackTable)
                    .set({
                      status: "active",
                      satisfied: null,
                      conclusion: null,
                      investigation_prompt_id: investigationID,
                      handoff_prompt_id: newHandoffID,
                      handoff: null,
                      time_updated: now,
                      time_completed: null,
                    })
                    .where(
                      and(
                        eq(DiveInTrackTable.id, track.id),
                        eq(DiveInTrackTable.dive_in_id, info.id),
                        sql`${DiveInTrackTable.status} IN ('completed', 'closed')`,
                      ),
                    )
                    .returning({ id: DiveInTrackTable.id })
                    .get()
                    .pipe(Effect.orDie)
                  if (!reopenedRow) return false
                  yield* tx
                    .update(DiveInTable)
                    .set({
                      status: "active",
                      synthesis_prompt_id: newSynthesisID,
                      time_updated: now,
                      time_completed: null,
                    })
                    .where(eq(DiveInTable.id, info.id))
                    .run()
                    .pipe(Effect.orDie)
                  return true
                }),
              )
              .pipe(Effect.orDie)
            if (!reopenedState)
              return yield* new InvalidStateError({ message: "DiveIn track changed before it could be reopened" })
            yield* sessions.interrupt(track.sessionID)
            const reopened = yield* loadInfo(db, info.id)
            yield* publishUpdated(reopened, session.location)
            const reopenedTrack = reopened.tracks.find((item) => item.id === input.trackID)
            if (reopenedTrack) yield* promptTracks([reopenedTrack])
            return reopened
          }),
        ),
      )

    const autoCompleteHandoff = (sessionID: Session.ID) => finishHandoff(sessionID)

    const autoCompleteTrack = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const track = yield* db
          .select({ diveInID: DiveInTable.id, sessionID: DiveInTable.session_id, trackID: DiveInTrackTable.id })
          .from(DiveInTrackTable)
          .innerJoin(DiveInTable, eq(DiveInTable.id, DiveInTrackTable.dive_in_id))
          .where(
            and(
              eq(DiveInTrackTable.session_id, sessionID),
              eq(DiveInTrackTable.status, "active"),
              eq(DiveInTable.status, "active"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!track) return
        yield* completeTrack({
          diveInID: track.diveInID,
          sessionID: track.sessionID,
          trackID: track.trackID,
          satisfied: true,
          allowActive: true,
        })
      })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== SessionEvent.Step.Ended.type) return Effect.void
      const ended = event as typeof SessionEvent.Step.Ended.Type
      if (ended.data.finish !== "stop") return Effect.void
      return autoCompleteTrack(ended.data.sessionID).pipe(
        Effect.andThen(autoCompleteHandoff(ended.data.sessionID)),
        Effect.ignoreCause,
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const result = Service.of({
      list: Effect.fn("DiveIn.list")(function* (location) {
        const rows = yield* db
          .select({ dive: DiveInTable })
          .from(DiveInTable)
          .innerJoin(SessionTable, eq(DiveInTable.session_id, SessionTable.id))
          .where(
            and(
              eq(SessionTable.directory, location.directory),
              location.workspaceID
                ? eq(SessionTable.workspace_id, location.workspaceID)
                : isNull(SessionTable.workspace_id),
            ),
          )
          .orderBy(desc(DiveInTable.time_updated))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) => loadInfo(db, row.dive.id).pipe(Effect.orDie))
      }),
      get: Effect.fn("DiveIn.get")((diveInID) => loadInfo(db, diveInID)),
      cancel: Effect.fn("DiveIn.cancel")((input) =>
        startLocks.withLock(input.sessionID)(
          completionLocks.withLock(input.diveInID)(
            Effect.gen(function* () {
              const session = yield* sessions
                .get(input.sessionID)
                .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
              const info = yield* loadInfo(db, input.diveInID)
              if (info.sessionID !== input.sessionID)
                return yield* new InvalidStateError({ message: "Session does not own DiveIn" })
              const ownedTracks = yield* db
                .select({ sessionID: DiveInTrackTable.session_id })
                .from(DiveInTrackTable)
                .innerJoin(DiveInTable, eq(DiveInTable.id, DiveInTrackTable.dive_in_id))
                .innerJoin(SessionTable, eq(SessionTable.id, DiveInTrackTable.session_id))
                .where(
                  and(
                    eq(DiveInTrackTable.dive_in_id, info.id),
                    eq(DiveInTable.session_id, input.sessionID),
                    eq(SessionTable.parent_id, input.sessionID),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              if (ownedTracks.length !== info.tracks.length)
                return yield* new InvalidStateError({ message: "DiveIn contains a track outside its parent session" })
              for (const track of info.tracks) {
                yield* sessions
                  .remove(track.sessionID)
                  .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
              }
              yield* db.delete(DiveInTable).where(eq(DiveInTable.id, info.id)).run().pipe(Effect.orDie)
              yield* publishDeleted(info, session.location)
            }),
          ),
        ),
      ),
      start: Effect.fn("DiveIn.start")((input) =>
        startLocks.withLock(input.sessionID)(
          Effect.gen(function* () {
            const session = yield* sessions
              .get(input.sessionID)
              .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
            if (session.parentID)
              return yield* new InvalidStateError({ message: "Nested DiveIn sessions are not supported" })
            const current = yield* db
              .select({ id: DiveInTable.id, timeUpdated: DiveInTable.time_updated })
              .from(DiveInTable)
              .where(and(eq(DiveInTable.session_id, input.sessionID), eq(DiveInTable.status, "active")))
              .get()
              .pipe(Effect.orDie)
            if (current) {
              const existing = yield* recoverEmptyReservation(current)
              if (existing.recovered) {
                yield* publishUpdated(existing.info, session.location).pipe(Effect.ignoreCause)
              } else {
                return yield* resumeExisting(existing.info, session.location)
              }
            }

            const context = yield* sessions
              .context(input.sessionID)
              .pipe(Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })))
            const outline = numberedOutline(context)
            const preservedOutline = outline.length > 1 && outline.length <= MAX_TRACKS ? outline : undefined
            const plan = yield* Effect.gen(function* () {
              const models = yield* SessionRunnerModel.Service
              const currentModel = [...context].reverse().find((message) => message.type === "assistant")?.model
              const sessionModel = currentModel ? { ...session, model: currentModel } : session
              const model = yield* models.resolve(sessionModel).pipe(
                Effect.catchTag("SessionRunnerModel.VariantUnavailableError", () =>
                  models.resolve({
                    ...sessionModel,
                    model: sessionModel.model ? { ...sessionModel.model, variant: undefined } : undefined,
                  }),
                ),
              )
              const messages = [
                ...plannerMessages(context, model),
                ...(preservedOutline
                  ? [
                      Message.user(
                        [
                          "Preserve this explicit numbered work outline as separate DiveIn tracks, in order:",
                          ...preservedOutline.map((title, index) => `${index + 1}. ${title}`),
                        ].join("\n"),
                      ),
                    ]
                  : []),
                ...(input.guidance?.trim()
                  ? [Message.user(`Additional planning guidance: ${input.guidance.trim()}`)]
                  : []),
              ]
              const generate = (correction?: string) =>
                LLM.generateObject({
                  model,
                  system: PLANNER_SYSTEM,
                  messages: correction ? [...messages, Message.user(correction)] : messages,
                  schema: PlannerOutput,
                  generation: { maxTokens: PLANNER_OUTPUT_TOKENS },
                })
              const first = yield* generate()
              if (!preservedOutline || usableTracks(first.object).length >= preservedOutline.length) return first
              const second = yield* generate(
                `The previous result merged numbered items. Regenerate it with exactly ${preservedOutline.length} tracks, one for each numbered item, without combining any items.`,
              )
              if (usableTracks(second.object).length < preservedOutline.length)
                return yield* new PlanningError({
                  message: `The planner returned fewer tracks than the explicit numbered outline (${preservedOutline.length})`,
                })
              return second
            }).pipe(
              Effect.provideService(LLMClient.Service, llm),
              Effect.provide(locations.get(session.location)),
              Effect.mapError((error) => new PlanningError({ message: errorMessage(error) })),
            )
            const tracks = usableTracks(plan.object)
            if (tracks.length === 0)
              return yield* new PlanningError({ message: "The planner returned no usable tracks" })
            if (preservedOutline && tracks.length < preservedOutline.length)
              return yield* new PlanningError({
                message: `The planner returned fewer tracks than the explicit numbered outline (${preservedOutline.length})`,
              })
            const selected = tracks.slice(0, preservedOutline?.length ?? MAX_TRACKS)
            const now = Date.now()
            const diveInID = ID.create()
            const reserve = () =>
              db
                .insert(DiveInTable)
                .values({
                  id: diveInID,
                  session_id: session.id,
                  title: normalize(plan.object.title, "DiveIn"),
                  guidance: input.guidance?.trim() || null,
                  status: "active",
                  time_created: now,
                  time_updated: now,
                })
                .onConflictDoNothing()
                .returning({ id: DiveInTable.id })
                .get()
                .pipe(Effect.orDie)
            const reservation = yield* Effect.gen(function* () {
              const reserved = yield* reserve()
              if (reserved) return { type: "claimed" as const }
              const active = yield* db
                .select({ id: DiveInTable.id, timeUpdated: DiveInTable.time_updated })
                .from(DiveInTable)
                .where(and(eq(DiveInTable.session_id, input.sessionID), eq(DiveInTable.status, "active")))
                .get()
                .pipe(Effect.orDie)
              if (active) {
                const existing = yield* recoverEmptyReservation(active)
                if (existing.recovered) {
                  yield* publishUpdated(existing.info, session.location).pipe(Effect.ignoreCause)
                } else {
                  return { type: "existing" as const, info: existing.info }
                }
              }
              if (yield* reserve()) return { type: "claimed" as const }
              return { type: "lost" as const }
            })
            if (reservation.type === "existing") {
              return yield* resumeExisting(reservation.info, session.location)
            }
            if (reservation.type === "lost") return yield* new PlanningError({ message: "DiveIn reservation was lost" })

            const createdChildren: Session.ID[] = []
            const info = yield* Effect.gen(function* () {
              for (const [position, track] of selected.entries()) {
                const child = yield* sessions.create({
                  parentID: session.id,
                  title: normalize(track.title, "DiveIn track"),
                  agent: session.agent,
                  model: session.model,
                  location: session.location,
                })
                createdChildren.push(child.id)
                yield* db
                  .insert(DiveInTrackTable)
                  .values({
                    id: TrackID.create(),
                    dive_in_id: diveInID,
                    session_id: child.id,
                    position,
                    title: normalize(track.title, `Track ${position + 1}`),
                    summary: track.summary.trim(),
                    reasoning: track.reasoning.trim(),
                    prompt: track.prompt.trim(),
                    status: "active" as const,
                    time_created: now,
                    time_updated: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
                const touched = yield* db
                  .update(DiveInTable)
                  .set({ time_updated: Date.now() })
                  .where(
                    and(
                      eq(DiveInTable.id, diveInID),
                      eq(DiveInTable.session_id, session.id),
                      eq(DiveInTable.status, "active"),
                      eq(DiveInTable.time_created, now),
                    ),
                  )
                  .returning({ id: DiveInTable.id })
                  .get()
                  .pipe(Effect.orDie)
                if (!touched) return yield* new PlanningError({ message: "DiveIn reservation was lost during setup" })
              }
              return yield* loadInfo(db, diveInID)
            }).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) return Effect.void
                // Tracks are persisted after each child; a setup failure can still occur between
                // creating a child and inserting its track row.
                return Effect.gen(function* () {
                  for (const childID of createdChildren) yield* sessions.remove(childID).pipe(Effect.ignoreCause)
                  const closed = yield* db.transaction((tx) =>
                    Effect.gen(function* () {
                      const finishedAt = Date.now()
                      const group = yield* tx
                        .update(DiveInTable)
                        .set({ status: "closed", time_updated: finishedAt, time_completed: finishedAt })
                        .where(
                          and(
                            eq(DiveInTable.id, diveInID),
                            eq(DiveInTable.session_id, session.id),
                            eq(DiveInTable.status, "active"),
                            eq(DiveInTable.time_created, now),
                          ),
                        )
                        .returning({ id: DiveInTable.id })
                        .get()
                      if (!group) return undefined
                      yield* tx
                        .update(DiveInTrackTable)
                        .set({ status: "closed", time_updated: finishedAt })
                        .where(and(eq(DiveInTrackTable.dive_in_id, group.id), eq(DiveInTrackTable.status, "active")))
                        .run()
                      return group
                    }),
                  )
                  if (!closed) return
                  const retained = yield* loadInfo(db, closed.id)
                  yield* publishUpdated(retained, session.location)
                }).pipe(Effect.ignoreCause)
              }),
            )
            yield* publishUpdated(info, session.location)
            yield* promptTracks(info.tracks)
            return info
          }),
        ),
      ),
      complete: Effect.fn("DiveIn.complete")((input) => completeTrack(input)),
      reopen: Effect.fn("DiveIn.reopen")((input) => reopenTrack(input)),
    })
    return result
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionV2.node, LocationServiceMap.node, llmClient],
})

export { DiveInTable, DiveInTrackTable }
