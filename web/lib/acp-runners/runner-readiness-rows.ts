import "server-only";

import type { RunnerReadinessRow } from "@/lib/acp-runners/readiness-summary";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { platformAcpRunners } from "@/lib/db/schema";

export async function loadRunnerReadinessRows(): Promise<RunnerReadinessRow[]> {
  const db = getDb() as unknown as NodePgDatabase<typeof schema>;

  return db
    .select({
      id: platformAcpRunners.id,
      adapter: platformAcpRunners.adapter,
      capabilityAgent: platformAcpRunners.capabilityAgent,
      model: platformAcpRunners.model,
      provider: platformAcpRunners.provider,
      enabled: platformAcpRunners.enabled,
      readinessStatus: platformAcpRunners.readinessStatus,
      readinessReasons: platformAcpRunners.readinessReasons,
    })
    .from(platformAcpRunners);
}
