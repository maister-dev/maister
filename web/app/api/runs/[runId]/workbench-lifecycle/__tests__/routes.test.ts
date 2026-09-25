import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError, type MaisterErrorCode } from "@/lib/errors";
import * as lifecycleService from "@/lib/workbench-lifecycle/service";

vi.mock("@/lib/workbench-lifecycle/service", () => ({
  stopFlowWorkbench: vi.fn(),
  stopWorkbenchRun: vi.fn(),
  stopThenArchive: vi.fn(),
  stopThenDrop: vi.fn(),
  archiveWorkbench: vi.fn(),
  dropWorkbench: vi.fn(),
  discardWorkbench: vi.fn(),
  exportWorkbenchBranch: vi.fn(),
  getWorkbenchHandoffMetadata: vi.fn(),
  snapshotWorkbenchCommit: vi.fn(),
  createWorkbenchHandoffBranch: vi.fn(),
}));

function postRequest(body?: unknown): Request {
  return new Request("http://localhost/api/runs/run-1/lifecycle", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("workbench lifecycle route wrappers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("POST /api/runs/[runId]/stop delegates to stopWorkbenchRun", async () => {
    vi.mocked(lifecycleService.stopWorkbenchRun).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      runStatus: "Review",
      supervisorStopped: true,
    });

    const { POST } = await import("@/app/api/runs/[runId]/stop/route");
    const res = await POST(postRequest(), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      runStatus: "Review",
      supervisorStopped: true,
    });
    expect(lifecycleService.stopWorkbenchRun).toHaveBeenCalledWith("run-1");
  });

  it("POST /api/runs/[runId]/stop-archive delegates to stopThenArchive", async () => {
    vi.mocked(lifecycleService.stopThenArchive).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      operation: "archive",
      runStatus: "Review",
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: "snapshot_created",
      archived: true,
      archivedBranch: "maister/archive/run-1",
      snapshotted: true,
      supervisorStopped: true,
    });

    const { POST } = await import("@/app/api/runs/[runId]/stop-archive/route");
    const res = await POST(postRequest(), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      archivedBranch: "maister/archive/run-1",
      supervisorStopped: true,
    });
    expect(lifecycleService.stopThenArchive).toHaveBeenCalledWith("run-1");
  });

  it("POST /api/runs/[runId]/stop-drop delegates to stopThenDrop", async () => {
    vi.mocked(lifecycleService.stopThenDrop).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      operation: "drop",
      runStatus: "Abandoned",
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: "snapshot_created",
      archivedBranch: "maister/archive/run-1",
      supervisorStopped: true,
    });

    const { POST } = await import("@/app/api/runs/[runId]/stop-drop/route");
    const res = await POST(postRequest(), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      runStatus: "Abandoned",
      workspaceRemoved: true,
      supervisorStopped: true,
    });
    expect(lifecycleService.stopThenDrop).toHaveBeenCalledWith("run-1");
  });

  it("POST /api/runs/[runId]/archive delegates to archiveWorkbench", async () => {
    vi.mocked(lifecycleService.archiveWorkbench).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      operation: "archive",
      runStatus: "Review",
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: "snapshot_created",
      archived: true,
      archivedBranch: "maister/archive/run-1",
      snapshotted: true,
    });

    const { POST } = await import("@/app/api/runs/[runId]/archive/route");
    const res = await POST(postRequest(), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      archivedBranch: "maister/archive/run-1",
    });
    expect(lifecycleService.archiveWorkbench).toHaveBeenCalledWith("run-1");
  });

  it("POST /api/runs/[runId]/drop delegates to dropWorkbench", async () => {
    vi.mocked(lifecycleService.dropWorkbench).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      operation: "drop",
      runStatus: "Abandoned",
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: "snapshot_created",
      archivedBranch: "maister/archive/run-1",
    });

    const { POST } = await import("@/app/api/runs/[runId]/drop/route");
    const res = await POST(postRequest(), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      runStatus: "Abandoned",
      workspaceRemoved: true,
    });
    expect(lifecycleService.dropWorkbench).toHaveBeenCalledWith("run-1");
  });

  it("POST /api/runs/[runId]/discard delegates to the common discard coordinator", async () => {
    vi.mocked(lifecycleService.discardWorkbench).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      operation: "discard",
      runStatus: "Abandoned",
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: "snapshot_created",
      archivedBranch: "maister/archive/run-1",
    });

    const { POST } = await import("@/app/api/runs/[runId]/discard/route");
    const res = await POST(postRequest(), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      operation: "discard",
      workspaceRemoved: true,
    });
    expect(lifecycleService.discardWorkbench).toHaveBeenCalledWith("run-1");
  });

  it("POST /api/runs/[runId]/export-branch parses the export body", async () => {
    vi.mocked(lifecycleService.exportWorkbenchBranch).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      remote: "origin",
      pushedRef: "origin/feature/ABC-1-x",
      publishedBranch: "feature/ABC-1-x",
      publishedRemote: "origin",
      publishedRef: "origin/feature/ABC-1-x",
      nameSource: "request",
      snapshotCreated: true,
      checkoutCommands: [
        "git -C /repo fetch origin feature/ABC-1-x",
        "git -C /repo switch --track origin/feature/ABC-1-x",
      ],
    });

    const { POST } = await import("@/app/api/runs/[runId]/export-branch/route");
    const res = await POST(
      postRequest({
        remote: "origin",
        // ADR-181 D4: the public name the dialog carries.
        branchName: "feature/ABC-1-x",
        snapshotDirty: true,
        commitMessage: "maister: hand off run-1",
        force: true,
        expectedHead: "a".repeat(40),
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      branch: "maister/run-1",
      snapshotCreated: true,
    });
    expect(lifecycleService.exportWorkbenchBranch).toHaveBeenCalledWith(
      "run-1",
      {
        remote: "origin",
        branchName: "feature/ABC-1-x",
        snapshotDirty: true,
        commitMessage: "maister: hand off run-1",
        force: true,
        expectedHead: "a".repeat(40),
      },
    );
  });

  // ADR-181 D4: a force is bound to one confirmed head — never sent without it,
  // and a head is meaningless without a force.
  it.each([
    ["a force without expectedHead", { force: true }],
    ["expectedHead without a force", { expectedHead: "a".repeat(40) }],
    ["an abbreviated expectedHead", { force: true, expectedHead: "abc1234" }],
  ])(
    "POST /api/runs/[runId]/export-branch refuses %s",
    async (_label, body) => {
      const { POST } = await import(
        "@/app/api/runs/[runId]/export-branch/route"
      );
      const res = await POST(postRequest({ remote: "origin", ...body }), {
        params: Promise.resolve({ runId: "run-1" }),
      });

      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: "CONFIG" });
      expect(lifecycleService.exportWorkbenchBranch).not.toHaveBeenCalled();
    },
  );

  it.each(["workspace_preservation_failed", "workspace_git_identity_invalid"])(
    "POST /api/runs/[runId]/drop returns typed reason %s",
    async (reason) => {
      vi.mocked(lifecycleService.dropWorkbench).mockRejectedValueOnce(
        new MaisterError("CONFLICT", "could not preserve worktree", {
          details: { reason, private: "not public" },
        }),
      );
      const { POST } = await import("@/app/api/runs/[runId]/drop/route");
      const res = await POST(postRequest({}), {
        params: Promise.resolve({ runId: "run-1" }),
      });

      expect(res.status).toBe(409);
      // ADR-181 D24: the reason token also rides `details`; every other
      // `details` field stays server-side.
      expect(await json(res)).toEqual({
        code: "CONFLICT",
        message: "could not preserve worktree",
        reason,
        details: { reason },
      });
    },
  );

  it("POST /api/runs/[runId]/export-branch returns typed push conflicts", async () => {
    vi.mocked(lifecycleService.exportWorkbenchBranch).mockRejectedValueOnce(
      Object.assign(
        new MaisterError(
          "CONFLICT",
          "git push origin maister/run-1 rejected: non-fast-forward",
        ),
        {
          pushRejected: "non_fast_forward",
          canForce: true,
          retryHint: "Remote branch has newer commits.",
          remoteHead: "d".repeat(40),
          remoteRef: "origin/feature/ABC-1-x",
        },
      ),
    );

    const { POST } = await import("@/app/api/runs/[runId]/export-branch/route");
    const res = await POST(
      postRequest({
        remote: "origin",
        snapshotDirty: false,
        force: false,
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      code: "CONFLICT",
      pushRejected: "non_fast_forward",
      canForce: true,
      retryHint: "Remote branch has newer commits.",
      remoteHead: "d".repeat(40),
      remoteRef: "origin/feature/ABC-1-x",
    });
  });

  it("POST /api/runs/[runId]/export-branch rejects invalid bodies", async () => {
    const { POST } = await import("@/app/api/runs/[runId]/export-branch/route");
    const res = await POST(postRequest({ remote: "", snapshotDirty: true }), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "CONFIG" });
    expect(lifecycleService.exportWorkbenchBranch).not.toHaveBeenCalled();
  });

  it("GET /api/runs/[runId]/handoff-metadata returns explicit metadata DTO", async () => {
    vi.mocked(
      lifecycleService.getWorkbenchHandoffMetadata,
    ).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      dirty: true,
      remotes: ["origin"],
      defaultRemote: "origin",
      suggestedHandoffBranch: "maister/handoff/run-1",
      checkoutCommands: [
        "git -C /repo fetch origin maister/handoff/run-1",
        "git -C /repo switch --track origin/maister/handoff/run-1",
      ],
    });

    const { GET } = await import(
      "@/app/api/runs/[runId]/handoff-metadata/route"
    );
    const res = await GET(new Request("http://localhost/api/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      dirty: true,
      remotes: ["origin"],
      defaultRemote: "origin",
      suggestedHandoffBranch: "maister/handoff/run-1",
      checkoutCommands: [
        "git -C /repo fetch origin maister/handoff/run-1",
        "git -C /repo switch --track origin/maister/handoff/run-1",
      ],
    });
    expect(lifecycleService.getWorkbenchHandoffMetadata).toHaveBeenCalledWith(
      "run-1",
    );
  });

  it("POST /api/runs/[runId]/snapshot-commit parses the commit body", async () => {
    vi.mocked(lifecycleService.snapshotWorkbenchCommit).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      commit: "abc1234",
      snapshotCreated: true,
    });

    const { POST } = await import(
      "@/app/api/runs/[runId]/snapshot-commit/route"
    );
    const res = await POST(
      postRequest({ commitMessage: "maister: snapshot run-1" }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      commit: "abc1234",
      snapshotCreated: true,
    });
    expect(lifecycleService.snapshotWorkbenchCommit).toHaveBeenCalledWith(
      "run-1",
      { commitMessage: "maister: snapshot run-1" },
    );
  });

  it("POST /api/runs/[runId]/snapshot-commit rejects spoofed server-owned body fields", async () => {
    vi.mocked(lifecycleService.snapshotWorkbenchCommit).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      commit: "abc1234",
      snapshotCreated: true,
    });

    const { POST } = await import(
      "@/app/api/runs/[runId]/snapshot-commit/route"
    );
    const res = await POST(
      postRequest({
        projectId: "attacker-project",
        worktreePath: "/tmp/other",
        branch: "attacker/ref",
        acpSessionId: "secret-session",
        commitMessage: "maister: snapshot run-1",
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "CONFIG" });
    expect(lifecycleService.snapshotWorkbenchCommit).not.toHaveBeenCalled();
  });

  it("POST /api/runs/[runId]/handoff-branch parses the handoff body", async () => {
    vi.mocked(
      lifecycleService.createWorkbenchHandoffBranch,
    ).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      handoffBranch: "maister/handoff/run-1",
      remote: "origin",
      pushedRef: "origin/maister/handoff/run-1",
      headCommit: "abc1234",
      checkoutCommands: [
        "git -C /repo fetch origin maister/handoff/run-1",
        "git -C /repo switch --track origin/maister/handoff/run-1",
      ],
    });

    const { POST } = await import(
      "@/app/api/runs/[runId]/handoff-branch/route"
    );
    const res = await POST(
      postRequest({
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
      }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      handoffBranch: "maister/handoff/run-1",
      pushedRef: "origin/maister/handoff/run-1",
    });
    expect(lifecycleService.createWorkbenchHandoffBranch).toHaveBeenCalledWith(
      "run-1",
      {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
      },
    );
  });

  it("POST /api/runs/[runId]/handoff-branch rejects invalid bodies", async () => {
    const { POST } = await import(
      "@/app/api/runs/[runId]/handoff-branch/route"
    );
    const res = await POST(
      postRequest({ remote: "", handoffBranch: "../bad" }),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "CONFIG" });
    expect(
      lifecycleService.createWorkbenchHandoffBranch,
    ).not.toHaveBeenCalled();
  });

  it("maps lifecycle service errors to route status codes", async () => {
    const cases: { code: MaisterErrorCode; status: number }[] = [
      { code: "UNAUTHENTICATED", status: 401 },
      { code: "UNAUTHORIZED", status: 403 },
      { code: "CONFLICT", status: 409 },
      { code: "EXECUTOR_UNAVAILABLE", status: 503 },
    ];
    const { GET } = await import(
      "@/app/api/runs/[runId]/handoff-metadata/route"
    );

    for (const item of cases) {
      vi.mocked(
        lifecycleService.getWorkbenchHandoffMetadata,
      ).mockRejectedValueOnce(new MaisterError(item.code, `${item.code} boom`));

      const res = await GET(new Request("http://localhost/api/runs/run-1"), {
        params: Promise.resolve({ runId: "run-1" }),
      });

      expect(res.status).toBe(item.status);
      expect(await json(res)).toMatchObject({ code: item.code });
    }
  });

  // ADR-181 D24: a policy refusal's token reaches the client under
  // `details.reason` (the UI's only branch key besides `code`).
  it("forwards details.reason on a refusal, and nothing else from details", async () => {
    vi.mocked(lifecycleService.dropWorkbench).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "busy", {
        details: { reason: "busy", attemptId: "server-only" },
      }),
    );
    const { POST } = await import("@/app/api/runs/[runId]/drop/route");
    const res = await POST(postRequest({}), {
      params: Promise.resolve({ runId: "run-1" }),
    });

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      code: "CONFLICT",
      message: "busy",
      details: { reason: "busy" },
    });
  });

  // C29: the shared loader tags an unknown run; every family-A route answers 404.
  it("maps run_not_found to 404", async () => {
    vi.mocked(lifecycleService.dropWorkbench).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "run not found: run-x", {
        details: { reason: "run_not_found" },
      }),
    );
    const { POST } = await import("@/app/api/runs/[runId]/drop/route");
    const res = await POST(postRequest({}), {
      params: Promise.resolve({ runId: "run-x" }),
    });

    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "run_not_found" },
    });
  });
});
