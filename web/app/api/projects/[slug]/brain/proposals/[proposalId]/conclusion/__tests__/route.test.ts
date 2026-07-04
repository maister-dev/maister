import type { BrainProposalDto } from "@/lib/brain/proposals";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { concludeBrainProposal, getBrainProposal } from "@/lib/brain/proposals";
import { MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

const SLUG = "demo";
const PROJECT_ID = "project-1";
const PROPOSAL_ID = "proposal-1";
const USER_ID = "user-1";

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    slug: SLUG,
    name: "Demo",
    repoPath: "/repos/demo",
    mainBranch: "main",
    archivedAt: null,
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof getProjectBySlug>>;
}

function proposalRow(
  overrides: Partial<BrainProposalDto> = {},
): BrainProposalDto {
  const now = new Date("2026-07-03T12:00:00.000Z");

  return {
    id: PROPOSAL_ID,
    projectId: PROJECT_ID,
    kind: "rule",
    evidenceItemIds: [],
    draft: {
      slug: "small-rule",
      title: "Small Rule",
      body: { markdown: "Keep changes small." },
    },
    status: "pending",
    blastRadius: "low",
    autonomyDecision: "manual",
    clusterHash: null,
    actor: { type: "agent", id: "improver" },
    resolution: null,
    authoredDraftId: null,
    taskId: null,
    runId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    appliedAt: null,
    idempotent: false,
    ...overrides,
  };
}

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: USER_ID,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: USER_ID,
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "admin",
  })),
}));

vi.mock("@/lib/queries/project", () => ({
  getProjectBySlug: vi.fn(),
}));

vi.mock("@/lib/brain/proposals", () => ({
  concludeBrainProposal: vi.fn(),
  getBrainProposal: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(() => ({ execute: vi.fn(), transaction: vi.fn() })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: USER_ID,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  });
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: USER_ID,
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "admin",
  });
  vi.mocked(getProjectBySlug).mockResolvedValue(projectRow());
  vi.mocked(getBrainProposal).mockResolvedValue(proposalRow());
  vi.mocked(concludeBrainProposal).mockResolvedValue(
    proposalRow({
      status: "applied",
      authoredDraftId: "authored-cap-1",
      resolution: { actor: { type: "user", id: USER_ID }, reason: "ok" },
    }),
  );
});

async function invokePost(body: unknown, proposalId = PROPOSAL_ID) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/projects/${SLUG}/brain/proposals/${proposalId}/conclusion`,
      {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
  );

  return POST(req, { params: Promise.resolve({ slug: SLUG, proposalId }) });
}

describe("Project Brain proposal conclusion route", () => {
  it("accepts catalog proposals only after writeBrain and manageCatalog", async () => {
    const res = await invokePost({ action: "accept", reason: "ok" });

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenNthCalledWith(
      1,
      PROJECT_ID,
      "writeBrain",
    );
    expect(requireProjectAction).toHaveBeenNthCalledWith(
      2,
      PROJECT_ID,
      "manageCatalog",
    );
    expect(concludeBrainProposal).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      projectSlug: SLUG,
      proposalId: PROPOSAL_ID,
      action: "accept",
      actor: { type: "user", id: USER_ID },
      reason: "ok",
    });
  });

  it("refuses catalog accept when the user can write Brain but cannot manage catalog", async () => {
    vi.mocked(requireProjectAction).mockImplementation(async (_id, action) => {
      if (action === "manageCatalog") {
        throw new MaisterError("UNAUTHORIZED", "catalog admin required");
      }

      return {
        user: {
          id: USER_ID,
          role: "member",
          accountStatus: "active",
          mustChangePassword: false,
        },
        role: "member",
      };
    });

    const res = await invokePost({ action: "accept", reason: "ok" });

    expect(res.status).toBe(403);
    expect(requireProjectAction).toHaveBeenCalledWith(PROJECT_ID, "writeBrain");
    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "manageCatalog",
    );
    expect(concludeBrainProposal).not.toHaveBeenCalled();
  });

  it("requires createTask before accepting docs projection proposals", async () => {
    vi.mocked(getBrainProposal).mockResolvedValue(
      proposalRow({ kind: "state" }),
    );
    vi.mocked(requireProjectAction).mockImplementation(async (_id, action) => {
      if (action === "createTask") {
        throw new MaisterError("UNAUTHORIZED", "task creation required");
      }

      return {
        user: {
          id: USER_ID,
          role: "member",
          accountStatus: "active",
          mustChangePassword: false,
        },
        role: "member",
      };
    });

    const res = await invokePost({ action: "accept", reason: "ok" });

    expect(res.status).toBe(403);
    expect(requireProjectAction).toHaveBeenCalledWith(PROJECT_ID, "writeBrain");
    expect(requireProjectAction).toHaveBeenCalledWith(PROJECT_ID, "createTask");
    expect(concludeBrainProposal).not.toHaveBeenCalled();
  });

  it("rejects proposals with writeBrain and no catalog/task permission", async () => {
    vi.mocked(concludeBrainProposal).mockResolvedValue(
      proposalRow({
        status: "rejected",
        resolution: { actor: { type: "user", id: USER_ID }, reason: "no" },
      }),
    );

    const res = await invokePost({ action: "reject", reason: "no" });

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledTimes(1);
    expect(requireProjectAction).toHaveBeenCalledWith(PROJECT_ID, "writeBrain");
    expect(concludeBrainProposal).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      projectSlug: SLUG,
      proposalId: PROPOSAL_ID,
      action: "reject",
      actor: { type: "user", id: USER_ID },
      reason: "no",
    });
  });

  it("authenticates before parsing the request body", async () => {
    vi.mocked(requireActiveSession).mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await invokePost("{");

    expect(res.status).toBe(401);
    expect(getBrainProposal).not.toHaveBeenCalled();
    expect(concludeBrainProposal).not.toHaveBeenCalled();
  });

  it("returns a PRECONDITION body for missing proposals", async () => {
    vi.mocked(concludeBrainProposal).mockRejectedValue(
      new MaisterError("PRECONDITION", "Brain proposal not found"),
    );

    const res = await invokePost({ action: "reject", reason: "missing" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toMatchObject({
      code: "PRECONDITION",
      message: "Brain proposal not found",
    });
  });
});
