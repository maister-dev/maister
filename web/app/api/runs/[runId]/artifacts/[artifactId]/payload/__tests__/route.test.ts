// T6.2 (RED): failing unit tests for
//   GET /api/runs/[runId]/artifacts/[artifactId]/payload.
//
// Contract (module not built yet — RED on the missing `../route` import):
//   GET(req, { params: Promise<{ runId, artifactId }> }) in
//     web/app/api/runs/[runId]/artifacts/[artifactId]/payload/route.ts
//   - auth: requireActiveSession() → projectId from the RUN ROW →
//     requireProjectAction(projectId, "readBoard")  (401 / 403)
//   - load the artifact by (id = artifactId AND run_id = runId); 404 on
//     mismatch (cross-run leak prevention) or absence
//   - dispatch by locator.kind:
//       inline        → 200 text/plain == locator.text
//       gate-verdict  → 200 application/json == gate_results.verdict
//       hitl-response → 200 application/json == hitl_requests.response
//       git-range     → 200 text/plain == diffRange(...) output
//       git-log       → 200 text/plain == logRange(...) output
//       file          → read UNDER the run dir (path-confined):
//                         in-dir file  → 200 contents
//                         traversal     → 404 (never read outside)
//                         deleted file  → 410 (gone)
//
// The `file` cases use REAL fs (a temp MAISTER_RUNTIME_ROOT) — NOT mocked —
// to prove path confinement for real. Everything else mocks the module
// boundary so the route's auth + dispatch is what's under test.

import type { ArtifactInstance } from "@/lib/db/schema";

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  artifactInstances as artifactInstancesTable,
  gateResults as gateResultsTable,
  hitlRequests as hitlRequestsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getRunDetail } from "@/lib/queries/run";
import { diffRange, logRange } from "@/lib/worktree";

const RUN_ID = "run-pl-1";
const SLUG = "proj-pl";
const PROJECT_ID = "project-pl-1";
const WORKTREE_PATH = "/repos/demo/.maister/worktrees/run-pl-1";
const BRANCH = "maister/task-1-attempt-1";
// PR2/F3: git locators store an immutable head SHA distinct from the live
// branch, so the route MUST render against locator.headRef, not detail.branch.
const HEAD_SHA = "9c4e1f0a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e";

type Row = Record<string, unknown>;
type Tables = {
  artifact_instances: Row[];
  gate_results: Row[];
  hitl_requests: Row[];
};

const dbState: { tables: Tables } = {
  tables: { artifact_instances: [], gate_results: [], hitl_requests: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === artifactInstancesTable) return "artifact_instances";
  if (t === gateResultsTable) return "gate_results";
  if (t === hitlRequestsTable) return "hitl_requests";
  throw new Error("unknown table");
}

// A permissive fake: `.where()` returns the full table; the route filters in
// memory (by id+run_id / gateResultId / hitlRequestId). Each test seeds only
// the rows it needs, so returning the whole (tiny) table is sufficient.
const selectChain = () => ({
  from: (table: unknown) => ({
    where: async () => dbState.tables[tableOf(table)],
  }),
});

const fakeDb = { select: selectChain };

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  })),
}));

vi.mock("@/lib/queries/run", () => ({
  getRunDetail: vi.fn(async () => ({
    runId: RUN_ID,
    projectId: PROJECT_ID,
    projectSlug: SLUG,
    status: "Review",
    currentStepId: null,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    agent: "claude",
    pendingHitl: null,
    takeoverOwnerUserId: null,
  })),
}));

vi.mock("@/lib/worktree", () => ({
  diffRange: vi.fn(async () => "diff --git a/x b/x\n+added\n"),
  logRange: vi.fn(async () => "abc1234 commit one\n"),
}));

let runtimeRoot: string;
const ORIGINAL_RUNTIME_ROOT = process.env.MAISTER_RUNTIME_ROOT;

function runDir(): string {
  return join(runtimeRoot, ".maister", SLUG, "runs", RUN_ID);
}

