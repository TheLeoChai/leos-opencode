import { integer, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { Session } from "@opencode-ai/schema/session"
import { DiveIn } from "@opencode-ai/schema/dive-in"
import { SessionMessage } from "../session/message"
import { SessionTable } from "../session/sql"

export const DiveInTable = sqliteTable(
  "dive_in",
  {
    id: text().$type<DiveIn.ID>().primaryKey(),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    guidance: text(),
    status: text().$type<DiveIn.Status>().notNull(),
    synthesis_prompt_id: text().$type<SessionMessage.ID>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    index("dive_in_session_idx").on(table.session_id),
    uniqueIndex("dive_in_active_session_idx")
      .on(table.session_id)
      .where(sql`${table.status} = 'active'`),
  ],
)

export const DiveInTrackTable = sqliteTable(
  "dive_in_track",
  {
    id: text().$type<DiveIn.TrackID>().primaryKey(),
    dive_in_id: text()
      .$type<DiveIn.ID>()
      .notNull()
      .references(() => DiveInTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    reasoning: text().notNull(),
    prompt: text().notNull(),
    status: text().$type<DiveIn.TrackStatus>().notNull(),
    satisfied: integer({ mode: "boolean" }),
    conclusion: text(),
    investigation_prompt_id: text().$type<SessionMessage.ID>(),
    handoff_prompt_id: text().$type<SessionMessage.ID>(),
    handoff: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("dive_in_track_group_position_idx").on(table.dive_in_id, table.position),
    uniqueIndex("dive_in_track_session_idx").on(table.session_id),
    index("dive_in_track_group_idx").on(table.dive_in_id),
  ],
)
