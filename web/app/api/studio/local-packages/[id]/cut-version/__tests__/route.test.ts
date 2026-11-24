import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-132 §c (T16): `adoptInProjectIds` advances already-attached projects to
// the new cut in the same request. Contract pinned here: authz + eligibility
// for EVERY id are validated BEFORE the irreversible cut (refusal → nothing
// mutated); after the cut, adopts are per-project after-writes whose failures
// are REPORTED (`adoptions[]`), never rolled back.
const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  requireProjectAction: vi.fn(),
  getLocalPackage: vi.fn(),
  assertPackageCuttable: vi.fn(),
  cutLocalPackageVersion: vi.fn(),
  listAdoptTargetProjects: vi.fn(),
  attachPackage: vi.fn(),
  upgradeAttachment: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: mocks.requireGlobalRole,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
  assertPackageCuttable: mocks.assertPackageCuttable,
}));
vi.mock("@/lib/local-packages/versions", () => ({
  cutLocalPackageVersion: mocks.cutLocalPackageVersion,
  listAdoptTargetProjects: mocks.listAdoptTargetProjects,
}));
vi.mock("@/lib/packages/attach", () => ({
  attachPackage: mocks.attachPackage,
  upgradeAttachment: mocks.upgradeAttachment,
}));
vi.mock("@/lib/db/client", () => ({
  getDb: mocks.getDb,
}));

import { POST } from "../route";

import { MaisterError } from "@/lib/errors";

const TARGETS = [
  {
    localPackageId: "lp1",
    projectId: "p1",
    slug: "proj-1",
    name: "Proj 1",
    repoPath: "/repos/p1",
    attachmentId: "att-1",
  },
  {
    localPackageId: "lp1",
    projectId: "p2",
    slug: "proj-2",
    name: "Proj 2",
    repoPath: "/repos/p2",
    attachmentId: "att-2",
  },
];

function req(body?: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/cut-version", {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "lp1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.requireProjectAction.mockResolvedValue(undefined);
  mocks.getLocalPackage.mockResolvedValue({
    id: "lp1",
    status: "active",
    name: "demo",
  });
  mocks.assertPackageCuttable.mockResolvedValue(undefined);
  mocks.cutLocalPackageVersion.mockResolvedValue({
    installId: "inst-new",
    versionLabel: "local-abcdef123456",
  });
  mocks.listAdoptTargetProjects.mockResolvedValue(TARGETS);
  mocks.upgradeAttachment.mockResolvedValue({ upgraded: true });
});

describe("cut-version adoptInProjectIds (ADR-132)", () => {
  it("refuses an INELIGIBLE project id with 409 BEFORE the cut (upstream-pinned project)", async () => {
    const res = await POST(req({ adoptInProjectIds: ["p-upstream"] }), ctx());

    expect(res.status).toBe(409);
    expect(mocks.cutLocalPackageVersion).not.toHaveBeenCalled();
    expect(mocks.upgradeAttachment).not.toHaveBeenCalled();
  });

  it("refuses an authz failure with 403 BEFORE the cut", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "denied"),
    );

    const res = await POST(req({ adoptInProjectIds: ["p1"] }), ctx());

    expect(res.status).toBe(403);
    expect(mocks.cutLocalPackageVersion).not.toHaveBeenCalled();
  });

  it("reports partial adopt failures per project — the cut is never rolled back", async () => {
    mocks.upgradeAttachment
      .mockResolvedValueOnce({ upgraded: true })
      .mockRejectedValueOnce(new MaisterError("CONFLICT", "worktree busy"));

    const res = await POST(req({ adoptInProjectIds: ["p1", "p2"] }), ctx());

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(mocks.cutLocalPackageVersion).toHaveBeenCalledTimes(1);
    expect(body.adoptions).toEqual([
      { projectId: "p1", status: "adopted" },
      { projectId: "p2", status: "failed", error: "worktree busy" },
    ]);
    // Adopts target the project's EXISTING attachment with the new install.
    expect(mocks.upgradeAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        projectSlug: "proj-1",
        attachmentId: "att-1",
        packageInstallId: "inst-new",
        workspaceRoot: "/repos/p1",
      }),
    );
  });

  it("adopt-less body keeps the existing contract: 201, no adoptions field, no upgrade calls", async () => {
    const res = await POST(req({}), ctx());

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).not.toHaveProperty("adoptions");
    expect(mocks.upgradeAttachment).not.toHaveBeenCalled();
    expect(mocks.listAdoptTargetProjects).not.toHaveBeenCalled();
  });

  it("acknowledges an accepted attachment awaiting Flow links and reports a concurrently removed attachment separately", async () => {
    const pending = {
      reason: "project_flow_link_pending",
      operationId: "op-1",
      memberRef: "core-flow",
      linkReason: "project_flow_link_conflict",
    };
    mocks.upgradeAttachment
      .mockRejectedValueOnce(
        new MaisterError("PRECONDITION", "link repair pending", {
          details: { ...pending, mutationAccepted: true },
        }),
      )
      .mockResolvedValueOnce(null);
    mocks.getDb.mockReturnValueOnce({
      select: () => ({
        from: () => ({
          where: async () => [
            { id: "p3", slug: "new", repoPath: "/repos/p3", archivedAt: null },
          ],
        }),
      }),
    });
    mocks.attachPackage.mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "link repair pending", {
        details: {
          ...pending,
          operationId: "op-3",
          mutationAccepted: true,
          attachmentId: "att-3",
        },
      }),
    );
    const response = await POST(
      req({ attachToProjectId: "p3", adoptInProjectIds: ["p1", "p2"] }),
      ctx(),
    );
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      attachmentId: "att-3",
      flowLinkPending: { ...pending, operationId: "op-3" },
    });
    expect(result.adoptions).toEqual([
      { projectId: "p1", status: "adopted", flowLinkPending: pending },
      { projectId: "p2", status: "failed", error: expect.any(String) },
    ]);
  });
});
