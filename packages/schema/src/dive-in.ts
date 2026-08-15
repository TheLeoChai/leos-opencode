export * as DiveIn from "./dive-in"

import { Schema } from "effect"
import { Session } from "./session"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { ascending } from "./identifier"

export const ID = Schema.String.check(Schema.isStartsWith("dive_")).pipe(
  Schema.brand("DiveIn.ID"),
  statics((schema) => ({ create: () => schema.make(`dive_${ascending()}`) })),
)
export type ID = typeof ID.Type

export const TrackID = Schema.String.check(Schema.isStartsWith("dtrk_")).pipe(
  Schema.brand("DiveIn.TrackID"),
  statics((schema) => ({ create: () => schema.make(`dtrk_${ascending()}`) })),
)
export type TrackID = typeof TrackID.Type

export const Status = Schema.Literals(["active", "completed", "closed"])
export type Status = typeof Status.Type

export const TrackStatus = Schema.Literals(["active", "completed", "closed"])
export type TrackStatus = typeof TrackStatus.Type

export interface Track extends Schema.Schema.Type<typeof Track> {}
export const Track = Schema.Struct({
  id: TrackID,
  sessionID: Session.ID,
  position: NonNegativeInt,
  title: Schema.String,
  summary: Schema.String,
  reasoning: Schema.String,
  prompt: Schema.String,
  status: TrackStatus,
  satisfied: Schema.Boolean.pipe(optional),
  conclusion: Schema.String.pipe(optional),
  handoff: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "DiveIn.Track" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  sessionID: Session.ID,
  title: Schema.String,
  guidance: Schema.String.pipe(optional),
  status: Status,
  tracks: Schema.Array(Track),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "DiveIn.Info" })
