import type { SchedulerJobKind } from "@/lib/db/schema";

export type SchedulerCommandKind = "http_ping" | "console_ping";

export type SchedulerCommandHttpPingTarget = {
  commandKind: "http_ping";
  timeoutMs?: number;
  url: string;
};

export type SchedulerCommandConsolePingTarget = {
  commandKind: "console_ping";
  host: string;
  timeoutMs?: number;
};

export type SchedulerCommandTarget =
  | SchedulerCommandHttpPingTarget
  | SchedulerCommandConsolePingTarget;

export type SchedulerFlowRunTarget = {
  baseBranch?: string;
  runnerId?: string;
  targetBranch?: string;
  taskId: string;
};

export type SchedulerNoTarget = Record<string, never>;

export type SchedulerJobTarget =
  | SchedulerCommandTarget
  | SchedulerFlowRunTarget
  | SchedulerNoTarget;

export type SchedulerTargetSummary =
  | {
      ok: true;
      summary: string;
    }
  | {
      errorMessage: string;
      ok: false;
    };

export type SchedulerCommandTargetDraft = {
  commandKind?: SchedulerCommandKind;
  host?: string | null;
  timeoutMs?: number | string | null;
  url?: string | null;
};

export type SchedulerFlowRunTargetDraft = {
  baseBranch?: string | null;
  runnerId?: string | null;
  targetBranch?: string | null;
  taskId?: string | null;
};

export type SchedulerTargetDraft =
  | SchedulerCommandTargetDraft
  | SchedulerFlowRunTargetDraft
  | Record<string, unknown>;

const HTTP_PING_TARGET_KEYS = new Set(["commandKind", "timeoutMs", "url"]);
const CONSOLE_PING_TARGET_KEYS = new Set(["commandKind", "host", "timeoutMs"]);
const FLOW_RUN_TARGET_KEYS = new Set([
  "baseBranch",
  "runnerId",
  "targetBranch",
  "taskId",
]);
const NO_TARGET_KEYS = new Set<string>();

export function buildCommandTarget(
  draft: SchedulerCommandTargetDraft,
): SchedulerCommandTarget {
  const commandKind = draft.commandKind ?? "http_ping";
  const timeoutMs = normalizeOptionalTimeout(draft.timeoutMs);

  if (commandKind === "http_ping") {
    const url = requireTrimmedString(draft.url, "command http_ping url");

    assertHttpUrl(url);

    return timeoutMs === undefined
      ? { commandKind, url }
      : { commandKind, timeoutMs, url };
  }

  const host = requireTrimmedString(draft.host, "command console_ping host");

  if (!isSafePingHost(host)) {
    throw new Error(
      "command console_ping host must be a hostname or IP literal without option-like labels",
    );
  }

  return timeoutMs === undefined
    ? { commandKind, host }
    : { commandKind, host, timeoutMs };
}

export function buildFlowRunTarget(
  draft: SchedulerFlowRunTargetDraft,
): SchedulerFlowRunTarget {
  const taskId = requireTrimmedString(draft.taskId, "flow_run task id");
  const runnerId = optionalTrimmedString(draft.runnerId);
  const baseBranch = optionalTrimmedString(draft.baseBranch);
  const targetBranch = optionalTrimmedString(draft.targetBranch);

  return {
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(runnerId === undefined ? {} : { runnerId }),
    ...(targetBranch === undefined ? {} : { targetBranch }),
    taskId,
  };
}

export function normalizeSchedulerTargetDraft(args: {
  draft: SchedulerTargetDraft;
  jobKind: SchedulerJobKind;
}): SchedulerJobTarget {
  if (args.jobKind === "command") {
    return buildCommandTarget(commandDraftFromUnknown(args.draft));
  }
  if (args.jobKind === "flow_run") {
    return buildFlowRunTarget(flowRunDraftFromUnknown(args.draft));
  }

  assertAllowedTargetKeys(
    recordFromUnknown(args.draft),
    `${args.jobKind} target`,
    NO_TARGET_KEYS,
  );

  return {};
}

