import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandTarget } from "./target-types";

import { and, asc, eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  standTargetConnectionSchema,
  standTargetDeliveryKeySchema,
  standTargetInputSchema,
  standTargetPageInputSchema,
  standTargetUpdateSchema,
} from "./target-types";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import {
  standComponents,
  standTargetRevisions,
  standTargets,
} from "@/lib/db/schema";
import { isUniqueViolation, redactQueryError } from "@/lib/db/pg-error";
import { readKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";

const log = pino({
  name: "stand-targets",
  level: process.env.LOG_LEVEL ?? "info",
});
const cursorNamespace = "maister.stand-targets.v1";

type TargetRow = typeof standTargets.$inferSelect;

function unavailable(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The configured stand is unavailable",
    { details: { reason: "stand_target_unavailable" } },
  );
}

function targetDto(
  row: TargetRow,
  componentIds: readonly string[],
): StandTarget {
  return {
    id: row.id,
    owner: { kind: "company", companyId: row.companyId },
    incarnationId: row.incarnationId,
    configRevision: row.configRevision,
    enabled: row.enabled,
    componentIds,
  };
}

const currentRevision = and(
  eq(standTargetRevisions.targetId, standTargets.id),
  eq(standTargetRevisions.revision, standTargets.configRevision),
);

/** Persist the complete reviewed revision before a later operation can reference it. */
export async function saveStandTarget(
  db: Db,
  userId: string,
  deliveryKey: unknown,
  raw: unknown,
  targetId?: string,
): Promise<{ target: StandTarget; duplicate: boolean }> {
  const parsed = (
    targetId === undefined ? standTargetInputSchema : standTargetUpdateSchema
  ).safeParse(raw);
  const key = standTargetDeliveryKeySchema.safeParse(deliveryKey);

  if (!parsed.success || !key.success)
    throw new MaisterError(
      "CONFIG",
      "Provide explicit stand configuration and an Idempotency-Key",
    );
  const input = parsed.data;
  const expectedRevision =
    "expectedRevision" in input ? input.expectedRevision : undefined;
  const requestDigest = contentDigest({ targetId: targetId ?? null, input });

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const authority = await authorizeCompanyUserAction(
        tx,
        userId,
        input.owner.companyId,
        "targets:manage",
      );

      await authorizeCompanyUserAction(
        tx,
        userId,
        input.owner.companyId,
        "targets:read",
      );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stand-target:${userId}:${key.data}`},0))`,
      );
      const [previous] = await tx
        .select({
          head: standTargets,
          revision: standTargetRevisions.revision,
          enabled: standTargetRevisions.enabled,
          componentIds: standTargetRevisions.componentIds,
          digest: standTargetRevisions.requestDigest,
        })
        .from(standTargetRevisions)
        .innerJoin(
          standTargets,
          eq(standTargets.id, standTargetRevisions.targetId),
        )
        .where(
          and(
            eq(standTargetRevisions.actorId, userId),
            eq(standTargetRevisions.deliveryKey, key.data),
            eq(standTargets.companyId, input.owner.companyId),
          ),
        );

      if (previous) {
        if (previous.digest !== requestDigest)
          throw new MaisterError(
            "CONFLICT",
            "The stand configuration delivery key already names different input",
          );

        return {
          target: targetDto(
            {
              ...previous.head,
              configRevision: previous.revision,
              enabled: previous.enabled,
            },
            previous.componentIds,
          ),
          duplicate: true,
        };
      }
      let current: TargetRow | undefined;

      if (targetId !== undefined) {
        [current] = await tx
          .select()
          .from(standTargets)
          .where(
            and(
              eq(standTargets.id, targetId),
              eq(standTargets.companyId, input.owner.companyId),
            ),
          )
          .for("no key update");
        if (!current) throw unavailable();
        if (current.incarnationId !== input.incarnationId)
          throw new MaisterError(
            "CONFLICT",
            "Register a replacement stand under a new target incarnation",
          );
        if (current.configRevision !== expectedRevision)
          throw new MaisterError(
            "CONFLICT",
            "The stand configuration changed",
            { details: { currentRevision: current.configRevision } },
          );
      }
      const revision = current ? current.configRevision + 1 : 1;
      const [head] = current
        ? await tx
            .update(standTargets)
            .set({ configRevision: revision, enabled: input.enabled })
            .where(eq(standTargets.id, current.id))
            .returning()
        : await tx
            .insert(standTargets)
            .values({
              companyId: input.owner.companyId,
              incarnationId: input.incarnationId,
              enabled: input.enabled,
            })
            .returning();

      if (!head) throw unavailable();
      const componentIds = input.components
        .map((component) => component.id)
        .sort();

      await tx.insert(standTargetRevisions).values({
        targetId: head.id,
        revision,
        enabled: input.enabled,
        connection: standTargetConnectionSchema.strip().parse(input),
        componentIds,
        actorId: authority.actor.id,
        authority: authority.witness,
        deliveryKey: key.data,
        requestDigest,
      });
      const runbooks = new Map<string, string>();
      const components: (typeof standComponents.$inferInsert)[] = [];

      for (const config of input.components) {
        const key = contentDigest(config.runbook);
        let runbookSha256 = runbooks.get(key);

        if (!runbookSha256) {
          const { record } = await readKnowledgeRecord(
            tx,
            { kind: "user", userId },
            config.runbook,
          );
          const witness = record.evidence.find(
            (entry) =>
              "witness" in entry &&
              entry.witness.id === config.runbook.witnessId &&
              entry.relation === "supports",
          );

          if (
            record.owner.kind !== "company" ||
            record.owner.companyId !== head.companyId ||
            record.kind !== "procedure" ||
            record.lifecycle !== "active" ||
            record.freshness.state === "stale" ||
            !witness ||
            !("witness" in witness) ||
            witness.witness.availability !== "available" ||
            !witness.witness.sha256
          )
            throw new MaisterError(
              "PRECONDITION",
              "The configured runbook and its exact supporting witness are unavailable",
              { details: { reason: "knowledge_reference_unavailable" } },
            );
          runbookSha256 = witness.witness.sha256;
          runbooks.set(key, runbookSha256);
        }
        components.push({
          targetId: head.id,
          configRevision: revision,
          componentId: config.id,
          config,
          runbookSha256,
          canonicalResourceKey: contentDigest({
            incarnationId: head.incarnationId,
            manager: config.serviceManager,
            scope: config.scope,
            user: config.user,
            unit: config.unit,
          }),
        });
      }
      await tx.insert(standComponents).values(components);

      return {
        target: targetDto(head, componentIds),
        duplicate: false,
      };
    });

    log.info(
      {
        targetId: result.target.id,
        incarnationId: result.target.incarnationId,
        configRevision: result.target.configRevision,
        duplicate: result.duplicate,
      },
      "stand configuration retained",
    );

    return result;
  } catch (error) {
    if (isUniqueViolation(error, "stand_targets_company_incarnation_unique"))
      throw new MaisterError(
        "CONFLICT",
        "The configured stand incarnation already exists",
      );
    throw redactQueryError(error);
  }
}

