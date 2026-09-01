import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

type Db = NodePgDatabase;

type FlowSeed = {
  enablementState?: "Disabled" | "Installed";
  flowTrustStatus?: "trusted" | "untrusted";
  packageTrustStatus?: "trusted" | "untrusted";
  revisionPackageStatus?: "Failed" | "Installed";
  setupStatus?: "failed" | "not_required";
  graphOnly?: boolean;
};

let testDatabase: StartedPostgresTestDb;
let db: Db;

const migrationPath = resolve(
  __dirname,
  "../migrations/0103_repair_trusted_package_flow_enablement.sql",
);

function id(): string {
  return randomUUID();
}

async function seedProject(): Promise<string> {
  const projectId = id();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (
      ${projectId},
      ${`repair-package-flow-${projectId.slice(0, 8)}`},
      'Package Flow repair migration',
      ${`/tmp/repair-package-flow-${projectId}`},
      ${`RP${projectId.slice(0, 8)}`.toUpperCase()}
    )
  `);

  return projectId;
}

async function seedPackageFlow(
  projectId: string,
  overrides: FlowSeed = {},
): Promise<string> {
  const suffix = id();
  const packageInstallId = id();
  const revisionId = id();
  const flowId = id();
  const flowRefId = `repair-flow-${suffix}`;
  const packageName = `repair-package-${suffix}`;
  const resolvedRevision = suffix.replaceAll("-", "");
  const manifest =
    overrides.graphOnly === false
      ? { schemaVersion: 1, steps: [] }
      : { schemaVersion: 1, nodes: [] };

  await db.execute(sql`
    INSERT INTO package_installs (
      id, source_url, name, version_label, resolved_revision, manifest,
      manifest_digest, installed_path, package_status, trust_status
    ) VALUES (
      ${packageInstallId}, 'file:///tmp/repair-package', ${packageName}, 'v1.0.0',
      ${resolvedRevision}, ${JSON.stringify({ spec: { flows: [] } })}::jsonb,
      'repair-digest', ${`/tmp/${packageName}`}, 'Installed',
      ${overrides.packageTrustStatus ?? "trusted"}
    )
  `);
  await db.execute(sql`
    INSERT INTO project_package_attachments (
      id, project_id, package_install_id, package_name
    ) VALUES (${id()}, ${projectId}, ${packageInstallId}, ${packageName})
  `);
  await db.execute(sql`
    INSERT INTO flow_revisions (
      id, flow_ref_id, source, version_label, resolved_revision,
      manifest_digest, manifest, schema_version, installed_path,
      setup_status, package_status, exec_trust
    ) VALUES (
      ${revisionId}, ${flowRefId}, 'file:///tmp/repair-package', 'v1.0.0',
      ${resolvedRevision}, 'repair-digest', ${JSON.stringify(manifest)}::jsonb,
      1, ${`/tmp/${packageName}/${flowRefId}`},
      ${overrides.setupStatus ?? "not_required"},
      ${overrides.revisionPackageStatus ?? "Installed"}, 'trusted'
    )
  `);
  await db.execute(sql`
    INSERT INTO flows (
      id, project_id, flow_ref_id, source, version, revision, installed_path,
      manifest, schema_version, enabled_revision_id, enablement_state,
      trust_status, version_binding, package_install_id
    ) VALUES (
      ${flowId}, ${projectId}, ${flowRefId}, 'file:///tmp/repair-package',
      'v1.0.0', ${resolvedRevision}, ${`/tmp/${packageName}/${flowRefId}`},
      ${JSON.stringify(manifest)}::jsonb, 1, ${revisionId},
      ${overrides.enablementState ?? "Installed"},
      ${overrides.flowTrustStatus ?? "trusted"}, 'latest', ${packageInstallId}
    )
  `);

  return flowId;
}

async function flowStates(
  flowIds: readonly string[],
): Promise<Map<string, string>> {
  // sql.param, not a bare `${flowIds}`: drizzle expands a bare array chunk into
  // a comma-separated parameter LIST, so the cast lands on a row constructor
  // (`ANY(($1,$2)::text[])`) and postgres refuses with "cannot cast type record
  // to text[]". sql.param binds the whole array as ONE parameter.
  const rows = await db.execute<{ id: string; enablement_state: string }>(sql`
    SELECT id, enablement_state
    FROM flows
    WHERE id = ANY(${sql.param(flowIds)}::text[])
  `);

  return new Map(rows.rows.map((row) => [row.id, row.enablement_state]));
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_repair_trusted_package_flow_enablement_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("migration 0103 — trusted package Flow enablement repair", () => {
  it("enables only ready trusted graph package Flows and is idempotent", async () => {
    const projectId = await seedProject();
    const eligible = await seedPackageFlow(projectId);
    const disabled = await seedPackageFlow(projectId, {
      enablementState: "Disabled",
    });
    const untrusted = await seedPackageFlow(projectId, {
      flowTrustStatus: "untrusted",
    });
    const untrustedPackage = await seedPackageFlow(projectId, {
      packageTrustStatus: "untrusted",
    });
    const failedSetup = await seedPackageFlow(projectId, {
      revisionPackageStatus: "Failed",
      setupStatus: "failed",
    });
    const legacy = await seedPackageFlow(projectId, { graphOnly: false });
    const flowIds = [
      eligible,
      disabled,
      untrusted,
      untrustedPackage,
      failedSetup,
      legacy,
    ];
    const migrationSql = await readFile(migrationPath, "utf8");

    await db.execute(sql.raw(migrationSql));

    const states = await flowStates(flowIds);

    expect(states.get(eligible)).toBe("Enabled");
    expect(states.get(disabled)).toBe("Disabled");
    expect(states.get(untrusted)).toBe("Installed");
    expect(states.get(untrustedPackage)).toBe("Installed");
    expect(states.get(failedSetup)).toBe("Installed");
    expect(states.get(legacy)).toBe("Installed");

    await db.execute(sql.raw(migrationSql));

    expect((await flowStates(flowIds)).get(eligible)).toBe("Enabled");
  });
});
