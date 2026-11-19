import "server-only";

import type {
  KnowledgeAccessCapture,
  KnowledgeAccessRestriction,
  Owner,
} from "@/lib/company/types";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeTransaction } from "./knowledge-access";

import { sql } from "drizzle-orm";
import pino from "pino";

import { assertNativeWorkspaceMode } from "./knowledge-workspace-policy";
import { knowledgeWriteLockSql } from "./knowledge-write-lock";
import { lockCurrentNativeKnowledgeToken } from "./knowledge-token-lock";

import {
  knowledgeAccessCaptureSchema,
  knowledgeRestrictionsSchema,
} from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { pgErrorOf } from "@/lib/db/pg-error";
import { captureInstallationProjects } from "@/lib/agents/installation-source-capture";
import { lockLibrarianKnowledgeContext } from "@/lib/librarian/knowledge-authority";
import { parseBoundRunId } from "@/lib/tokens/verify";

const log = pino({
  name: "brain:knowledge-disclosure",
  level: process.env.LOG_LEVEL ?? "info",
});

export type KnowledgeReadConsumer = Readonly<
  | { runId: string; capture: KnowledgeAccessCapture }
  | { runId: null; librarianTurnId: string; capture: KnowledgeAccessCapture }
> | null;

export function canonicalKnowledgeRestrictions(
  restrictions: readonly KnowledgeAccessRestriction[],
): KnowledgeAccessRestriction[] {
  const entries = new Map(
    restrictions.map((entry) => [contentDigest(entry), entry]),
  );

  return [...entries.keys()].sort().map((key) => entries.get(key)!);
}

/** Destination ownership already supplies its own read gate; narrower record/source dependencies remain. */
export function additionalKnowledgeRestrictions(
  owner: Owner,
  restrictions: readonly KnowledgeAccessRestriction[],
): KnowledgeAccessRestriction[] {
  const destination = contentDigest(owner);

  const retained = canonicalKnowledgeRestrictions(
    restrictions.filter(
      (restriction) => contentDigest(restriction) !== destination,
    ),
  );

  if (
    !knowledgeRestrictionsSchema.safeParse(retained).success ||
    Buffer.byteLength(JSON.stringify(retained), "utf8") > 65536
  )
    throw new MaisterError(
      "PRECONDITION",
      "Inherited knowledge source access exceeds its bounded contract",
      { details: { reason: "knowledge_capture_limit" } },
    );

  return retained;
}

/** Lock the consumer before record/grant reads; concurrent tools cannot upgrade shared run locks. */
export async function lockKnowledgeReadConsumer(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
): Promise<KnowledgeReadConsumer> {
  // Fresh/small policy tables can overestimate recursive work and spend seconds
  // compiling authorization branches while holding the consumer Run lock.
  await tx.execute(sql`SET LOCAL jit=off`);
  log.debug(
    { principalKind: principal.kind, queryExecutionPolicy: "interpreted" },
    "FIX native knowledge admission avoids policy JIT compilation",
  );
  if (principal.kind === "user") return null;
  if (principal.kind === "librarian_read") {
    const { turnId, capture } = await lockLibrarianKnowledgeContext(
      tx,
      principal.tokenId,
      "knowledge:read",
    );

    return { runId: null, librarianTurnId: turnId, capture };
  }
  if (principal.kind === "execution")
    return lockRunKnowledgeReadConsumer(tx, principal.runId);
  const token = await lockCurrentNativeKnowledgeToken(tx, principal.tokenId);

  if (token.token_kind === "user") return null;
  if (
    token.token_kind !== "agent" &&
    !(
      token.token_kind === "project" &&
      String(token.name).startsWith("orchestrator-run:")
    )
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "This token cannot consume shared native knowledge",
    );
  const runId = parseBoundRunId(String(token.name));

  return lockRunKnowledgeReadConsumer(tx, runId);
}

async function lockRunKnowledgeReadConsumer(
  tx: KnowledgeTransaction,
  runId: string | null,
): Promise<KnowledgeReadConsumer> {
  const run =
    runId === null
      ? undefined
      : (
          await tx.execute(
            sql`SELECT knowledge_access,workspace_mode FROM runs WHERE id=${runId} AND status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review') FOR NO KEY UPDATE`,
          )
        ).rows[0];
  const capture = knowledgeAccessCaptureSchema.safeParse(run?.knowledge_access);

  if (
    runId === null ||
    !run ||
    !capture.success ||
    capture.data.state !== "complete"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native knowledge requires a compatible server-owned source capture profile",
      { details: { reason: "knowledge_capture_profile_required" } },
    );

  assertNativeWorkspaceMode(run.workspace_mode);

  return { runId, capture: capture.data };
}

