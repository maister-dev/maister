import type {
  Run as RunRow,
  Task as TaskRow,
  ArtifactInstance as ArtifactInstanceRow,
} from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { buildContext } from "@/lib/flows/context";
import { renderStrict } from "@/lib/flows/templating";
import { isMaisterError } from "@/lib/errors";

const task: Pick<TaskRow, "id" | "title" | "prompt" | "attemptNumber"> = {
  id: "task-1",
  title: "Test Artifacts",
  prompt: "Do the thing",
  attemptNumber: 1,
};

const run: Pick<RunRow, "id"> = { id: "run-1" };

const executor = {
  id: "exec-1",
  agent: "claude",
  model: "claude-sonnet-4-6",
  router: null,
} as const;

function makeArtifactInstance(
  partial: Partial<ArtifactInstanceRow> & {
    artifactDefId: string;
    kind: string;
    validity: string;
  },
): ArtifactInstanceRow {
  return {
    id: `artifact-${partial.artifactDefId}`,
    runId: "run-1",
    nodeAttemptId: null,
    nodeId: partial.nodeId ?? undefined,
    attempt: partial.attempt ?? 1,
    producer: "runner",
    locator: { kind: "file", path: "tmp" },
    uri: `file:///tmp/${partial.artifactDefId}.txt`,
    hash: null,
    sizeBytes: null,
    requiredFor: null,
    visibility: "internal",
    retention: "run",
    monotonicId: null,
    supersededById: null,
    createdAt: new Date(),
    // partial spreads last so callers can override any field (including uri, nodeId, etc.)
    ...partial,
  } as ArtifactInstanceRow;
}

describe("buildContext — artifacts namespace (T3.4)", () => {
  it("builds artifacts namespace from artifact_instances rows, keyed by artifactDefId", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "impl-diff",
        kind: "diff",
        uri: "file:///runs/run-1/impl.diff",
        validity: "current",
        nodeId: "implement",
      }),
      makeArtifactInstance({
        artifactDefId: "test-report",
        kind: "test_report",
        uri: "file:///runs/run-1/junit.xml",
        validity: "current",
        nodeId: "test",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    expect(ctx.artifacts).toBeDefined();
    expect(ctx.artifacts["impl-diff"]).toBeDefined();
    expect(ctx.artifacts["impl-diff"].kind).toBe("diff");
    expect(ctx.artifacts["impl-diff"].uri).toBe("file:///runs/run-1/impl.diff");
    expect(ctx.artifacts["impl-diff"].validity).toBe("current");
    expect(ctx.artifacts["impl-diff"].nodeId).toBe("implement");
  });

  it("resolves highest-validity artifact when multiple rows exist for the same artifactDefId", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "shared-diff",
        kind: "diff",
        uri: "file:///runs/run-1/old.diff",
        validity: "superseded",
        nodeId: "impl-v1",
      }),
      makeArtifactInstance({
        artifactDefId: "shared-diff",
        kind: "diff",
        uri: "file:///runs/run-1/new.diff",
        validity: "current",
        nodeId: "impl-v2",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    // CURRENT should win over SUPERSEDED
    expect(ctx.artifacts["shared-diff"].uri).toBe(
      "file:///runs/run-1/new.diff",
    );
    expect(ctx.artifacts["shared-diff"].validity).toBe("current");
    expect(ctx.artifacts["shared-diff"].nodeId).toBe("impl-v2");
  });

  it("renders artifacts namespace via renderStrict (artifacts.<id>.kind)", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "plan-doc",
        kind: "generic_file",
        uri: "file:///runs/run-1/plan.md",
        validity: "current",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    const rendered = renderStrict("{{ artifacts.plan-doc.kind }}", ctx);

    expect(rendered).toBe("generic_file");
  });

  it("renders artifacts.<id>.uri via renderStrict", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "results",
        kind: "test_report",
        uri: "s3://bucket/results.json",
        validity: "current",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    const rendered = renderStrict(
      "Results at {{ artifacts.results.uri }}",
      ctx,
    );

    expect(rendered).toBe("Results at s3://bucket/results.json");
  });

  it("renders artifacts.<id>.validity via renderStrict", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "old-logs",
        kind: "log",
        uri: "file:///old.log",
        validity: "stale",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    const rendered = renderStrict(
      "Status: {{ artifacts.old-logs.validity }}",
      ctx,
    );

    expect(rendered).toBe("Status: stale");
  });

  it("renders artifacts.<id>.nodeId via renderStrict", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "impl-diff",
        kind: "diff",
        uri: "file:///impl.diff",
        validity: "current",
        nodeId: "implement",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    const rendered = renderStrict(
      "Produced by: {{ artifacts.impl-diff.nodeId }}",
      ctx,
    );

    expect(rendered).toBe("Produced by: implement");
  });

  it("throws MaisterError(CONFIG) on undefined artifact id in template", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "exists",
        kind: "diff",
        uri: "file:///exists.diff",
        validity: "current",
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    try {
      renderStrict("{{ artifacts.nonexistent.uri }}", ctx);
      throw new Error("expected throw on undefined artifact id");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect(err).toHaveProperty("code", "CONFIG");
      expect(String(err)).toMatch(/artifacts\.nonexistent/);
    }
  });

  it("throws MaisterError(CONFIG) on undefined artifact field in template", () => {
    const artifacts: ArtifactInstanceRow[] = [
      makeArtifactInstance({
        artifactDefId: "impl",
        kind: "diff",
        uri: "file:///impl.diff",
        validity: "current",
        nodeId: undefined,
      }),
    ];

    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts,
    });

    try {
      renderStrict("{{ artifacts.impl.nodeId }}", ctx);
      throw new Error("expected throw on undefined artifact field");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect(err).toHaveProperty("code", "CONFIG");
      expect(String(err)).toMatch(/artifacts\.impl\.nodeId/);
    }
  });

  it("ignores artifacts param when undefined (backward compat)", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      // artifacts: undefined (omitted)
    });

    expect(ctx.artifacts).toEqual({});
  });

  it("empty artifacts array produces empty artifacts namespace", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [],
    });

    expect(ctx.artifacts).toEqual({});
  });
});

