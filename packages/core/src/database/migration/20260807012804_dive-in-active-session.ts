import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260807012804_dive-in-active-session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE UNIQUE INDEX \`dive_in_active_session_idx\` ON \`dive_in\` (\`session_id\`) WHERE "dive_in"."status" = 'active';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
