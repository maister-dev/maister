import type {
  ActivityPulseItem,
  ActivitySalience,
  PulseEventKind,
} from "@/lib/ext-activity/types";

type DomainEventActivityRow = {
  id: bigint;
  kind: PulseEventKind;
  occurredAt: Date;
  runId: string | null;
  taskId: string | null;
  taskKey: string | null;
  payload: Record<string, unknown> | null;
};

type DomainEventMapping = {
  salience: ActivitySalience;
  action: ActivityPulseItem["action"];
  summary: string;
  gateId?: string | null;
  hitlRequestId?: string | null;
};

function taskLabel(row: DomainEventActivityRow): string {
  return row.taskKey ?? row.taskId ?? "task";
}

function stringField(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapDomainEvent(row: DomainEventActivityRow): DomainEventMapping {
  switch (row.kind) {
    case "task.created":
      return {
        salience: "high",
        action: { verb: "create", object: `task ${taskLabel(row)}`, outcome: "created" },
        summary: `created task ${taskLabel(row)}`,
      };
    case "task.comment_added":
      return {
        salience: "high",
        action: { verb: "comment", object: `task ${taskLabel(row)}`, outcome: "added" },
        summary: `added a comment on ${taskLabel(row)}`,
      };
    case "task.triage_requeued":
      return {
        salience: "high",
        action: { verb: "requeue", object: `task ${taskLabel(row)}`, outcome: "triage" },
        summary: `requeued ${taskLabel(row)} for triage`,
      };
    case "task.clarification_answered":
      return {
        salience: "high",
        action: { verb: "answer", object: `clarification for ${taskLabel(row)}`, outcome: "answered" },
        summary: `answered a clarification for ${taskLabel(row)}`,
        hitlRequestId: stringField(row.payload, "hitlRequestId"),
      };
    case "run.done":
      return {
        salience: "high",
        action: { verb: "finish", object: "run", outcome: "done" },
        summary: `run ${row.runId ?? ""} completed`.trim(),
      };
    case "run.failed":
      return {
        salience: "high",
        action: { verb: "finish", object: "run", outcome: "failed" },
        summary: `run ${row.runId ?? ""} failed`.trim(),
      };
    case "run.crashed":
      return {
        salience: "high",
        action: { verb: "finish", object: "run", outcome: "crashed" },
        summary: `run ${row.runId ?? ""} crashed`.trim(),
      };
    case "run.abandoned":
      return {
        salience: "high",
        action: { verb: "finish", object: "run", outcome: "abandoned" },
        summary: `run ${row.runId ?? ""} was abandoned`.trim(),
      };
    case "run.review":
      return {
        salience: "high",
        action: { verb: "finish", object: "run", outcome: "review" },
        summary: `run ${row.runId ?? ""} reached review`.trim(),
      };
    case "run.escalated":
      return {
        salience: "high",
        action: { verb: "escalate", object: "run", outcome: "needs attention" },
        summary: `run ${row.runId ?? ""} escalated`.trim(),
      };
    // ADR-159: the operator rework round-trip. `PulseEventKind` is an alias of
    // `DomainEventKind`, so these cases are load-bearing — without them this
    // exhaustive switch stops compiling the moment the taxonomy widens.
    case "run.rework_claimed":
      return {
        salience: "high",
        action: { verb: "claim", object: "run", outcome: "taken for rework" },
        summary: `run ${row.runId ?? ""} was taken back for rework`.trim(),
      };
    case "run.rework_returned":
      return {
        salience: "high",
        action: { verb: "return", object: "run", outcome: "returned to flow" },
        summary: `run ${row.runId ?? ""} was returned to the flow`.trim(),
      };
    case "gate.failed": {
      const gateId = stringField(row.payload, "gateId");

      return {
        salience: "high",
        action: {
          verb: "fail",
          object: gateId ? `gate ${gateId}` : "gate",
          outcome: "failed",
        },
        summary: gateId
          ? `gate ${gateId} failed`
          : "a gate failed",
        gateId,
      };
    }
  }
}

export function mapDomainEventToPulseItem(
  row: DomainEventActivityRow,
): ActivityPulseItem {
  const mapped = mapDomainEvent(row);

  return {
    id: row.id.toString(10),
    ts: row.occurredAt,
    kind: row.kind,
    salience: mapped.salience,
    summary: mapped.summary,
    action: mapped.action,
    runId: row.runId,
    taskId: row.taskId,
    taskKey: row.taskKey,
    hitlRequestId: mapped.hitlRequestId ?? null,
    gateId: mapped.gateId ?? null,
  };
}
