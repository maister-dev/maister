import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { MaisterError } from "@/lib/errors";

// The saved per-Flow mapping overrides its manifest runner. General task and
// platform defaults cannot satisfy an unavailable explicit declaration.
const effectiveDefault = sql`coalesce(mapped.runner_id, d.desired->>'runner')`;
const unavailable = sql`d.id IS NOT NULL AND runner.id IS NULL`;

function runnerBinding(flowId: string | SQLWrapper): SQL {
  return sql`FROM flows f
    LEFT JOIN project_dependency_declarations d ON d.project_id = f.project_id AND d.kind = 'flow'
      AND d.logical_id = f.flow_ref_id AND d.desired->>'runner' <> 'inherit'
    LEFT JOIN project_flow_runner_defaults mapped ON mapped.flow_id = f.id AND mapped.project_id = f.project_id
    LEFT JOIN platform_acp_runners runner ON runner.id = ${effectiveDefault} AND runner.enabled AND runner.readiness_status = 'Ready'
    WHERE f.id = ${flowId}`;
}

export function declaredFlowRunnerUnavailable(
  flowId: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 ${runnerBinding(flowId)} AND ${unavailable})`;
}

const bindingSchema = z.object({
  defaultRunnerId: z.string().nullable(),
  unavailable: z.boolean(),
});

export async function readFlowRunnerBinding(
  db: SqlTransaction,
  flowId: string,
): Promise<z.infer<typeof bindingSchema>> {
  const { rows } = await db.execute(
    sql`SELECT ${effectiveDefault} AS "defaultRunnerId", (${unavailable}) AS unavailable ${runnerBinding(flowId)}`,
  );

  if (!rows.length)
    throw new MaisterError(
      "PRECONDITION",
      "The project Flow no longer exists.",
      {
        details: { reason: "flow_unavailable" },
      },
    );

  return bindingSchema.parse(rows[0]);
}

export async function requireReadyDeclaredFlowRunner(
  db: SqlTransaction,
  flowId: string,
): Promise<string | null> {
  const binding = await readFlowRunnerBinding(db, flowId);

  if (binding.unavailable)
    throw new MaisterError(
      "PRECONDITION",
      "The declared Flow runner is unavailable. Provision or enable it in the platform runner catalog.",
      { details: { reason: "declared_flow_runner_unavailable" } },
    );

  return binding.defaultRunnerId;
}
