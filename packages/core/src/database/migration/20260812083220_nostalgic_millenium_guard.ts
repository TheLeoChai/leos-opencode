import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812083220_nostalgic_millenium_guard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`dive_in\` ADD \`synthesis_prompt_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
