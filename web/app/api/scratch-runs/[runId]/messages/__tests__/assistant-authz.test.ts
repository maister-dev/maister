import type { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

// (ADR-096) A project-less local-package assistant run is bound to its launching
// user AND a live working-dir lock. The cited finding: follow-up messages only
// called requireActiveSession(), so ANY active user with the run id could drive
// prompts into another editor's locked working dir. These pin the cross-user
// denial at the route AND the ownership/lock logic in the guard.
const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  sendScratchPromptAndProjectEvents: vi.fn(),
  runtimeRoot: vi.fn(),
}));

const state: {
  run: Record<string, unknown> | null;
  lockHeld: boolean;
} = { run: null, lockHeld: true };

const tableNameSymbol = Symbol.for("drizzle:Name");

function tableName(table: unknown): string | null {
  if (!table || typeof table !== "object") return null;

  return (table as Record<symbol, unknown>)[tableNameSymbol] as string | null;
}

type FakeDb = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
  insert: (table: unknown) => { values: (v: unknown) => Promise<void> };
  update: (table: unknown) => {
    set: (v: unknown) => { where: (p: unknown) => Promise<void> };
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const fakeDb: FakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => {
        const name = tableName(table);

        if (name === "runs") return state.run ? [state.run] : [];
        if (name === "local_packages") {
          return state.lockHeld ? [{ id: "lp1" }] : [];
        }

        return [];
      },
    }),
  }),
  insert: () => ({ values: async () => undefined }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/instance-config", () => ({ runtimeRoot: mocks.runtimeRoot }));
vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: mocks.sendScratchPromptAndProjectEvents,
  normalizeScratchPrompt: (p: string) => p,
}));

import { POST } from "../route";

import { assertLocalPackageAssistantActor } from "@/lib/scratch-runs/service";

const runId = "33333333-3333-4333-8333-333333333333";

function messageRequest(): NextRequest {
  return new Request(`http://x/api/scratch-runs/${runId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "drive the agent", attachments: [] }),
  }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.run = {
    id: runId,
    runKind: "scratch",
    projectId: null,
    localPackageId: "lp1",
    createdByUserId: "owner",
    capabilityAgent: "claude",
    status: "Running",
  };
  state.lockHeld = true;
  mocks.runtimeRoot.mockReturnValue("/tmp");
  mocks.sendScratchPromptAndProjectEvents.mockResolvedValue({
    stopReason: "end_turn",
  });
});

describe("POST /api/scratch-runs/[runId]/messages — project-less assistant", () => {
  it("rejects a message from a user who did not launch the run", async () => {
    mocks.requireActiveSession.mockResolvedValue({ id: "attacker" });

    const res = await POST(messageRequest(), {
      params: Promise.resolve({ runId }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mocks.sendScratchPromptAndProjectEvents).not.toHaveBeenCalled();
  });
});

describe("assertLocalPackageAssistantActor", () => {
  const run = { createdByUserId: "owner", localPackageId: "lp1" };

  it("allows the owner to read (no lock required)", async () => {
    await expect(
      assertLocalPackageAssistantActor(run, "owner", { requireLock: false }),
    ).resolves.toBeUndefined();
  });

  it("denies a non-owner with UNAUTHORIZED", async () => {
    await expect(
      assertLocalPackageAssistantActor(run, "attacker", { requireLock: false }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows the owner to drive while holding a live lock", async () => {
    state.lockHeld = true;
    await expect(
      assertLocalPackageAssistantActor(run, "owner", { requireLock: true }),
    ).resolves.toBeUndefined();
  });

  it("denies the owner driving without a live lock (CONFLICT)", async () => {
    state.lockHeld = false;
    await expect(
      assertLocalPackageAssistantActor(run, "owner", { requireLock: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
