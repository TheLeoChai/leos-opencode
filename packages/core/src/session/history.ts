import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { ModelV2 } from "../model"
import { MessageTable, PartTable, SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

const legacyInfo = (row: typeof MessageTable.$inferSelect) =>
  ({ ...row.data, id: row.id, sessionID: row.session_id }) as SessionV1.Info

const legacyPart = (row: typeof PartTable.$inferSelect) =>
  ({ ...row.data, id: row.id, sessionID: row.session_id, messageID: row.message_id }) as SessionV1.Part

const legacyTextPart = (id: string, text: string) => ({ type: "text" as const, id, text })

const legacyAssistantContent = (parts: SessionV1.Part[]): SessionMessage.AssistantContent[] =>
  parts.flatMap((part): SessionMessage.AssistantContent[] => {
    if (part.type === "text") {
      if (part.ignored || part.text.length === 0) return []
      return [legacyTextPart(part.id, part.text)]
    }
    if (part.type === "reasoning") {
      return [
        {
          type: "reasoning" as const,
          id: part.id,
          text: part.text,
          time: {
            created: DateTime.makeUnsafe(part.time.start),
            ...(part.time.end === undefined ? {} : { completed: DateTime.makeUnsafe(part.time.end) }),
          },
        },
      ]
    }
    if (part.type === "tool" && part.state.status === "completed") {
      return [legacyTextPart(`${part.id}:output`, `[Tool ${part.tool} output]\n${part.state.output}`)]
    }
    if (part.type === "subtask") {
      return [legacyTextPart(part.id, `[Subtask: ${part.description}]\n${part.prompt}`)]
    }
    return []
  })

const legacyUserText = (parts: SessionV1.Part[]) =>
  parts
    .flatMap((part) => {
      if (part.type === "text" && !part.ignored && part.text.length > 0) return [part.text]
      if (part.type === "file") return [`[Attached file: ${part.filename ?? "file"}]`]
      if (part.type === "subtask") return [`[Subtask: ${part.description}]\n${part.prompt}`]
      return []
    })
    .join("\n")

const fromLegacy = (row: typeof MessageTable.$inferSelect, parts: SessionV1.Part[]) => {
  const info = legacyInfo(row)
  const time = { created: DateTime.makeUnsafe(info.time.created) }
  if (info.role === "user") {
    const text = legacyUserText(parts)
    if (text.length === 0) return
    return SessionMessage.User.make({
      id: SessionMessage.ID.make(row.id),
      type: "user",
      text,
      time,
    })
  }

  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(row.id),
    type: "assistant",
    agent: info.agent,
    model: {
      id: info.modelID,
      providerID: info.providerID,
      ...(info.variant === undefined ? {} : { variant: ModelV2.VariantID.make(info.variant) }),
    },
    content: legacyAssistantContent(parts),
    ...(info.finish === undefined ? {} : { finish: info.finish }),
    ...(info.cost === undefined ? {} : { cost: info.cost }),
    tokens: {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cache: info.tokens.cache,
    },
    time: {
      ...time,
      ...(info.time.completed === undefined ? {} : { completed: DateTime.makeUnsafe(info.time.completed) }),
    },
  })
}

const legacyHistory = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)
  const partRows = yield* db
    .select()
    .from(PartTable)
    .where(eq(PartTable.session_id, sessionID))
    .orderBy(asc(PartTable.time_created), asc(PartTable.id))
    .all()
    .pipe(Effect.orDie)
  const parts = new Map<string, SessionV1.Part[]>()
  for (const row of partRows) {
    const current = parts.get(row.message_id) ?? []
    current.push(legacyPart(row))
    parts.set(row.message_id, current)
  }
  return rows.flatMap((row) => {
    const message = fromLegacy(row, parts.get(row.id) ?? [])
    return message ? [message] : []
  })
})

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  const rows = yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq)
  if (rows.length === 0) return yield* legacyHistory(db, sessionID)
  return yield* Effect.forEach(rows, decodeMessageRow)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  if (rows.length === 0) return (yield* legacyHistory(db, sessionID)).map((message) => ({ seq: baselineSeq, message }))
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})

export * as SessionHistory from "./history"