describe("buildContext — artifact body content (ADR-120, P2)", () => {
  const planRow = makeArtifactInstance({
    artifactDefId: "plan",
    kind: "plan",
    uri: "file:///runs/run-1/plan.md",
    validity: "current",
    nodeId: "plan-node",
  });

  it("attaches .content (+ .contentTruncated) when artifactContents has the id", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
      artifactContents: {
        plan: { text: "# The Plan\nstep 1", truncated: false },
      },
    });

    expect(ctx.artifacts.plan.content).toBe("# The Plan\nstep 1");
    expect(ctx.artifacts.plan.contentTruncated).toBe(false);
  });

  it("marks contentTruncated true when the body was capped", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
      artifactContents: { plan: { text: "cut…", truncated: true } },
    });

    expect(ctx.artifacts.plan.contentTruncated).toBe(true);
  });

  it("leaves .content undefined when artifactContents lacks the id", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
      // no artifactContents
    });

    expect(ctx.artifacts.plan.content).toBeUndefined();
  });

  it("attaches content only to the current-wins row for the id", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [
        makeArtifactInstance({
          artifactDefId: "plan",
          kind: "plan",
          uri: "file:///old.md",
          validity: "superseded",
          nodeId: "old",
        }),
        makeArtifactInstance({
          artifactDefId: "plan",
          kind: "plan",
          uri: "file:///new.md",
          validity: "current",
          nodeId: "new",
        }),
      ],
      artifactContents: { plan: { text: "NEW BODY", truncated: false } },
    });

    expect(ctx.artifacts.plan.nodeId).toBe("new");
    expect(ctx.artifacts.plan.content).toBe("NEW BODY");
  });

  it("renders {{ artifacts.<id>.content }} via renderStrict", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
      artifactContents: { plan: { text: "BODY-HERE", truncated: false } },
    });

    expect(renderStrict("Plan:\n{{ artifacts.plan.content }}", ctx)).toBe(
      "Plan:\nBODY-HERE",
    );
  });

  it("a bare {{ content }} for an unresolved id throws CONFIG (strict)", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
      // no artifactContents → .content undefined
    });

    try {
      renderStrict("{{ artifacts.plan.content }}", ctx);
      throw new Error("expected CONFIG throw on undefined content");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect(err).toHaveProperty("code", "CONFIG");
    }
  });

  it("renders a ?? default when content is absent (guarded form)", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
    });

    expect(renderStrict("{{ artifacts.plan.content ?? 'none' }}", ctx)).toBe(
      "none",
    );
  });

  it("mustache re-render invariant: a body containing {{ }} renders VERBATIM", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
      artifacts: [planRow],
      artifactContents: {
        plan: { text: "see {{ task.prompt }} for details", truncated: false },
      },
    });

    // The injected value is substituted literally — the braces are NOT
    // re-processed against the context (no recursion).
    expect(renderStrict("{{ artifacts.plan.content }}", ctx)).toBe(
      "see {{ task.prompt }} for details",
    );
  });
});
