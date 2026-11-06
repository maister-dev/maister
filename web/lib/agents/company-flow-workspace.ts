import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { OperationalIntegrityBaseline } from "@/lib/run-results/operational-types";
import type { CompanyFlowSessionContext } from "./company-flow-session-context";

import { mkdir, readdir } from "node:fs/promises";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { loadCompanyFlowSessionContext } from "./company-flow-session-context";
import {
  companyAgentRuntimePath,
  companyAgentWorkdirPath,
} from "./workspace-paths";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "./operational-integrity";
import { inspectOperationalWorkspace } from "./operational-context";
import { agentMaterializationWitnessPathsForRun } from "./materialization-manifest";

import { runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agents:company-flow-workspace",
  level: process.env.LOG_LEVEL ?? "info",
});

async function currentCompanyFlowRun(
  db: Db,
  runId: string,
): Promise<CompanyFlowSessionContext["run"]> {
  const context = await db.transaction((tx) =>
    loadCompanyFlowSessionContext(tx, runId),
  );

  return context.run;
}

/** Capture the managed plain directory before any platform materialization; resumed work must match its retained witness. */
export async function prepareCompanyFlowWorkspace(
  db: Db,
  runId: string,
): Promise<void> {
  const run = await currentCompanyFlowRun(db, runId);
  const cwd = companyAgentWorkdirPath(run.companyId, runId);

  if (run.operationalIntegrityBaseline) {
    const integrity = await inspectOperationalWorkspace(db, run);

    if (integrity.verdict !== "clean")
      throw new MaisterError(
        "PRECONDITION",
        "Company graph source changed before continuation; inspect its retained evidence before recovery",
        {
          details: {
            reason: "company_flow_integrity_refused",
            reasons: integrity.reasonCodes,
          },
        },
      );

    return;
  }
  if (run.status !== "Running")
    throw new MaisterError(
      "PRECONDITION",
      "A company graph can capture its first directory witness only while Running",
    );
  await mkdir(cwd, { recursive: true });
  if ((await readdir(cwd)).length !== 0)
    throw new MaisterError(
      "PRECONDITION",
      "An unwitnessed company graph directory is not empty; preserve it for diagnosis",
    );
  const runtimePath = companyAgentRuntimePath(run.companyId, runId);

  await mkdir(runtimePath, { recursive: true });
  const baseline: OperationalIntegrityBaseline = {
    ...(await captureOperationalBaseline(cwd, "plain_directory")),
    owner: {
      kind: "company",
      companyId: run.companyId,
      runId,
      cwd,
      runtimePath,
    },
    contextMounts: [],
  };
  const written = await db
    .update(runs)
    .set({ operationalIntegrityBaseline: baseline })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "Running"),
        isNull(runs.operationalIntegrityBaseline),
        run.executionAssignmentId
          ? eq(runs.executionAssignmentId, run.executionAssignmentId)
          : isNull(runs.executionAssignmentId),
      ),
    )
    .returning({ id: runs.id });

  if (!written[0])
    throw new MaisterError(
      "CONFLICT",
      "Company graph directory witness was superseded",
      { details: { reason: "assignment_fenced" } },
    );
  log.debug(
    { runId, companyId: run.companyId, generation: baseline.generation },
    "company graph source baseline retained",
  );
}

/** Admit only this Run's leased platform writes into the existing source generation ledger. */
export async function witnessCompanyFlowMaterialization(
  db: Db,
  runId: string,
): Promise<void> {
  const run = await currentCompanyFlowRun(db, runId);
  const baseline = run.operationalIntegrityBaseline;

  if (!baseline)
    throw new MaisterError(
      "PRECONDITION",
      "Company graph materialization has no retained source baseline",
    );
  const cwd = companyAgentWorkdirPath(run.companyId, runId);
  const next = await captureOperationalGeneration(
    cwd,
    baseline,
    await agentMaterializationWitnessPathsForRun(cwd, runId),
  );
  const written = await db
    .update(runs)
    .set({ operationalIntegrityBaseline: next })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, run.status),
        sql`${runs.operationalIntegrityBaseline}->>'generation'=${String(baseline.generation)}`,
        run.executionAssignmentId
          ? eq(runs.executionAssignmentId, run.executionAssignmentId)
          : isNull(runs.executionAssignmentId),
      ),
    )
    .returning({ id: runs.id });

  if (!written[0])
    throw new MaisterError(
      "CONFLICT",
      "Company graph materialization generation was superseded",
      { details: { reason: "assignment_fenced" } },
    );
  log.debug(
    { runId, companyId: run.companyId, generation: next.generation },
    "company graph platform generation retained",
  );
}
