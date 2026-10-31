export type AgentTriggerAttemptOutcome =
  | "launched"
  | "queued"
  | "refused"
  | "deduplicated"
  | "suppressed"
  | "failed"
  | "unknown";

export type AgentTriggerBindingSnapshot = {
  version: 1;
  scheduleId: string;
  triggerType: "cron" | "event" | "mention";
  cronExpr: string | null;
  timezone: string | null;
  eventKinds: string[];
};
