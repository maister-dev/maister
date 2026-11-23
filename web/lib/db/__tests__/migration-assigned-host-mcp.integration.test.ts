import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

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
  const { db, pool } = database;

  try {
    await pool.query(
      "SET maister.task_launch_writer='v3'; SET maister.agent_preparation_writer='v2'; SET maister.execution_host_registry_writer='v2'",
    );
    const local = await seedLocalHost(db);
    const run = await seedRun(db, { projectId: await seedProject(db) });
    const assignment = randomUUID();

    await pool.query(
      "INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason) VALUES($1,$2,$3,1,'active','launch')",
      [assignment, run, local.id],
    );
    const command = async (kind: string, id = randomUUID()) =>
      pool.query(
        "INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,max_attempts) VALUES($1,$2,$3,$4,1,$5,3)",
        [id, run, assignment, local.id, kind],
      );
    const saved = [randomUUID(), randomUUID()];

    await command("session.create", saved[0]);
    await command("workspace.prepare", saved[1]);
    const read = async () =>
      (
        await pool.query(
          "SELECT row_to_json(c)::text AS witness FROM execution_commands c WHERE id=ANY($1::text[]) ORDER BY id",
          [saved],
        )
      ).rows.map(({ witness }) => witness);
    const witness = await read();
    const host = (kind: string, role: string | null = null) =>
      pool.query(
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
    await migrate(db, { migrationsFolder: "./lib/db/migrations" });
    expect(await read()).toEqual(witness);
    await host("local_direct", "secondary");
    await expect(host("remote_direct")).rejects.toMatchObject({ code: "23514" });
    await command("mcp.prepare");
    await expect(host("local_direct")).rejects.toMatchObject({ code: "23505" });
    await expect(host("unknown")).rejects.toMatchObject({ code: "23514" });
    await expect(command("unknown")).rejects.toMatchObject({ code: "23514" });
  } finally {
    await database.stop();
  }
}, 180_000);
