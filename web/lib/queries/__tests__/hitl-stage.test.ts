import { beforeEach, describe, expect, it, vi } from "vitest";

const { compileManifest, resolveManifest } = vi.hoisted(() => ({
  compileManifest: vi.fn(),
  resolveManifest: vi.fn(),
}));

vi.mock("@/lib/flows/graph/compile", () => ({ compileManifest }));
vi.mock("@/lib/flows/graph/current-node-kind", () => ({ resolveManifest }));

import { resolveStages, type StageInput } from "@/lib/queries/hitl-stage";

function graphWith(nodeTypes: Record<string, string>) {
  return {
    nodes: new Map(
      Object.entries(nodeTypes).map(([id, nodeType]) => [id, { nodeType }]),
    ),
  };
}

const fakeDb = {} as Parameters<typeof resolveStages>[0];

describe("resolveStages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the node type from the compiled graph (label = step_id)", async () => {
    resolveManifest.mockResolvedValue({ nodes: [] });
    compileManifest.mockReturnValue(graphWith({ review: "human" }));

    const out = await resolveStages(fakeDb, [
      {
        hitlRequestId: "h1",
        stepId: "review",
        flowRevisionId: "rev1",
        flowId: null,
      },
    ]);

    expect(out.get("h1")).toEqual({ label: "review", type: "human" });
  });

  it("compiles each distinct flow revision at most once (no N+1)", async () => {
    resolveManifest.mockResolvedValue({ nodes: [] });
    compileManifest.mockReturnValue(graphWith({ a: "ai_coding", b: "judge" }));

    const rows: StageInput[] = [
      {
        hitlRequestId: "h1",
        stepId: "a",
        flowRevisionId: "rev1",
        flowId: null,
      },
      {
        hitlRequestId: "h2",
        stepId: "b",
        flowRevisionId: "rev1",
        flowId: null,
      },
      {
        hitlRequestId: "h3",
        stepId: "a",
        flowRevisionId: "rev2",
        flowId: null,
      },
    ];

    await resolveStages(fakeDb, rows);

    expect(resolveManifest).toHaveBeenCalledTimes(2);
    expect(compileManifest).toHaveBeenCalledTimes(2);
  });

  it("degrades an unresolved step_id to a null type", async () => {
    resolveManifest.mockResolvedValue({ nodes: [] });
    compileManifest.mockReturnValue(graphWith({ other: "cli" }));

    const out = await resolveStages(fakeDb, [
      {
        hitlRequestId: "h1",
        stepId: "missing",
        flowRevisionId: "rev1",
        flowId: null,
      },
    ]);

    expect(out.get("h1")).toEqual({ label: "missing", type: null });
  });

  it("falls back to a null type when no manifest resolves (legacy)", async () => {
    resolveManifest.mockResolvedValue(null);

    const out = await resolveStages(fakeDb, [
      {
        hitlRequestId: "h1",
        stepId: "step1",
        flowRevisionId: null,
        flowId: null,
      },
    ]);

    expect(out.get("h1")).toEqual({ label: "step1", type: null });
    expect(compileManifest).not.toHaveBeenCalled();
  });
});
