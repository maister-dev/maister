import { MaisterError } from "@/lib/errors-core";

export type BudgetBreachMeter = "tokens" | "failures" | "wallclock";
export type BudgetBreachScope = "run" | "task" | "tree";
export type BudgetBreachDecisionId = "raise" | "restart" | "park" | "abandon";
export type BudgetBreachParkMode = "snapshot" | "export";
export type BudgetBreachClaimStage =
  | "claimed"
  | "preserving"
  | "terminalized"
  | "failed"
  | "relaunch_failed";

export type BudgetBreachRunKind = "flow" | "agent" | "scratch";
export type BudgetBreachRunStatus =
  | "Pending"
  | "Running"
  | "NeedsInput"
  | "NeedsInputIdle"
  | "HumanWorking"
  | "WaitingOnChildren"
  | "Review"
  | "Crashed"
  | "Done"
  | "Abandoned"
  | "Failed";
export type BudgetBreachAgentWorkspace =
  | "none"
  | "repo_read"
  | "worktree"
  | null;

export type BudgetBreachRaiseDecision = {
  optionId: "raise";
  dimension: BudgetBreachMeter;
  newLimit: number;
};

export type BudgetBreachRestartDecision = {
  optionId: "restart";
};

export type BudgetBreachParkDecision = {
  optionId: "park";
  mode: BudgetBreachParkMode;
  branchName: string | null;
};

export type BudgetBreachAbandonDecision = {
  optionId: "abandon";
  dropWorkspace: boolean;
};

export type BudgetBreachDecision =
  | BudgetBreachRaiseDecision
  | BudgetBreachRestartDecision
  | BudgetBreachParkDecision
  | BudgetBreachAbandonDecision;

export type BudgetBreachStagedDecision = BudgetBreachDecision & {
  stage: BudgetBreachClaimStage;
  ref?: string;
  error?: string;
};

export type BudgetBreachResponsePayload = BudgetBreachDecision;

export type BudgetBreachAvailabilityContext = {
  runKind: BudgetBreachRunKind;
  status: BudgetBreachRunStatus;
  taskId: string | null;
  flowId: string | null;
  agentId: string | null;
  parentRunId: string | null;
  agentWorkspace: BudgetBreachAgentWorkspace;
  hasOwnedWorkspace: boolean;
};

export type BudgetBreachAvailableOption = {
  optionId: BudgetBreachDecisionId;
  label: string;
  helperText: string;
  destructive: boolean;
  dropAllowed: boolean;
  requiresBranchName: boolean;
  modes: BudgetBreachParkMode[];
};

export type BudgetBreachBudgetObservation = {
  limit: number | null;
  spent: number | null;
  source: "value" | "no-data";
};

export type BudgetBreachProgressInput = {
  schema: unknown;
  budgetByDimension: Record<BudgetBreachMeter, BudgetBreachBudgetObservation>;
  nodes: {
    completed: number | null;
    total: number | null;
    currentNodeId: string | null;
  };
  diff: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  } | null;
  gates: {
    open: number;
    satisfied: number;
    failed: number;
    unknown: number;
  };
  wallclockMinutes: number | null;
  resumeCount: number;
};

export type BudgetBreachSchemaView = {
  scope: BudgetBreachScope;
  meter: BudgetBreachMeter;
  current: number;
  limit: number;
};

export type BudgetBreachProgressDto = {
  breach: {
    dimension: BudgetBreachMeter;
    limit: number;
    spent: number;
    overshootPct: number;
  };
  budgetByDimension: Record<BudgetBreachMeter, BudgetBreachBudgetObservation>;
  nodes: {
    completed: number | null;
    total: number | null;
    currentNodeId: string | null;
  };
  diff: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  } | null;
  gates: BudgetBreachProgressInput["gates"];
  wallclockMinutes: number | null;
  resumeCount: number;
};

export type BudgetBreachParseContext = {
  breachedMeter: BudgetBreachMeter;
  breachedLimit: number;
};

export type BudgetBreachClaimInput = {
  storedResponse: unknown;
  respondedAt: Date | null;
  incoming: BudgetBreachDecision;
};

export type BudgetBreachClaimVerdict =
  | { kind: "fresh" }
  | { kind: "idempotent" }
  | { kind: "re-drive"; stage: BudgetBreachClaimStage }
  | { kind: "re-claimable" }
  | { kind: "conflict" };

