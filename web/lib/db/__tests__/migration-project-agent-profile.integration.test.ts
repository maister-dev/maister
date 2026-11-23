import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { startMainPostgresTestDbUpTo } from "@/test-support/pg-container";

it("preserves existing agent links and Run witnesses and enforces unique owned MCP additions on populated upgrade", async () => {
  const previous = "0402_package_mcp_scope";
  const testDb = await startMainPostgresTestDbUpTo(
    { databaseName: "agent_profile_upgrade" },
    previous,
  );
  const { db, pool } = testDb;

  try {
    await pool.query(
      "SET maister.task_launch_writer='v3'; SET maister.agent_preparation_writer='v2'",
    );
    const project = await seedProjectRow(db);
    const link = randomUUID();
    const agent = "example:test";
    const run = randomUUID();

    await pool.query(
      `INSERT INTO agents (id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'example','v1','git','Test','Existing agent','none','session','["manual"]','read_only','/example/test.md')`,
      [agent],
    );
    await pool.query(
      "INSERT INTO agent_project_links(id,agent_id,project_id,schedules_revision) VALUES ($1,$2,$3,7)",
      [link, agent, project.id],
    );
    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,source_agent_id,activity_sort_at,activity_timestamp_provenance,agent_activity_snapshot) VALUES ($1,$2,'agent','Running','agent','manual',$4,now(),'verified_creation',$3)",
      [
        run,
        project.id,
        JSON.stringify({
          version: 1,
          agentId: agent,
          definitionSha256: "f".repeat(64),
        }),
        agent,
      ],
    );
    const readWitness = async () =>
      (
        await pool.query(
          "SELECT agent_activity_snapshot::text FROM runs WHERE id=$1",
          [run],
        )
      ).rows[0].agent_activity_snapshot;
    const before = await readWitness();

    await upgradeMainTestDb(testDb, previous);
    await migrate(db, { migrationsFolder: "./lib/db/migrations" });
    expect(await readWitness()).toBe(before);
    expect(
      (
        await pool.query(
          "SELECT prompt_override,schedules_revision FROM agent_project_links WHERE id=$1",
          [link],
        )
      ).rows[0],
    ).toEqual({ prompt_override: null, schedules_revision: 7 });
    expect(
      (
        await pool.query("SELECT project_agent_profile FROM runs WHERE id=$1", [
          run,
        ])
      ).rows[0].project_agent_profile,
    ).toBeNull();
    await expect(
      pool.query(
        "UPDATE agent_project_links SET prompt_override='  ' WHERE id=$1",
        [link],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const add = (id: string, ref: string) =>
      pool.query("INSERT INTO agent_project_mcp_additions VALUES ($1,$2)", [
        id,
        ref,
      ]);

    await expect(add(randomUUID(), "design")).rejects.toMatchObject({
      code: "23503",
    });
    await expect(add(link, "../unsafe")).rejects.toMatchObject({
      code: "23514",
    });
    await add(link, "design");
    await expect(add(link, "design")).rejects.toMatchObject({ code: "23505" });
    await pool.query("DELETE FROM agent_project_links WHERE id=$1", [link]);
    expect(
      (
        await pool.query(
          "SELECT ref_id FROM agent_project_mcp_additions WHERE link_id=$1",
          [link],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await testDb.stop();
  }
}, 180_000);
