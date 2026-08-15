import { DiveIn } from "@opencode-ai/core/dive-in"
import { Location } from "@opencode-ai/core/location"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import {
  DiveInNotFoundError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
} from "@opencode-ai/protocol/errors"
import { Api } from "../api"

export const DiveInHandler = HttpApiBuilder.group(Api, "server.diveIn", (handlers) =>
  Effect.succeed(
    handlers
      .handle("diveIn.list", () =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          const diveIn = yield* DiveIn.Service
          return yield* diveIn.list({ directory: location.directory, workspaceID: location.workspaceID })
        }),
      )
      .handle("diveIn.get", (ctx) =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          const diveIn = yield* DiveIn.Service
          const info = yield* notFound(diveIn.get(ctx.params.diveInID))
          const sessions = yield* SessionV2.Service
          const session = yield* sessions.get(info.sessionID).pipe(
            Effect.mapError(
              () =>
                new DiveInNotFoundError({
                  diveInID: info.id,
                  message: `DiveIn not found: ${info.id}`,
                }),
            ),
          )
          if (
            session.location.directory !== location.directory ||
            session.location.workspaceID !== location.workspaceID
          )
            return yield* new DiveInNotFoundError({ diveInID: info.id, message: `DiveIn not found: ${info.id}` })
          return info
        }),
      )
      .handle("diveIn.start", (ctx) =>
        DiveIn.Service.use((diveIn) =>
          invalidRequest(diveIn.start({ sessionID: ctx.params.sessionID, ...ctx.payload })),
        ),
      )
      .handle("diveIn.cancel", (ctx) =>
        Effect.gen(function* () {
          const diveIn = yield* DiveIn.Service
          yield* mapComplete(diveIn.cancel(ctx.params))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("diveIn.complete", (ctx) =>
        DiveIn.Service.use((diveIn) =>
          mapComplete(
            diveIn.complete({
              ...ctx.params,
              ...ctx.payload,
            }),
          ),
        ),
      )
      .handle("diveIn.reopen", (ctx) => DiveIn.Service.use((diveIn) => mapComplete(diveIn.reopen(ctx.params)))),
  ),
)

function notFound<A>(effect: Effect.Effect<A, DiveIn.NotFoundError>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new DiveInNotFoundError({
          diveInID: error.diveInID,
          message: `DiveIn not found: ${error.diveInID}`,
        }),
    ),
  )
}

function invalidRequest<A>(effect: Effect.Effect<A, DiveIn.Error>) {
  return effect.pipe(Effect.mapError(mapError))
}

function mapComplete<A>(effect: Effect.Effect<A, DiveIn.Error | SessionV2.NotFoundError>) {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error instanceof SessionV2.NotFoundError)
        return new SessionNotFoundError({
          sessionID: error.sessionID,
          message: `Session not found: ${error.sessionID}`,
        })
      if (error instanceof DiveIn.NotFoundError)
        return new DiveInNotFoundError({ diveInID: error.diveInID, message: `DiveIn not found: ${error.diveInID}` })
      return mapError(error)
    }),
  )
}

function mapError(error: DiveIn.Error) {
  if (error instanceof DiveIn.PlanningError)
    return new ServiceUnavailableError({ message: error.message, service: "divein" })
  if (error instanceof DiveIn.TrackConclusionMissingError)
    return new InvalidRequestError({
      message: `DiveIn track ${error.trackID} is not ready to complete. Wait for its final response to finish, then try again.`,
    })
  return new InvalidRequestError({ message: error.message })
}