export type BudgetBreachPolicyField =
  | "maxTokens"
  | "consecutiveFailures"
  | "wallClockMinutes";

const BUDGET_METER_FIELD: Record<BudgetBreachMeter, BudgetBreachPolicyField> = {
  tokens: "maxTokens",
  failures: "consecutiveFailures",
  wallclock: "wallClockMinutes",
};

const DECISION_IDS = new Set<BudgetBreachDecisionId>([
  "raise",
  "restart",
  "park",
  "abandon",
]);

const ACTIVE_STATUSES = new Set(["NeedsInput", "NeedsInputIdle"]);
const ACTIVE_CLAIM_STAGES = new Set<BudgetBreachClaimStage>([
  "claimed",
  "preserving",
  "terminalized",
]);

export function budgetMeterToPolicyField(
  meter: BudgetBreachMeter,
): BudgetBreachPolicyField {
  return BUDGET_METER_FIELD[meter];
}

export function getBudgetBreachAvailableOptions(
  context: BudgetBreachAvailabilityContext,
): BudgetBreachAvailableOption[] {
  const optionIds: BudgetBreachDecisionId[] = [
    "raise",
    ...(isRestartAvailable(context) ? (["restart"] as const) : []),
    ...(isParkAvailable(context) ? (["park"] as const) : []),
    "abandon",
  ];

  return optionIds.map((optionId) => buildAvailableOption(optionId, context));
}

export function assertBudgetBreachOptionAvailable(
  optionId: BudgetBreachDecisionId,
  context: BudgetBreachAvailabilityContext,
): void {
  if (!ACTIVE_STATUSES.has(context.status)) {
    throw new MaisterError(
      "PRECONDITION",
      `budget_breach option unavailable for run status ${context.status}`,
    );
  }

  const available = getBudgetBreachAvailableOptions(context).some(
    (option) => option.optionId === optionId,
  );

  if (!available) {
    throw new MaisterError(
      "PRECONDITION",
      `budget_breach option unavailable: ${optionId}`,
    );
  }
}

export function parseBudgetBreachResponse(
  body: unknown,
  context: BudgetBreachParseContext,
): BudgetBreachDecision {
  const record = asRecord(body, "budget_breach response body");
  const optionId = parseOptionId(record.optionId);

  if (optionId === "raise") {
    return parseRaiseDecision(record, context);
  }

  if (optionId === "restart") {
    return { optionId: "restart" };
  }

  if (optionId === "park") {
    return parseParkDecision(record);
  }

  return parseAbandonDecision(record);
}

export function budgetBreachProgressFromInput(
  input: BudgetBreachProgressInput,
): BudgetBreachProgressDto | null {
  const schema = budgetBreachSchemaView(input.schema);

  if (schema === null) {
    return null;
  }

  return {
    breach: {
      dimension: schema.meter,
      limit: schema.limit,
      spent: schema.current,
      overshootPct: overshootPct(schema.current, schema.limit),
    },
    budgetByDimension: input.budgetByDimension,
    nodes: input.nodes,
    diff: input.diff,
    gates: input.gates,
    wallclockMinutes: input.wallclockMinutes,
    resumeCount: input.resumeCount,
  };
}

export function budgetBreachSchemaView(
  schema: unknown,
): BudgetBreachSchemaView | null {
  const record = asRecordOrNull(schema);

  if (record === null || record.kind !== "budget_breach") {
    return null;
  }

  const scope = parseScopeOrNull(record.scope);
  const meter = parseMeterOrNull(record.meter);
  const current = parseIntegerOrNull(record.current);
  const limit = parseIntegerOrNull(record.limit);

  if (
    scope === null ||
    meter === null ||
    current === null ||
    limit === null ||
    limit <= 0
  ) {
    return null;
  }

  return { scope, meter, current, limit };
}

export function budgetBreachClaimStage(
  value: unknown,
): BudgetBreachClaimStage | null {
  const record = asRecordOrNull(value);

  if (record === null) {
    return null;
  }

  return parseStageOrNull(record.stage);
}

export function budgetBreachClaimRef(value: unknown): string | null {
  const record = asRecordOrNull(value);

  if (record === null || typeof record.ref !== "string") {
    return null;
  }

  const ref = record.ref.trim();

  return ref.length > 0 ? ref : null;
}

export function isActiveBudgetBreachClaim(value: unknown): boolean {
  const stage = budgetBreachClaimStage(value);

  return stage !== null && ACTIVE_CLAIM_STAGES.has(stage);
}

