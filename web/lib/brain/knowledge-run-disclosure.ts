import "server-only";

import type { AnyColumn } from "drizzle-orm";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { KnowledgePrincipal } from "./knowledge-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { assertNativeWorkspaceMode } from "./knowledge-workspace-policy";
import { usesNativeKnowledgeTransport } from "./knowledge-execution-access";
import { resolveKnowledgePrincipal } from "./knowledge-access";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
  unavailableKnowledgeReference,
} from "./knowledge-restrictions";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

export type KnowledgeRecipient = Exclude<
  KnowledgePrincipal,
  { kind: "execution" }
>;

const log = pino({
  name: "knowledge-run-disclosure",
  level: process.env.LOG_LEVEL ?? "info",
});

export function runHasPrivateMemorySql(
  runIdRef: AnyColumn | ReturnType<typeof sql>,
): ReturnType<typeof sql<boolean>> {
  return sql<boolean>`EXISTS (SELECT 1 FROM agent_memory_injections memory
    WHERE memory.run_id=${runIdRef} AND memory.application_state <> 'retired')`;
}

export function runKnowledgeEnrolledSql(
  knowledgeAccessRef: AnyColumn | ReturnType<typeof sql>,
  resultContractRef: AnyColumn | ReturnType<typeof sql>,
): ReturnType<typeof sql<boolean>> {
  return sql<boolean>`COALESCE(${knowledgeAccessRef} IS NOT NULL OR ${resultContractRef}->>'nativeContract'=${FINDINGS_CONTRACT}, false)`;
}

export function runDisclosureGovernedSql(refs: {
  id: AnyColumn | ReturnType<typeof sql>;
  knowledgeAccess: AnyColumn | ReturnType<typeof sql>;
  resultContract: AnyColumn | ReturnType<typeof sql>;
}): ReturnType<typeof sql<boolean>> {
  return sql<boolean>`COALESCE(${runKnowledgeEnrolledSql(refs.knowledgeAccess, refs.resultContract)} OR ${runHasPrivateMemorySql(refs.id)}, false)`;
}

async function vaultRunRestrictions(
  tx: SqlTransaction,
  runId: unknown,
  projectId: unknown,
): Promise<unknown[]> {
  if (typeof runId !== "string" || typeof projectId !== "string")
    throw unavailableKnowledgeReference();
  const rows = (
    await tx.execute(sql`
    SELECT tree->'references' AS refs FROM agent_memory_injections
    WHERE run_id=${runId} AND application_state <> 'retired'
  `)
  ).rows;

  return [
    { kind: "project_context", projectId },
    ...rows.flatMap(({ refs }) => (Array.isArray(refs) ? refs : [])),
  ];
}

