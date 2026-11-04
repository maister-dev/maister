import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyBindingDetach,
  CompanyBindingDetachReceipt,
} from "./company-binding-types";
import type {
  CompanyFlowBinding,
  CompanyFlowBindingRevision,
  CompanyFlowBindingUpdate,
} from "./company-flow-binding-types";
import type { CompanyFlowBindingHead } from "./company-flow-bindings";

import { sql } from "drizzle-orm";
import pino from "pino";

import { beginCompanyBindingTransaction } from "./company-bindings";
import { companyBindingDetachSchema } from "./company-binding-types";
import { captureCompanyFlowBinding } from "./company-flow-binding-capture";
import {
  decodeCompanyFlowBindingRevision,
  retainCompanyFlowBindingRevision,
} from "./company-flow-binding-snapshot";
import { companyFlowBindingUpdateSchema } from "./company-flow-binding-types";
import {
  companyFlowBindingDto,
  loadCompanyFlowBindingHead,
  loadCompanyFlowBindingRevision,
} from "./company-flow-bindings";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const log = pino({
  name: "agents:company-flow-bindings",
  level: process.env.LOG_LEVEL ?? "info",
});

async function lockCompanyFlowBinding(
  tx: SqlTransaction,
  bindingId: string,
): Promise<CompanyFlowBindingHead> {
  await tx.execute(
    sql`SELECT id FROM company_flow_bindings WHERE id=${bindingId} FOR UPDATE`,
  );

  return loadCompanyFlowBindingHead(tx, bindingId);
}

async function replayCompanyFlowBinding(
  tx: SqlTransaction,
  bindingId: string,
  userId: string,
  key: string,
  digest: string,
): Promise<CompanyFlowBindingRevision | null> {
  const row = (
    await tx.execute(
      sql`SELECT * FROM company_flow_binding_revisions WHERE binding_id=${bindingId} AND request_actor_id=${userId} AND request_key=${key}`,
    )
  ).rows[0];

  if (!row) return null;
  if (row.request_digest !== digest)
    throw new MaisterError(
      "CONFLICT",
      "The company Flow binding delivery key was already used for different content",
    );

  return decodeCompanyFlowBindingRevision(row);
}

function assertMutableCompanyFlowBinding(
  head: CompanyFlowBindingHead,
  retained: CompanyFlowBindingRevision,
  expectedRevision: number,
): void {
  if (
    head.revision !== expectedRevision ||
    retained.snapshot.detachedAt !== null
  )
    throw new MaisterError(
      "CONFLICT",
      "The company Flow binding changed or was retired; inspect its current configuration revision",
    );
  if (head.revision === 2147483647)
    throw new MaisterError(
      "CONFLICT",
      "The company Flow configuration revision limit has been reached",
    );
}

export async function updateCompanyFlowBinding(
  db: SqlDatabase,
  userId: string,
  bindingId: string,
  request: CompanyFlowBindingUpdate,
): Promise<{ binding: CompanyFlowBinding; duplicate: boolean }> {
  const parsed = companyFlowBindingUpdateSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company Flow replacement request is invalid",
    );
  const input = parsed.data;
  const digest = contentDigest({ bindingId, operation: "updated", input });
  const result = await db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const current = await loadCompanyFlowBindingHead(tx, bindingId);
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
        "Company Flow binding ownership cannot be changed",
      );
    const head = await lockCompanyFlowBinding(tx, bindingId);
    const replay = await replayCompanyFlowBinding(
      tx,
      bindingId,
      userId,
      input.idempotencyKey,
      digest,
    );

    if (replay)
      return { binding: companyFlowBindingDto(head, replay), duplicate: true };
    assertMutableCompanyFlowBinding(
      head,
      await loadCompanyFlowBindingRevision(tx, head, head.revision),
      input.expectedRevision,
    );
    const snapshot = await captureCompanyFlowBinding(tx, input);

    if (snapshot.flowRefId !== head.flowRefId)
      throw new MaisterError(
        "CONFLICT",
        "A company coordinator binding cannot change its stable Flow identity",
      );
    const next = { ...head, revision: head.revision + 1 };

    await tx.execute(
      sql`UPDATE company_flow_bindings SET revision=${next.revision},flow_revision_id=${snapshot.flowRevisionId},package_install_id=${snapshot.packageInstallId},specialist_binding_id=${snapshot.specialistBindingId},enabled=${snapshot.enabled},updated_at=now() WHERE id=${head.id}`,
    );
    const retained = await retainCompanyFlowBindingRevision(tx, {
      bindingId,
      revision: next.revision,
      snapshot,
      authoritySnapshot: {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        actor: authority.actor,
        witness: authority.witness,
      },
      operation: "updated",
      requestKey: input.idempotencyKey,
      requestDigest: digest,
    });

    return { binding: companyFlowBindingDto(next, retained), duplicate: false };
  });

  log.info(
    {
      actorId: userId,
      bindingId,
      revision: result.binding.revision,
      flowRevisionId: result.binding.configuration.flowRevisionId,
      duplicate: result.duplicate,
    },
    "company coordinator configuration replaced",
  );

  return result;
}

export async function detachCompanyFlowBinding(
  db: SqlDatabase,
  userId: string,
  bindingId: string,
  request: CompanyBindingDetach,
): Promise<CompanyBindingDetachReceipt> {
  const parsed = companyBindingDetachSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company Flow retirement request is invalid",
    );
  const input = parsed.data;
  const digest = contentDigest({ bindingId, operation: "detached", input });
  const result = await db.transaction<CompanyBindingDetachReceipt>(
    async (tx) => {
      await beginCompanyBindingTransaction(tx);
      const current = await loadCompanyFlowBindingHead(tx, bindingId);
      const authority = await authorizeCompanyUserAction(
        tx,
        userId,
        current.companyId,
        "specialists:manage",
      );
      const head = await lockCompanyFlowBinding(tx, bindingId);
      const replay = await replayCompanyFlowBinding(
        tx,
        bindingId,
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
      const previous = await loadCompanyFlowBindingRevision(
        tx,
        head,
        head.revision,
      );

      assertMutableCompanyFlowBinding(head, previous, input.expectedRevision);
      const next = { ...head, revision: head.revision + 1 };
      const detachedAt = new Date().toISOString();

      await tx.execute(
        sql`UPDATE company_flow_bindings SET revision=${next.revision},flow_revision_id=NULL,package_install_id=NULL,specialist_binding_id=NULL,enabled=false,detached_at=${detachedAt},updated_at=now() WHERE id=${head.id}`,
      );
      await retainCompanyFlowBindingRevision(tx, {
        bindingId,
        revision: next.revision,
        snapshot: {
          ...previous.snapshot,
          enabled: false,
          detachedAt,
          detachmentReason: input.reason,
        },
        authoritySnapshot: {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          actor: authority.actor,
          witness: authority.witness,
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
      bindingId,
      revision: result.revision,
      duplicate: result.duplicate,
    },
    "company coordinator binding retired",
  );

  return result;
}
