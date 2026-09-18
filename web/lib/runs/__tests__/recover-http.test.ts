import { describe, expect, it } from "vitest";

import { recoverHttpResponse } from "@/lib/runs/recover-http";

// The whole point of this module is that the internal recover route and the
// `/api/v1/ext` one answer the SAME outcome identically, so the contract is
// pinned per state rather than spot-checked.
const CASES = [
  { state: "resumed", httpStatus: 200, runStatus: "Running" },
  { state: "redispatched", httpStatus: 200, runStatus: "Running" },
  { state: "queued", httpStatus: 202, runStatus: "Pending" },
] as const;

const REFUSALS = [
  {
    state: "discard-only",
    httpStatus: 409,
    code: "CONFLICT",
    reason: "discard_only",
  },
  {
    state: "conflict",
    httpStatus: 409,
    code: "CONFLICT",
    reason: "recover_cas_lost",
  },
  {
    state: "workspace-removed",
    httpStatus: 409,
    code: "PRECONDITION",
    reason: "workspace_removed",
  },
  { state: "unresumable", httpStatus: 410, code: "CHECKPOINT", reason: null },
  {
    state: "transient",
    httpStatus: 503,
    code: "EXECUTOR_UNAVAILABLE",
    reason: null,
  },
] as const;

describe("recoverHttpResponse", () => {
  it.each(CASES)(
    "$state → $httpStatus with runStatus $runStatus",
    ({ state, httpStatus, runStatus }) => {
      expect(recoverHttpResponse(state)).toEqual({
        httpStatus,
        body: { ok: true, state, runStatus },
      });
    },
  );

  it.each(REFUSALS)(
    "$state → $httpStatus with typed code $code",
    ({ state, httpStatus, code, reason }) => {
      const res = recoverHttpResponse(state);

      expect(res.httpStatus).toBe(httpStatus);
      expect(res.body).toMatchObject({ code });
      expect(res.body).not.toHaveProperty("ok");
      // ADR-175: the three 409s share two codes, so an unattended caller tells
      // them apart on `details.reason` — the sanctioned discriminator.
      if (reason === null) expect(res.body).not.toHaveProperty("details");
      else expect(res.body).toMatchObject({ details: { reason } });
    },
  );

  // ADR-175: `runStatus` is the COMMITTED status. A crashed orchestrator handed
  // back to its existing child-wait gate really is `WaitingOnChildren`, and
  // reporting `Running` would publish a status the run does not have.
  it("reports the committed run status for a resumed run", () => {
    expect(
      recoverHttpResponse({ state: "resumed", runStatus: "WaitingOnChildren" }),
    ).toEqual({
      httpStatus: 200,
      body: { ok: true, state: "resumed", runStatus: "WaitingOnChildren" },
    });
    expect(recoverHttpResponse({ state: "resumed" })).toEqual({
      httpStatus: 200,
      body: { ok: true, state: "resumed", runStatus: "Running" },
    });
  });

  it("never leaks a session handle in any outcome", () => {
    for (const { state } of [...CASES, ...REFUSALS]) {
      const serialized = JSON.stringify(recoverHttpResponse(state).body);

      expect(serialized).not.toContain("acpSessionId");
      expect(serialized).not.toContain("acp_session_id");
    }
  });
});
