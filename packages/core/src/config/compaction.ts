export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  threshold: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
    .pipe(Schema.optional)
    .annotate({
      description: "Fraction of usable context that triggers automatic compaction (default: 0.75)",
    }),
  keep_threshold: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThan(1)).pipe(Schema.optional).annotate({
    description: "Fraction of current context tokens to keep at a user-turn boundary (default: 0.35)",
  }),
  target: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)).pipe(Schema.optional).annotate({
    description: "Deprecated; retention now uses keep_threshold",
  }),
}) {}
