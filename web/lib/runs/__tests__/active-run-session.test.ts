import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { runs } from "@/lib/db/schema";
import {
  activeSessionCapabilityAgent,
  activeSessionRunnerSnapshot,
} from "@/lib/runs/active-run-session";

describe("active-run-session", () => {
  const pool = new Pool({
    connectionString: "postgres://test:test@localhost:5432/test",
  });
  const db = drizzle(pool);

  afterAll(async () => {
    await pool.end();
  });

  it("qualifies the outer run id in scalar session projections", () => {
    const query = db
      .select({
        runId: runs.id,
        capabilityAgent: activeSessionCapabilityAgent(runs.id),
        runnerSnapshot: activeSessionRunnerSnapshot(runs.id),
      })
      .from(runs)
      .where(eq(runs.id, "run-1"));

    const generatedSql = query.toSQL().sql;

    expect(generatedSql).toContain('WHERE rs.run_id = "runs"."id"');
    expect(generatedSql).not.toContain('WHERE rs.run_id = "id"');
  });
});
