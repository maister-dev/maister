import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Owner } from "@/lib/company/types";
import type { SpecialistAssignment } from "./types";
import type { AssignmentAction } from "./access";

import { inArray, sql } from "drizzle-orm";

import { authorizeAssignment } from "./access";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInputInTransaction,
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
import { runs } from "@/lib/db/schema";
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
    "assignments:cancel" | "assignments:recover" | "assignments:accept"
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
  /** Operations whose verification read this viewer passes: target read plus retained input access. */
  verifiableOperationIds: string[];
}> {
  return db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);
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
      return {
        operationIds: [],
        canRestart: false,
        canRecover: false,
        verifiableOperationIds: [],
      };
    const operations = (
      await tx.execute(sql`
      SELECT id,input_revision FROM stand_operations WHERE assignment_id=${assignment.id}
      ORDER BY created_at DESC,id LIMIT 32
    `)
    ).rows.flatMap(({ id, input_revision }) =>
      typeof id === "string"
        ? [{ id, inputRevision: Number(input_revision) }]
        : [],
    );
    const operationIds = operations.map(({ id }) => id);
    // Verification also reads the retained input revision (claimStandReadAuthority).
    const readableInput = new Map<number, boolean>();

    for (const { inputRevision } of operations) {
      if (readableInput.has(inputRevision)) continue;
      try {
        await getSpecialistAssignmentInputInTransaction(
          tx,
          userId,
          assignment.id,
          inputRevision,
        );
        readableInput.set(inputRevision, true);
      } catch (error) {
        if (!accessRefused(error)) throw error;
        readableInput.set(inputRevision, false);
      }
    }

    return {
      operationIds,
      canRestart: operationIds.length > 0 && (await allowed("targets:restart")),
      canRecover: operationIds.length > 0 && (await allowed("targets:recover")),
      verifiableOperationIds: operations.flatMap(({ id, inputRevision }) =>
        readableInput.get(inputRevision) ? [id] : [],
      ),
    };
  });
}

export type StandSuccessorChoice = Readonly<{
  id: string;
  objective: string;
  revision: number;
  inputRevision: number;
}>;

/**
 * Open, readable assignments that cite each operation's target; the
 * recovery decision rechecks every condition when the operator submits.
 */
export async function listStandSuccessorChoices(
  db: Db,
  userId: string,
  operationIds: readonly string[],
): Promise<Record<string, StandSuccessorChoice[]>> {
  if (!operationIds.length) return {};

  return db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);
    const targets = (
      await tx.execute(sql`
        SELECT id,target_id FROM stand_operations
        WHERE id=ANY(${sql.param([...operationIds])}::text[])
      `)
    ).rows as { id: string; target_id: string }[];
    const targetIds = [...new Set(targets.map(({ target_id }) => target_id))];

    if (!targetIds.length) return {};
    // Filter by cited target before the bound so unrelated open work cannot
    // push a valid successor out of the candidate window.
    const candidates = (
      await tx.execute(sql`
        SELECT assignment.id FROM specialist_assignments assignment
        JOIN specialist_input_revisions input ON input.assignment_id=assignment.id
          AND input.revision=assignment.input_revision
        WHERE assignment.status NOT IN ('completed','failed','cancelled')
          AND input.objective_input->'targetIds' ?| ${sql.param(targetIds)}::text[]
        ORDER BY assignment.updated_at DESC,assignment.id LIMIT 50
      `)
    ).rows as { id: string }[];
    const readable: SpecialistAssignment[] = [];

    for (const { id } of candidates) {
      try {
        readable.push(
          await getSpecialistAssignmentInTransaction(tx, userId, id),
        );
      } catch (error) {
        if (!accessRefused(error)) throw error;
      }
    }

    return Object.fromEntries(
      targets.map(({ id, target_id }) => [
        id,
        readable
          .filter((assignment) => assignment.targetIds.includes(target_id))
          .map((assignment) => ({
            id: assignment.id,
            objective: assignment.objective,
            revision: assignment.revision,
            inputRevision: assignment.inputRevision,
          })),
      ]),
    );
  });
}

export type AssignmentRunSummary = Readonly<{
  id: string;
  status: string;
  runKind: string;
  launchedAt: Date | null;
}>;

/** Status and kind for runs the caller was already authorized to see. */
export async function readAssignmentRunSummaries(
  db: Db,
  visibleRunIds: readonly string[],
): Promise<AssignmentRunSummary[]> {
  if (!visibleRunIds.length) return [];

  return db
    .select({
      id: runs.id,
      status: runs.status,
      runKind: runs.runKind,
      launchedAt: runs.launchedAt,
    })
    .from(runs)
    .where(inArray(runs.id, visibleRunIds))
    .orderBy(sql`${runs.activitySortAt} DESC NULLS LAST`, runs.id);
}

/** Display names for context authors; unknown or removed principals keep their ID. */
export async function resolveAssignmentActorNames(
  db: Db,
  actors: readonly Readonly<{ kind: string; id: string | null }>[],
): Promise<Record<string, string>> {
  const userIds = [
    ...new Set(
      actors.flatMap(({ kind, id }) => (kind === "user" && id ? [id] : [])),
    ),
  ];

  if (!userIds.length) return {};
  const rows = (
    await db.execute(sql`
      SELECT id,coalesce(nullif(name,''),email) AS label FROM users
      WHERE id=ANY(${sql.param(userIds)}::text[])
    `)
  ).rows as { id: string; label: string }[];

  return Object.fromEntries(rows.map(({ id, label }) => [id, label]));
}
