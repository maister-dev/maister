import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { TokenScope } from "@/lib/tokens/scopes";

import { usesNativeKnowledgeTransport } from "./knowledge-execution-access";

import { MaisterError } from "@/lib/errors";

// These existing shared stores have no recipient/source envelope. Native findings
// and proposals retain one; future assignment channels must do so before admission.
const UNCLASSIFIED_PROJECT_WRITES: ReadonlySet<string> = new Set<TokenScope>([
  "tasks:create",
  "tasks:update",
  "tasks:complete",
  "tasks:triage",
  "comments:create",
  "relations:create",
  "relations:delete",
  "hitl:request",
]);

/** A native execution cannot discard source restrictions by changing its output destination. */
export async function assertNativeProjectStoreWrite(
  db: SqlTransaction,
  runId: string,
  scope: string,
): Promise<void> {
  if (!UNCLASSIFIED_PROJECT_WRITES.has(scope)) return;
  if (!(await usesNativeKnowledgeTransport(db, runId))) return;
  throw new MaisterError(
    "PRECONDITION",
    "This shared destination does not retain source restrictions. Return evidence-linked findings or use a structured knowledge proposal.",
    { details: { reason: "native_unclassified_sink" } },
  );
}
