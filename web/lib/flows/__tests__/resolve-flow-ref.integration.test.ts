import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { resolveFlowRef } from "@/lib/flows/resolve-flow-ref";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

// Two projects, each owning a flow whose ref collides by name across projects —
// the shape that proves resolution is project-scoped (R4).
const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();
const FLOW_A_BUGFIX = randomUUID();
const FLOW_A_DEV = randomUUID();
const FLOW_B_BUGFIX = randomUUID();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "resolve_flow_ref_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.flows);
  await db.delete(schema.projects);

  await db.insert(schema.projects).values([
    {
      id: PROJECT_A,
      slug: "proj-a",
      name: "Project A",
      taskKey: "PJA",
      repoPath: `/tmp/${PROJECT_A}`,
      maisterYamlPath: `/tmp/${PROJECT_A}/maister.yaml`,
    },
    {
      id: PROJECT_B,
      slug: "proj-b",
      name: "Project B",
      taskKey: "PJB",
      repoPath: `/tmp/${PROJECT_B}`,
      maisterYamlPath: `/tmp/${PROJECT_B}/maister.yaml`,
    },
  ]);

  const flowDefaults = {
    source: "github.com/acme/pkg",
    version: "v1.0.0",
    installedPath: "/tmp/flow",
    manifest: {},
    schemaVersion: 1,
  };

  await db.insert(schema.flows).values([
    {
      id: FLOW_A_BUGFIX,
      projectId: PROJECT_A,
      flowRefId: "aif-bugfix",
      ...flowDefaults,
    },
    {
      id: FLOW_A_DEV,
      projectId: PROJECT_A,
      flowRefId: "aif-dev",
      ...flowDefaults,
    },
    {
      id: FLOW_B_BUGFIX,
      projectId: PROJECT_B,
      flowRefId: "b-only",
      ...flowDefaults,
    },
  ]);
});

describe("resolveFlowRef (integration)", () => {
  it("resolves a flows.id UUID to itself", async () => {
    const result = await resolveFlowRef(PROJECT_A, FLOW_A_BUGFIX, db);

    expect(result).toEqual({ ok: true, flowId: FLOW_A_BUGFIX });
  });

  it("resolves a human flow_ref_id to the flow's UUID", async () => {
    const result = await resolveFlowRef(PROJECT_A, "aif-bugfix", db);

    expect(result).toEqual({ ok: true, flowId: FLOW_A_BUGFIX });
  });

  it("refuses an unknown value and reports the project's valid refs", async () => {
    const result = await resolveFlowRef(PROJECT_A, "nope", db);

    expect(result.ok).toBe(false);
    // The detail is what lets an agent self-correct in one shot (R5).
    expect(result).toMatchObject({
      ok: false,
      detail: { field: "flowId", received: "nope" },
    });
    expect(result.ok === false && result.detail.validRefs).toEqual([
      "aif-bugfix",
      "aif-dev",
    ]);
    expect(result.ok === false && result.detail.expected).toContain(
      "flow_ref_id",
    );
  });

  it("refuses another project's flows.id UUID (existence-hide)", async () => {
    const result = await resolveFlowRef(PROJECT_A, FLOW_B_BUGFIX, db);

    expect(result.ok).toBe(false);
  });

  it("refuses another project's flow_ref_id", async () => {
    const result = await resolveFlowRef(PROJECT_A, "b-only", db);

    expect(result.ok).toBe(false);
  });
});
