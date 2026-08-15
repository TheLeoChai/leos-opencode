export * as SessionInput from "./input"

import { and, asc, eq, isNull, lte, notExists } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Admitted, Delivery } from "@opencode-ai/schema/session-input"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { optional } from "../schema"
import { SessionInputCancellationTable, SessionInputTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export { Admitted, Delivery }

const PersistedPrompt = Schema.Struct({
  ...Prompt.fields,
  resume: Schema.Boolean.pipe(optional),
})
const encodePrompt = Schema.encodeSync(Prompt)
const decodePersistedPrompt = Schema.decodeUnknownSync(PersistedPrompt)
const encodePersistedPrompt = Schema.encodeSync(PersistedPrompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted => {
  const persisted = decodePersistedPrompt(row.prompt)
  return Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: Prompt.fromUserMessage(persisted),
    delivery: row.delivery,
    ...(persisted.resume === undefined ? {} : { resume: persisted.resume }),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })
}

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.id, id),
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
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export class CancellationConflict extends Schema.TaggedErrorClass<CancellationConflict>()(
  "SessionInput.CancellationConflict",
  { id: SessionMessage.ID },
) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly resume?: boolean
  },
) {
  const cancelled = yield* db
    .select({ id: SessionInputCancellationTable.id })
    .from(SessionInputCancellationTable)
    .where(eq(SessionInputCancellationTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (cancelled) return yield* new CancellationConflict({ id: input.id })
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  yield* events
    .publish(SessionEvent.PromptAdmitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
    })
    .pipe(
      Effect.asVoid,
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.void : Effect.die(defect)))),
      ),
    )
  const stored = yield* find(db, input.id)
  if (stored) return stored
  return yield* new CancellationConflict({ id: input.id })
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly resume?: boolean
    readonly timeCreated: DateTime.Utc
  },
) {
  const cancellation = yield* db
    .select({ id: SessionInputCancellationTable.id, sessionID: SessionInputCancellationTable.session_id })
    .from(SessionInputCancellationTable)
    .where(eq(SessionInputCancellationTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (cancellation?.sessionID === input.sessionID) return false
  if (cancellation) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePersistedPrompt({
        ...input.prompt,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
      }),
      delivery: input.delivery,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return true
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const cancellation = yield* db
    .select({ id: SessionInputCancellationTable.id, sessionID: SessionInputCancellationTable.session_id })
    .from(SessionInputCancellationTable)
    .where(eq(SessionInputCancellationTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (cancellation?.sessionID === input.sessionID) return false
  if (cancellation) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return true
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return true
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePersistedPrompt(input.prompt),
      delivery: input.delivery,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
  return true
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, delivery),
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
  return row !== undefined
})

export const cancel = Effect.fn("SessionInput.cancel")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly messageID: SessionMessage.ID },
) {
  const event = yield* events.publish(SessionEvent.PromptCancelled, {
    sessionID: input.sessionID,
    messageID: input.messageID,
    timestamp: yield* DateTime.now,
  })
  if (event.durable === undefined) return yield* Effect.die("Prompt cancellation event is missing aggregate sequence")
  return event.durable.seq
})

export const cancelPending = Effect.fn("SessionInput.cancelPending")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const inputs = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
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
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    inputs,
    (input) => cancel(db, events, { sessionID, messageID: SessionMessage.ID.make(input.id) }),
    {
      discard: true,
    },
  )
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) => input.delivery === expected.delivery && matchesPrompt(input, expected)

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    const id = SessionMessage.ID.make(row.id)
    yield* events
      .publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(row.time_created),
        messageID: id,
        prompt: Prompt.fromUserMessage(decodePersistedPrompt(row.prompt)),
        delivery: row.delivery,
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, id).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows.length
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
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
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
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
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row]).pipe(Effect.as(true))
})
