import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812073159_common_jasper_sitwell",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_input_cancellation\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`cancelled_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_cancellation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_input_cancellation_session_idx\` ON \`session_input_cancellation\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
