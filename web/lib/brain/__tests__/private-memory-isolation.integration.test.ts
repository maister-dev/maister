import type { Owner } from "@/lib/company/types";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import {
  readAgentMemoryRaw,
  writeAgentMemoryCas,
} from "@/lib/agents/memory-store";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import { getKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import {
  listPersonalMemory,
  rememberPersonalMemory,
} from "@/lib/librarian/memory";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { migrateTestDatabase } from "@/test-support/migrate-test-database";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { parseAgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";

it("IT-CBE-07 native migration, search and referenced reads leave private agent and personal librarian stores isolated", async () => {
  const database = await startMainPostgresTestDb({
    databaseName: "native_private_memory_isolation",
  });
  const root = await mkdtemp(join(tmpdir(), "cbe07-memory-"));
  const originalRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

  process.env.MAISTER_RUNTIME_ROOT = root;
  try {
    const project = await seedProjectRow(database.db);
    const userId = await seedActiveUser(database.db, { role: "admin" });
    const principal = { kind: "user" as const, userId };
    const companyId = (
      await database.pool.query<{ id: string }>("SELECT id FROM companies")
    ).rows[0]!.id;

    await database.db.execute(
      sql`INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES(${companyId},'user',${userId},'knowledge:read',${userId})`,
    );
    const agentId = "qualification:private-keeper";
    const marker = `cbe07-canary-${randomUUID()}`;
    const agentContent = `${marker} private professional instructions`;
    const librarianContent = `${marker} personal owner preference`;
    const memory = await writeAgentMemoryCas(
      database.db,
      project.slug,
      agentId,
      agentContent,
      null,
    );
    const personalId = await rememberPersonalMemory(
      userId,
      { kind: "preference", content: librarianContent, scope: "general" },
      database.db,
    );
    const { rows: vaults } = await database.pool.query<{ id: string }>(
      "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES ($1,$2) RETURNING id",
      [project.id, agentId],
    );
    const vault = await applyVaultMutation(
      database.db,
      parseAgentMemoryMutation({
        command: "create",
        path: "/memories/index.md",
        file_text: `${marker} vault content`,
        ifRevisionId: null,
        ifHash: null,
        requestKey: "private-isolation",
      }),
      async () => ({
        vaultId: vaults[0]!.id,
        actor: { kind: "human", userId },
        principalKey: `user:${userId}`,
        sourceProjectIds: [project.id],
        sourceRestrictions: [],
        writeAdmission: "apply",
        canRead: async () => true,
        capture: async () => {},
      }),
      agentMemoryVaultLimits(),
    );

    if (vault.status !== "applied") throw new Error("Vault seed must apply");

    expect(memory.ok).toBe(true);
    // Both private stores are populated before Company Brain's first migration.
    await migrateTestDatabase(database.pool, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    expect(
      (await database.db.execute(sql`SELECT id FROM brain_items`)).rows,
    ).toEqual([]);
    const projectRecordId = randomUUID();
    const companyRecordId = randomUUID();

    await database.db.execute(
      sql`UPDATE projects SET brain_enabled=true WHERE id=${project.id}`,
    );
    await database.db.execute(
      sql`INSERT INTO brain_items(id,project_id,kind,title,content,confidence,content_hash) VALUES(${projectRecordId},${project.id},'assertion','Explicit project record',${`${marker} project assertion`},0.3,${randomUUID()})`,
    );
    await database.db.execute(
      sql`INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) VALUES(${companyRecordId},${companyId},'assertion','Explicit company record',${`${marker} company assertion`},0.3,${randomUUID()})`,
    );
    // A replay must not import private rows or filesystem content either.
    await migrateTestDatabase(database.pool, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    const knowledgeControls: readonly Readonly<{
      owner: Owner;
      id: string;
      assertion: string;
    }>[] = [
      {
        owner: { kind: "project", projectId: project.id },
        id: projectRecordId,
        assertion: `${marker} project assertion`,
      },
      {
        owner: { kind: "company", companyId },
        id: companyRecordId,
        assertion: `${marker} company assertion`,
      },
    ];

    for (const record of knowledgeControls) {
      const page = await searchKnowledge(database.db, principal, {
        q: marker,
        owner: record.owner,
        limit: 10,
      });

      expect(page.items.map((item) => item.id)).toEqual([record.id]);
      expect(
        await getKnowledgeRecord(database.db, principal, {
          recordId: record.id,
        }),
      ).toMatchObject({
        id: record.id,
        owner: record.owner,
        assertion: record.assertion,
      });
    }
    for (const privateId of [
      agentId,
      personalId,
      vault.affected[0]!.noteId,
      vault.affected[0]!.revisionId,
    ]) {
      await expect(
        getKnowledgeRecord(database.db, principal, { recordId: privateId }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "knowledge_reference_unavailable" },
      });
      await expect(
        getKnowledgeWitness(database.db, principal, privateId),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "knowledge_reference_unavailable" },
      });
    }
    expect(
      (await database.db.execute(sql`SELECT id FROM brain_items ORDER BY id`))
        .rows,
    ).toEqual([projectRecordId, companyRecordId].sort().map((id) => ({ id })));
    expect(await readAgentMemoryRaw(project.slug, agentId)).toMatchObject({
      content: agentContent,
      hash: memory.ok ? memory.state.hash : null,
    });
    expect((await listPersonalMemory(userId, database.db)).items).toMatchObject(
      [{ id: personalId, content: librarianContent }],
    );
  } finally {
    if (originalRuntimeRoot === undefined)
      delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = originalRuntimeRoot;
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
