import { DiveIn } from "@opencode-ai/schema/dive-in"
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { DiveInNotFoundError, InvalidRequestError, ServiceUnavailableError, SessionNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const makeDiveInGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.diveIn")
    .add(
      HttpApiEndpoint.get("diveIn.list", "/api/divein", {
        query: LocationQuery,
        success: Schema.Array(DiveIn.Info),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.diveIn.list",
            summary: "List DiveIn groups",
            description: "List persisted DiveIn groups for a location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("diveIn.get", "/api/divein/:diveInID", {
        params: { diveInID: DiveIn.ID },
        success: DiveIn.Info,
        error: DiveInNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.diveIn.get",
          summary: "Get a DiveIn group",
          description: "Get one persisted DiveIn group and its tracks.",
        }),
      ),
    )
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.post("diveIn.start", "/api/session/:sessionID/divein", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ guidance: Schema.String.pipe(Schema.optional) }),
        success: DiveIn.Info,
        error: [SessionNotFoundError, InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.diveIn.start",
            summary: "Start a DiveIn",
            description: "Plan independent side tracks for a session and start them concurrently.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("diveIn.cancel", "/api/session/:sessionID/divein/:diveInID/cancel", {
        params: { sessionID: Session.ID, diveInID: DiveIn.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, DiveInNotFoundError, InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.diveIn.cancel",
            summary: "Cancel a DiveIn",
            description: "Remove the current DiveIn tracks while preserving the main session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("diveIn.complete", "/api/session/:sessionID/divein/:diveInID/track/:trackID/complete", {
        params: { sessionID: Session.ID, diveInID: DiveIn.ID, trackID: DiveIn.TrackID },
        payload: Schema.Struct({ satisfied: Schema.Boolean }),
        success: DiveIn.Info,
        error: [SessionNotFoundError, DiveInNotFoundError, InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.diveIn.complete",
            summary: "Complete a DiveIn track",
            description: "Confirm a track conclusion and synthesize all completed tracks into the main session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("diveIn.reopen", "/api/session/:sessionID/divein/:diveInID/track/:trackID/reopen", {
        params: { sessionID: Session.ID, diveInID: DiveIn.ID, trackID: DiveIn.TrackID },
        success: DiveIn.Info,
        error: [SessionNotFoundError, DiveInNotFoundError, InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.diveIn.reopen",
            summary: "Reopen a DiveIn track",
            description: "Undo a completed track before its handoff reaches the main session.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "DiveIn", description: "Side-track investigation workflows." }))
