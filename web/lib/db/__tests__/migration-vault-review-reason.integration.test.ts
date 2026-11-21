import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import { startMainPostgresTestDbUpTo } from "@/test-support/pg-container";

const predecessor = "0360_workspace_integrity_limits";
const states = ["pending", "accepted", "rejected", "redacted"] as const;

it("K14 preserves prior decisions and receipts and accepts legacy writes after the additive upgrade", async () => {
  const database = await startMainPostgresTestDbUpTo(
    { databaseName: "vault_review_reason_upgrade" },
    predecessor,
  );

  try {
    const project = await seedProjectRow(database.db);
    const reviewer = await seedActiveUser(database.db, { role: "admin" });
    const digest = "a".repeat(64);

    await database.db.execute(sql`
      INSERT INTO agent_memory_vaults(id,project_id,agent_id)
      VALUES ('upgrade-vault',${project.id},'fixture:review')
    `);
    for (const state of states) {
      const settled = state === "accepted" || state === "rejected";

      await database.db.execute(sql`
        INSERT INTO agent_memory_operations
          (id,vault_id,principal_key,request_key,command_kind,command_digest,outcome)
        VALUES (${state},'upgrade-vault','fixture',${`request-${state}`},'create',${digest},'pending')
      `);
      if (state === "accepted") {
        await database.db.execute(sql`
          INSERT INTO agent_memory_operations
            (id,vault_id,principal_key,request_key,command_kind,command_digest,outcome)
          VALUES ('applied','upgrade-vault','fixture','request-applied','create',${digest},'applied')
        `);
      }
      await database.db.execute(sql`
        INSERT INTO agent_memory_proposals(id,vault_id,operation_id,author,source_project_ids,
          source_restrictions,changes,state,version,decided_at,reviewer_id,decision_key,applied_operation_id)
        VALUES (${state},'upgrade-vault',${state},'{}',ARRAY[${project.id}], '[]', '[{}]',
          ${state},${state === "pending" ? 1 : 2},
          CASE WHEN ${state === "pending"} THEN NULL ELSE now() END,
          ${settled ? reviewer : null},${settled ? `decide-${state}` : null},
          ${state === "accepted" ? "applied" : null})
      `);
    }
    await database.db.execute(sql`
      INSERT INTO inbox_review_receipts (id,user_id,request_key,digest)
      VALUES ('upgrade-receipt',${reviewer},'decide-accepted',${digest})
    `);
    const oldShape = () =>
      database.db.execute(sql`
      SELECT p.id,p.operation_id,p.state,p.version,p.reviewer_id,p.decided_at,p.applied_operation_id,
        p.source_project_ids,p.source_restrictions,o.command_digest
      FROM agent_memory_proposals p JOIN agent_memory_operations o ON p.operation_id=o.id
      WHERE p.vault_id='upgrade-vault' ORDER BY p.id
    `);
    const retained = (await oldShape()).rows;

    await upgradeMainTestDb(database, predecessor);
    await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
    expect((await oldShape()).rows).toEqual(retained);
    expect(
      (
        await database.db.execute(sql`
      SELECT id,digest FROM inbox_review_receipts WHERE id='upgrade-receipt'
    `)
      ).rows,
    ).toEqual([{ id: "upgrade-receipt", digest }]);
    expect(
      (
        await database.db.execute(sql`
      SELECT count(*)::int AS count FROM agent_memory_proposals WHERE decision_reason IS NULL
    `)
      ).rows,
    ).toEqual([{ count: states.length }]);

    await expect(
      database.db.execute(sql`
      UPDATE agent_memory_proposals SET decision_reason='premature' WHERE id='pending'
    `),
    ).rejects.toThrow();
    await database.db.execute(sql`
      UPDATE agent_memory_proposals SET state='rejected', version=2, decided_at=now(),
        reviewer_id=${reviewer}, decision_key='legacy-review' WHERE id='pending'
    `);
    await expect(
      database.db.execute(sql`
      UPDATE agent_memory_proposals SET decision_reason='   ' WHERE id='rejected'
    `),
    ).rejects.toThrow();
    await database.db.execute(sql`
      UPDATE agent_memory_proposals SET decision_reason='Changed requirement' WHERE id='rejected'
    `);
    expect(
      (
        await database.db.execute(sql`
      SELECT id,decision_reason FROM agent_memory_proposals WHERE id IN ('pending','rejected') ORDER BY id
    `)
      ).rows,
    ).toEqual([
      { id: "pending", decision_reason: null },
      { id: "rejected", decision_reason: "Changed requirement" },
    ]);
    expect(
      (
        await database.db.execute(sql`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
      WHERE created_at > (SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC OFFSET 1 LIMIT 1)
    `)
      ).rows,
    ).toEqual([{ count: 1 }]);
  } finally {
    await database.stop();
  }
}, 180_000);
