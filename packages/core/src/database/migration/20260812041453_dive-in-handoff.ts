import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812041453_dive-in-handoff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`dive_in_track\` ADD \`investigation_prompt_id\` text;`)
      yield* tx.run(`ALTER TABLE \`dive_in_track\` ADD \`handoff_prompt_id\` text;`)
      yield* tx.run(`ALTER TABLE \`dive_in_track\` ADD \`handoff\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
