import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Owner } from "@/lib/company/types";
import type { SpecialistAssignment } from "./types";
import type { AssignmentAction } from "./access";

import { sql } from "drizzle-orm";

import { authorizeAssignment } from "./access";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
} from "./store";
import {
  loadCompanyAssignmentCoordinator,
  loadCompanyAssignmentSpecialist,
} from "./company-intake";

import { listCompanySpecialists } from "@/lib/agents/company-binding-list";
import { authorizeCompanyRunUserActionInTransaction } from "@/lib/agents/company-run-read-access";
import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { isMaisterError } from "@/lib/errors";
import { authorizePeekRun } from "@/lib/runs/peek-read-model";
import { isTerminalRunStatus } from "@/lib/runs/run-status-sets";

export type SpecialistChoice = Readonly<{
  id: string;
  name: string;
  owner: Owner;
  supportsStand: boolean;
}>;

function accessRefused(error: unknown): boolean {
  return (
    isMaisterError(error) &&
    ["UNAUTHORIZED", "PRECONDITION", "CONFLICT"].includes(error.code)
  );
}

export async function canChangeAssignment(
  db: Db,
  userId: string,
  assignment: SpecialistAssignment,
  action: Extract<
    AssignmentAction,
    "assignments:cancel" | "assignments:recover"
  >,
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await authorizeAssignment(tx, userId, assignment.owner, action, {
        preset: "supervised",
      });
    });

    return true;
  } catch (error) {
    if (accessRefused(error)) return false;
    throw error;
  }
}

export async function assignmentHasLiveWork(
  db: Db,
  assignmentId: string,
): Promise<boolean> {
  const rows = (
    await db.execute<{ status: string; placed: boolean }>(sql`
    SELECT run.status,EXISTS (
      SELECT 1 FROM execution_assignments placement WHERE placement.run_id=run.id AND placement.state='active'
    ) AS placed FROM specialist_run_links link JOIN runs run ON run.id=link.run_id
    WHERE link.assignment_id=${assignmentId}
  `)
  ).rows;

  return rows.some(
    ({ status, placed }) => placed || !isTerminalRunStatus(status),
  );
}

/** Only offer bindings which can be addressed under the current manual assignment policy. */
export async function listManualSpecialistChoices(
  db: Db,
  userId: string,
  projectId?: string,
): Promise<SpecialistChoice[]> {
  if (projectId)
    return db.transaction(async (tx) => {
      const owner = { kind: "project" as const, projectId };

      try {
        for (const action of [
          "assignments:read",
          "assignments:submit",
          "assignments:update",
        ] as const)
          await authorizeAssignment(tx, userId, owner, action, {
            preset: "supervised",
          });
      } catch (error) {
        if (accessRefused(error)) return [];
        throw error;
      }
      const rows = (
        await tx.execute(sql`
      SELECT link.id,agent.name,agent.specialist->'targetClasses' ? 'stand' AS supports_stand FROM agent_project_links link JOIN agents agent ON agent.id=link.agent_id
      WHERE link.project_id=${projectId} AND link.enabled AND agent.enabled AND agent.quarantined_at IS NULL
        AND agent.specialist IS NOT NULL AND (agent.kind='operational' OR agent.flow_ref IS NOT NULL)
        AND agent.triggers ? 'manual'
      ORDER BY agent.name,link.id LIMIT 100
    `)
      ).rows;

      return rows.flatMap(({ id, name, supports_stand }) =>
        typeof id === "string" && typeof name === "string"
          ? [{ id, name, owner, supportsStand: supports_stand === true }]
          : [],
      );
    });

  try {
    const page = await listCompanySpecialists(db, userId, { limit: 50 });

    return db.transaction(async (tx) => {
      const owner = {
        kind: "company" as const,
        companyId: await installationCompany(tx),
      };

      for (const action of [
        "assignments:read",
        "assignments:submit",
        "assignments:update",
      ] as const)
        await authorizeAssignment(tx, userId, owner, action, {
          preset: "supervised",
        });
      const result: SpecialistChoice[] = [];

      for (const candidate of page.items) {
        if (!candidate.enabled || candidate.detachedAt) continue;
        try {
          const selected = await loadCompanyAssignmentSpecialist(tx, {
            owner,
            specialistBindingId: candidate.bindingId,
          });
          const definition = selected.revision.snapshot.definition;

          if (!definition.triggers.includes("manual")) continue;
          if (definition.flow)
            await loadCompanyAssignmentCoordinator(
              tx,
              owner.companyId,
              selected,
            );
          else if (definition.kind !== "operational") continue;
          result.push({
            id: candidate.bindingId,
            name: candidate.name,
            owner,
            supportsStand:
              candidate.targetClasses.includes("stand") &&
              candidate.grantActions.includes("targets:read"),
          });
        } catch (error) {
          if (!accessRefused(error)) throw error;
        }
      }

      return result;
    });
  } catch (error) {
    if (accessRefused(error)) return [];
    throw error;
  }
}

