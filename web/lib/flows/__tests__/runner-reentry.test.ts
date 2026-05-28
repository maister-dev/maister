import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executors as executorsTable,
  flows as flowsTable,
  hitlRequests as hitlRequestsTable,
  projects as projectsTable,
  runs as runsTable,
  stepRuns as stepRunsTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { runFlow } from "@/lib/flows/runner";

type TableRows = {
  runs: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  flows: Record<string, unknown>[];
  executors: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  workspaces: Record<string, unknown>[];
  step_runs: Record<string, unknown>[];
  hitl_requests: Record<string, unknown>[];
};

type CapturedUpdate = {
  table: keyof TableRows;
  set: Record<string, unknown>;
};

function tableNameOf(table: unknown): keyof TableRows {
  if (table === runsTable) return "runs";
  if (table === tasksTable) return "tasks";
  if (table === flowsTable) return "flows";
  if (table === executorsTable) return "executors";
  if (table === projectsTable) return "projects";
  if (table === workspacesTable) return "workspaces";
  if (table === stepRunsTable) return "step_runs";
  if (table === hitlRequestsTable) return "hitl_requests";
  throw new Error("unknown table object passed to fakeDb");
}

function makeFakeDb(initial: Partial<TableRows>): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  updates: CapturedUpdate[];
  inserts: Array<{ table: keyof TableRows; row: Record<string, unknown> }>;
  rows: TableRows;
} {
  const rows: TableRows = {
    runs: initial.runs ?? [],
    tasks: initial.tasks ?? [],
    flows: initial.flows ?? [],
    executors: initial.executors ?? [],
    projects: initial.projects ?? [],
    workspaces: initial.workspaces ?? [],
    step_runs: initial.step_runs ?? [],
    hitl_requests: initial.hitl_requests ?? [],
  };
  const updates: CapturedUpdate[] = [];
  const inserts: Array<{
    table: keyof TableRows;
    row: Record<string, unknown>;
  }> = [];

  const project = (
    cols: Record<string, unknown> | undefined,
    rs: Record<string, unknown>[],
  ) =>
    cols
      ? rs.map((r) => {
          const out: Record<string, unknown> = {};

          for (const key of Object.keys(cols)) {
            out[key] = r[key];
          }

          return out;
        })
      : rs;

  const selectChain = (cols?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const tableName = tableNameOf(table);
      const projected = () => project(cols, rows[tableName]);
      const makeThenable = () => {
        const promise = Promise.resolve(projected());

        return Object.assign(promise, {
          orderBy: () => Promise.resolve(projected()),
        });
      };

      return {
        where: () => makeThenable(),
        innerJoin: () => ({
          where: () => makeThenable(),
        }),
        orderBy: () => Promise.resolve(projected()),
      };
    },
  });
  const insertChain = (table: unknown) => {
    const tableName = tableNameOf(table);

    return {
      values: async (row: Record<string, unknown>) => {
        inserts.push({ table: tableName, row });
        rows[tableName].push(row);
      },
    };
  };
  const updateChain = (table: unknown) => {
    const tableName = tableNameOf(table);

    return {
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table: tableName, set: vals });
          for (const r of rows[tableName]) {
            Object.assign(r, vals);
          }
        },
      }),
    };
  };
  const client = {
    select: (cols?: Record<string, unknown>) => selectChain(cols),
    insert: insertChain,
    update: updateChain,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return await fn({
        select: (cols?: Record<string, unknown>) => selectChain(cols),
        insert: insertChain,
        update: updateChain,
      });
    },
  };

  return { client, updates, inserts, rows };
}

const flowManifest = {
  schemaVersion: 1,
  name: "test-flow",
  steps: [
    { id: "first", type: "human" as const, form_schema: "schema.json" },
    { id: "second", type: "human" as const, form_schema: "schema.json" },
  ],
};

vi.mock("@/lib/scheduler", () => ({
  promoteNextPending: vi.fn(async () => null),
}));

let runtimeRoot: string;
let flowInstallPath: string;

