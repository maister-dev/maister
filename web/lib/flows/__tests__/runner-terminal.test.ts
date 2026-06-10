import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actorIdentities as actorIdentitiesTable,
  artifactInstances as artifactInstancesTable,
  assignmentEvents as assignmentEventsTable,
  assignments as assignmentsTable,
  flows as flowsTable,
  hitlRequests as hitlRequestsTable,
  projects as projectsTable,
  runs as runsTable,
  stepRuns as stepRunsTable,
  tasks as tasksTable,
  webhookEvents as webhookEventsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";

// vi.mock is hoisted; declare the spy lazily inside the factory so it
// resolves cleanly. The mock makes runAgentStep return a failing step
// result with errorCode='CRASH', which simulates the
// permission-persistence failure path from pass 2 without wiring a
// full mock-supervisor-api harness.
vi.mock("@/lib/flows/runner-agent", () => ({
  runAgentStep: vi.fn(async () => ({
    ok: false,
    errorCode: "CRASH" as const,
    stdout: "",
    vars: {},
    durationMs: 0,
  })),
}));

vi.mock("@/lib/scheduler", () => ({
  promoteNextPending: vi.fn(async () => null),
}));

// Imported AFTER vi.mock so the mocked runner-agent binding is in
// place when runner.ts is evaluated.
const { runFlow } = await import("@/lib/flows/runner");

type Row = Record<string, unknown>;
type TableRows = {
  runs: Row[];
  tasks: Row[];
  flows: Row[];
  projects: Row[];
  workspaces: Row[];
  step_runs: Row[];
  hitl_requests: Row[];
  assignments: Row[];
  assignment_events: Row[];
  actor_identities: Row[];
  artifact_instances: Row[];
  webhook_events: Row[];
};

function tableNameOf(t: unknown): keyof TableRows {
  if (t === runsTable) return "runs";
  if (t === tasksTable) return "tasks";
  if (t === flowsTable) return "flows";
  if (t === projectsTable) return "projects";
  if (t === workspacesTable) return "workspaces";
  if (t === stepRunsTable) return "step_runs";
  if (t === hitlRequestsTable) return "hitl_requests";
  if (t === assignmentsTable) return "assignments";
  if (t === assignmentEventsTable) return "assignment_events";
  if (t === actorIdentitiesTable) return "actor_identities";
  if (t === artifactInstancesTable) return "artifact_instances";
  if (t === webhookEventsTable) return "webhook_events";
  throw new Error("unknown table");
}

function makeFakeDb(initial: TableRows): {
  client: any;
  updates: Array<{ table: keyof TableRows; set: Row }>;
} {
  const rows = initial;
  const updates: Array<{ table: keyof TableRows; set: Row }> = [];
  const inserts: Array<{ table: keyof TableRows; row: Row }> = [];

  const selectChain = (cols?: Row) => ({
    from: (table: unknown) => {
      const name = tableNameOf(table);
      const project = () =>
        cols
          ? rows[name].map((r) => {
              const out: Row = {};

              for (const k of Object.keys(cols)) out[k] = r[k];

              return out;
            })
          : rows[name];
      const thenable = (rs: Row[]) => {
        const p = Promise.resolve(rs);

        return Object.assign(p, {
          orderBy: () => thenable(rs),
          limit: (n: number) => Promise.resolve(rs.slice(0, n)),
        });
      };

      return {
        where: () => thenable(project()),
        innerJoin: () => ({ where: () => thenable(project()) }),
        orderBy: () => Promise.resolve(project()),
      };
    },
  });
  const insertChain = (table: unknown) => {
    const name = tableNameOf(table);

    return {
      values: (row: Row) => {
        const inserted =
          name === "step_runs"
            ? { stdout: null, vars: {}, exitCode: null, ...row }
            : row;

        inserts.push({ table: name, row: inserted });
        rows[name].push(inserted);

        return Object.assign(Promise.resolve(undefined), {
          onConflictDoUpdate: () => Promise.resolve(undefined),
        });
      },
    };
  };
  const updateChain = (table: unknown) => {
    const name = tableNameOf(table);

    return {
      set: (vals: Row) => ({
        where: () => {
          const affected = [...rows[name]];

          updates.push({ table: name, set: vals });
          for (const r of affected) Object.assign(r, vals);

          return Object.assign(Promise.resolve(undefined), {
            returning: (cols?: Row) =>
              Promise.resolve(
                cols
                  ? affected.map((r) => {
                      const out: Row = {};

                      for (const k of Object.keys(cols)) out[k] = r[k];

                      return out;
                    })
                  : affected,
              ),
          });
        },
      }),
    };
  };
  const client = {
    select: (cols?: Row) => selectChain(cols),
    insert: insertChain,
    update: updateChain,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return await fn({
        select: (cols?: Row) => selectChain(cols),
        insert: insertChain,
        update: updateChain,
      });
    },
  };

  return { client, updates };
}

let runtimeRoot: string;

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "runner-terminal-"));
});

afterEach(async () => {
  await rm(runtimeRoot, { recursive: true, force: true });
});

describe("runFlow terminal-status precedence", () => {
  it("step result errorCode='CRASH' transitions runs.status to 'Crashed' (not 'Failed')", async () => {
    const fixture: TableRows = {
      runs: [
        {
          id: "run-1",
          taskId: "task-1",
          projectId: "proj-1",
          flowId: "flow-1",
          runnerId: "claude-code",
          capabilityAgent: "claude",
          runnerSnapshot: {
            id: "claude-code",
            adapter: "claude",
            capabilityAgent: "claude",
            model: "claude-sonnet-4-6",
            provider: { kind: "anthropic" },
            providerKind: "anthropic",
            permissionPolicy: "default",
            sidecarId: null,
          },
          status: "Running",
          currentStepId: null,
          flowVersion: "v1",
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
          installedPath: "/tmp/test",
          manifest: {
            schemaVersion: 1,
            name: "tf",
            steps: [
              {
                id: "plan",
                type: "agent" as const,
                mode: "new-session" as const,
                prompt: "go",
              },
            ],
          },
          version: "v1",
          revision: "unknown",
        },
      ],
      projects: [{ id: "proj-1", slug: "demo" }],
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
      assignments: [],
      assignment_events: [],
      actor_identities: [],
      artifact_instances: [],
      webhook_events: [],
    };
    const { client, updates } = makeFakeDb(fixture);

    await runFlow("run-1", { db: client, runtimeRoot });

    // Terminal write must hit the Crashed branch — without the
    // precedence fix the runner used to write Failed unconditionally
    // and the CRASH signal from the step result was lost.
    const finalRunsUpdate = updates
      .filter(
        (u) =>
          u.table === "runs" &&
          (u.set.status === "Failed" || u.set.status === "Crashed"),
      )
      .at(-1);

    expect(finalRunsUpdate?.set.status).toBe("Crashed");
  });
});
