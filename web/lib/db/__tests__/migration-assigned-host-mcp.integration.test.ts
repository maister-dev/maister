import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { getHostById } from "@/lib/execution-host/hosts";
import { reserveHostWorkspace } from "@/lib/execution-host/workspace-preparation";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { startMainPostgresTestDbUpTo } from "@/test-support/pg-container";

it("upgrades populated host and command ledgers without changing old witnesses or weakening the single local host invariant", async () => {
  const cutoff = "0403_project_agent_instance_profile";
  const database = await startMainPostgresTestDbUpTo(
    { databaseName: "assigned_mcp_upgrade" },
    cutoff,
  );
  const client = await database.pool.connect();
  const db = drizzle(client);
  const executionDb = drizzle(client, { schema });

  try {
    await client.query(
      "SET maister.task_launch_writer='v3'; SET maister.agent_preparation_writer='v2'; SET maister.execution_host_registry_writer='v2'",
    );
    const { id } = await seedLocalHost(db);
    const local = await getHostById(executionDb, id);
    const projectId = await seedProject(db);
    const run = await seedRun(db, {
      projectId,
      status: "Pending",
      runKind: "agent",
      agentWorkspace: "none",
    });

    if (!local) throw new Error("Expected the seeded host");
    const assignment = await executionDb.transaction(async (tx) => {
      const owner = await mintAssignment(tx, {
        runId: run,
        hostId: id,
        reason: "launch",
      });

      await reserveHostWorkspace(
        tx,
        { host: local, assignment: owner },
        { projectId, branch: "main", baseBranch: null, baseCommit: null },
        { mode: "emptyDirectory", inputDigest: "a".repeat(64) },
      );

      return owner;
    });
    const command = async (kind: string, id = randomUUID()) =>
      client.query(
        "INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,max_attempts) VALUES($1,$2,$3,$4,1,$5,3)",
        [id, run, assignment.id, local.id, kind],
      );
    const read = async () =>
      (
        await client.query<{ witness: string }>(
          "SELECT row_to_json(c)::text AS witness FROM execution_commands c WHERE run_id=$1 ORDER BY id",
          [run],
        )
      ).rows.map(({ witness }) => witness);
    const witness = await read();
    expect(witness).toHaveLength(1);
    const host = (kind: string, role: string | null = null) =>
      client.query(
        "INSERT INTO execution_hosts (id,host_key,kind,display_name,transport,capabilities,readiness) VALUES ($1,$2,$3,'Test',jsonb_strip_nulls(jsonb_build_object('kind',$3::text,'role',$4::text)),'{}','ready')",
        [randomUUID(), randomUUID(), kind, role],
      );

    await expect(host("remote_direct")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(command("mcp.prepare")).rejects.toMatchObject({
      code: "23514",
    });
    await host("local_direct", "secondary");
    await upgradeMainTestDb(database, cutoff);
    await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
    expect(await read()).toEqual(witness);
    await host("local_direct", "secondary");
    await expect(host("remote_direct")).rejects.toMatchObject({
      code: "23514",
    });
    await command("mcp.prepare");
    await expect(host("local_direct")).rejects.toMatchObject({ code: "23505" });
    await expect(host("unknown")).rejects.toMatchObject({ code: "23514" });
    await expect(command("unknown")).rejects.toMatchObject({ code: "23514" });
  } finally {
    client.release();
    await database.stop();
  }
}, 180_000);
