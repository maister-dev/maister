import type { LegacyMemoryImportCommand } from "../import-legacy";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { importLegacyAgentMemory } from "../import-legacy";

import { agentMemoryPath } from "@/lib/agents/memory-store";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

it("AV-10 cannot resume, activate or clean a legacy note under a reassigned project slug", async () => {
  const fixture = await startMainPostgresTestDb({
    databaseName: "agent_memory_import_owner",
  });
  const root = await mkdtemp(
    path.join(tmpdir(), "maister-memory-import-owner-"),
  );

  try {
    const db = fixture.db;
    const original = await seedProjectRow(db);
    const replacement = await seedProjectRow(db);
    const actorUserId = await seedActiveUser(db, { role: "admin" });
    const agentId = "fixture:legacy";
    const source = agentMemoryPath(original.slug, agentId, root);
    const contents = "An original project memory.";
    const invoke = (command: LegacyMemoryImportCommand) =>
      importLegacyAgentMemory(db, { root, command, actorUserId });
    const rename = (projectId: string, slug: string) =>
      fixture.pool.query("UPDATE projects SET slug=$2 WHERE id=$1", [
        projectId,
        slug,
      ]);
    const replaceOwner = async () => {
      await rename(original.id, "retired-import-owner");
      await rename(replacement.id, original.slug);
    };

    await fixture.pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
       VALUES ($1,'fixture','v1','git','Legacy','Migration fixture','none','session','[]','read_only','/fixture/legacy.md')`,
      [agentId],
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, contents, "utf8");
    await invoke("import");

    await replaceOwner();
    await expect(invoke("import")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    await expect(invoke("activate")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS count FROM agent_memory_cutover",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);

    await rename(replacement.id, replacement.slug);
    await rename(original.id, original.slug);
    await invoke("activate");
    await replaceOwner();
    await expect(invoke("cleanup")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    await expect(readFile(source, "utf8")).resolves.toBe(contents);
    expect(
      (
        await fixture.pool.query(
          `SELECT v.project_id,r.state FROM agent_memory_import_receipts r
       JOIN agent_memory_vaults v ON v.id=r.vault_id`,
        )
      ).rows,
    ).toEqual([{ project_id: original.id, state: "verified" }]);
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