export function evaluateBudgetBreachClaim(
  input: BudgetBreachClaimInput,
): BudgetBreachClaimVerdict {
  if (input.storedResponse === null) {
    return input.respondedAt === null
      ? { kind: "fresh" }
      : { kind: "idempotent" };
  }

  const stored = normalizeStoredDecision(input.storedResponse);

  if (stored === null) {
    return { kind: "conflict" };
  }

  if (input.respondedAt !== null) {
    return equalDecisionPayload(stored, input.incoming)
      ? { kind: "idempotent" }
      : { kind: "conflict" };
  }

  if (stored.stage === "failed") {
    return { kind: "re-claimable" };
  }

  if (!equalDecisionPayload(stored, input.incoming)) {
    return { kind: "conflict" };
  }

  return { kind: "re-drive", stage: stored.stage };
}

function buildAvailableOption(
  optionId: BudgetBreachDecisionId,
  context: BudgetBreachAvailabilityContext,
): BudgetBreachAvailableOption {
  return {
    optionId,
    label: optionId,
    helperText: optionId,
    destructive: optionId === "abandon",
    dropAllowed: optionId === "abandon" && context.hasOwnedWorkspace,
    requiresBranchName: optionId === "park",
    modes: optionId === "park" ? ["snapshot", "export"] : [],
  };
}

function isRestartAvailable(context: BudgetBreachAvailabilityContext): boolean {
  if (context.parentRunId !== null || context.taskId === null) {
    return false;
  }

  if (context.runKind === "flow") {
    return context.flowId !== null;
  }

  return (
    context.runKind === "agent" &&
    context.agentId !== null &&
    context.agentWorkspace === "worktree"
  );
}

function isParkAvailable(context: BudgetBreachAvailabilityContext): boolean {
  if (!context.hasOwnedWorkspace || context.parentRunId !== null) {
    return false;
  }

  if (context.runKind === "agent") {
    return context.agentWorkspace === "worktree";
  }

  return context.runKind === "flow" || context.runKind === "scratch";
}

function parseRaiseDecision(
  body: Record<string, unknown>,
  context: BudgetBreachParseContext,
): BudgetBreachRaiseDecision {
  const response =
    body.response === undefined || body.response === null
      ? null
      : asRecordOrNull(body.response);

  if (
    body.response !== undefined &&
    body.response !== null &&
    response === null &&
    typeof body.response !== "number" &&
    typeof body.response !== "string"
  ) {
    throw new MaisterError("PRECONDITION", "raise response must be an object");
  }

  const rawLimit = response?.newLimit ?? body.raiseTo ?? body.response;
  const newLimit = parsePositiveInteger(
    rawLimit,
    "budget_breach raise newLimit",
  );
  const rawDimension = response?.dimension;
  const dimension =
    rawDimension === undefined
      ? context.breachedMeter
      : parseMeter(rawDimension);

  if (dimension !== context.breachedMeter) {
    throw new MaisterError(
      "PRECONDITION",
      `budget_breach raise dimension ${dimension} does not match breached meter ${context.breachedMeter}`,
    );
  }

  if (newLimit <= context.breachedLimit) {
    throw new MaisterError(
      "PRECONDITION",
      `budget_breach raise requires a newLimit greater than ${context.breachedLimit}`,
    );
  }

  return { optionId: "raise", dimension, newLimit };
}

function parseParkDecision(
  body: Record<string, unknown>,
): BudgetBreachParkDecision {
  const response = asRecord(body.response ?? {}, "park response");
  const mode = parseParkMode(response.mode ?? "snapshot");
  const branchName =
    response.branchName === undefined || response.branchName === null
      ? null
      : parseNonEmptyString(response.branchName, "park branchName");

  if (mode === "export" && branchName === null) {
    throw new MaisterError(
      "PRECONDITION",
      "budget_breach park export requires branchName",
    );
  }

  return { optionId: "park", mode, branchName };
}

function parseAbandonDecision(
  body: Record<string, unknown>,
): BudgetBreachAbandonDecision {
  const response =
    body.response === undefined || body.response === null
      ? null
      : asRecord(body.response, "abandon response");
  const dropWorkspace = parseOptionalBoolean(
    response?.dropWorkspace ?? body.dropWorkspace,
    false,
    "abandon dropWorkspace",
  );

  return { optionId: "abandon", dropWorkspace };
}