function seedArtifact(
  overrides: Partial<ArtifactInstance> & {
    locator: ArtifactInstance["locator"];
  },
  runId: string = RUN_ID,
): string {
  const id = (overrides.id as string) ?? "art-1";

  dbState.tables.artifact_instances.push({
    id,
    runId,
    nodeAttemptId: null,
    nodeId: "implement",
    attempt: 1,
    artifactDefId: null,
    kind: overrides.kind ?? "log",
    producer: "runner",
    locator: overrides.locator,
    uri: null,
    hash: null,
    sizeBytes: null,
    validity: "current",
    requiredFor: null,
    visibility: "internal",
    retention: "run",
    monotonicId: null,
    supersededById: null,
    createdAt: new Date("2026-06-01T10:00:00Z"),
  });

  return id;
}

async function invokeGet(artifactId: string, runId: string = RUN_ID) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/runs/${runId}/artifacts/${artifactId}/payload`,
      { method: "GET" },
    ),
  );

  return GET(req, { params: Promise.resolve({ runId, artifactId }) });
}

beforeEach(() => {
  dbState.tables = {
    artifact_instances: [],
    gate_results: [],
    hitl_requests: [],
  };

  runtimeRoot = mkdtempSync(join(tmpdir(), "rt-payload-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  mkdirSync(runDir(), { recursive: true });

  vi.mocked(requireActiveSession).mockClear();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  } as never);

  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  } as never);

  vi.mocked(getRunDetail).mockClear();
  vi.mocked(diffRange).mockClear();
  vi.mocked(diffRange).mockResolvedValue("diff --git a/x b/x\n+added\n");
  vi.mocked(logRange).mockClear();
  vi.mocked(logRange).mockResolvedValue("abc1234 commit one\n");
});

afterEach(() => {
  if (ORIGINAL_RUNTIME_ROOT === undefined) {
    delete process.env.MAISTER_RUNTIME_ROOT;
  } else {
    process.env.MAISTER_RUNTIME_ROOT = ORIGINAL_RUNTIME_ROOT;
  }
});

describe("GET /api/runs/[runId]/artifacts/[artifactId]/payload", () => {
  it("returns 401 when the session is not active", async () => {
    seedArtifact({ locator: { kind: "inline", text: "hi" } });
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokeGet("art-1");

    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller lacks readBoard on the run's project", async () => {
    seedArtifact({ locator: { kind: "inline", text: "hi" } });
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet("art-1");

    expect(res.status).toBe(403);
    expect(diffRange).not.toHaveBeenCalled();
  });

  it("returns 404 when the artifact belongs to a different run (no cross-run leak)", async () => {
    // Artifact exists, but its run_id is some OTHER run.
    seedArtifact(
      { id: "art-other", locator: { kind: "inline", text: "secret" } },
      "run-OTHER",
    );

    const res = await invokeGet("art-other", RUN_ID);

    expect(res.status).toBe(404);
  });

  it("returns 404 when the artifact does not exist", async () => {
    const res = await invokeGet("ghost");

    expect(res.status).toBe(404);
  });

  it("inline locator → 200 text/plain == locator.text", async () => {
    seedArtifact({
      id: "art-inline",
      locator: { kind: "inline", text: "hello payload" },
    });

    const res = await invokeGet("art-inline");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("hello payload");
  });

  it("gate-verdict locator → 200 application/json == gate_results.verdict", async () => {
    const verdict = { verdict: "pass", confidence: 0.9, reasons: ["ok"] };

    dbState.tables.gate_results.push({
      id: "gate-1",
      runId: RUN_ID,
      verdict,
    });
    seedArtifact({
      id: "art-gate",
      kind: "ai_judgment",
      locator: { kind: "gate-verdict", gateResultId: "gate-1" },
    });

    const res = await invokeGet("art-gate");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(verdict);
  });

  it("hitl-response locator → 200 application/json == hitl_requests.response", async () => {
    const response = { decision: "approve", comments: "lgtm" };

    dbState.tables.hitl_requests.push({
      id: "hitl-1",
      runId: RUN_ID,
      response,
    });
    seedArtifact({
      id: "art-hitl",
      kind: "human_note",
      locator: { kind: "hitl-response", hitlRequestId: "hitl-1" },
    });

    const res = await invokeGet("art-hitl");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(response);
  });

  it("git-range locator → 200 text/plain == diffRange output, called with the stored headRef SHA", async () => {
    seedArtifact({
      id: "art-diff",
      kind: "diff",
      locator: { kind: "git-range", baseCommit: "abc1234", headRef: HEAD_SHA },
    });

    const res = await invokeGet("art-diff");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("diff --git");
    // F3: rendered against the stored immutable headRef, NOT the live branch.
    expect(diffRange).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: WORKTREE_PATH,
        branch: HEAD_SHA,
        baseRef: expect.any(String),
      }),
    );
  });

  it("git-log locator → 200 text/plain == logRange output, called with the stored headRef SHA", async () => {
    seedArtifact({
      id: "art-log",
      kind: "commit_set",
      locator: { kind: "git-log", baseRef: "main", headRef: HEAD_SHA },
    });

    const res = await invokeGet("art-log");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("commit one");
    // F3: rendered against the stored immutable headRef, NOT the live branch.
    expect(logRange).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: WORKTREE_PATH,
        branch: HEAD_SHA,
      }),
    );
  });

  // --- file locator: REAL fs path confinement (SECURITY) ------------------

  it("file locator (in-run-dir) → 200 returns the real file contents", async () => {
    const name = "implement.log";

    writeFileSync(join(runDir(), name), "real file body\n", "utf8");
    seedArtifact({
      id: "art-file",
      kind: "log",
      locator: { kind: "file", path: name },
    });

    const res = await invokeGet("art-file");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("real file body\n");
  });

  it("file locator traversal → 404 and NEVER reads the outside file", async () => {
    // Plant a sentinel OUTSIDE the run dir; if the route ever read it, the
    // body would contain this marker.
    const outside = join(runtimeRoot, "SECRET_OUTSIDE.txt");

    writeFileSync(outside, "TOP-SECRET-OUTSIDE\n", "utf8");
    // Sanity: the sentinel is real and readable by the test itself.
    expect(readFileSync(outside, "utf8")).toContain("TOP-SECRET-OUTSIDE");

    seedArtifact({
      id: "art-escape",
      kind: "generic_file",
      locator: { kind: "file", path: "../../../../SECRET_OUTSIDE.txt" },
    });

    const res = await invokeGet("art-escape");
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain("TOP-SECRET-OUTSIDE");
  });

  it("file locator whose target was deleted → 410 (gone)", async () => {
    // Seed an artifact pointing at a file that does NOT exist on disk.
    seedArtifact({
      id: "art-gone",
      kind: "log",
      locator: { kind: "file", path: "vanished.log" },
    });

    const res = await invokeGet("art-gone");

    expect(res.status).toBe(410);
  });

  // --- cross-run gate/hitl confinement (defense-in-depth) -----------------
  // The artifact belongs to the requested run, but its locator points at a
  // gate_results / hitl_requests row owned by a DIFFERENT run. The lookup must
  // scope on runId too, never serving another run's verdict/response.

  it("gate-verdict locator whose gate row belongs to another run → 404", async () => {
    dbState.tables.gate_results.push({
      id: "G",
      runId: "OTHER_RUN",
      verdict: { verdict: "pass", reasons: ["leaked"] },
    });
    seedArtifact({
      id: "art-gate-x",
      kind: "ai_judgment",
      locator: { kind: "gate-verdict", gateResultId: "G" },
    });

    const res = await invokeGet("art-gate-x");
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain("leaked");
  });

  it("hitl-response locator whose hitl row belongs to another run → 404", async () => {
    dbState.tables.hitl_requests.push({
      id: "H",
      runId: "OTHER_RUN",
      response: { decision: "approve", comments: "leaked" },
    });
    seedArtifact({
      id: "art-hitl-x",
      kind: "human_note",
      locator: { kind: "hitl-response", hitlRequestId: "H" },
    });

    const res = await invokeGet("art-hitl-x");
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain("leaked");
  });
});
