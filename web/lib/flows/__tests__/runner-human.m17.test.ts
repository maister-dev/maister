import { describe, expect, it, vi } from "vitest";

/**
 * M17 ADR-054: criticality creation-path tests for linear human steps
 * Verify that criticality is written ONCE at hitl_requests INSERT and never updated.
 */

import { runHumanStep } from "@/lib/flows/runner-human";

// Capture INSERT values for assertion.
const capturedInserts: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        capturedInserts.push(row);

        return Promise.resolve();
      },
    }),
    // T7: runHumanStep now resolves projectId via a runs PK lookup for the
    // hitl.requested emit — return a projectId-bearing row so the emit rides it.
    select: () => ({
      from: () => ({ where: async () => [{ projectId: "proj-1" }] }),
    }),
  }),
}));

vi.mock("@/lib/assignments/service", () => ({
  createHitlAssignmentForRun: vi.fn(async () => {}),
}));

vi.mock("@/lib/config", () => ({
  validateFormSchemaVersion: vi.fn(),
  readAndValidateFormSchemaDoc: vi.fn(async () => ({
    schemaVersion: 1,
    fields: [],
  })),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...real,
    readFile: vi.fn(async (p: string) => {
      // Input artifact paths (inside runs/) must not exist → fresh creation.
      if (String(p).includes("/runs/")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      // Form schema files return a valid empty schema.
      if (String(p).endsWith(".json")) {
        return JSON.stringify({ schemaVersion: 1, fields: [] });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    realpath: vi.fn(async (p: string) => p),
    unlink: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/atomic", () => ({
  atomicWriteJson: vi.fn(async () => {}),
}));

const baseCtx: any = {
  runtimeRoot: "/tmp/test-root",
  projectSlug: "test-project",
  runId: "run-1",
  stepId: "review",
  flowInstallPath: "/flows/test",
  context: {},
};

describe("runHumanStep — M17 criticality field", () => {
  it("writes criticality: 'high' from step config to hitl_requests row", async () => {
    capturedInserts.length = 0;
    const step = {
      id: "review",
      type: "human" as const,
      form_schema: "schemas/review.json",
      criticality: "high" as const,
    };

    await runHumanStep(step, baseCtx);

    const inserted = capturedInserts.find(
      (r) => r.kind === "form" || r.kind === "human",
    );

    expect(inserted?.criticality).toBe("high");
  });

  it("writes criticality: 'low' from step config to hitl_requests row", async () => {
    capturedInserts.length = 0;
    const step = {
      id: "review",
      type: "human" as const,
      form_schema: "schemas/review.json",
      criticality: "low" as const,
    };

    await runHumanStep(step, baseCtx);

    const inserted = capturedInserts.find(
      (r) => r.kind === "form" || r.kind === "human",
    );

    expect(inserted?.criticality).toBe("low");
  });

  it("writes criticality: 'medium' from step config to hitl_requests row", async () => {
    capturedInserts.length = 0;
    const step = {
      id: "review",
      type: "human" as const,
      form_schema: "schemas/review.json",
      criticality: "medium" as const,
    };

    await runHumanStep(step, baseCtx);

    const inserted = capturedInserts.find(
      (r) => r.kind === "form" || r.kind === "human",
    );

    expect(inserted?.criticality).toBe("medium");
  });

  it("writes criticality: 'critical' from step config to hitl_requests row", async () => {
    capturedInserts.length = 0;
    const step = {
      id: "review",
      type: "human" as const,
      form_schema: "schemas/review.json",
      criticality: "critical" as const,
    };

    await runHumanStep(step, baseCtx);

    const inserted = capturedInserts.find(
      (r) => r.kind === "form" || r.kind === "human",
    );

    expect(inserted?.criticality).toBe("critical");
  });

  it("writes NULL criticality when step has no criticality field", async () => {
    capturedInserts.length = 0;
    const step = {
      id: "review",
      type: "human" as const,
      form_schema: "schemas/review.json",
    };

    await runHumanStep(step, baseCtx);

    const inserted = capturedInserts.find(
      (r) => r.kind === "form" || r.kind === "human",
    );

    expect(inserted?.criticality).toBeNull();
  });

  it("criticality is write-once: a second HITL raise on same step creates new row", async () => {
    capturedInserts.length = 0;
    const step = {
      id: "review",
      type: "human" as const,
      form_schema: "schemas/review.json",
      criticality: "high" as const,
    };

    await runHumanStep(step, baseCtx);
    await runHumanStep(step, { ...baseCtx, runId: "run-2" });

    const hitlInserts = capturedInserts.filter(
      (r) => r.kind === "form" || r.kind === "human",
    );

    expect(hitlInserts).toHaveLength(2);
    expect(hitlInserts[0]?.criticality).toBe("high");
    expect(hitlInserts[1]?.criticality).toBe("high");
  });
});
