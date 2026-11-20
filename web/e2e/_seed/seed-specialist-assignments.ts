/* eslint-disable no-console */
// Seeds two company assignments for the admin plus an unrelated user's token,
// and prints their identifiers as JSON. Run with the server-only shim; the
// caller points HOME at a disposable directory for the package cache.
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { cp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";

import { createE2EDbPool } from "./db";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { createCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import { resolveInstalledAgentDefinition } from "@/lib/agents/effective";
import { createCompanyGrants } from "@/lib/company/grants";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { createSpecialistAssignment } from "@/lib/specialist-assignments/store";
import { issueUserAccessToken } from "@/lib/tokens/issue";
import { prepareCompanySpecialistAssignment } from "@/test-support/specialist-assignment-seed";

async function seedInstallationBinding(
  db: Db,
  adminId: string,
  marker: string,
): Promise<string> {
  const source = resolve(
    `e2e/.runtime/specialist-home-${marker}/installation-source`,
  );
  await cp(resolve("test-fixtures/rah-native"), source, { recursive: true });
  await writeFile(
    join(source, "maister-agents/installation-observer.md"),
    "---\nname: Installation observer\ndescription: Observe active projects\nkind: operational\ncompletion: {contract: operational_v1}\nspecialist:\n  responsibilities: [Inspect recent project runs]\n  targetClasses: [stand]\nmode: session\nworkspace: none\ntriggers: [manual, cron]\nrisk_tier: read_only\n---\nInspect recent project runs.\n",
  );
  const installed = await installPackageRevision({
    source,
    version: `rah/installation-${marker}`,
    db,
  });
  await trustPackageRevision({ packageInstallId: installed.id, db });
  const grants = await createCompanyGrants(db, adminId, {
    principalKind: "user",
    principalId: adminId,
    actions: ["specialists:manage", "specialists:read"],
    idempotencyKey: randomUUID(),
  });
  const agentId = "rah:installation-observer";
  const definition = await resolveInstalledAgentDefinition(db, {
    agentId,
    packageInstallId: installed.id,
  });
  const { specialist } = await createCompanySpecialistBinding(
    db,
    adminId,
    agentId,
    {
      owner: { kind: "company", companyId: grants.page.companyId },
      packageInstallId: installed.id,
      packageRevision: definition.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(definition.parsed),
      enabled: true,
      configuration: {},
      grantActions: [],
      idempotencyKey: randomUUID(),
      installationGrant: {
        schemaVersion: 1,
        reach: "active_projects",
        scopes: ["projects:read", "agent_memory:read"],
        memoryEnabled: true,
      },
    },
  );
  return specialist.bindingId;
}

async function main(): Promise<void> {
  const [adminEmail, marker, objective, otherObjective, managerId] =
    process.argv.slice(2);
  const pool = createE2EDbPool(resolvePostgresDbUrl());

  try {
    const db = drizzle(pool) as unknown as Db;
    const adminId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
        adminEmail,
      ])
    ).rows[0]!.id;
    const outsiderId = randomUUID();

    await pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [outsiderId, `${outsiderId}@example.test`],
    );
    const prepared = await prepareCompanySpecialistAssignment(db, {
      administratorId: adminId,
      requesterId: adminId,
      version: `rah/e2e-${marker}`,
    });
    const assignment = await createSpecialistAssignment(db, adminId, {
      ...prepared,
      objectiveInput: { ...prepared.objectiveInput, objective },
    });
    const other = await createSpecialistAssignment(db, adminId, {
      ...prepared,
      objectiveInput: { ...prepared.objectiveInput, objective: otherObjective },
      origin: { kind: "manual", interactionId: randomUUID() },
    });
    const token = await issueUserAccessToken(
      {
        ownerUserId: outsiderId,
        name: `e2e-outsider-${marker}`,
        scopes: ["assignments:read", "assignments:cancel"],
      },
      db,
    );
    const installationBindingId = await seedInstallationBinding(
      db,
      adminId,
      marker,
    );
    await createCompanyGrants(db, adminId, {
      principalKind: "user",
      principalId: managerId,
      actions: ["specialists:read", "specialists:manage"],
      idempotencyKey: randomUUID(),
    });
    await pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1) ON CONFLICT DO NOTHING",
    );

    console.log(
      JSON.stringify({
        assignmentId: assignment.id,
        otherAssignmentId: other.id,
        outsiderSecret: token.secret,
        installationBindingId,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("seed-specialist-assignments failed:", error);
  process.exitCode = 1;
});