export async function getStandTarget(
  db: Db,
  userId: string,
  targetId: string,
): Promise<StandTarget> {
  return db.transaction(async (tx) => {
    const companyId = await installationCompany(tx);

    await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
    const [target] = await tx
      .select({
        head: standTargets,
        componentIds: standTargetRevisions.componentIds,
      })
      .from(standTargets)
      .innerJoin(standTargetRevisions, currentRevision)
      .where(
        and(
          eq(standTargets.id, targetId),
          eq(standTargets.companyId, companyId),
        ),
      );

    if (!target) throw unavailable();

    return targetDto(target.head, target.componentIds);
  });
}

export async function listStandTargets(
  db: Db,
  userId: string,
  raw: unknown,
): Promise<{ items: StandTarget[]; nextCursor: string | null }> {
  const parsed = standTargetPageInputSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid stand pagination query");
  const { cursor, limit } = parsed.data;

  return db.transaction(async (tx) => {
    const companyId = await installationCompany(tx);
    const authority = await authorizeCompanyUserAction(
      tx,
      userId,
      companyId,
      "targets:read",
    );
    const scope = contentDigest({ authority, limit });
    const after = cursor
      ? decodeKeysetCursor(cursorNamespace, cursor, scope)
      : null;
    const upper =
      after?.upper ??
      (
        await tx.execute<{ at: string }>(
          sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        )
      ).rows[0]!.at;
    const rows = await tx
      .select({
        head: standTargets,
        componentIds: standTargetRevisions.componentIds,
        at: sql<string>`to_char(${standTargets.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(standTargets)
      .innerJoin(standTargetRevisions, currentRevision)
      .where(
        and(
          eq(standTargets.companyId, companyId),
          sql`${standTargets.createdAt}<=${upper}::timestamptz`,
          after
            ? sql`(${standTargets.createdAt},${standTargets.id})>(${after.at}::timestamptz,${after.id})`
            : undefined,
        ),
      )
      .orderBy(asc(standTargets.createdAt), asc(standTargets.id))
      .limit(limit + 1);
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);

    return {
      items: selected.map((row) => targetDto(row.head, row.componentIds)),
      nextCursor:
        rows.length > limit && last
          ? encodeKeysetCursor(cursorNamespace, {
              version: 1,
              scope,
              at: last.at,
              id: last.head.id,
              upper,
            })
          : null,
    };
  });
}
