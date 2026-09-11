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
  { state: "discard-only", httpStatus: 409, code: "CONFLICT" },
  { state: "conflict", httpStatus: 409, code: "CONFLICT" },
  { state: "workspace-removed", httpStatus: 409, code: "PRECONDITION" },
  { state: "unresumable", httpStatus: 410, code: "CHECKPOINT" },
  { state: "transient", httpStatus: 503, code: "EXECUTOR_UNAVAILABLE" },
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
    ({ state, httpStatus, code }) => {
      const res = recoverHttpResponse(state);

      expect(res.httpStatus).toBe(httpStatus);
      expect(res.body).toMatchObject({ code });
      expect(res.body).not.toHaveProperty("ok");
    },
  );

  it("never leaks a session handle in any outcome", () => {
    for (const { state } of [...CASES, ...REFUSALS]) {
      const serialized = JSON.stringify(recoverHttpResponse(state).body);

      expect(serialized).not.toContain("acpSessionId");
      expect(serialized).not.toContain("acp_session_id");
    }
  });
});
