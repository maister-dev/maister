import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { assignments, hitlRequests, runSessions } from "@/lib/db/schema";

describe("database schema shape", () => {
  it("stores durable runner-resolution warnings on run_sessions", () => {
    const columns = getTableColumns(runSessions);

    expect(columns).toHaveProperty("resolutionWarning");
    expect(columns.resolutionWarning.name).toBe("resolution_warning");
  });

  it("models decision requests with direct parent and artifact provenance", () => {
    const columns = getTableColumns(hitlRequests);
    const assignmentColumns = getTableColumns(assignments);

    expect(columns.parentHitlRequestId.name).toBe("parent_hitl_request_id");
    expect(columns.sourceArtifactId.name).toBe("source_artifact_id");
    expect(columns.decisionId.name).toBe("decision_id");
    expect(columns.kind.enumValues).toContain("decision_request");
    expect(assignmentColumns.actionKind.enumValues).toContain(
      "decision_request",
    );
  });
});
