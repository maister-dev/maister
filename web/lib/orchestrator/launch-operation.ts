import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, sql } from "drizzle-orm";

import { tasks } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { MaisterError } from "@/lib/errors";

export type DelegationLaunchOperation = Readonly<{
  kind: "delegate" | "plan";
  identity: string;
  payloadDigest: string;
}>;

/** A server-generated plan revision binds one token/parent/key decision and its exact semantic body. */
export function delegationLaunchOperation(
  kind: DelegationLaunchOperation["kind"],
  tokenId: string,
  parentRunId: string,
  key: string | null,
  body: unknown,
): DelegationLaunchOperation {
  if (!key || key.trim().length === 0 || key.length > 256)
    throw new MaisterError(
      "CONFIG",
      "Supply a stable Idempotency-Key (1–256 characters) for this delegated task launch",
      { details: { reason: "delegation_launch_key_required" } },
    );

  return {
    kind,
    identity: retryDigest({ version: 2, kind, tokenId, parentRunId, key }),
    payloadDigest: retryDigest(body),
  };
}

export function delegationPlanRevision(
  operation: DelegationLaunchOperation,
  itemKey?: string,
): string {
  if ((operation.kind === "plan") !== (itemKey !== undefined))
    throw new MaisterError(
      "CONFIG",
      "Plan launch operation requires its item identity",
      { details: { reason: "delegation_launch_identity_invalid" } },
    );

  return `${operation.kind}:v2:${operation.identity}:${operation.payloadDigest}${itemKey !== undefined ? `:${retryDigest(itemKey)}` : ""}`;
}

/** Historical SHA-only plan revisions are never interpreted as new operation authority. */
export function parseDelegationPlanRevision(
  value: string,
):
  | (DelegationLaunchOperation & Readonly<{ itemIdentity: string | null }>)
  | null {
  const match =
    /^(delegate|plan):v2:([a-f0-9]{64}):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/.exec(
      value,
    );

  if (!match || (match[1] === "plan") !== Boolean(match[4])) return null;

  return {
    kind: match[1] as DelegationLaunchOperation["kind"],
    identity: match[2],
    payloadDigest: match[3],
    itemIdentity: match[4] ?? null,
  };
}

export function assertDelegationOperationPayload(
  operation: DelegationLaunchOperation,
  storedPlanRevision: string,
): void {
  const stored = parseDelegationPlanRevision(storedPlanRevision);

  if (
    !stored ||
    stored.kind !== operation.kind ||
    stored.identity !== operation.identity ||
    stored.payloadDigest !== operation.payloadDigest
  )
    throw new MaisterError(
      "CONFLICT",
      "This Idempotency-Key already owns a different delegation request; replay the original request or use a new key for a new decision",
      { details: { reason: "delegation_launch_key_conflict" } },
    );
}

/** The caller holds the existing parent delegation lock before lookup and carrier creation. */
export async function findDelegationOperationTasks(
  db: Db,
  projectId: string,
  parentRunId: string,
  operation: DelegationLaunchOperation,
): Promise<Array<typeof tasks.$inferSelect>> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        sql`${tasks.qualificationChildProof}->>'parentRunId'=${parentRunId}`,
        sql`split_part(${tasks.qualificationChildProof}->>'planRevision',':',1)=${operation.kind}`,
        sql`split_part(${tasks.qualificationChildProof}->>'planRevision',':',2)='v2'`,
        sql`split_part(${tasks.qualificationChildProof}->>'planRevision',':',3)=${operation.identity}`,
      ),
    )
    .orderBy(tasks.number);

  for (const task of rows)
    assertDelegationOperationPayload(
      operation,
      task.qualificationChildProof?.planRevision ?? "",
    );

  return rows;
}