/** Cross-owner source graphs can cycle. Serialize bounded native writes before taking any record locks. */
export async function lockKnowledgeWriteConsumer(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
): Promise<KnowledgeReadConsumer> {
  if (principal.kind === "execution" || principal.kind === "librarian_read")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Execution inspection cannot authorize knowledge writes",
    );
  const consumer = await lockKnowledgeReadConsumer(tx, principal);

  try {
    await tx.execute(sql`SELECT ${knowledgeWriteLockSql()}`);
  } catch (error) {
    if (pgErrorOf(error)?.code === "55P03") {
      log.warn(
        {
          principalKind: principal.kind,
          runId: consumer?.runId,
          reason: "knowledge_write_busy",
        },
        "native knowledge write admission exhausted its lock bound",
      );
      throw new MaisterError(
        "CONFLICT",
        "Another knowledge update is in progress; retry the same delivery after inspecting current state",
        { details: { reason: "knowledge_write_busy" } },
      );
    }
    throw error;
  }
  log.debug(
    { principalKind: principal.kind, runId: consumer?.runId },
    "native knowledge write admitted before source record locks",
  );

  return consumer;
}

/** Disclosure commits its complete restriction union before any bytes leave the service. */
export async function recordKnowledgeDisclosure(
  tx: KnowledgeTransaction,
  consumer: KnowledgeReadConsumer,
  restrictions: readonly KnowledgeAccessRestriction[],
): Promise<void> {
  if (consumer === null) return;
  const installation =
    consumer.runId === null
      ? null
      : await tx.execute(
          sql`SELECT 1 FROM agent_installation_run_authorities WHERE run_id=${consumer.runId}`,
        );
  if (consumer.runId !== null && installation?.rows.length) {
    const projects: string[] = [];
    for (const source of restrictions) {
      if (
        source.kind === "project" ||
        source.kind === "project_context" ||
        source.kind === "project_visibility" ||
        source.kind === "agent_memory"
      )
        projects.push(source.projectId);
      if (source.kind === "agent_vault_revision_v1") {
        const result =
          await tx.execute(sql`SELECT source_project_ids FROM agent_memory_revisions
          WHERE (vault_id,note_id,id)=(${source.vaultId},${source.noteId},${source.revisionId})`);
        const ids = result.rows[0]?.source_project_ids;
        if (
          !Array.isArray(ids) ||
          ids.some((id: unknown) => typeof id !== "string")
        )
          throw new MaisterError(
            "PRECONDITION",
            "Installation vault source capture is incomplete",
          );
        projects.push(...(ids as string[]));
      }
    }
    await captureInstallationProjects(tx, consumer.runId, projects);
  }
  const combined = canonicalKnowledgeRestrictions([
    ...consumer.capture.restrictions,
    ...restrictions,
  ]);

  if (
    !knowledgeRestrictionsSchema.safeParse(combined).success ||
    Buffer.byteLength(JSON.stringify(combined), "utf8") > 65536
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native knowledge source capture reached its bound; narrow the requested work",
      { details: { reason: "knowledge_capture_limit" } },
    );
  if (contentDigest(combined) === contentDigest(consumer.capture.restrictions))
    return;
  if (consumer.capture.generation === 2147483647)
    throw new MaisterError(
      "PRECONDITION",
      "Native knowledge capture generation is exhausted",
    );
  const capture: KnowledgeAccessCapture = {
    ...consumer.capture,
    schemaVersion: combined.some(
      ({ kind }) => kind === "agent_vault_revision_v1",
    )
      ? 2
      : consumer.capture.schemaVersion,
    generation: consumer.capture.generation + 1,
    restrictions: combined,
  };

  const contents = JSON.stringify(capture);
  await tx.execute(
    consumer.runId === null
      ? sql`UPDATE librarian_turns SET knowledge_access=${contents}::jsonb WHERE id=${consumer.librarianTurnId}`
      : sql`UPDATE runs SET knowledge_access=${contents}::jsonb WHERE id=${consumer.runId}`,
  );
}
