import type { FlowContext } from "@/lib/flows/types";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assignmentEvents as assignmentEventsTable,
  assignments as assignmentsTable,
  hitlRequests as hitlRequestsTable,
  runs as runsTable,
} from "@/lib/db/schema";
import { runHumanStep } from "@/lib/flows/runner-human";

let runtimeRoot: string;
let flowInstallPath: string;
const inserted: Array<Record<string, unknown>> = [];

type FakeTableName =
  | "hitl_requests"
  | "runs"
  | "assignments"
  | "assignment_events";

function tableOf(table: unknown): FakeTableName {
  if (table === hitlRequestsTable) return "hitl_requests";
  if (table === runsTable) return "runs";
  if (table === assignmentsTable) return "assignments";
  if (table === assignmentEventsTable) return "assignment_events";

  throw new Error("unknown table");
}

function insertChain(table: unknown) {
  const name = tableOf(table);

  return {
    values: (row: Record<string, unknown>) => {
      if (name === "hitl_requests") {
        inserted.push(row);
      }

      const persisted =
        name === "assignments"
          ? {
              ...row,
              projectId: row.projectId ?? "proj-1",
              runId: row.runId ?? "run-1",
            }
          : row;
      const result: any = Promise.resolve(undefined);

      result.onConflictDoUpdate = () => result;
      result.returning = async () => [persisted];

      return result;
    },
  };
}

function selectChain() {
  return {
    from: (table: unknown) => ({
      where: () => {
        const name = tableOf(table);
        const rows =
          name === "runs" ? [{ projectId: "proj-1", taskId: null }] : [];
        const result: any = Promise.resolve(rows);

        result.limit = async () => rows;

        return result;
      },
    }),
  };
}

const fakeDb = {
  insert: insertChain,
  select: selectChain,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    await fn({
      insert: insertChain,
      select: selectChain,
    }),
};

const ctxBase = (overrides: Partial<FlowContext> = {}): FlowContext => ({
  task: { id: "t1", title: "T", prompt: "hi", attemptNumber: 1 },
  run: { id: "run-1", attemptNumber: 1, projectSlug: "demo" },
  executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
  steps: {},
  env: {},
  artifacts: {},
  ...overrides,
});

async function writeSchema(): Promise<string> {
  const schemaPath = join(flowInstallPath, "schema.json");

  await writeFile(
    schemaPath,
    JSON.stringify({
      schemaVersion: 1,
      fields: [{ name: "approved", type: "boolean" }],
    }),
  );

  return "schema.json";
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "runner-human-rt-"));
  flowInstallPath = await mkdtemp(join(tmpdir(), "runner-human-flow-"));
  inserted.length = 0;
  vi.restoreAllMocks();
});

afterEach(async () => {
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(flowInstallPath, { recursive: true, force: true });
});

describe("runHumanStep — first pass", () => {
  it("writes needs-input.json and inserts a hitl_requests row with kind=form when on_reject is unset", async () => {
    const formSchema = await writeSchema();
    const result = await runHumanStep(
      { id: "review", type: "human", form_schema: formSchema },
      {
        runtimeRoot,
        projectSlug: "demo",
        runId: "run-1",
        stepId: "review",
        flowInstallPath,
        context: ctxBase(),
        db: fakeDb,
      },
    );

    expect(result.needsInput).toBe(true);
    expect(result.ok).toBe(false);

    const needsInputPath = join(
      runtimeRoot,
      ".maister",
      "demo",
      "runs",
      "run-1",
      "needs-input.json",
    );
    const raw = await readFile(needsInputPath, "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.stepId).toBe("review");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.on_reject).toBeNull();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      runId: "run-1",
      stepId: "review",
      kind: "form",
    });
  });

  it("inserts kind=human when on_reject is present", async () => {
    const formSchema = await writeSchema();

    await runHumanStep(
      {
        id: "review",
        type: "human",
        form_schema: formSchema,
        on_reject: { goto_step: "plan" },
      },
      {
        runtimeRoot,
        projectSlug: "demo",
        runId: "run-1",
        stepId: "review",
        flowInstallPath,
        context: ctxBase(),
        db: fakeDb,
      },
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].kind).toBe("human");
  });
});

describe("runHumanStep — resume from existing input artifact", () => {
  it("returns vars from the artifact and skips needs-input.json + hitl_requests insert", async () => {
    const formSchema = await writeSchema();
    const artifactDir = join(runtimeRoot, ".maister", "demo", "runs", "run-1");

    await mkdir(artifactDir, { recursive: true });
    const payload = { approved: true, comments: "looks good" };

    await writeFile(
      join(artifactDir, "input-review.json"),
      JSON.stringify(payload),
    );

    const result = await runHumanStep(
      { id: "review", type: "human", form_schema: formSchema },
      {
        runtimeRoot,
        projectSlug: "demo",
        runId: "run-1",
        stepId: "review",
        flowInstallPath,
        context: ctxBase(),
        db: fakeDb,
      },
    );

    expect(result.needsInput).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.vars).toEqual(payload);
    expect(inserted).toHaveLength(0);
  });

  it("throws MaisterError(CONFIG) when the artifact is malformed JSON", async () => {
    const formSchema = await writeSchema();
    const artifactDir = join(runtimeRoot, ".maister", "demo", "runs", "run-1");

    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "input-review.json"), "{not valid json");

    await expect(
      runHumanStep(
        { id: "review", type: "human", form_schema: formSchema },
        {
          runtimeRoot,
          projectSlug: "demo",
          runId: "run-1",
          stepId: "review",
          flowInstallPath,
          context: ctxBase(),
          db: fakeDb,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
