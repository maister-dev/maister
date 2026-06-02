import { describe, expect, it } from "vitest";

import {
  artifactInstanceId,
  projectorArtifactId,
} from "@/lib/flows/graph/artifact-store";

describe("artifactInstanceId", () => {
  it("returns run:<nodeAttemptId>:<artifactDefId> when artifactDefId is present", () => {
    expect(
      artifactInstanceId({
        nodeAttemptId: "na-123",
        artifactDefId: "impl-diff",
      }),
    ).toBe("run:na-123:impl-diff");
  });

  it("returns run:<nodeAttemptId>:default:<kind> when only kind is present", () => {
    expect(
      artifactInstanceId({
        nodeAttemptId: "na-456",
        kind: "log",
      }),
    ).toBe("run:na-456:default:log");
  });

  it("prefers artifactDefId over kind when both are provided", () => {
    expect(
      artifactInstanceId({
        nodeAttemptId: "na-789",
        artifactDefId: "my-def",
        kind: "diff",
      }),
    ).toBe("run:na-789:my-def");
  });

  it("returns run:<nodeAttemptId>:default:generic_file when neither artifactDefId nor kind is present", () => {
    expect(
      artifactInstanceId({
        nodeAttemptId: "na-000",
      }),
    ).toBe("run:na-000:default:generic_file");
  });
});

describe("projectorArtifactId", () => {
  it("returns proj:<runId>:<monotonicId>", () => {
    expect(
      projectorArtifactId({
        runId: "run-abc",
        monotonicId: 42,
      }),
    ).toBe("proj:run-abc:42");
  });

  it("handles monotonicId = 0", () => {
    expect(
      projectorArtifactId({
        runId: "run-xyz",
        monotonicId: 0,
      }),
    ).toBe("proj:run-xyz:0");
  });

  it("handles large monotonicIds", () => {
    expect(
      projectorArtifactId({
        runId: "run-large",
        monotonicId: 999999,
      }),
    ).toBe("proj:run-large:999999");
  });
});
