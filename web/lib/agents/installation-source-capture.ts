import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  installationProjectAccess,
  type InstallationRunAuthority,
} from "./installation-authority";

import { MaisterError } from "@/lib/errors";

const maximumSources = 256;
const log = pino({
  name: "installation-source-capture",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function installationRunProjects(
  tx: SqlTransaction,
  runId: string,
): Promise<string[]> {
  const result =
    await tx.execute(sql`SELECT project_id FROM agent_installation_run_sources WHERE run_id=${runId}
    ORDER BY project_id COLLATE "C" LIMIT ${maximumSources + 1}`);

  if (
    result.rows.length > maximumSources ||
    result.rows.some((row) => typeof row.project_id !== "string")
  )
    throw new MaisterError(
      "PRECONDITION",
      "The installation source capture is unavailable or exceeds its bound",
    );

  return result.rows.map(({ project_id }) => String(project_id));
}

/** Serialize with the Run credential and vault writer before projecting a response. */
export async function captureInstallationProjects(
  tx: SqlTransaction,
  runId: string,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return;
  const handle = await tx.execute(
    sql`SELECT run_id FROM agent_installation_run_authorities WHERE run_id=${runId} FOR UPDATE`,
  );

  if (handle.rows.length !== 1)
    throw new MaisterError(
      "PRECONDITION",
      "The installation run has no retained source capture",
    );
  const prior = await installationRunProjects(tx, runId);
  const combined = new Set([...prior, ...projectIds]);

  if (
    combined.size > maximumSources ||
    [...combined].some(
      (id) =>
        id.length < 1 ||
        id.length > 192 ||
        !id.isWellFormed() ||
        id.includes("\0"),
    )
  )
    throw new MaisterError(
      "PRECONDITION",
      "Narrow the request to fit the installation source capture bound",
    );

  await tx.execute(sql`INSERT INTO agent_installation_run_sources(run_id,project_id)
    SELECT ${runId},item FROM jsonb_array_elements_text(${JSON.stringify([...combined])}::jsonb) AS item
    ON CONFLICT DO NOTHING`);
  log.debug(
    { runId, sources: combined.size, newSources: combined.size - prior.length },
    "installation projects retained before disclosure",
  );
}

export async function assertCurrentInstallationSources(
  tx: SqlTransaction,
  context: InstallationRunAuthority,
): Promise<void> {
  const ids = await installationRunProjects(tx, context.runId);

  if (!ids.length) return;
  const allowed =
    await tx.execute(sql`SELECT id FROM projects WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    AND archived_at IS NULL AND ${installationProjectAccess(context, sql`projects.id`, "readBoard")} FOR SHARE`);

  if (allowed.rows.length !== ids.length)
    throw new MaisterError(
      "PRECONDITION",
      "An installation execution source is no longer visible",
    );
}
