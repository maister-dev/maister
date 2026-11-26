import type { DatabaseSync } from "node:sqlite";

/** Reconstruct a pre-v19 store from test data written through the current API. */
export function removeWorkspaceExecutionSchema(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS seed_workspace_execution_state;
    DROP TABLE IF EXISTS workspace_execution_state;
  `);
}