export async function listRequestedSpecialistAssignments(
  db: Db,
  userId: string,
  projectId?: string,
): Promise<SpecialistAssignment[]> {
  return db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);
    const candidates = (
      await tx.execute(sql`
      SELECT id FROM specialist_assignments
      WHERE requester->>'kind'='user' AND requester->>'id'=${userId}
        ${projectId ? sql`AND project_id=${projectId}` : sql``}
      ORDER BY updated_at DESC,id LIMIT 50
    `)
    ).rows;
    const result: SpecialistAssignment[] = [];

    for (const row of candidates) {
      if (typeof row.id !== "string") continue;
      try {
        result.push(
          await getSpecialistAssignmentInTransaction(tx, userId, row.id),
        );
      } catch (error) {
        if (!accessRefused(error)) throw error;
      }
    }

    return result;
  });
}

export async function listVisibleAssignmentRunIds(
  userId: string,
  runIds: readonly string[],
): Promise<string[]> {
  const result: string[] = [];

  for (const runId of runIds) {
    try {
      await authorizePeekRun(userId, runId);
      result.push(runId);
    } catch (error) {
      if (!accessRefused(error)) throw error;
    }
  }

  return result;
}

/** Show recovery only for the current readable crashed company coordinator. */
export async function readRecoverableCompanyCoordinator(
  db: Db,
  userId: string,
  assignment: SpecialistAssignment,
): Promise<string | null> {
  if (assignment.owner.kind !== "company") return null;
  const companyId = assignment.owner.companyId;

  try {
    return await db.transaction(async (tx: Db) => {
      const [row] = (
        await tx.execute(sql`
          SELECT run.id FROM runs run
          WHERE run.id=specialist_current_root_id(${assignment.id},${assignment.inputRevision})
            AND run.company_id=${companyId} AND run.run_kind='flow'
            AND run.status='Crashed' AND run.resume_target_step_id IS NOT NULL
            AND run.company_cancellation_intent IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM stand_operations operation WHERE operation.assignment_id=${assignment.id}
                AND operation.action='restart' AND operation.effect_state<>'not_dispatched'
            )
        `)
      ).rows;

      if (typeof row?.id !== "string") return null;
      await authorizeCompanyRunUserActionInTransaction(
        tx,
        userId,
        row.id,
        "assignments:recover",
      );

      return row.id;
    });
  } catch (error) {
    if (accessRefused(error)) return null;
    throw error;
  }
}

export type AssignmentReview = Readonly<{
  expectedRevision: number;
  inputRevision: number;
  contextRevision: number;
  result: Readonly<{ runId: string; revision: number }>;
  verificationIds: readonly string[];
}>;

/** Offer only the current eligible root and its exact retained verification. */
export async function readAssignmentReview(
  db: Db,
  userId: string,
  assignmentId: string,
): Promise<AssignmentReview | null> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );

      if (assignment.status !== "awaiting_acceptance") return null;
      await authorizeAssignment(
        tx,
        userId,
        assignment.owner,
        "assignments:accept",
        { preset: "supervised" },
      );
      const [row] = (
        await tx.execute<{
          run_id: string;
          result_revision: number;
          verification_ids: string[];
        }>(sql`
        SELECT witness.run_id,witness.result_revision,
          specialist_acceptance_verification_ids(result.value) AS verification_ids
        FROM specialist_delivery_receipts witness
        JOIN run_results result ON result.id=specialist_final_result_id(
          witness.assignment_id,witness.input_revision,witness.run_id,witness.result_revision)
        WHERE witness.assignment_id=${assignmentId} AND witness.input_revision=${assignment.inputRevision}
        ORDER BY witness.result_revision DESC,witness.created_at DESC,witness.id LIMIT 1
        FOR SHARE OF result
      `)
      ).rows;

      if (!row) return null;
      await authorizeRunKnowledgeDisclosure(
        tx,
        { kind: "user", userId },
        row.run_id,
      );

      return {
        expectedRevision: assignment.revision,
        inputRevision: assignment.inputRevision,
        contextRevision: assignment.contextRevision,
        result: { runId: row.run_id, revision: row.result_revision },
        verificationIds: row.verification_ids,
      };
    });
  } catch (error) {
    if (accessRefused(error)) return null;
    throw error;
  }
}

export async function readAssignmentStandChoices(
  db: Db,
  userId: string,
  assignment: SpecialistAssignment,
): Promise<{
  operationIds: string[];
  canRestart: boolean;
  canRecover: boolean;
}> {
  return db.transaction(async (tx) => {
    const companyId = await installationCompany(tx);
    const allowed = async (
      action: "targets:read" | "targets:restart" | "targets:recover",
    ): Promise<boolean> => {
      try {
        await authorizeCompanyUserAction(tx, userId, companyId, action);

        return true;
      } catch (error) {
        if (accessRefused(error)) return false;
        throw error;
      }
    };

    if (!(await allowed("targets:read")))
      return { operationIds: [], canRestart: false, canRecover: false };
    const operationIds = (
      await tx.execute(sql`
      SELECT id FROM stand_operations WHERE assignment_id=${assignment.id}
      ORDER BY created_at DESC,id LIMIT 32
    `)
    ).rows.flatMap(({ id }) => (typeof id === "string" ? [id] : []));

    return {
      operationIds,
      canRestart: operationIds.length > 0 && (await allowed("targets:restart")),
      canRecover: operationIds.length > 0 && (await allowed("targets:recover")),
    };
  });
}
