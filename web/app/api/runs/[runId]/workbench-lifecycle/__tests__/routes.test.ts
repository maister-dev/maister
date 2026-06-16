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
      runStatus: "Abandoned",
      workspaceRemoved: true,
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
      runStatus: "Abandoned",
      workspaceRemoved: true,
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

  it("POST /api/runs/[runId]/export-branch parses the export body", async () => {
    vi.mocked(lifecycleService.exportWorkbenchBranch).mockResolvedValueOnce({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      remote: "origin",
      pushedRef: "origin/maister/run-1",
      snapshotCreated: true,
      checkoutCommands: [
        "git -C /repo fetch origin maister/run-1",
        "git -C /repo switch maister/run-1",
      ],
    });

    const { POST } = await import("@/app/api/runs/[runId]/export-branch/route");
    const res = await POST(
      postRequest({
        remote: "origin",
        snapshotDirty: true,
        commitMessage: "maister: hand off run-1",
        force: true,
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
        snapshotDirty: true,
        commitMessage: "maister: hand off run-1",
        force: true,
      },
    );
  });

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
});
