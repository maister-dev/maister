import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";

import { sql } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";
import { isNativeFindingsContract } from "@/lib/run-results/contract";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

/** Physical shared directories lack a complete recipient-aware native source envelope. */
export function nativeSharedWorkspaceRefusal(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Native knowledge cooperation requires an owned workspace or workspace-none execution. Physical shared workspaces do not retain the required source policy.",
    {
      details: { reason: "native_shared_workspace_unsupported" },
    },
  );
}

/** Applied only after native enrollment has been established by server metadata. */
export function assertNativeWorkspaceMode(workspaceMode: unknown): void {
  if (workspaceMode === "shared") throw nativeSharedWorkspaceRefusal();
}

/** Legacy shared allocation remains compatible; native ancestry cannot be downgraded by a generic child contract. */
export async function assertLegacySharedWorkspace(
  db: SqlTransaction,
  input: Readonly<{
    projectId: string;
    parentRunId: string | null;
    resultContract: RunResultContract | null;
    nativeInput: unknown;
  }>,
): Promise<void> {
  if (
    isNativeFindingsContract(input.resultContract) ||
    input.nativeInput != null
  )
    throw nativeSharedWorkspaceRefusal();
  if (input.parentRunId === null) return;
  const row = (
    await db.execute(
      sql`SELECT knowledge_access,result_contract->>'nativeContract' AS native_contract FROM runs WHERE id=${input.parentRunId} AND project_id=${input.projectId}`,
    )
  ).rows[0];

  if (
    row &&
    (row.knowledge_access !== null || row.native_contract === FINDINGS_CONTRACT)
  )
    throw nativeSharedWorkspaceRefusal();
}
