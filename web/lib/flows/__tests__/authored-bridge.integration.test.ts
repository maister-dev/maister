/**
 * Integration test for T-B2: bridgePublishedAuthoredFlow.
 *
 * Verifies §7.1.4 and §7.1.5 from the M27 SDD:
 *   4. Publishing an authored `flow` MUST bridge it into a `flows` row +
 *      `flow_revisions` row via installAuthoredFlowPackageBridge,
 *      trustStatus=trusted_by_policy, exec_trust=untrusted.
 *   5. setup.sh MUST NOT run on publish/bridge.
 *
 * Also verifies idempotency: running the bridge twice for the same content
 * does not error or duplicate rows.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAuthoredCapability,
  publishAuthoredCapabilityLocal,
} from "@/lib/catalog/authored-service";
import * as schemaModule from "@/lib/db/schema";
import { bridgePublishedAuthoredFlow } from "@/lib/flows/authored-bridge";

const schema = schemaModule as unknown as Record<string, any>;
const { flows, flowRevisions } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let projectId: string;
let projectSlug: string;

// A minimal valid graph flow.yaml with engine_min: 1.2.0 and one node.
const VALID_FLOW_YAML = `schemaVersion: 1
name: test-authored-bridge
compat:
  engine_min: 1.2.0
nodes:
  - id: implement
    type: ai_coding
    action:
      prompt: "Implement {{ task.prompt }}"
    transitions:
      success: done
`;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authored_bridge_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "authored-bridge-int-home-"));
  const originalHome = process.env.HOME;

  process.env.HOME = homeDir;

  // Restore HOME after all tests.
  afterAll(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  projectId = randomUUID();
  projectSlug = `bridge-test-${randomUUID()}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug: projectSlug,
    name: projectSlug,
    // repo_path is used as workspaceRoot for symlink placement.
    repoPath: join(homeDir, "repo"),
    maisterYamlPath: join(homeDir, "repo", "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }
});

async function seedAuthoredFlowAndPublish(capSlug: string): Promise<{
  capId: string;
  revision: {
    id: string;
    revisionNumber: number;
    contentHash: string;
    body: Record<string, unknown>;
    title: string;
  };
}> {
  const title = `Test Bridge Flow ${capSlug}`;
  const body = {
    flowYaml: VALID_FLOW_YAML,
    packageMetadata: { slug: capSlug, name: title },
    files: [],
  };

  const created = await createAuthoredCapability({
    projectSlug,
    input: {
      kind: "flow",
      slug: capSlug,
      title,
      body,
    },
    db,
  });
  const capId = created.capability.id;

  const published = await publishAuthoredCapabilityLocal({
    projectSlug,
    capId,
    db,
  });

  return {
    capId,
    revision: {
      id: published.revision.id,
      revisionNumber: published.revision.revisionNumber,
      contentHash: published.revision.contentHash,
      body: published.revision.body as Record<string, unknown>,
      title: published.revision.title,
    },
  };
}

describe("bridgePublishedAuthoredFlow (T-B2)", () => {
  it("creates flows + flow_revisions rows after publish, trust_status=trusted_by_policy, exec_trust=untrusted", async () => {
    const capSlug = `bridge-main-${randomUUID().slice(0, 8)}`;
    const { capId, revision } = await seedAuthoredFlowAndPublish(capSlug);

    const result = await bridgePublishedAuthoredFlow({
      projectSlug,
      projectId,
      capId,
      revision,
      db,
    });

    expect(result.flowRowId).toEqual(expect.any(String));
    expect(result.revisionId).toEqual(expect.any(String));

    // flows row: trustStatus=trusted_by_policy, enablementState=Enabled
    const flowRows = await db
      .select()
      .from(flows)
      .where(eq(flows.id, result.flowRowId));

    expect(flowRows).toHaveLength(1);
    expect(flowRows[0].trustStatus).toBe("trusted_by_policy");
    expect(flowRows[0].enablementState).toBe("Enabled");

    // flow_revisions row: packageStatus=Installed, exec_trust=untrusted
    const revisionRows = await db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.id, result.revisionId));

    expect(revisionRows).toHaveLength(1);
    expect(revisionRows[0].packageStatus).toBe("Installed");
    expect(revisionRows[0].execTrust).toBe("untrusted");
  });

  it("exec_trust column exists in the DB schema (raw-SQL probe)", async () => {
    // Pre-migration this throws: column "exec_trust" does not exist
    await db.execute(sql`
      SELECT exec_trust
      FROM flow_revisions
      LIMIT 0
    `);
  });

  it("does NOT run setup.sh: setupStatus remains 'pending' when setup.sh is present", async () => {
    const capSlug = `bridge-nosetup-${randomUUID().slice(0, 8)}`;
    const title = `Test Bridge Setup Flow ${capSlug}`;
    // Include a setup.sh file in the package body — installRevision will set
    // setupStatus='pending' (setup.sh present but deferred). The bridge MUST
    // NOT flip it to 'done' (which would mean setup.sh actually ran).
    const bodyWithSetup = {
      flowYaml: VALID_FLOW_YAML,
      packageMetadata: { slug: capSlug, name: title },
      files: [
        {
          kind: "setup",
          path: "setup.sh",
          content: "#!/usr/bin/env bash\necho 'setup ran'\n",
        },
      ],
    };

    const created = await createAuthoredCapability({
      projectSlug,
      input: { kind: "flow", slug: capSlug, title, body: bodyWithSetup },
      db,
    });
    const published = await publishAuthoredCapabilityLocal({
      projectSlug,
      capId: created.capability.id,
      db,
    });
    const revision = {
      id: published.revision.id,
      revisionNumber: published.revision.revisionNumber,
      contentHash: published.revision.contentHash,
      body: published.revision.body as Record<string, unknown>,
      title: published.revision.title,
    };

    const result = await bridgePublishedAuthoredFlow({
      projectSlug,
      projectId,
      capId: created.capability.id,
      revision,
      db,
    });

    // setupStatus must remain 'pending' — setup.sh EXISTS in the package but
    // MUST NOT have been executed during bridge (exec_trust gate, §4.2/§6.4).
    const revisionRows = await db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.id, result.revisionId));

    expect(revisionRows[0].setupStatus).toBe("pending");
  });

  it("is idempotent: running bridge twice for same content does not error or duplicate", async () => {
    const capSlug = `bridge-idem-${randomUUID().slice(0, 8)}`;
    const { capId, revision } = await seedAuthoredFlowAndPublish(capSlug);

    const first = await bridgePublishedAuthoredFlow({
      projectSlug,
      projectId,
      capId,
      revision,
      db,
    });

    // Second call with identical content — must not throw.
    const second = await bridgePublishedAuthoredFlow({
      projectSlug,
      projectId,
      capId,
      revision,
      db,
    });

    // Both calls should resolve to the SAME revision row (idempotent install).
    expect(second.revisionId).toBe(first.revisionId);
    expect(second.flowRowId).toBe(first.flowRowId);

    // Still exactly one flows row for this flowRefId in the project.
    const flowRows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.projectId, projectId), eq(flows.flowRefId, capSlug)));

    expect(flowRows).toHaveLength(1);
  });
});
