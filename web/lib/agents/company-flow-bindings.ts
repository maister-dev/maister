import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyFlowBinding,
  CompanyFlowBindingCreate,
  CompanyFlowBindingRevision,
} from "./company-flow-binding-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import { beginCompanyBindingTransaction } from "./company-bindings";
import { captureCompanyFlowBinding } from "./company-flow-binding-capture";
import {
  decodeCompanyFlowBindingRevision,
  retainCompanyFlowBindingRevision,
} from "./company-flow-binding-snapshot";
import { companyFlowBindingCreateSchema } from "./company-flow-binding-types";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const log = pino({
  name: "agents:company-flow-bindings",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompanyFlowBindingHead = Readonly<{
  id: string;
  companyId: string;
  flowRefId: string;
  revision: number;
  createdAt: string;
}>;

export function decodeCompanyFlowBindingHead(
  row: Readonly<Record<string, unknown>> | undefined,
): CompanyFlowBindingHead {
  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "The company Flow binding is unavailable",
      { details: { reason: "company_binding_reference_unavailable" } },
    );
  const createdAt = databaseTimestamp(row.created_at);

  if (
    typeof row.id !== "string" ||
    typeof row.company_id !== "string" ||
    typeof row.flow_ref_id !== "string" ||
    typeof row.revision !== "number" ||
    !createdAt
  )
    throw new MaisterError(
      "CONFIG",
      "The company Flow binding head is invalid",
    );

  return {
    id: row.id,
    companyId: row.company_id,
    flowRefId: row.flow_ref_id,
    revision: row.revision,
    createdAt,
  };
}

export async function loadCompanyFlowBindingHead(
  tx: SqlTransaction,
  bindingId: string,
): Promise<CompanyFlowBindingHead> {
  return decodeCompanyFlowBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_flow_bindings WHERE id=${bindingId}`,
      )
    ).rows[0],
  );
}

/** Configuration capture follows Flow-head then specialist-head order, matching Flow replacement. */
export async function lockCompanyFlowBindingConfiguration(
  tx: SqlTransaction,
  bindingId: string,
): Promise<CompanyFlowBindingHead> {
  return decodeCompanyFlowBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_flow_bindings WHERE id=${bindingId} FOR SHARE`,
      )
    ).rows[0],
  );
}

