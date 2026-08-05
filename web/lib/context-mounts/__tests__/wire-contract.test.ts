/**
 * ADR-157: the web→supervisor wire contract for context mounts.
 *
 * This test exists because the bug it pins actually shipped into the branch: the
 * launch snapshot (`{projectId, slug, repoPath, mountPath, committish}`) was
 * threaded onto `POST /sessions` verbatim, while the supervisor's
 * `ContextMountSchema` (`supervisor/src/types.ts`) is `.strict()` and names its
 * fields `{slug, path, ref, commit}`. Every mount-bearing launch would have 400'd.
 * The flow/agent integration suites could not catch it — they use a stub
 * SupervisorApi that never validates the payload.
 *
 * The assertions below MIRROR the supervisor schema. They are duplicated on
 * purpose: the web suite never collects `supervisor/src/**`, so a cross-package
 * import is not available. If `ContextMountSchema` changes, this test must change
 * with it — that coupling is the point.
 */
import { describe, expect, it } from "vitest";

import {
  contextMountsToWire,
  type ContextMountSnapshot,
} from "@/lib/context-mounts/types";

// supervisor/src/types.ts → ContextMountSchema
const SUPERVISOR_WIRE_KEYS = ["slug", "path", "ref", "commit"] as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function snapshot(
  overrides: Partial<ContextMountSnapshot> = {},
): ContextMountSnapshot {
  return {
    projectId: "11111111-2222-3333-4444-555555555555",
    slug: "api-contracts",
    repoPath: "/repos/api-contracts",
    mountPath: "/runtime/.maister/web-app/runs/run-1/context/api-contracts",
    committish: "a".repeat(40),
    ref: "main",
    ...overrides,
  };
}

describe("contextMountsToWire — supervisor POST /sessions contract", () => {
  it("emits EXACTLY the supervisor's four keys and drops every snapshot-only field", () => {
    const [wire] = contextMountsToWire([snapshot()]);

    // `.strict()` on the supervisor side: an extra key is a hard rejection, so
    // this is an exact-set assertion, not a superset one.
    expect(Object.keys(wire).sort()).toEqual([...SUPERVISOR_WIRE_KEYS].sort());
    expect(wire).toEqual({
      slug: "api-contracts",
      path: "/runtime/.maister/web-app/runs/run-1/context/api-contracts",
      ref: "main",
      commit: "a".repeat(40),
    });
    // The snapshot-only fields must never reach the wire.
    for (const leaked of ["projectId", "repoPath", "mountPath", "committish"]) {
      expect(wire).not.toHaveProperty(leaked);
    }
  });

  it("maps mountPath→path and committish→commit (the fields the bug got wrong)", () => {
    const [wire] = contextMountsToWire([
      snapshot({ mountPath: "/abs/mount", committish: "b".repeat(64) }),
    ]);

    expect(wire.path).toBe("/abs/mount");
    expect(wire.commit).toBe("b".repeat(64));
  });

  it("keeps ref distinct from commit so the preamble reports the ref asked for", () => {
    const [wire] = contextMountsToWire([
      snapshot({ ref: "release/2026-08", committish: "c".repeat(40) }),
    ]);

    expect(wire.ref).toBe("release/2026-08");
    expect(wire.commit).toBe("c".repeat(40));
    expect(wire.ref).not.toBe(wire.commit);
  });

  it("falls back to the commit when a pre-`ref` snapshot row has none", () => {
    const legacy = snapshot();

    delete legacy.ref;

    const [wire] = contextMountsToWire([legacy]);

    // Lossy but in-contract: `ref` is required and min(1) on the supervisor side,
    // so a legacy row must still produce a non-empty value.
    expect(wire.ref).toBe(legacy.committish);
    expect(wire.ref.length).toBeGreaterThan(0);
  });

  it("satisfies the supervisor's per-field constraints", () => {
    const wire = contextMountsToWire([
      snapshot(),
      snapshot({ slug: "b2", mountPath: "/abs/b2", committish: "d".repeat(7) }),
    ]);

    for (const mount of wire) {
      expect(mount.slug).toMatch(SLUG_RE); // kebab-case, 1..64
      expect(mount.slug.length).toBeLessThanOrEqual(64);
      expect(mount.path.startsWith("/")).toBe(true); // worktreePathSchema: absolute
      expect(mount.path).not.toContain("..");
      expect(mount.ref.length).toBeGreaterThanOrEqual(1);
      expect(mount.ref.length).toBeLessThanOrEqual(255);
      expect(mount.commit.length).toBeGreaterThanOrEqual(7); // spec bounds 7..64
      expect(mount.commit.length).toBeLessThanOrEqual(64);
    }
  });

  it("preserves order and cardinality (the supervisor caps at 8)", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      snapshot({ slug: `sib-${i}`, mountPath: `/abs/sib-${i}` }),
    );
    const wire = contextMountsToWire(eight);

    expect(wire).toHaveLength(8);
    expect(wire.map((m) => m.slug)).toEqual(eight.map((m) => m.slug));
  });

  it("maps an empty snapshot to an empty array", () => {
    expect(contextMountsToWire([])).toEqual([]);
  });
});