/** Authorize a bounded execution page in one read transaction; no per-run payload query is needed. */
export async function authorizeRunsKnowledgeDisclosure(
  tx: SqlTransaction,
  recipient: KnowledgePrincipal | undefined,
  runIds: readonly string[],
): Promise<void> {
  if (recipient?.kind === "execution")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Execution settlement inspection cannot authorize outward disclosure; identify a current receiving user or token",
    );
  const ids = [...new Set(runIds)].sort();

  if (!ids.length) return;
  if (ids.length > 256) throw unavailableKnowledgeReference();
  const predicate = sql`id IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  // Classification precedes locks so an enrolled parent is always locked before its children.
  const classifications = (
    await tx.execute(
      sql`SELECT id,project_id,
        ${runKnowledgeEnrolledSql(sql`knowledge_access`, sql`result_contract`)} AS enrolled,
        ${runHasPrivateMemorySql(sql`runs.id`)} AS has_vault
        FROM runs WHERE ${predicate}`,
    )
  ).rows;

  if (classifications.length !== ids.length)
    throw unavailableKnowledgeReference();
  const governed = classifications
    .filter((row) => row.enrolled === true)
    .map((row) => row.id);

  const privateRuns = classifications.filter(
    (row) => row.has_vault === true && row.enrolled !== true,
  );

  if (!governed.length && !privateRuns.length) return;
  if (!recipient)
    throw new MaisterError(
      "CONFIG",
      "Native execution material requires a current receiving principal",
      { details: { reason: "native_recipient_required" } },
    );
  const consumer = await lockKnowledgeReadConsumer(tx, recipient);
  const rows =
    governed.length === 0
      ? []
      : (
          await tx.execute(
            sql`SELECT knowledge_access,workspace_mode FROM runs WHERE id IN (${sql.join(
              governed.map((id) => sql`${id}`),
              sql`, `,
            )}) ORDER BY id FOR SHARE`,
          )
        ).rows;

  if (rows.length !== governed.length) throw unavailableKnowledgeReference();
  await resolveKnowledgePrincipal(tx, recipient, "knowledge:read");
  const baseline = await authorizeSourceRestrictions(
    tx,
    recipient,
    consumer?.capture.restrictions ?? [],
  );
  const disclosed: KnowledgeAccessRestriction[] = [];
  let sourceChecks = 0;

  for (const row of privateRuns) {
    const access = await authorizeSourceRestrictions(
      tx,
      recipient,
      await vaultRunRestrictions(tx, row.id, row.project_id),
      baseline,
    );

    sourceChecks += access.visited.length;
    if (consumer) disclosed.push(...restrictionsForKnowledgeAccess(access));
  }

  for (const row of rows) {
    assertNativeWorkspaceMode(row.workspace_mode);
    const capture = knowledgeAccessCaptureSchema.safeParse(
      row.knowledge_access,
    );

    if (!capture.success || capture.data.state !== "complete")
      throw unavailableKnowledgeReference();
    const access = await authorizeSourceRestrictions(
      tx,
      recipient,
      capture.data.restrictions,
      baseline,
    );

    sourceChecks += access.visited.length;
    if (consumer) disclosed.push(...restrictionsForKnowledgeAccess(access));
  }
  await recordKnowledgeDisclosure(tx, consumer, disclosed);
  log.debug(
    {
      runCount: governed.length + privateRuns.length,
      recipientKind: recipient.kind,
      sourceChecks,
    },
    "execution source authority checked before derived disclosure",
  );
}

/** Select authorized native Inbox rows without disclosing denied prompts or counts; legacy rows stay at their caller's project gate. */
export async function readableKnowledgeRunIds(
  db: SqlDatabase,
  recipient: KnowledgeRecipient | undefined,
  runIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(runIds)].sort();

  if (!ids.length || !recipient) return new Set();

  return db.transaction(async (tx) => {
    const consumer = await lockKnowledgeReadConsumer(tx, recipient);

    await resolveKnowledgePrincipal(tx, recipient, "knowledge:read");
    const baseline = await authorizeSourceRestrictions(
      tx,
      recipient,
      consumer?.capture.restrictions ?? [],
    );
    const readable = new Set<string>();
    const disclosed: KnowledgeAccessRestriction[] = [];

    for (let offset = 0; offset < ids.length; offset += 256) {
      const page = ids.slice(offset, offset + 256);
      const rows = (
        await tx.execute(sql`SELECT id,knowledge_access,workspace_mode FROM runs
        WHERE id IN (${sql.join(
          page.map((id) => sql`${id}`),
          sql`, `,
        )}) ORDER BY id FOR SHARE`)
      ).rows;

      for (const row of rows) {
        if (row.workspace_mode === "shared") continue;
        const capture = knowledgeAccessCaptureSchema.safeParse(
          row.knowledge_access,
        );

        if (!capture.success || capture.data.state !== "complete") continue;
        try {
          const access = await authorizeSourceRestrictions(
            tx,
            recipient,
            capture.data.restrictions,
            baseline,
          );

          readable.add(String(row.id));
          if (consumer)
            disclosed.push(...restrictionsForKnowledgeAccess(access));
        } catch (error) {
          if (
            !isRunKnowledgeUnavailable(error) ||
            error.details?.reason !== "knowledge_reference_unavailable"
          )
            throw error;
          log.debug(
            {
              runId: row.id,
              recipientKind: recipient.kind,
              reason: error.details?.reason,
            },
            "source-denied execution excluded from Inbox content",
          );
        }
      }
    }
    await recordKnowledgeDisclosure(tx, consumer, disclosed);

    return readable;
  });
}

/** Authorize the receiving principal and retain the source union before derived bytes leave one run. */
export async function authorizeRunKnowledgeDisclosure(
  tx: SqlTransaction,
  recipient: KnowledgePrincipal,
  runId: string,
): Promise<void> {
  await authorizeRunsKnowledgeDisclosure(tx, recipient, [runId]);
}

/** Recheck a whole outward page without issuing one transaction per run. */
export async function assertRunsKnowledgeDisclosure(
  db: SqlDatabase,
  recipient: KnowledgeRecipient,
  runIds: readonly string[],
): Promise<void> {
  if (!runIds.length) return;
  await db.transaction((tx) =>
    authorizeRunsKnowledgeDisclosure(tx, recipient, runIds),
  );
}

/** Use the same guard at HTTP/RSC boundaries and again before delayed/streamed content is emitted. */
export async function assertRunKnowledgeDisclosure(
  db: SqlDatabase,
  recipient: KnowledgeRecipient,
  runId: string,
): Promise<void> {
  await assertRunsKnowledgeDisclosure(db, recipient, [runId]);
}

/** Source unavailability has one safe response class without exposing the missing source's identity. */
export function isRunKnowledgeUnavailable(
  error: unknown,
): error is MaisterError {
  return (
    isMaisterError(error) &&
    error.code === "PRECONDITION" &&
    [
      "knowledge_reference_unavailable",
      "knowledge_capture_profile_required",
      "knowledge_capture_limit",
      "knowledge_reference_budget_exceeded",
      "native_shared_workspace_unsupported",
    ].includes(String(error.details?.reason))
  );
}

async function cancelUnservedContent(
  owner: Pick<ReadableStream<Uint8Array>, "cancel">,
  error: unknown,
): Promise<never> {
  try {
    await owner.cancel(error);
  } catch (cleanupError) {
    throw new MaisterError(
      "CRASH",
      "Source-controlled content could not release its upstream after disclosure refusal",
      {
        cause: new AggregateError(
          [error, cleanupError],
          "Disclosure and content cancellation failed",
        ),
        details: { reason: "knowledge_disclosure_cleanup_failed" },
      },
    );
  }
  throw error;
}

/** Native streams authorize each requested chunk after its asynchronous read, without holding DB locks over network waits. */
export async function protectRunKnowledgeStream(
  db: SqlDatabase,
  recipient: KnowledgeRecipient,
  runId: string,
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  let enrolled: boolean;

  try {
    enrolled =
      (await usesNativeKnowledgeTransport(db, runId)) ||
      (
        await db.execute(
          sql`SELECT 1 WHERE ${runHasPrivateMemorySql(sql`${runId}`)}`,
        )
      ).rows.length > 0;
    if (enrolled) await assertRunKnowledgeDisclosure(db, recipient, runId);
  } catch (error) {
    return cancelUnservedContent(body, error);
  }
  if (!enrolled) return body;
  const reader = body.getReader();
  let cancelled = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) return;
        try {
          const chunk = await reader.read();

          if (cancelled) return;
          if (chunk.done) {
            reader.releaseLock();
            controller.close();

            return;
          }
          await assertRunKnowledgeDisclosure(db, recipient, runId);
          if (!cancelled) controller.enqueue(chunk.value);
        } catch (error) {
          if (cancelled) return;
          cancelled = true;
          try {
            await cancelUnservedContent(reader, error);
          } finally {
            reader.releaseLock();
          }
        }
      },
      async cancel(reason: unknown) {
        cancelled = true;
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