export async function loadCompanyFlowBindingRevision(
  tx: SqlTransaction,
  head: CompanyFlowBindingHead,
  revision: number,
): Promise<CompanyFlowBindingRevision> {
  const row = (
    await tx.execute(
      sql`SELECT * FROM company_flow_binding_revisions WHERE binding_id=${head.id} AND revision=${revision}`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "The retained company Flow configuration revision is unavailable",
      { details: { reason: "company_binding_reference_unavailable" } },
    );
  const retained = decodeCompanyFlowBindingRevision(row);

  if (
    retained.snapshot.companyId !== head.companyId ||
    retained.snapshot.flowRefId !== head.flowRefId
  )
    throw new MaisterError(
      "CRASH",
      "The retained company Flow configuration belongs to a different company or Flow",
    );

  return retained;
}

export function companyFlowBindingDto(
  head: CompanyFlowBindingHead,
  retained: CompanyFlowBindingRevision,
): CompanyFlowBinding {
  return {
    id: head.id,
    revision: retained.revision,
    owner: { kind: "company", companyId: head.companyId },
    configuration: retained.snapshot,
    createdAt: head.createdAt,
    updatedAt: retained.createdAt,
  };
}

export async function createCompanyFlowBinding(
  db: SqlDatabase,
  userId: string,
  request: CompanyFlowBindingCreate,
): Promise<{ binding: CompanyFlowBinding; duplicate: boolean }> {
  const parsed = companyFlowBindingCreateSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company Flow binding request is invalid",
    );
  const input = parsed.data;
  const digest = contentDigest({ operation: "created", input });
  const result = await db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const authority = await authorizeCompanyUserAction(
      tx,
      userId,
      input.owner.companyId,
      "specialists:manage",
    );

    await authorizeCompanyUserAction(
      tx,
      userId,
      input.owner.companyId,
      "specialists:read",
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-flow-binding-create:${input.owner.companyId}:${userId}:${input.idempotencyKey}`},0))`,
    );
    const previous = (
      await tx.execute(
        sql`SELECT * FROM company_flow_bindings WHERE company_id=${input.owner.companyId} AND created_by=${userId} AND creation_key=${input.idempotencyKey}`,
      )
    ).rows[0];

    if (previous) {
      if (previous.creation_digest !== digest)
        throw new MaisterError(
          "CONFLICT",
          "The company Flow binding delivery key was already used for different content",
        );
      const head = decodeCompanyFlowBindingHead(previous);

      return {
        binding: companyFlowBindingDto(
          head,
          await loadCompanyFlowBindingRevision(tx, head, 1),
        ),
        duplicate: true,
      };
    }
    const snapshot = await captureCompanyFlowBinding(tx, input);

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-flow-binding-ref:${input.owner.companyId}:${snapshot.flowRefId}`},0))`,
    );
    const existing = (
      await tx.execute(
        sql`SELECT id FROM company_flow_bindings WHERE company_id=${input.owner.companyId} AND flow_ref_id=${snapshot.flowRefId} AND detached_at IS NULL`,
      )
    ).rows[0];

    if (existing)
      throw new MaisterError(
        "CONFLICT",
        "The company already has a current binding for this coordinator Flow; replace its exact revision",
      );
    const head = decodeCompanyFlowBindingHead(
      (
        await tx.execute(
          sql`INSERT INTO company_flow_bindings(id,company_id,flow_ref_id,flow_revision_id,package_install_id,specialist_binding_id,enabled,created_by,creation_key,creation_digest) VALUES(${randomUUID()},${snapshot.companyId},${snapshot.flowRefId},${snapshot.flowRevisionId},${snapshot.packageInstallId},${snapshot.specialistBindingId},${snapshot.enabled},${userId},${input.idempotencyKey},${digest}) RETURNING *`,
        )
      ).rows[0],
    );
    const retained = await retainCompanyFlowBindingRevision(tx, {
      bindingId: head.id,
      revision: 1,
      snapshot,
      authoritySnapshot: {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        actor: authority.actor,
        witness: authority.witness,
      },
      operation: "created",
      requestKey: input.idempotencyKey,
      requestDigest: digest,
    });

    return { binding: companyFlowBindingDto(head, retained), duplicate: false };
  });

  log.info(
    {
      actorId: userId,
      bindingId: result.binding.id,
      companyId: result.binding.owner.companyId,
      revision: result.binding.revision,
      flowRevisionId: result.binding.configuration.flowRevisionId,
      manifestSha256: result.binding.configuration.manifestSha256,
      duplicate: result.duplicate,
    },
    "reviewed company coordinator configuration retained",
  );

  return result;
}

export async function getCompanyFlowBinding(
  db: SqlDatabase,
  userId: string,
  bindingId: string,
): Promise<CompanyFlowBinding> {
  return db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const head = await loadCompanyFlowBindingHead(tx, bindingId);

    await authorizeCompanyUserAction(
      tx,
      userId,
      head.companyId,
      "specialists:read",
    );

    return companyFlowBindingDto(
      head,
      await loadCompanyFlowBindingRevision(tx, head, head.revision),
    );
  });
}

export async function getCompanyFlowBindingRevision(
  db: SqlDatabase,
  userId: string,
  bindingId: string,
  revision: number,
): Promise<CompanyFlowBindingRevision> {
  if (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)
    throw new MaisterError(
      "CONFIG",
      "A positive retained company Flow configuration revision is required",
    );

  return db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const head = await loadCompanyFlowBindingHead(tx, bindingId);

    await authorizeCompanyUserAction(
      tx,
      userId,
      head.companyId,
      "specialists:read",
    );

    return loadCompanyFlowBindingRevision(tx, head, revision);
  });
}
