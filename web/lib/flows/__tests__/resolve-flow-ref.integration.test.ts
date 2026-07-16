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

// Two projects that BOTH own a flow with ref "aif-bugfix". That collision is the
// only shape where project-scoping on the ref axis can return the WRONG row — a
// fixture with distinct refs could only ever prove "not found" (R4).
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
      flowRefId: "aif-bugfix",
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

  // The only case where ref-axis scoping can return the WRONG row rather than
  // simply missing: both projects own "aif-bugfix".
  it("resolves a ref shared with another project to THIS project's flow", async () => {
    const a = await resolveFlowRef(PROJECT_A, "aif-bugfix", db);
    const b = await resolveFlowRef(PROJECT_B, "aif-bugfix", db);

    expect(a).toEqual({ ok: true, flowId: FLOW_A_BUGFIX });
    expect(b).toEqual({ ok: true, flowId: FLOW_B_BUGFIX });
  });

  // Both columns are `text`, so an id colliding with a sibling's ref is not
  // schema-forbidden (only convention keeps ids UUID-shaped). The id match must
  // win deterministically rather than depending on Postgres row order.
  it("prefers the flows.id match when a sibling's flow_ref_id collides with it", async () => {
    const collidingId = "collides-with-a-ref";

    await db.insert(schema.flows).values({
      id: collidingId,
      projectId: PROJECT_A,
      flowRefId: "some-other-ref",
      source: "github.com/acme/pkg",
      version: "v1.0.0",
      installedPath: "/tmp/flow",
      manifest: {},
      schemaVersion: 1,
    });
    await db.insert(schema.flows).values({
      id: randomUUID(),
      projectId: PROJECT_A,
      flowRefId: collidingId,
      source: "github.com/acme/pkg",
      version: "v1.0.0",
      installedPath: "/tmp/flow",
      manifest: {},
      schemaVersion: 1,
    });

    const result = await resolveFlowRef(PROJECT_A, collidingId, db);

    expect(result).toEqual({ ok: true, flowId: collidingId });
  });
});
