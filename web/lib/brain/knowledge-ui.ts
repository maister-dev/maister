import "server-only";

import type { Owner } from "@/lib/company/types";
import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";
import type {
  KnowledgeDatabase,
  KnowledgeTransaction,
} from "./knowledge-access";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  authorizeKnowledge,
  resolveKnowledgePrincipal,
} from "./knowledge-access";
import { knowledgeOwnerActionPolicy } from "./knowledge-query-policy";
import {
  knowledgeOwnerValue,
  type KnowledgeOwnerChoice,
} from "./knowledge-owner-selection";

import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";

export {
  knowledgeOwnerValue,
  knowledgeOwnerSelection,
} from "./knowledge-owner-selection";

const log = pino({
  name: "brain:knowledge-ui",
  level: process.env.LOG_LEVEL ?? "info",
});

async function knowledgeUiTransaction<T>(
  db: KnowledgeDatabase,
  read: (tx: KnowledgeTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);

      return read(tx);
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Choices name only owners for which the current native action policy succeeds. */
export async function knowledgeOwnerChoices(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  action: KnowledgeAction,
): Promise<readonly KnowledgeOwnerChoice[]> {
  return knowledgeUiTransaction(db, async (tx) => {
    const identity = await resolveKnowledgePrincipal(tx, principal, action);
    const companies = (
      await tx.execute(
        sql`SELECT c.id FROM companies c WHERE ${knowledgeOwnerActionPolicy(identity, sql`NULL::text`, sql`c.id`, action)} ORDER BY c.id`,
      )
    ).rows;
    const projects = (
      await tx.execute(
        sql`SELECT p.id,p.name FROM projects p WHERE ${knowledgeOwnerActionPolicy(identity, sql`p.id`, sql`NULL::text`, action)} ORDER BY p.name,p.id LIMIT 513`,
      )
    ).rows;

    if (projects.length > 512)
      throw new MaisterError(
        "PRECONDITION",
        "The knowledge owner selector exceeds its bounded contract",
      );

    log.debug(
      { action, companyCount: companies.length, projectCount: projects.length },
      "knowledge owner choices resolved",
    );

    return [
      ...companies.map((row) => {
        const owner: Owner = { kind: "company", companyId: String(row.id) };

        return { owner, value: knowledgeOwnerValue(owner), projectName: null };
      }),
      ...projects.map((row) => {
        const owner: Owner = { kind: "project", projectId: String(row.id) };

        return {
          owner,
          value: knowledgeOwnerValue(owner),
          projectName: String(row.name),
        };
      }),
    ];
  });
}

async function actionAllowed(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  owner: Owner,
  action: KnowledgeAction,
): Promise<boolean> {
  try {
    await authorizeKnowledge(tx, principal, owner, action);

    return true;
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED") return false;
    throw error;
  }
}

export async function knowledgeOwnerActions(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  owner: Owner,
): Promise<Readonly<{ propose: boolean; review: boolean; confirm: boolean }>> {
  return knowledgeUiTransaction(db, async (tx) => ({
    propose: await actionAllowed(tx, principal, owner, "knowledge:propose"),
    review: await actionAllowed(tx, principal, owner, "knowledge:review"),
    confirm: await actionAllowed(tx, principal, owner, "knowledge:confirm"),
  }));
}

/** A narrow record grant can only reduce the current owner action authority. */
export async function knowledgeRecordActions(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  owner: Owner,
  recordId: string,
): Promise<Readonly<{ propose: boolean; review: boolean; confirm: boolean }>> {
  const actions = await knowledgeOwnerActions(db, principal, owner);

  return knowledgeUiTransaction(db, async (tx) => {
    const identity = await resolveKnowledgePrincipal(
      tx,
      principal,
      "knowledge:read",
    );
    const row = (
      await tx.execute(
        sql`SELECT visibility FROM brain_items WHERE id=${recordId} FOR SHARE`,
      )
    ).rows[0];

    if (!row)
      throw new MaisterError(
        "PRECONDITION",
        "Knowledge reference is unavailable",
        { details: { reason: "knowledge_reference_unavailable" } },
      );
    if (row.visibility !== "restricted") return actions;
    const grants = (
      await tx.execute(
        sql`SELECT action FROM brain_record_grants WHERE record_id=${recordId} AND principal_type=${identity.actor.kind} AND principal_id=${identity.actor.id} AND revoked_at IS NULL FOR SHARE`,
      )
    ).rows.map((grant) => String(grant.action));

    return {
      propose: actions.propose && grants.includes("knowledge:propose"),
      review: actions.review && grants.includes("knowledge:review"),
      confirm: actions.confirm && grants.includes("knowledge:confirm"),
    };
  });
}

/** Existence-safe page state for an unavailable reference; unrelated failures reach the route boundary. */
export async function knowledgeReferenceView<T>(
  read: () => Promise<T>,
): Promise<
  | Readonly<{ state: "available"; value: T }>
  | Readonly<{ state: "unavailable" }>
> {
  try {
    return { state: "available", value: await read() };
  } catch (error) {
    if (
      isMaisterError(error) &&
      (error.code === "UNAUTHORIZED" ||
        error.details?.reason === "knowledge_reference_unavailable")
    )
      return { state: "unavailable" };
    throw error;
  }
}
