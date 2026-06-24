import "server-only";

import pino from "pino";

const log = pino({
  name: "exec-policy",
  level: process.env.LOG_LEVEL ?? "info",
});

// Every policy-driven autonomy action funnels through this boundary so the audit
// shape stays consistent. Phase 0 records the launch; the Phase-A/B/C autonomy
// actions call it as they fire.
export type ExecPolicyActionKind =
  | "launched"
  | "permission_auto_approved"
  | "human_gate_auto_passed"
  | "check_downgraded"
  | "rework_exhausted"
  | "ralph_relaunch"
  | "auto_retried"
  | "escalated"
  | "dirty_auto_resolved"
  | "history_rewritten"
  | "budget_warned"
  | "budget_escalated"
  | "budget_restorable"
  | "budget_terminated"
  | "budget_raised";

export type ExecPolicyAuditRecord = {
  runId: string;
  kind: ExecPolicyActionKind;
  detail?: Record<string, unknown>;
};

// Returns the record so callers can both log and forward it. NOTE: the per-run
// timeline (run.events.jsonl) integration lands with the Phase-A web-side
// autonomy actions (downgraded check, ralph relaunch), where those events fire
// and the supervisor's line schema is matched. At launch the durable record is
// the runs.execution_policy snapshot + this structured line.
export function logExecPolicyAction(
  record: ExecPolicyAuditRecord,
): ExecPolicyAuditRecord {
  log.info(
    { runId: record.runId, kind: record.kind, ...(record.detail ?? {}) },
    `[exec-policy] ${record.kind}`,
  );

  return record;
}
