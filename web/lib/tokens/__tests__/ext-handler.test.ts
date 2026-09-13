import type { TokenActor } from "@/lib/tokens/verify";

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockTokenAuthError extends Error {
    readonly kind: string;
    readonly tokenId?: string;
    readonly projectId?: string;

    constructor(
      kind: string,
      message?: string,
      meta?: { tokenId?: string; projectId?: string },
    ) {
      super(message ?? kind);
      this.name = "TokenAuthError";
      this.kind = kind;
      this.tokenId = meta?.tokenId;
      this.projectId = meta?.projectId;
    }
  }

  return {
    bumpTokenLastUsed: vi.fn(),
    getDb: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    recordTokenAudit: vi.fn(),
    tokenAuthError: MockTokenAuthError,
    verifyToken: vi.fn(),
  };
});

vi.mock("pino", () => ({
  default: vi.fn(() => ({
    error: mocks.logError,
    warn: mocks.logWarn,
  })),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/tokens/audit", () => ({
  bumpTokenLastUsed: mocks.bumpTokenLastUsed,
  recordTokenAudit: mocks.recordTokenAudit,
}));

vi.mock("@/lib/tokens/verify", () => ({
  TokenAuthError: mocks.tokenAuthError,
  httpStatusForTokenAuth: (kind: string) =>
    kind === "wrong-project" ? 404 : 401,
  verifyToken: mocks.verifyToken,
}));

const actor: TokenActor = {
  tokenId: "tok-1",
  projectId: "project-1",
  tokenKind: "project",
  ownerUserId: null,
  agentId: null,
  actorLabel: "token:test",
  scopes: ["tasks:create"],
  boundRunId: null,
};

function request(): Request {
  return new Request("http://localhost/api/v1/ext/projects/demo/tasks", {
    headers: { authorization: "Bearer mai_secret" },
  });
}

describe("handleExt mandatory token audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.verifyToken.mockResolvedValue(actor);
    mocks.recordTokenAudit.mockResolvedValue(undefined);
    mocks.bumpTokenLastUsed.mockResolvedValue(undefined);
    mocks.logError.mockClear();
    mocks.logWarn.mockClear();
  });

  it("fails closed when the success audit write fails", async () => {
    mocks.recordTokenAudit.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const { handleExt } = await import("@/lib/tokens/ext-handler");

    await expect(
      handleExt(
        request(),
        {
          scopeLabel: "tasks:create",
          endpoint: "POST /api/v1/ext/projects/[slug]/tasks",
          method: "POST",
        },
        async () => NextResponse.json({ taskId: "task-1" }, { status: 201 }),
      ),
    ).rejects.toThrow("audit unavailable");
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "POST /api/v1/ext/projects/[slug]/tasks",
        projectId: "project-1",
        result: "ok",
        scopeUsed: "tasks:create",
        statusCode: 201,
        tokenId: "tok-1",
      }),
      "[FIX:token-audit-required] token audit write failed",
    );
  });

  it("fails closed when the insufficient-scope audit write fails", async () => {
    mocks.verifyToken.mockResolvedValue({
      ...actor,
      scopes: ["tasks:read"],
    });
    mocks.recordTokenAudit.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const { handleExt } = await import("@/lib/tokens/ext-handler");

    await expect(
      handleExt(
        request(),
        {
          scopeLabel: "tasks:create",
          endpoint: "POST /api/v1/ext/projects/[slug]/tasks",
          method: "POST",
        },
        async () => NextResponse.json({ taskId: "task-1" }, { status: 201 }),
      ),
    ).rejects.toThrow("audit unavailable");
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "POST /api/v1/ext/projects/[slug]/tasks",
        projectId: "project-1",
        result: "error",
        scopeUsed: "tasks:create",
        statusCode: 403,
        tokenId: "tok-1",
      }),
      "[FIX:token-audit-required] token audit write failed",
    );
  });
});

// I18 (ADR-168 D5). The 403 body names the scope the ROUTE requires — a
// published, caller-independent fact — while still revealing nothing about the
// scopes the TOKEN holds. Both halves are one invariant: loosening the first
// must not erode the second, so they are asserted against the same response.
describe("handleExt insufficient-scope disclosure boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.recordTokenAudit.mockResolvedValue(undefined);
    mocks.bumpTokenLastUsed.mockResolvedValue(undefined);
  });

  it("I18: names the required scope and leaks none of the scopes the token holds", async () => {
    // A distinctive held set: every entry is greppable in the serialized body.
    const heldScopes = [
      "tasks:read",
      "comments:read",
      "relations:read",
      "memory:read",
    ];

    mocks.verifyToken.mockResolvedValue({ ...actor, scopes: heldScopes });

    const { handleExt } = await import("@/lib/tokens/ext-handler");

    const res = await handleExt(
      request(),
      {
        scopeLabel: "flows:read",
        endpoint: "GET /api/v1/ext/projects/[slug]/flows",
        method: "GET",
      },
      async () => NextResponse.json({ flows: [] }, { status: 200 }),
    );

    expect(res.status).toBe(403);

    const body = await res.json();

    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.details?.requiredScope).toBe("flows:read");
    expect(body.message).toContain("flows:read");

    const serialized = JSON.stringify(body);

    for (const held of heldScopes) {
      expect(serialized).not.toContain(held);
    }
  });
});
