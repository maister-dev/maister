/**
 * M27/T-B5 (≡ C8b(1), ADR-069): the runner pins its capability universe to the
 * launch-frozen `runs.resolved_capability_set` snapshot instead of re-reading
 * the live catalog, so an edit/publish mid-run cannot change what the run
 * materializes (in-flight immutability). `pinCatalogToSnapshot` keeps only the
 * live records whose (kind, refId, scope) matches a frozen winner; a null
 * snapshot (legacy/pre-C8a run) falls back to the live catalog unchanged.
 */
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import {
  buildResolvedCapabilitySet,
  pinCatalogToSnapshot,
} from "@/lib/capabilities/resolver";

type Rec = { kind: string; capabilityRefId: string; source: string };

const rec = (kind: string, refId: string, source: string): Rec => ({
  kind,
  capabilityRefId: refId,
  source,
});

const snapshot = (
  capabilities: ResolvedCapabilitySet["capabilities"],
  mcps: ResolvedCapabilitySet["mcps"],
): ResolvedCapabilitySet => ({
  flowRevisionId: "rev-1",
  flowOrigin: "git",
  capabilities,
  mcps,
});

describe("buildResolvedCapabilitySet — capability scope (B5)", () => {
  it("records the winning scope on capability AND mcp entries", () => {
    const set = buildResolvedCapabilitySet({
      records: [
        {
          capabilityRefId: "lint",
          kind: "skill",
          source: "project",
          revision: "a",
        },
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "flow-package",
          revision: "b",
        },
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "authored",
    });

    expect(set.capabilities).toEqual([
      { refId: "lint", kind: "skill", sha: "a", scope: "project" },
    ]);
    expect(set.mcps).toEqual([
      { refId: "github", sha: "b", scope: "flow-package" },
    ]);
  });

  it("keeps the local-first winner's scope when an id appears at two scopes", () => {
    const set = buildResolvedCapabilitySet({
      records: [
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "flow-package",
          revision: "old",
        },
        {
          capabilityRefId: "github",
          kind: "mcp",
          source: "project",
          revision: "new",
        },
      ],
      flowRevisionId: "rev-1",
      flowOrigin: "git",
    });

    expect(set.mcps).toEqual([
      { refId: "github", sha: "new", scope: "project" },
    ]);
  });
});

describe("pinCatalogToSnapshot (B5)", () => {
  it("returns the live catalog unchanged when the snapshot is null (legacy run)", () => {
    const live = [rec("mcp", "github", "project")];

    expect(pinCatalogToSnapshot(live, null)).toBe(live);
    expect(pinCatalogToSnapshot(live, undefined)).toBe(live);
  });

  it("keeps only records whose (kind, refId, scope) matches a frozen winner", () => {
    const live = [
      rec("mcp", "github", "flow-package"),
      rec("skill", "lint", "project"),
      rec("rule", "stray", "platform"),
    ];
    const snap = snapshot(
      [{ refId: "lint", kind: "skill", sha: null, scope: "project" }],
      [{ refId: "github", sha: null, scope: "flow-package" }],
    );

    expect(pinCatalogToSnapshot(live, snap)).toEqual([
      rec("mcp", "github", "flow-package"),
      rec("skill", "lint", "project"),
    ]);
  });

  it("excludes a same-id record added at a higher-precedence scope mid-run", () => {
    // Launch froze github@flow-package; a project github appears after launch.
    const live = [
      rec("mcp", "github", "flow-package"),
      rec("mcp", "github", "project"),
    ];
    const snap = snapshot(
      [],
      [{ refId: "github", sha: null, scope: "flow-package" }],
    );

    expect(pinCatalogToSnapshot(live, snap)).toEqual([
      rec("mcp", "github", "flow-package"),
    ]);
  });

  it("excludes a wholly new ref that was not in the frozen set", () => {
    const live = [
      rec("mcp", "github", "project"),
      rec("mcp", "added-after-launch", "project"),
    ];
    const snap = snapshot(
      [],
      [{ refId: "github", sha: null, scope: "project" }],
    );

    expect(pinCatalogToSnapshot(live, snap)).toEqual([
      rec("mcp", "github", "project"),
    ]);
  });

  it("yields nothing for a frozen winner whose live record was removed", () => {
    const snap = snapshot([], [{ refId: "gone", sha: null, scope: "project" }]);

    expect(pinCatalogToSnapshot([], snap)).toEqual([]);
  });
});