export function summarizeSchedulerTarget(args: {
  jobKind: SchedulerJobKind;
  target: Record<string, unknown>;
}): string {
  if (args.jobKind === "command") {
    const target = buildCommandTarget(commandDraftFromUnknown(args.target));

    if (target.commandKind === "http_ping") {
      return target.timeoutMs === undefined
        ? `HTTP ping ${target.url}`
        : `HTTP ping ${target.url} · ${target.timeoutMs}ms`;
    }

    return target.timeoutMs === undefined
      ? `Host ping ${target.host}`
      : `Host ping ${target.host} · ${target.timeoutMs}ms`;
  }

  if (args.jobKind === "flow_run") {
    const target = buildFlowRunTarget(flowRunDraftFromUnknown(args.target));
    const runner = target.runnerId ? ` · runner ${target.runnerId}` : "";

    return `Flow run task ${target.taskId}${runner}`;
  }

  return "No target";
}

export function summarizeSchedulerTargetForDisplay(args: {
  jobKind: SchedulerJobKind;
  target: Record<string, unknown>;
}): SchedulerTargetSummary {
  try {
    return { ok: true, summary: summarizeSchedulerTarget(args) };
  } catch (err) {
    return {
      errorMessage: err instanceof Error ? err.message : String(err),
      ok: false,
    };
  }
}

export function isSafePingHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.startsWith("-")) return false;
  if (host.includes("..")) return false;

  return host.split(".").every((label) => {
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label);
  });
}

function commandDraftFromUnknown(
  draft: SchedulerTargetDraft,
): SchedulerCommandTargetDraft {
  const record = recordFromUnknown(draft);
  const commandKind = optionalCommandKind(record.commandKind) ?? "http_ping";
  const allowedKeys =
    commandKind === "http_ping"
      ? HTTP_PING_TARGET_KEYS
      : CONSOLE_PING_TARGET_KEYS;

  assertAllowedTargetKeys(record, `command ${commandKind} target`, allowedKeys);

  return {
    commandKind,
    host: optionalString(record.host),
    timeoutMs: optionalNumberOrString(record.timeoutMs, "command timeout"),
    url: optionalString(record.url),
  };
}

function flowRunDraftFromUnknown(
  draft: SchedulerTargetDraft,
): SchedulerFlowRunTargetDraft {
  const record = recordFromUnknown(draft);

  assertAllowedTargetKeys(record, "flow_run target", FLOW_RUN_TARGET_KEYS);

  return {
    baseBranch: optionalString(record.baseBranch),
    runnerId: optionalString(record.runnerId),
    targetBranch: optionalString(record.targetBranch),
    taskId: optionalString(record.taskId),
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scheduler target must be an object");
  }

  return value as Record<string, unknown>;
}

function assertAllowedTargetKeys(
  record: Record<string, unknown>,
  label: string,
  allowedKeys: ReadonlySet<string>,
): void {
  const unknownKeys = Object.keys(record)
    .filter((key) => !allowedKeys.has(key))
    .sort();

  if (unknownKeys.length === 0) return;

  throw new Error(
    `${label} has unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
  );
}

function optionalCommandKind(value: unknown): SchedulerCommandKind | undefined {
  if (value === undefined) return undefined;
  if (value === "http_ping" || value === "console_ping") return value;

  throw new Error(
    "command target commandKind must be http_ping or console_ping",
  );
}

function optionalNumberOrString(
  value: unknown,
  label: string,
): number | string | null | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  throw new Error(`${label} must be a positive finite number`);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }

  throw new Error("scheduler target field must be a string");
}

function optionalTrimmedString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requireTrimmedString(
  value: string | null | undefined,
  label: string,
): string {
  const trimmed = optionalTrimmedString(value);

  if (trimmed === undefined) {
    throw new Error(`${label} is required`);
  }

  return trimmed;
}

function normalizeOptionalTimeout(
  value: number | string | null | undefined,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;

  const normalized = typeof value === "number" ? value : Number(value.trim());

  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("command timeoutMs must be a positive finite number");
  }

  return normalized;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("command http_ping url must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("command http_ping url must use the http or https scheme");
  }
}