function normalizeStoredDecision(
  value: unknown,
): BudgetBreachStagedDecision | null {
  const record = asRecordOrNull(value);

  if (record === null) {
    return null;
  }

  const optionId = parseOptionIdOrNull(record.optionId);

  if (optionId === null) {
    return null;
  }

  const stage = parseStageOrNull(record.stage) ?? "claimed";

  if (optionId === "raise") {
    const dimension = parseMeterOrNull(record.dimension);
    const newLimit = parseIntegerOrNull(record.newLimit);

    return dimension === null || newLimit === null
      ? null
      : { optionId, dimension, newLimit, stage };
  }

  if (optionId === "restart") {
    return { optionId, stage };
  }

  if (optionId === "park") {
    const mode = parseParkModeOrNull(record.mode);
    const branchName =
      record.branchName === undefined || record.branchName === null
        ? null
        : typeof record.branchName === "string"
          ? record.branchName
          : undefined;

    return mode === null || branchName === undefined
      ? null
      : { optionId, mode, branchName, stage };
  }

  return {
    optionId,
    dropWorkspace: record.dropWorkspace === true,
    stage,
  };
}

function equalDecisionPayload(
  stored: BudgetBreachStagedDecision,
  incoming: BudgetBreachDecision,
): boolean {
  if (stored.optionId !== incoming.optionId) {
    return false;
  }

  if (stored.optionId === "raise" && incoming.optionId === "raise") {
    return (
      stored.dimension === incoming.dimension &&
      stored.newLimit === incoming.newLimit
    );
  }

  if (stored.optionId === "park" && incoming.optionId === "park") {
    return (
      stored.mode === incoming.mode && stored.branchName === incoming.branchName
    );
  }

  if (stored.optionId === "abandon" && incoming.optionId === "abandon") {
    return stored.dropWorkspace === incoming.dropWorkspace;
  }

  return stored.optionId === "restart";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecordOrNull(value);

  if (record === null) {
    throw new MaisterError("PRECONDITION", `${label} must be an object`);
  }

  return record;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOptionId(value: unknown): BudgetBreachDecisionId {
  const optionId = parseOptionIdOrNull(value);

  if (optionId === null) {
    throw new MaisterError(
      "PRECONDITION",
      "budget_breach optionId is required",
    );
  }

  return optionId;
}

function parseOptionIdOrNull(value: unknown): BudgetBreachDecisionId | null {
  return typeof value === "string" &&
    DECISION_IDS.has(value as BudgetBreachDecisionId)
    ? (value as BudgetBreachDecisionId)
    : null;
}

function parseMeter(value: unknown): BudgetBreachMeter {
  const meter = parseMeterOrNull(value);

  if (meter === null) {
    throw new MaisterError("PRECONDITION", "invalid budget_breach dimension");
  }

  return meter;
}

function parseMeterOrNull(value: unknown): BudgetBreachMeter | null {
  return value === "tokens" || value === "failures" || value === "wallclock"
    ? value
    : null;
}

function parseScopeOrNull(value: unknown): BudgetBreachScope | null {
  return value === "run" || value === "task" || value === "tree" ? value : null;
}

function parseParkMode(value: unknown): BudgetBreachParkMode {
  const mode = parseParkModeOrNull(value);

  if (mode === null) {
    throw new MaisterError("PRECONDITION", "invalid budget_breach park mode");
  }

  return mode;
}

function parseParkModeOrNull(value: unknown): BudgetBreachParkMode | null {
  return value === "snapshot" || value === "export" ? value : null;
}

function parseStageOrNull(value: unknown): BudgetBreachClaimStage | null {
  return value === "claimed" ||
    value === "preserving" ||
    value === "terminalized" ||
    value === "failed" ||
    value === "relaunch_failed"
    ? value
    : null;
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parseIntegerInputOrNull(value);

  if (parsed === null || parsed <= 0) {
    throw new MaisterError(
      "PRECONDITION",
      `${label} must be a positive integer`,
    );
  }

  return parsed;
}

function overshootPct(spent: number, limit: number): number {
  return Math.max(0, Math.round(((spent - limit) / limit) * 100));
}

function parseIntegerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value;
}

function parseIntegerInputOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }

  if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `${label} must be a non-empty string`,
    );
  }

  return value.trim();
}

function parseOptionalBoolean(
  value: unknown,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new MaisterError("PRECONDITION", `${label} must be a boolean`);
  }

  return value;
}
