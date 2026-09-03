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
 * The decisive assertions run the REAL acceptor: `StartSessionRequestSchema` is
 * imported straight out of `supervisor/src/types.ts` (it depends on nothing but
 * `node:path` + `zod`, and both packages pin the same zod), so a change to
 * `ContextMountSchema` fails THIS test rather than only production. A mirrored
 * hand-copy would have been the weaker guard — it can agree with itself forever
 * while drifting from the schema it claims to describe.
 */
import { describe, expect, it } from "vitest";

// The one deliberate cross-package import in the web suite. Not an accident and
// not a layering violation to be "tidied": a contract test that does not execute
// the real acceptor cannot detect drift, which is the entire failure mode that
// let this bug through two green suites.
import { StartSessionRequestSchema } from "../../../../supervisor/src/types";

import {
  CONTEXT_REPOS_MAX,
  contextMountsToWire,
  type ContextMountSnapshot,
} from "@/lib/context-mounts/types";

// supervisor/src/types.ts → ContextMountSchema
const SUPERVISOR_WIRE_KEYS = ["slug", "path", "ref", "commit"] as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The minimum StartSessionRequest the schema accepts, so `contextMounts` is the
// only field under test.
const BASE_REQUEST = {
  runId: "run-1",
  projectSlug: "web-app",
  worktreePath: "/runtime/worktrees/web-app/run-1",
  stepId: "implement",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
};

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

  // Deliberately makes NO claim about the cap — the bound coupling is the
  // CONTEXT_REPOS_MAX-driven case below. A name asserting "the supervisor caps at
  // 8" would go stale into a lie the moment either bound moved, while still
  // passing: the same defect as an assertion that never executes what it claims.
  it("preserves order and cardinality across the projection", () => {
    const many = Array.from({ length: 3 }, (_, i) =>
      snapshot({ slug: `sib-${i}`, mountPath: `/abs/sib-${i}` }),
    );
    const wire = contextMountsToWire(many);

    expect(wire).toHaveLength(many.length);
    expect(wire.map((m) => m.slug)).toEqual(many.map((m) => m.slug));
  });

  it("maps an empty snapshot to an empty array", () => {
    expect(contextMountsToWire([])).toEqual([]);
  });
});

describe("the REAL supervisor acceptor (StartSessionRequestSchema)", () => {
  it("REJECTS a raw snapshot — the shipped bug, pinned so it cannot return", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...BASE_REQUEST,
      contextMounts: [snapshot()],
    });

    expect(result.success).toBe(false);

    const issues = result.success ? [] : result.error.issues;
    const paths = issues.map((i) => i.path.join("."));

    // Missing the two renamed fields…
    expect(paths).toContain("contextMounts.0.path");
    expect(paths).toContain("contextMounts.0.commit");
    // …and `.strict()` rejects every snapshot-only key.
    const unrecognized = issues.find((i) => i.code === "unrecognized_keys");

    expect(unrecognized).toBeDefined();
    expect(
      (unrecognized as { keys?: string[] } | undefined)?.keys?.sort(),
    ).toEqual(["committish", "mountPath", "projectId", "repoPath"]);
  });

  it("ACCEPTS the mapped wire payload", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...BASE_REQUEST,
      contextMounts: contextMountsToWire([snapshot()]),
    });

    expect(result.success).toBe(true);
  });

  // The mount cap is enforced TWICE across a package boundary: web
  // `CONTEXT_REPOS_MAX` (imported by config.schema.ts, so the web side is DRY)
  // and the supervisor's hardcoded `.max(8)`, which imports nothing from web.
  // Driving both cases off CONTEXT_REPOS_MAX — never a literal 8 — is what makes
  // this catch drift in BOTH directions: raising the web constant alone fails the
  // accept case (the supervisor rejects the extra mounts), and raising the
  // supervisor bound alone fails the reject case.
  it("ACCEPTS exactly CONTEXT_REPOS_MAX mapped mounts and REJECTS one more", () => {
    const mounts = (n: number) =>
      contextMountsToWire(
        Array.from({ length: n }, (_, i) =>
          snapshot({ slug: `sib-${i}`, mountPath: `/abs/sib-${i}` }),
        ),
      );

    expect(
      StartSessionRequestSchema.safeParse({
        ...BASE_REQUEST,
        contextMounts: mounts(CONTEXT_REPOS_MAX),
      }).success,
    ).toBe(true);
    expect(
      StartSessionRequestSchema.safeParse({
        ...BASE_REQUEST,
        contextMounts: mounts(CONTEXT_REPOS_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("stays valid with no mounts at all (existing senders unaffected)", () => {
    expect(StartSessionRequestSchema.safeParse(BASE_REQUEST).success).toBe(
      true,
    );
  });
});
