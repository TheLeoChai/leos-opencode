import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260807002941_dive-in",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`dive_in\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`guidance\` text,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_dive_in_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`dive_in_track\` (
          \`id\` text PRIMARY KEY,
          \`dive_in_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`title\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`reasoning\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`status\` text NOT NULL,
          \`satisfied\` integer,
          \`conclusion\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_dive_in_track_dive_in_id_dive_in_id_fk\` FOREIGN KEY (\`dive_in_id\`) REFERENCES \`dive_in\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_dive_in_track_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`dive_in_session_idx\` ON \`dive_in\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`dive_in_track_group_position_idx\` ON \`dive_in_track\` (\`dive_in_id\`,\`position\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`dive_in_track_session_idx\` ON \`dive_in_track\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`dive_in_track_group_idx\` ON \`dive_in_track\` (\`dive_in_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
