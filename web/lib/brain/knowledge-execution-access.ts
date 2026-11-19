import "server-only";

import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { KnowledgePrincipal } from "./knowledge-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { requireInstallationRunAuthority } from "@/lib/agents/installation-authority";
import { assertNativeWorkspaceMode } from "./knowledge-workspace-policy";
import { resolveKnowledgePrincipal } from "./knowledge-access";
import { currentKnowledgeNodeAttemptPolicy } from "./knowledge-node-policy";
import { recordKnowledgeDisclosure } from "./knowledge-disclosure";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
  unavailableKnowledgeReference,
} from "./knowledge-restrictions";

import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

const log = pino({
  name: "knowledge-execution-access",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function usesNativeKnowledgeTransport(
  db: SqlTransaction,
  runId: string,
): Promise<boolean> {
  const row = (
    await db.execute(
      sql`SELECT result_contract->>'nativeContract' AS native_contract,knowledge_access IS NOT NULL AS enrolled FROM runs WHERE id=${runId}`,
    )
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();

  return row.native_contract === FINDINGS_CONTRACT || row.enrolled === true;
}

/** Legacy Brain transports cannot create an unclassified side channel for a versioned native execution. */
export async function assertLegacyBrainTransport(
  db: SqlTransaction,
  runId: string | null,
): Promise<void> {
  if (runId === null || !(await usesNativeKnowledgeTransport(db, runId)))
    return;
  throw new MaisterError(
    "PRECONDITION",
    "Native evidence runs require structured Company Brain tools: use knowledge_search, knowledge_get, knowledge_capture_source and knowledge_propose",
    { details: { reason: "native_knowledge_transport_required" } },
  );
}

/** Read-only inspection is anchored to the executing role and current node, independently of API leases. */
export async function resolveRunKnowledgePrincipal(
  tx: SqlTransaction,
  runId: string,
  nodeAttemptId?: string,
): Promise<KnowledgePrincipal> {
  const run = (
    await tx.execute(sql`
    SELECT execution.run_kind,(SELECT node.id FROM node_attempts node WHERE ${currentKnowledgeNodeAttemptPolicy("node", sql`execution.id`, sql`execution.current_step_id`)} ORDER BY node.attempt DESC LIMIT 1) AS node_attempt_id
    FROM runs execution WHERE execution.id=${runId} FOR SHARE OF execution
  `)
  ).rows[0];

  if (!run || (run.run_kind !== "agent" && run.run_kind !== "flow"))
    throw unavailableKnowledgeReference();
  const selectedNode =
    run.run_kind === "flow" ? (nodeAttemptId ?? run.node_attempt_id) : null;

  if (
    (run.run_kind === "flow" && typeof selectedNode !== "string") ||
    (run.run_kind === "agent" && nodeAttemptId !== undefined)
  )
    throw unavailableKnowledgeReference();
  const principal: KnowledgePrincipal = {
    kind: "execution",
    runId,
    nodeAttemptId: typeof selectedNode === "string" ? selectedNode : null,
  };

  await resolveKnowledgePrincipal(tx, principal, "knowledge:read");

  return principal;
}

/** Classify retained server-owned mounts; never infer provenance from model claims or paths. */
function mountedSourceRestrictions(
  snapshot: unknown,
): KnowledgeAccessRestriction[] {
  if (snapshot === null) return [];
  if (!Array.isArray(snapshot) || snapshot.length > 256)
    throw new MaisterError(
      "CONFIG",
      "Native source capture requires a bounded retained context-mount snapshot",
    );
  const mounts: readonly unknown[] = snapshot;

  return mounts.map((mount) => {
    if (
      typeof mount !== "object" ||
      mount === null ||
      !("projectId" in mount) ||
      typeof mount.projectId !== "string" ||
      mount.projectId.length === 0 ||
      mount.projectId.length > 128
    )
      throw new MaisterError(
        "CONFIG",
        "A retained context mount has no valid source project identity",
      );

    return { kind: "project_context", projectId: mount.projectId };
  });
}

/** Current role/source authority must pass before a native prompt is dispatched or restored. */
export async function assertNativeRunKnowledgeInputs(
  db: SqlDatabase,
  runId: string,
): Promise<void> {
  await db.transaction((tx) =>
    assertNativeRunKnowledgeInputsInTransaction(tx, runId),
  );
}

/** Authorize current input sources inside an existing command-admission transaction. */
export async function assertNativeRunKnowledgeInputsInTransaction(
  tx: SqlTransaction,
  runId: string,
): Promise<void> {
  const row = (
    await tx.execute(
      sql`SELECT result_contract->>'nativeContract' AS native_contract,knowledge_access,status,context_mounts,workspace_mode FROM runs WHERE id=${runId} FOR NO KEY UPDATE`,
    )
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  if (
    row.native_contract !== FINDINGS_CONTRACT &&
    row.knowledge_access === null
  )
    return;
  const capture = knowledgeAccessCaptureSchema.safeParse(row.knowledge_access);

  if (
    !capture.success ||
    capture.data.state !== "complete" ||
    ![
      "Pending",
      "Running",
      "NeedsInput",
      "NeedsInputIdle",
      "WaitingOnChildren",
      "Review",
    ].includes(String(row.status))
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native execution requires an active run and complete source classification",
      { details: { reason: "knowledge_capture_profile_required" } },
    );
  assertNativeWorkspaceMode(row.workspace_mode);
  const principal = await resolveRunKnowledgePrincipal(tx, runId);

  const mounts = mountedSourceRestrictions(row.context_mounts);

  const walk = await authorizeSourceRestrictions(tx, principal, [
    ...capture.data.restrictions,
    ...mounts,
  ]);
  const installation = await requireInstallationRunAuthority(tx, runId);
  await recordKnowledgeDisclosure(
    tx,
    { runId, capture: capture.data },
    installation ? restrictionsForKnowledgeAccess(walk) : mounts,
  );
  log.debug(
    {
      runId,
      generation: capture.data.generation,
      sourceCount: capture.data.restrictions.length,
    },
    "native execution input sources authorized before dispatch",
  );
}

/** Capture actual server-classified consumption before private prompt snapshots or response bytes exist. */
export async function recordNativeRunSources(
  db: SqlDatabase,
  runId: string,
  restrictions: readonly KnowledgeAccessRestriction[],
): Promise<void> {
  await db.transaction((tx) =>
    recordNativeRunSourcesInTransaction(tx, runId, restrictions),
  );
}

/** Compose source capture into an existing source-before-child transaction using current execution authority. */
export async function recordNativeRunSourcesInTransaction(
  tx: SqlTransaction,
  runId: string,
  restrictions: readonly KnowledgeAccessRestriction[],
  nodeAttemptId?: string,
): Promise<void> {
  const row = (
    await tx.execute(
      sql`SELECT result_contract->>'nativeContract' AS native_contract,knowledge_access,workspace_mode FROM runs WHERE id=${runId} FOR NO KEY UPDATE`,
    )
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  if (
    row.native_contract !== FINDINGS_CONTRACT &&
    row.knowledge_access === null
  )
    return;
  assertNativeWorkspaceMode(row.workspace_mode);
  const capture = knowledgeAccessCaptureSchema.safeParse(row.knowledge_access);

  if (!capture.success || capture.data.state !== "complete")
    throw new MaisterError(
      "PRECONDITION",
      "Native source consumption requires complete server-owned capture",
      { details: { reason: "knowledge_capture_profile_required" } },
    );
  const principal = await resolveRunKnowledgePrincipal(
    tx,
    runId,
    nodeAttemptId,
  );

  const walk = await authorizeSourceRestrictions(tx, principal, [
    ...capture.data.restrictions,
    ...restrictions,
  ]);
  const installation = await requireInstallationRunAuthority(tx, runId);
  await recordKnowledgeDisclosure(
    tx,
    { runId, capture: capture.data },
    installation ? restrictionsForKnowledgeAccess(walk) : restrictions,
  );
  log.debug(
    { runId, addedSourceCount: restrictions.length },
    "native execution source consumption captured before disclosure",
  );
}
