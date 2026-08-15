export * as DiveInEvent from "./dive-in-event"

import { DiveIn } from "./dive-in"
import { Event } from "./event"
import { Session } from "./session"

export const Updated = Event.define({
  type: "divein.updated",
  schema: {
    diveInID: DiveIn.ID,
    sessionID: Session.ID,
    status: DiveIn.Status,
  },
})

export const Deleted = Event.define({
  type: "divein.deleted",
  schema: {
    diveInID: DiveIn.ID,
    sessionID: Session.ID,
  },
})

export const Definitions = Event.inventory(Updated, Deleted)
