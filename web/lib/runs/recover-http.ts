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
    | { code: string; message: string; details?: { reason: string } };
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

// ADR-175: the COMMITTED status, not a constant derived from the outcome. The
// orchestrator wait arm hands a run back while leaving it `WaitingOnChildren`,
// so a derived `"Running"` would publish a status the run does not have. The
// result carries the committed value when it differs; the switch stays
// exhaustive, so a new state is still a compile error.
function runStatusForState(
  state: RecoverSuccessState,
  committed: string | undefined,
): string {
  switch (state) {
    case "resumed":
      return committed ?? "Running";
    case "redispatched":
      return "Running";
    case "queued":
      return "Pending";
  }
}

// Non-success states are typed MaisterError codes (ADR-008 closed union) so API
// clients can branch on `code` per docs/error-taxonomy.md — not just the HTTP
// status. The codes match the OpenAPI 409/410/503 entries (MaisterErrorBody).
// ADR-175: three outcomes answer 409 and two of them share `CONFLICT`, so an
// unattended caller could not tell "retry later" from "this run is
// unrecoverable". `details.reason` is the sanctioned discriminator (the UI still
// branches on `code`); the tokens are registered in docs/error-taxonomy.md.
function errorBodyForState(state: RecoverRefusalState): {
  code: string;
  message: string;
  details?: { reason: string };
} {
  switch (state) {
    case "discard-only":
      return {
        code: "CONFLICT",
        message: "run has no resumable session — discard it instead",
        details: { reason: "discard_only" },
      };
    case "conflict":
      return {
        code: "CONFLICT",
        message:
          "run is not in Crashed — already terminal or a concurrent recover won the CAS",
        details: { reason: "recover_cas_lost" },
      };
    case "workspace-removed":
      return {
        code: "PRECONDITION",
        message:
          "run workspace was removed; archived history cannot be recovered",
        details: { reason: "workspace_removed" },
      };
    case "unresumable":
      return {
        code: "CHECKPOINT",
        message: "the recover dispatch failed unrecoverably — discard the run",
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

export function recoverHttpResponse(
  result: RecoverResult,
): RecoverHttpResponse {
  const { state } = result;
  const committed = result.state === "resumed" ? result.runStatus : undefined;
  const httpStatus = statusForState(state);

  if (isSuccessState(state)) {
    return {
      httpStatus,
      body: {
        ok: true,
        state,
        runStatus: runStatusForState(state, committed),
      },
    };
  }

  return { httpStatus, body: errorBodyForState(state) };
}
