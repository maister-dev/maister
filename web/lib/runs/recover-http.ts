// Pure RecoverResult → HTTP projection (no "server-only", no db/clock). Shared
// by the internal recover route AND the `/api/v1/ext` recover route so the two
// surfaces can NEVER answer the same recovery outcome differently. The
// divergence this prevents is already latent: `unresumable` is `410 CHECKPOINT`
// here, while the ext surface's generic `httpStatusForExtCode` has no
// `CHECKPOINT` case and would default it to 500.
//
// The DTO NEVER carries acpSessionId or any session handle — only
// {ok, state, runStatus?} on success, {code, message} on refusal.

import type { RecoverResult } from "@/lib/runs/recover";

type RecoverState = RecoverResult["state"];

type RecoverSuccessState = Extract<
  RecoverState,
  "resumed" | "redispatched" | "queued"
>;

type RecoverRefusalState = Exclude<RecoverState, RecoverSuccessState>;

export type RecoverHttpResponse = {
  httpStatus: number;
  body:
    | { ok: true; state: RecoverSuccessState; runStatus?: string }
    | { code: string; message: string };
};

function statusForState(state: RecoverState): number {
  switch (state) {
    case "resumed":
    case "redispatched":
      return 200;
    case "queued":
      return 202;
    case "discard-only":
    case "conflict":
    case "workspace-removed":
      return 409;
    case "unresumable":
      return 410;
    case "transient":
      return 503;
  }
}

function runStatusForState(state: RecoverSuccessState): string {
  switch (state) {
    case "resumed":
    case "redispatched":
      return "Running";
    case "queued":
      return "Pending";
  }
}

// Non-success states are typed MaisterError codes (ADR-008 closed union) so API
// clients can branch on `code` per docs/error-taxonomy.md — not just the HTTP
// status. The codes match the OpenAPI 409/410/503 entries (MaisterErrorBody).
function errorBodyForState(state: RecoverRefusalState): {
  code: string;
  message: string;
} {
  switch (state) {
    case "discard-only":
      return {
        code: "CONFLICT",
        message: "run has no resumable session — discard it instead",
      };
    case "conflict":
      return {
        code: "CONFLICT",
        message:
          "run is not in Crashed — already terminal or a concurrent recover won the CAS",
      };
    case "workspace-removed":
      return {
        code: "PRECONDITION",
        message:
          "run workspace was removed; archived history cannot be recovered",
      };
    case "unresumable":
      return {
        code: "CHECKPOINT",
        message: "the stored acp session is unresumable — discard the run",
      };
    case "transient":
      return {
        code: "EXECUTOR_UNAVAILABLE",
        message: "transient supervisor failure during resume — retryable",
      };
  }
}

function isSuccessState(state: RecoverState): state is RecoverSuccessState {
  return state === "resumed" || state === "redispatched" || state === "queued";
}

export function recoverHttpResponse(state: RecoverState): RecoverHttpResponse {
  const httpStatus = statusForState(state);

  if (isSuccessState(state)) {
    return {
      httpStatus,
      body: { ok: true, state, runStatus: runStatusForState(state) },
    };
  }

  return { httpStatus, body: errorBodyForState(state) };
}
