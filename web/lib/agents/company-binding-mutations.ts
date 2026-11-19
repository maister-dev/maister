import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyBindingDetach,
  CompanyBindingDetachReceipt,
  CompanyBindingRevision,
  CompanyBindingUpdate,
  CompanySpecialist,
} from "./company-binding-types";
import type { CompanyBindingHead } from "./company-bindings";

import { sql } from "drizzle-orm";
import pino from "pino";

import { decodeCompanyBindingRevision } from "./company-binding-snapshot";
import {
  companyBindingDetachSchema,
  companyBindingUpdateSchema,
} from "./company-binding-types";
import {
  assertInstallationGrantAdmin,
  buildCompanyBindingSnapshot,
  beginCompanyBindingTransaction,
  logCompanyBindingChange,
  companySpecialistDto,
  loadCompanyBindingHead,
  loadCompanyBindingRevision,
  retainBindingChange,
} from "./company-bindings";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const log = pino({
  name: "agents:company-bindings",
  level: process.env.LOG_LEVEL ?? "info",
});

async function lockBindingHead(
  tx: SqlTransaction,
  agentId: string,
  bindingId: string,
): Promise<CompanyBindingHead> {
  await tx.execute(
    sql`SELECT id FROM company_specialist_bindings WHERE id=${bindingId} AND agent_id=${agentId} FOR UPDATE`,
  );

  return loadCompanyBindingHead(tx, agentId, bindingId);
}

async function replayBindingChange(
  tx: SqlTransaction,
  head: CompanyBindingHead,
  userId: string,
  key: string,
  digest: string,
): Promise<CompanyBindingRevision | null> {
  const row = (
    await tx.execute(
      sql`SELECT * FROM company_specialist_binding_revisions WHERE binding_id=${head.id} AND request_actor_id=${userId} AND request_key=${key}`,
    )
  ).rows[0];

  if (!row) return null;
  if (row.request_digest !== digest)
    throw new MaisterError(
      "CONFLICT",
      "The company binding delivery key was already used for different content",
    );

  return decodeCompanyBindingRevision(row);
}

function assertMutableBinding(
  head: CompanyBindingHead,
  retained: CompanyBindingRevision,
  expectedRevision: number,
): void {
  if (
    head.revision !== expectedRevision ||
    retained.snapshot.detachedAt !== null
  )
    throw new MaisterError(
      "CONFLICT",
      "The company binding changed or was detached; inspect its current revision before editing",
    );
  if (head.revision === 2147483647)
    throw new MaisterError(
      "CONFLICT",
      "The company binding revision limit has been reached",
    );
}

/** Full replacement makes clearing policy/configuration explicit; exact replay returns the original receipt. */
export async function updateCompanySpecialistBinding(
  db: SqlDatabase,
  userId: string,
  agentId: string,
  bindingId: string,
  request: CompanyBindingUpdate,
): Promise<{ specialist: CompanySpecialist; duplicate: boolean }> {
  const parsed = companyBindingUpdateSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company specialist replacement request is invalid",
    );
  const input = parsed.data;
  const digest = contentDigest({
    agentId,
    bindingId,
    operation: "updated",
    input,
  });

  const result = await db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const current = await loadCompanyBindingHead(tx, agentId, bindingId);
    const authority = await authorizeCompanyUserAction(
      tx,
      userId,
      current.companyId,
      "specialists:manage",
    );

    await authorizeCompanyUserAction(
      tx,
      userId,
      current.companyId,
      "specialists:read",
    );
    if (input.owner.companyId !== current.companyId)
      throw new MaisterError(
        "CONFLICT",
        "Company binding ownership cannot be changed",
      );
    const head = await lockBindingHead(tx, agentId, bindingId);
    const replay = await replayBindingChange(
      tx,
      head,
      userId,
      input.idempotencyKey,
      digest,
    );

    if (replay)
      return {
        specialist: companySpecialistDto(head, replay),
        duplicate: true,
      };
    const previous = await loadCompanyBindingRevision(tx, head, head.revision);
    assertMutableBinding(head, previous, input.expectedRevision);
    if (previous.snapshot.installationGrant || input.installationGrant)
      await assertInstallationGrantAdmin(tx, userId);
    const installationGrant =
      input.installationGrant === undefined
        ? previous.snapshot.installationGrant
        : input.installationGrant;
    const snapshot = await buildCompanyBindingSnapshot(tx, agentId, {
      ...input,
      installationGrant,
    });
    const next = { ...head, revision: head.revision + 1 };

    await tx.execute(
      sql`UPDATE company_specialist_bindings SET revision=${next.revision},package_install_id=${snapshot.packageInstallId},enabled=${snapshot.enabled},updated_at=now() WHERE id=${head.id}`,
    );
    const retained = await retainBindingChange(tx, next, authority, {
      snapshot,
      operation: "updated",
      requestKey: input.idempotencyKey,
      requestDigest: digest,
    });

    return {
      specialist: companySpecialistDto(next, retained),
      duplicate: false,
    };
  });

  logCompanyBindingChange(userId, "updated", result);

  return result;
}

/** Retire current authority/configuration without requiring content read permission or deleting history. */
export async function detachCompanySpecialistBinding(
  db: SqlDatabase,
  userId: string,
  agentId: string,
  bindingId: string,
  request: CompanyBindingDetach,
): Promise<CompanyBindingDetachReceipt> {
  const parsed = companyBindingDetachSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company specialist detach request is invalid",
    );
  const input = parsed.data;
  const digest = contentDigest({
    agentId,
    bindingId,
    operation: "detached",
    input,
  });

  const result = await db.transaction<CompanyBindingDetachReceipt>(
    async (tx) => {
      await beginCompanyBindingTransaction(tx);
      const current = await loadCompanyBindingHead(tx, agentId, bindingId);
      const authority = await authorizeCompanyUserAction(
        tx,
        userId,
        current.companyId,
        "specialists:manage",
      );
      const head = await lockBindingHead(tx, agentId, bindingId);
      const replay = await replayBindingChange(
        tx,
        head,
        userId,
        input.idempotencyKey,
        digest,
      );

      if (replay)
        return {
          id: head.id,
          revision: replay.revision,
          status: "detached",
          duplicate: true,
        };
      const previous = await loadCompanyBindingRevision(
        tx,
        head,
        head.revision,
      );

      assertMutableBinding(head, previous, input.expectedRevision);
      if (previous.snapshot.installationGrant)
        await assertInstallationGrantAdmin(tx, userId);
      const next = { ...head, revision: head.revision + 1 };
      const detachedAt = new Date().toISOString();

      await tx.execute(
        sql`UPDATE company_specialist_bindings SET revision=${next.revision},package_install_id=NULL,enabled=false,detached_at=${detachedAt},updated_at=now() WHERE id=${head.id}`,
      );
      await retainBindingChange(tx, next, authority, {
        snapshot: {
          ...previous.snapshot,
          enabled: false,
          detachedAt,
          detachmentReason: input.reason,
        },
        operation: "detached",
        requestKey: input.idempotencyKey,
        requestDigest: digest,
      });

      return {
        id: head.id,
        revision: next.revision,
        status: "detached",
        duplicate: false,
      };
    },
  );

  log.info(
    {
      actorId: userId,
      agentId,
      bindingId: result.id,
      revision: result.revision,
      duplicate: result.duplicate,
    },
    "company specialist binding retired",
  );

  return result;
}