async function writeFormSchema(): Promise<void> {
  await writeFile(
    join(flowInstallPath, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      fields: [{ name: "approved", type: "boolean" }],
    }),
  );
}

async function writeArtifact(
  stepId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const dir = join(runtimeRoot, ".maister", "demo", "runs", "run-1");

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${stepId}.json`),
    JSON.stringify(payload),
  );
}

function baseFixture(): TableRows {
  return {
    runs: [
      {
        id: "run-1",
        taskId: "task-1",
        projectId: "proj-1",
        flowId: "flow-1",
        executorId: "exec-1",
        status: "Pending",
        currentStepId: null,
        flowVersion: "v1",
        // Runner derives the install path from (flowRefId, flowRevision).
        // The unit-test fake DB lets us substitute the "unknown" sentinel
        // here so the resolver produces a stable path under
        // ~/.maister/flows/test-flow@unknown/ for the test environment.
        flowRevision: "unknown",
      },
    ],
    tasks: [
      {
        id: "task-1",
        projectId: "proj-1",
        title: "T",
        prompt: "p",
        flowId: "flow-1",
        attemptNumber: 1,
        status: "InFlight",
      },
    ],
    flows: [
      {
        id: "flow-1",
        projectId: "proj-1",
        flowRefId: "test-flow",
        installedPath: flowInstallPath,
        manifest: flowManifest,
        version: "v1",
        revision: "unknown",
      },
    ],
    executors: [
      {
        id: "exec-1",
        projectId: "proj-1",
        agent: "claude",
        model: "claude-sonnet-4-6",
      },
    ],
    projects: [
      {
        id: "proj-1",
        slug: "demo",
      },
    ],
    workspaces: [
      {
        id: "ws-1",
        runId: "run-1",
        projectId: "proj-1",
        branch: "feature/x",
        worktreePath: "/tmp/wt",
        removedAt: null,
      },
    ],
    step_runs: [],
    hitl_requests: [],
  };
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "runner-reentry-rt-"));
  flowInstallPath = await mkdtemp(join(tmpdir(), "runner-reentry-flow-"));
  await writeFormSchema();
});

afterEach(async () => {
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(flowInstallPath, { recursive: true, force: true });
});

describe("runFlow re-entry", () => {
  it("rejects non-Running/non-NeedsInput status with PRECONDITION", async () => {
    const fixture = baseFixture();

    fixture.runs[0].status = "Pending";

    const { client } = makeFakeDb(fixture);

    await expect(runFlow("run-1", { db: client, runtimeRoot })).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("boot on Running starts at step 0 (regression check)", async () => {
    const fixture = baseFixture();

    fixture.runs[0].status = "Running";
    fixture.flows[0].manifest = {
      schemaVersion: 1,
      name: "tf",
      steps: [
        { id: "first", type: "human" as const, form_schema: "schema.json" },
      ],
    };

    const { client, inserts } = makeFakeDb(fixture);

    await writeArtifact("first", { approved: true });

    await runFlow("run-1", { db: client, runtimeRoot });

    const stepRunInserts = inserts.filter((i) => i.table === "step_runs");

    expect(stepRunInserts).toHaveLength(1);
    expect(stepRunInserts[0].row.stepId).toBe("first");
  });

  it("boot on NeedsInput with currentStepId='second' transitions NeedsInput→Running and skips the 'first' step", async () => {
    const fixture = baseFixture();

    fixture.runs[0].status = "NeedsInput";
    fixture.runs[0].currentStepId = "second";
    fixture.flows[0].manifest = {
      schemaVersion: 1,
      name: "tf",
      steps: [
        { id: "first", type: "human" as const, form_schema: "schema.json" },
        { id: "second", type: "human" as const, form_schema: "schema.json" },
      ],
    };
    fixture.step_runs.push({
      id: "sr-first",
      runId: "run-1",
      stepId: "first",
      stepType: "human",
      status: "Succeeded",
      attempt: 1,
      vars: {},
      startedAt: new Date(0),
    });
    fixture.step_runs.push({
      id: "sr-second-existing",
      runId: "run-1",
      stepId: "second",
      stepType: "human",
      status: "NeedsInput",
      attempt: 1,
      vars: {},
      startedAt: new Date(1),
    });

    const { client, inserts, updates } = makeFakeDb(fixture);

    await writeArtifact("second", { approved: true });

    await runFlow("run-1", { db: client, runtimeRoot }).catch(() => undefined);

    const stepRunInserts = inserts.filter((i) => i.table === "step_runs");
    const insertedStepIds = stepRunInserts.map((i) => i.row.stepId);

    expect(insertedStepIds).not.toContain("first");

    const runsStatusUpdates = updates
      .filter((u) => u.table === "runs" && "status" in u.set)
      .map((u) => u.set.status);

    expect(runsStatusUpdates[0]).toBe("Running");

    const currentStepIdUpdates = updates
      .filter((u) => u.table === "runs" && "currentStepId" in u.set)
      .map((u) => u.set.currentStepId);

    expect(currentStepIdUpdates[0]).toBe("second");
  });

  it("boot on NeedsInput with an unknown currentStepId fails closed with Crashed + CONFIG and inserts no step_runs", async () => {
    const fixture = baseFixture();

    fixture.runs[0].status = "NeedsInput";
    fixture.runs[0].currentStepId = "ghost-step-id-not-in-manifest";
    fixture.flows[0].manifest = {
      schemaVersion: 1,
      name: "tf",
      steps: [
        { id: "first", type: "human" as const, form_schema: "schema.json" },
        { id: "second", type: "human" as const, form_schema: "schema.json" },
      ],
    };

    const { client, inserts, updates } = makeFakeDb(fixture);

    await expect(
      runFlow("run-1", { db: client, runtimeRoot }),
    ).rejects.toMatchObject({ code: "CONFIG" });

    const stepRunInserts = inserts.filter((i) => i.table === "step_runs");

    expect(stepRunInserts).toHaveLength(0);

    const runsStatusUpdates = updates
      .filter((u) => u.table === "runs" && "status" in u.set)
      .map((u) => u.set.status);

    // The fail-closed transition writes Crashed BEFORE throwing.
    expect(runsStatusUpdates).toContain("Crashed");
  });

  it("atomic resume claim: two concurrent runFlow calls only execute the loop once", async () => {
    const fixture = baseFixture();

    fixture.runs[0].status = "NeedsInput";
    fixture.runs[0].currentStepId = "first";
    fixture.flows[0].manifest = {
      schemaVersion: 1,
      name: "tf",
      steps: [
        { id: "first", type: "human" as const, form_schema: "schema.json" },
      ],
    };
    fixture.step_runs.push({
      id: "sr-first-existing",
      runId: "run-1",
      stepId: "first",
      stepType: "human",
      status: "NeedsInput",
      attempt: 1,
      vars: {},
      startedAt: new Date(0),
    });

    const { client, inserts, updates } = makeFakeDb(fixture);

    await writeArtifact("first", { approved: true });

    // Race two concurrent resume calls. Without the atomic claim,
    // both would load NeedsInput and both would re-execute the step.
    const [a, b] = await Promise.allSettled([
      runFlow("run-1", { db: client, runtimeRoot }),
      runFlow("run-1", { db: client, runtimeRoot }),
    ]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");

    const statusUpdates = updates
      .filter((u) => u.table === "runs" && "status" in u.set)
      .map((u) => u.set.status);

    // Exactly one NeedsInput→Running transition must occur. The
    // losing claimant must NOT issue an UPDATE (so the count of
    // transition rows is the number of distinct winning claims).
    expect(statusUpdates.filter((s) => s === "Running")).toHaveLength(1);

    // The losing claimant must NOT have inserted a fresh step_run
    // row either — the winning side reuses the existing NeedsInput
    // row, the loser exits before any step work happens.
    const stepRunInserts = inserts.filter((i) => i.table === "step_runs");

    expect(stepRunInserts.length).toBeLessThanOrEqual(0);
  });
});
