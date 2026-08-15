import { and, eq, isNull } from "drizzle-orm"
import { Cause, Effect, Layer } from "effect"
import { Database } from "../../database/database"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionInputCancellationTable, SessionInputTable, SessionTable } from "../sql"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

type DatabaseService = Database.Interface["db"]

/** Wake only admitted inputs that never reached a provider turn before this process started. */
export const recoverPending = Effect.fn("SessionExecutionLocal.recoverPending")(function* (
  db: DatabaseService,
  wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>,
) {
  const rows = yield* db
    .select({ sessionID: SessionInputTable.session_id, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .innerJoin(SessionTable, eq(SessionTable.id, SessionInputTable.session_id))
    .leftJoin(
      SessionInputCancellationTable,
      and(
        eq(SessionInputCancellationTable.id, SessionInputTable.id),
        eq(SessionInputCancellationTable.session_id, SessionInputTable.session_id),
      ),
    )
    .where(and(isNull(SessionInputTable.promoted_seq), isNull(SessionInputCancellationTable.id)))
    .all()
    .pipe(Effect.orDie)
  const sessionIDs = Array.from(
    new Set(
      rows
        .filter((row) => row.prompt.resume !== false)
        .map((row) => SessionSchema.ID.make(row.sessionID)),
    ),
  )
  yield* Effect.forEach(sessionIDs, wake, { concurrency: "unbounded", discard: true })
})

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })
    yield* recoverPending(database.db, coordinator.wake)

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [Database.node, SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
