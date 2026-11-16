import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskQualificationSummary } from "@/lib/tasks/qualification-queries";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { SpecialistAssignmentStatus } from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "./store";

import { MaisterError } from "@/lib/errors";
import { redactQueryError } from "@/lib/db/pg-error";
import { taskLaunchPreviewState } from "@/lib/tasks/launch-preview";
import { postgresTextSchema } from "@/lib/text-schema";

export type AssignmentAdmissionView = Readonly<{
  schemaVersion: 1;
  assignmentId: string;
  revision: number;
  inputRevision: number;
  status: SpecialistAssignmentStatus;
  kind: "company" | "project_agent" | "project_flow";
  carrier: Readonly<{
    taskId: string;
    taskNumber: number;
    taskHref: string;
    input: Readonly<{ revision: number; sha256: string }> | null;
    qualification: TaskQualificationSummary | null;
    activeLaunch: TaskLaunchReceipt | null;
  }> | null;
  limitations: readonly (
    "repository_evidence_not_checked" | "carrier_input_unavailable"
  )[];
}>;

const carrierSchema = z
  .object({
    task_id: postgresTextSchema.min(1).max(128),
    task_number: z.number().int().positive().max(2147483647),
    project_slug: postgresTextSchema.min(1).max(256),
    source_revision: z.number().int().positive().max(2147483647).nullable(),
    source_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

/** This observation never resolves launch readiness or writes qualification/intent state. */
export async function getSpecialistAssignmentAdmission(
  db: Db,
  userId: string,
  assignmentId: string,
): Promise<AssignmentAdmissionView> {
  try {
    return await db.transaction<AssignmentAdmissionView>(async (tx) => {
      await beginAssignmentTransaction(tx);
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );
      const current = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        assignment.inputRevision,
      );
      const kind: AssignmentAdmissionView["kind"] =
        assignment.owner.kind === "company"
          ? "company"
          : current.snapshot.standingDefinition.schemaVersion === 2
            ? "project_flow"
            : "project_agent";
      const view: AssignmentAdmissionView = {
        schemaVersion: 1,
        assignmentId: assignment.id,
        revision: assignment.revision,
        inputRevision: assignment.inputRevision,
        status: assignment.status,
        kind,
        carrier: null,
        limitations: [],
      };

      if (kind !== "project_flow") return view;
      const [head] = (
        await tx.execute(
          sql`SELECT project_task_id FROM specialist_assignments WHERE id=${assignment.id}`,
        )
      ).rows;

      if (head?.project_task_id === null) return view;
      // Canonical launch locks task before assignment; metadata must not acquire that task lock in reverse.
      const [row] = (
        await tx.execute(sql`
        SELECT carrier.id AS task_id,carrier.number AS task_number,project.slug AS project_slug,
          source.revision AS source_revision,source.digest AS source_digest
        FROM specialist_assignments head JOIN tasks carrier ON carrier.id=head.project_task_id AND carrier.project_id=head.project_id
        JOIN projects project ON project.id=carrier.project_id
        LEFT JOIN specialist_input_revisions source ON source.assignment_id=head.id
          AND carrier.qualification_source_version='specialist-assignment:v1:'||source.assignment_id||':'||source.revision::text||':'||source.digest
          AND source.standing_definition->'schemaVersion'='2'::jsonb
          AND source.standing_definition->'coordinatorFlow'->>'flowId'=carrier.flow_id
        WHERE head.id=${assignment.id}
      `)
      ).rows;
      const parsed = carrierSchema.safeParse(row);

      if (!parsed.success)
        throw new MaisterError(
          "CONFIG",
          "Retained assignment carrier is unavailable or malformed; inspect native intake integrity",
        );
      const carrier = parsed.data;
      const original =
        carrier.source_revision === null
          ? null
          : await getSpecialistAssignmentInputInTransaction(
              tx,
              userId,
              assignmentId,
              carrier.source_revision,
            );

      if (original && original.digest !== carrier.source_digest)
        throw new MaisterError(
          "CONFLICT",
          "Retained carrier input changed during inspection",
        );
      const state = await taskLaunchPreviewState(tx, carrier.task_id);

      return {
        ...view,
        carrier: {
          taskId: carrier.task_id,
          taskNumber: carrier.task_number,
          taskHref: `/projects/${encodeURIComponent(carrier.project_slug)}/tasks/${carrier.task_number}`,
          input: original
            ? { revision: original.revision, sha256: original.digest }
            : null,
          qualification: state.qualification,
          activeLaunch: state.activeLaunch,
        },
        limitations: original
          ? ["repository_evidence_not_checked"]
          : ["repository_evidence_not_checked", "carrier_input_unavailable"],
      };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

export function assertAssignmentAdmissionQuery(url: string): void {
  if (new URL(url).searchParams.size !== 0)
    throw new MaisterError(
      "CONFIG",
      "Assignment admission inspection accepts no query parameters",
    );
}
