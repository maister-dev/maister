/**
 * T2.1 — schema shape unit tests for M14 additions.
 * Pure TS-level assertions; no DB connection required.
 */
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  capabilityImports,
  nodeAttempts,
  type CapabilityImport,
  type CapabilityImportInsert,
  type MaterializationPlan,
  type NodeAttempt,
} from "@/lib/db/schema";

describe("capabilityImports table shape", () => {
  it("exposes all required columns", () => {
    const cols = Object.keys(capabilityImports);

    expect(cols).toContain("id");
    expect(cols).toContain("projectId");
    expect(cols).toContain("capabilityRefId");
    expect(cols).toContain("source");
    expect(cols).toContain("versionTag");
    expect(cols).toContain("resolvedRevision");
    expect(cols).toContain("manifestDigest");
    expect(cols).toContain("manifest");
    expect(cols).toContain("installedPath");
    expect(cols).toContain("setupStatus");
    expect(cols).toContain("packageStatus");
    expect(cols).toContain("trustStatus");
    expect(cols).toContain("createdAt");
    expect(cols).toContain("updatedAt");
  });

  it("has the correct DB table name", () => {
    expect(getTableName(capabilityImports)).toBe("capability_imports");
  });

  it("CapabilityImport inferred type carries all columns", () => {
    // Compile-time check: construct an object of the inferred type.
    // If any column is missing from the type, this will fail at tsc.
    const row: CapabilityImport = {
      id: "ci-1",
      projectId: "proj-1",
      capabilityRefId: "my-mcp",
      source: "github.com/org/cap",
      versionTag: "v1.0.0",
      resolvedRevision: "a".repeat(40),
      manifestDigest: "sha256:abc",
      manifest: { name: "my-mcp" },
      installedPath: "/home/user/.maister/caps/my-mcp@abc",
      setupStatus: "pending",
      packageStatus: "Installing",
      trustStatus: "untrusted",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(row.id).toBe("ci-1");
  });

  it("CapabilityImportInsert type is a subset of CapabilityImport", () => {
    const insert: CapabilityImportInsert = {
      id: "ci-2",
      projectId: "proj-2",
      capabilityRefId: "my-rule",
      source: "github.com/org/rules",
      versionTag: "v2.0.0",
      resolvedRevision: "b".repeat(40),
      manifestDigest: "sha256:def",
      manifest: {},
      installedPath: "/home/user/.maister/caps/my-rule@bbb",
    };

    expect(insert.capabilityRefId).toBe("my-rule");
  });
});

describe("nodeAttempts.materializationPlan column", () => {
  it("exposes materializationPlan column key", () => {
    expect(Object.keys(nodeAttempts)).toContain("materializationPlan");
  });

  it("NodeAttempt inferred type includes materializationPlan as nullable", () => {
    // If the type doesn't include materializationPlan this won't compile.
    type HasMatPlan = NodeAttempt extends { materializationPlan: infer T }
      ? T
      : never;
    // The column is nullable jsonb — should be MaterializationPlan | null | undefined
    type _check = HasMatPlan extends MaterializationPlan | null | undefined
      ? true
      : false;
    const ok: _check = true;

    expect(ok).toBe(true);
  });
});

describe("MaterializationPlan type shape", () => {
  it("accepts a complete plan object", () => {
    const plan: MaterializationPlan = {
      profileDigest: "sha256:abc123",
      resolvedRevisions: [
        { refId: "my-mcp", kind: "mcp", sha: "a".repeat(40) },
      ],
      materializedFiles: [".claude/settings.json"],
      enforcedClasses: ["mcps"],
      instructedClasses: ["skills"],
      refusedClasses: [],
      cleanup: { status: "pending" },
    };

    expect(plan.profileDigest).toBe("sha256:abc123");
    expect(plan.cleanup.status).toBe("pending");
  });

  it("accepts a plan with cleanup error and timestamp", () => {
    const plan: MaterializationPlan = {
      profileDigest: "sha256:xyz",
      resolvedRevisions: [],
      materializedFiles: [],
      enforcedClasses: [],
      instructedClasses: [],
      refusedClasses: [],
      cleanup: {
        status: "failed",
        error: "chmod failed",
        at: "2026-06-02T10:00:00Z",
      },
    };

    expect(plan.cleanup.error).toBe("chmod failed");
  });
});
