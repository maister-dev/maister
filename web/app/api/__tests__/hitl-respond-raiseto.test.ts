// Route-contract pin for POST /api/runs/{runId}/hitl/{hitlRequestId}/respond:
// the request bodySchema MUST preserve `raiseTo` (cost-budget governance,
// ADR-101). Regression for the C1 schema-strip bug — z.object() drops unknown
// keys, so omitting `raiseTo` from bodySchema silently swallowed the client's
// raised ceiling and EVERY "Raise & resume" failed PRECONDITION, while the
// service-level tests (which call respondToHitl directly, bypassing the route)
// stayed green. This test exercises the wire path through bodySchema.parse.

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../runs/[runId]/hitl/[hitlRequestId]/respond/route";

const requireActiveSessionSpy = vi.fn();
const respondToHitlSpy = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireActiveSession: (...a: unknown[]) => requireActiveSessionSpy(...a),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({}),
}));

vi.mock("@/lib/services/hitl", () => ({
  respondToHitl: (...a: unknown[]) => respondToHitlSpy(...a),
}));

function routeParams() {
  return { params: Promise.resolve({ runId: "r1", hitlRequestId: "h1" }) };
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/runs/r1/hitl/h1/respond", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireActiveSessionSpy
    .mockReset()
    .mockResolvedValue({ id: "u1", name: "User One", email: "u1@x.local" });
  respondToHitlSpy
    .mockReset()
    .mockResolvedValue(NextResponse.json({ ok: true }, { status: 202 }));
});

describe("POST /api/runs/{runId}/hitl/{hitlRequestId}/respond — budget raiseTo transport", () => {
  it("preserves a valid raiseTo through bodySchema to the service (C1 regression)", async () => {
    const res = await POST(
      postReq({ optionId: "raise", raiseTo: 5000 }),
      routeParams(),
    );

    expect(res.status).toBe(202);
    expect(respondToHitlSpy).toHaveBeenCalledTimes(1);

    const [input] = respondToHitlSpy.mock.calls[0] as [
      { body: Record<string, unknown> },
    ];

    expect(input.body).toMatchObject({ optionId: "raise", raiseTo: 5000 });
  });

  it("rejects a non-positive / non-integer raiseTo at the schema (400 CONFIG, service not reached)", async () => {
    for (const bad of [-5, 0, 12.5]) {
      respondToHitlSpy.mockClear();
      const res = await POST(
        postReq({ optionId: "raise", raiseTo: bad }),
        routeParams(),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("CONFIG");
      expect(respondToHitlSpy).not.toHaveBeenCalled();
    }
  });

  it("still accepts a plain abandon (no raiseTo)", async () => {
    const res = await POST(postReq({ optionId: "abandon" }), routeParams());

    expect(res.status).toBe(202);

    const [input] = respondToHitlSpy.mock.calls[0] as [
      { body: Record<string, unknown> },
    ];

    expect(input.body.optionId).toBe("abandon");
    expect(input.body.raiseTo).toBeUndefined();
  });
});
