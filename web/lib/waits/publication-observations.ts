import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { WaitJson } from "@/lib/waits/contracts";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  runPublicationObservations,
  runPublications,
  workspaces,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { encodeWaitDigest } from "@/lib/waits/store";

const events = {
  ci: "run.ci_observed",
  pr: "run.pr_observed",
  ref: "run.workspace_head_changed",
} as const;

type Kind = keyof typeof events;

export async function recordPublicationObservation(
  db: Db,
  input: {
    publicationId: string;
    kind: Kind;
    headSha: string;
    fact: Record<string, WaitJson>;
    waitId: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [publication] = await tx
      .select()
      .from(runPublications)
      .where(
        and(
          eq(runPublications.id, input.publicationId),
          eq(runPublications.phase, "observed"),
        ),
      );

    if (!publication) return false;

    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, publication.workspaceId),
          eq(workspaces.publishedRemote, publication.remoteName),
          sql`'refs/heads/' || ${workspaces.publishedBranch} = ${publication.headRef}`,
          input.kind === "pr"
            ? sql`${workspaces.prNumber} IS NOT DISTINCT FROM ${publication.prNumber}
        AND ${workspaces.prUrl} IS NOT DISTINCT FROM ${publication.prUrl}`
            : undefined,
        ),
      )
      .for("update");

    if (!workspace) return false;
    const [latest] = await tx
      .select({ id: runPublications.id })
      .from(runPublications)
      .where(
        and(
          eq(runPublications.workspaceId, workspace.id),
          eq(runPublications.phase, "observed"),
        ),
      )
      .orderBy(desc(runPublications.generation))
      .limit(1);

    if (latest?.id !== publication.id) return false;
    const fact = { ...input.fact, schemaVersion: 1, waitId: input.waitId };
    const [previous] = await tx
      .select()
      .from(runPublicationObservations)
      .where(
        and(
          eq(runPublicationObservations.publicationId, input.publicationId),
          eq(runPublicationObservations.kind, input.kind),
          sql`${runPublicationObservations.fact}->>'waitId' = ${input.waitId}`,
        ),
      )
      .orderBy(
        desc(runPublicationObservations.observedAt),
        desc(runPublicationObservations.id),
      )
      .limit(1);

    if (
      previous?.headSha === input.headSha &&
      encodeWaitDigest(previous.fact) === encodeWaitDigest(fact)
    )
      return false;
    const sourceRevision = encodeWaitDigest([
      input.waitId,
      previous?.id ?? null,
      input.headSha,
      fact,
    ]);
    const id = encodeWaitDigest([
      input.publicationId,
      input.kind,
      sourceRevision,
    ]);
    const { projectId, runId } = publication;
    const observedAt = new Date();

    await tx.insert(runPublicationObservations).values({
      id,
      kind: input.kind,
      publicationId: input.publicationId,
      projectId,
      runId,
      fact,
      sourceRevision,
      headSha: input.headSha,
      observedAt,
    });
    await emitDomainEvent({
      db: tx,
      kind: events[input.kind],
      projectId,
      runId,
      actor: { type: "system", id: null },
      occurredAt: observedAt,
      payload: {
        schemaVersion: 1,
        publicationId: input.publicationId,
        observationId: id,
      },
    });

    return true;
  });
}
