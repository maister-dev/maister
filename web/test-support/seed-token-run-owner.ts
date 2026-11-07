import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

/** Persist the actual agent owner before exercising the production token minter. */
export async function seedAgentTokenRunOwner(
  db: Pick<Db, "execute">,
  input: Readonly<{ projectId: string; agentId: string; runId?: string }>,
): Promise<string> {
  const runId = input.runId ?? randomUUID();

  await db.execute(sql`
    INSERT INTO runs (id, project_id, agent_id, run_kind, status, flow_version, flow_revision)
    VALUES (${runId}, ${input.projectId}, ${input.agentId}, 'agent', 'Running', 'agent', 'manual')
  `);

  return runId;
}
