import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";
import type {
  BudgetBreachAvailableOption,
  BudgetBreachClaimStage,
  BudgetBreachParkMode,
  BudgetBreachProgressDto,
} from "@/lib/runs/budget-breach-fork";

import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUturnRightIcon,
  ExclamationTriangleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

export interface HitlDecisionControlsLabels {
  criticalityLabel: string;
  "criticality.low": string;
  "criticality.medium": string;
  "criticality.high": string;
  "criticality.critical": string;
  confidenceLabel: string;
  reviewComments: string;
  decisionApprove: string;
  decisionRework: string;
  sendBackWithComments: string;
  responseLabel: string;
  responseHint: string;
  schemaLabel: string;
  submit: string;
  reviewCommentsPlaceholder: string;
  formInstructions: string;
  formCustomPlaceholder: string;
  // ADR-071 gate-panel additions — `$count`/`$n`/`$m` templates (house
  // pattern, see flow-graph-view formatCount). Optional so pre-ADR-071
  // consumers keep compiling without them.
  reviewOpenCount?: string;
  reviewOutdatedCount?: string;
  reviewLoopChip?: string;
  reviewApproveOpenWarn?: string;
  reviewReworkExhausted?: string;
  // A2 infra_recovery (auto_retry exhaustion) — retry/abandon button labels.
  infraRecoveryRetry?: string;
  infraRecoveryAbandon?: string;
  // Cost-budget governance budget_breach card (ESCALATE rung). Optional so
  // pre-feature consumers keep compiling without them.
  budgetBreachTitle?: string;
  budgetNewCeiling?: string;
  budgetRaiseResume?: string;
  budgetRestart?: string;
  budgetPark?: string;
  budgetAbandon?: string;
  budgetDropWorkspace?: string;
  budgetParkModeSnapshot?: string;
  budgetParkModeExport?: string;
  budgetParkBranchName?: string;
  budgetParkBranchPlaceholder?: string;
  budgetProgressLabel?: string;
  budgetProgressBudget?: string;
  budgetProgressNodes?: string;
  budgetProgressDiff?: string;
  budgetProgressGates?: string;
  budgetProgressWallclock?: string;
  budgetProgressResumes?: string;
  budgetProgressNoData?: string;
  budgetClaimStage?: string;
  "budgetClaimStage.claimed"?: string;
  "budgetClaimStage.preserving"?: string;
  "budgetClaimStage.terminalized"?: string;
  "budgetClaimStage.failed"?: string;
  "budgetClaimStage.relaunch_failed"?: string;
  // `$scope`/`$meter`/`$current`/`$limit` template (house `$`-token pattern).
  budgetBreachSummary?: string;
  "budgetScope.run"?: string;
  "budgetScope.task"?: string;
  "budgetScope.tree"?: string;
  "budgetMeter.tokens"?: string;
  "budgetMeter.failures"?: string;
  "budgetMeter.wallclock"?: string;
  // Guardrail-hook trip card (ADR-108 / M40) — resume/abort + the tripped rule
  // and the offending tool call. Optional so pre-feature consumers keep
  // compiling without them. `$rule`/`$title` `$`-token templates.
  hookTripTitle?: string;
  hookTripSummary?: string;
  "hookTripRule.repetition"?: string;
  "hookTripRule.no_progress"?: string;
  hookTripToolCall?: string;
  hookTripResume?: string;
  hookTripAbort?: string;
  // Consensus resolution card (M41): bounded draft/disagreement context plus
  // purpose-built decisions. Optional to keep older callers source-compatible.
  consensusTitle?: string;
  consensusRound?: string;
  consensusDrafts?: string;
  consensusDisagreements?: string;
  consensusNoDisagreements?: string;
  consensusDebateLog?: string;
  consensusDraftFallback?: string;
  consensusPickDraft?: string;
  consensusResolutionLabel?: string;
  consensusResolutionPlaceholder?: string;
  consensusProvideResolution?: string;
  consensusRerunRound?: string;
  consensusAbort?: string;
}

export interface ReviewSchema {
  allowedDecisions?: string[];
  transitions?: Record<string, string>;
  reworkTargets?: string[];
  workspacePolicies?: string[];
  // ADR-071: server-stamped at gate creation (runner-graph). maxLoops = the
  // node's rework bound (null when no rework declared); gateAttempt = the
  // 1-based visit number of this gate. Absent on pre-ADR-071 rows.
  maxLoops?: number | null;
  gateAttempt?: number;
}

export interface ReviewLoopInfo {
  gateAttempt: number;
  // Total allowed gate visits = maxLoops + 1 (the initial visit is attempt 1).
  totalVisits: number;
  // Mirrors the hitl-validate exhaustion rule: rework is rejected (422) when
  // gateAttempt > maxLoops — the UI disables it at the same boundary.
  exhausted: boolean;
}

// Loop visibility (ADR-071 D5): both fields must be server-stamped numbers —
// a legacy row (fields absent) or a no-rework node (maxLoops null) yields
// null: no chip, no boundary. Exactly the validate-rule applicability check.
export function reviewLoopInfo(
  reviewSchema: ReviewSchema | null,
): ReviewLoopInfo | null {
  if (!reviewSchema) return null;

  const { maxLoops, gateAttempt } = reviewSchema;

  if (typeof maxLoops !== "number" || typeof gateAttempt !== "number") {
    return null;
  }

  return {
    gateAttempt,
    totalVisits: maxLoops + 1,
    exhausted: gateAttempt > maxLoops,
  };
}

export interface ReviewThreadCountsView {
  openCount: number;
  outdatedCount: number;
}

// A single field view derived from a stored `form_schema` doc (config.schema
// `formSchemaSchema`). Narrowed structurally so the pure presentational layer
// stays decoupled from the server-side Zod type.
export interface HitlFormFieldView {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

// A `form` HITL renders option buttons + free-text per field ONLY when the
// stored schema is a form-schema doc with a non-empty `fields[]`. Any other
// schema (or a non-form kind) falls back to the raw-JSON response textarea.
export function formFieldsFromSchema(
  schema: unknown,
): HitlFormFieldView[] | null {
  if (!schema || typeof schema !== "object") return null;
  const fields = (schema as { fields?: unknown }).fields;

  if (!Array.isArray(fields) || fields.length === 0) return null;

  const views = fields.filter(
    (f): f is HitlFormFieldView =>
      !!f &&
      typeof f === "object" &&
      typeof (f as { name?: unknown }).name === "string",
  );

  return views.length > 0 ? views : null;
}

export interface HitlDecisionControlsProps {
  kind:
    | "permission"
    | "form"
    | "human"
    | "infra_recovery"
    | "budget_breach"
    | "hook_trip";
  reviewSchema: ReviewSchema | null;
  options: HitlOption[];
  schema: unknown;
  criticality?: "low" | "medium" | "high" | "critical" | null;
  // ADR-071: server-computed open/outdated thread counts for the gate panel
  // (run-detail layout only — board/inbox consumers omit it).
  reviewCounts?: ReviewThreadCountsView | null;
  showConfidence: boolean;
  confidence: string;
  comments: string;
  jsonValue: string;
  formValues: Record<string, string>;
  // budget_breach: controlled "new ceiling" value (raw text — positive-int
  // enforced at submit, mirrors the server's fail-closed raise validation).
  budgetCeiling?: string;
  budgetProgress?: BudgetBreachProgressDto | null;
  availableOptions?: BudgetBreachAvailableOption[];
  claimStage?: BudgetBreachClaimStage | null;
  budgetParkMode?: BudgetBreachParkMode;
  budgetBranchName?: string;
  budgetDropWorkspace?: boolean;
  disabled: boolean;
  compact?: boolean;
  error: string | null;
  labels: HitlDecisionControlsLabels;
  onConfidenceChange: (v: string) => void;
  onCommentsChange: (v: string) => void;
  onJsonChange: (v: string) => void;
  onFormFieldChange: (name: string, value: string) => void;
  onBudgetCeilingChange?: (v: string) => void;
  onBudgetRaise?: () => void;
  onBudgetRestart?: () => void;
  onBudgetParkModeChange?: (v: BudgetBreachParkMode) => void;
  onBudgetBranchNameChange?: (v: string) => void;
  onBudgetPark?: () => void;
  onBudgetDropWorkspaceChange?: (v: boolean) => void;
  onBudgetAbandon?: () => void;
  onDecision: (decision: string) => void;
  onSendBack: () => void;
  onOption: (optionId: string) => void;
  onSubmitJson: () => void;
  onSubmitForm: () => void;
}

// Structural view of the watchdog-stamped budget_breach `schema` (LOCKED in the
// spec): { kind, scope, meter, current, limit, decisions }. Narrowed here so the
// pure card stays decoupled from the server type. Returns null for any other
// schema (the branch only renders for a real budget_breach row).
export interface BudgetBreachView {
  scope: "run" | "task" | "tree";
  meter: "tokens" | "failures" | "wallclock";
  current: number;
  limit: number;
}

export function budgetBreachFromSchema(
  schema: unknown,
): BudgetBreachView | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (s.kind !== "budget_breach") return null;
  if (
    (s.scope !== "run" && s.scope !== "task" && s.scope !== "tree") ||
    (s.meter !== "tokens" &&
      s.meter !== "failures" &&
      s.meter !== "wallclock") ||
    typeof s.current !== "number" ||
    typeof s.limit !== "number"
  ) {
    return null;
  }

  return {
    scope: s.scope,
    meter: s.meter,
    current: s.current,
    limit: s.limit,
  };
}

// Structural view of the hook_trip `schema` (ADR-108 / M40):
// { kind: "hook_trip", rule, decisions: ["resume","abort"], toolCall? }. Only a
// `halt` rule escalates to a HITL (repetition / no_progress; path_guard is
// deny-and-continue and never reaches here). `toolCallTitle` is the offending
// call's display title when the adapter supplied one. Returns null for any other
// schema so the branch renders only for a real hook_trip row.
export interface HookTripView {
  rule: string;
  toolCallTitle?: string;
}

export function hookTripFromSchema(schema: unknown): HookTripView | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (s.kind !== "hook_trip" || typeof s.rule !== "string") return null;

  const toolCall = s.toolCall as { title?: unknown } | null | undefined;
  const title =
    toolCall && typeof toolCall.title === "string" ? toolCall.title : undefined;

  return { rule: s.rule, ...(title ? { toolCallTitle: title } : {}) };
}

export interface ConsensusDraftChoiceView {
  decision: string;
  label: string;
  excerpt?: string;
}

export interface ConsensusDisagreementView {
  axis: string;
  summary?: string;
}

export interface ConsensusHitlView {
  round: number;
  allowedDecisions: string[];
  drafts: ConsensusDraftChoiceView[];
  disagreements: ConsensusDisagreementView[];
  debateExcerpt?: string;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object",
      )
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function consensusDecisions(s: Record<string, unknown>): string[] {
  const decisions = stringArray(s.allowedDecisions);

  return decisions.length > 0 ? decisions : stringArray(s.decisions);
}

function consensusDrafts(
  s: Record<string, unknown>,
  decisions: string[],
): ConsensusDraftChoiceView[] {
  const pickDecisions = decisions.filter((decision) =>
    decision.startsWith("pick-draft-"),
  );

  return recordArray(s.drafts ?? s.choices).map((draft, index) => {
    const n = index + 1;
    const decision = optionalText(draft.decision) ?? pickDecisions[index];
    const label =
      optionalText(draft.label) ??
      optionalText(draft.participantLabel) ??
      optionalText(draft.title) ??
      optionalText(draft.name) ??
      `Draft ${n}`;
    const excerpt =
      optionalText(draft.excerpt) ??
      optionalText(draft.summary) ??
      optionalText(draft.preview);

    return {
      decision: decision ?? `pick-draft-${n}`,
      label,
      ...(excerpt ? { excerpt } : {}),
    };
  });
}

function consensusDisagreements(
  s: Record<string, unknown>,
): ConsensusDisagreementView[] {
  return recordArray(s.disagreements ?? s.materialAxisDisagreements)
    .map((item) => {
      const axis = optionalText(item.axis);
      const summary =
        optionalText(item.summary) ??
        optionalText(item.claim) ??
        optionalText(item.reason);

      return axis ? { axis, ...(summary ? { summary } : {}) } : null;
    })
    .filter((item): item is ConsensusDisagreementView => item !== null);
}

function consensusDebateExcerpt(
  s: Record<string, unknown>,
): string | undefined {
  const debateLog = s.debateLog ?? s.debate_log;

  if (debateLog && typeof debateLog === "object") {
    const excerpt = optionalText(
      (debateLog as Record<string, unknown>).excerpt,
    );

    if (excerpt) return excerpt;
  }

  return optionalText(s.debateExcerpt ?? s.debate_log_excerpt);
}

// Structural view of the consensus-resolution human HITL schema. The server
// owns ids and artifact references; the UI exposes only bounded labels/excerpts
// and allow-listed decisions so users never edit raw participant/run ids.
export function consensusHitlFromSchema(
  schema: unknown,
): ConsensusHitlView | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (s.kind !== "consensus_resolution" && s.kind !== "consensus") {
    return null;
  }

  const allowedDecisions = consensusDecisions(s);
  const hasConsensusDecision = allowedDecisions.some(
    (decision) =>
      decision.startsWith("pick-draft-") ||
      decision === "provide-resolution" ||
      decision === "re-run-round" ||
      decision === "abort",
  );

  if (!hasConsensusDecision) return null;

  const round = typeof s.round === "number" && s.round > 0 ? s.round : 1;

  return {
    round,
    allowedDecisions,
    drafts: consensusDrafts(s, allowedDecisions),
    disagreements: consensusDisagreements(s),
    ...(consensusDebateExcerpt(s)
      ? { debateExcerpt: consensusDebateExcerpt(s) }
      : {}),
  };
}

// String-token variant of fillTemplate for the breach summary (scope/meter are
// localized words, current/limit are numbers stringified by the caller).
function fillStringTemplate(
  template: string,
  tokens: Record<string, string>,
): string {
  return Object.entries(tokens).reduce(
    (out, [token, value]) => out.replace(token, value),
    template,
  );
}

// `$`-token label templates (house pattern — see flow-graph-view
// formatCount): the catalog stores literal `$count`/`$n`/`$m` placeholders.
function fillTemplate(
  template: string,
  tokens: Record<string, number>,
): string {
  return Object.entries(tokens).reduce(
    (out, [token, value]) => out.replace(token, String(value)),
    template,
  );
}

function labeledNumber(template: string, n: number): string {
  return fillTemplate(template, { $n: n });
}

function optionById(
  options: BudgetBreachAvailableOption[] | undefined,
  optionId: string,
): BudgetBreachAvailableOption | null {
  return options?.find((option) => option.optionId === optionId) ?? null;
}

function budgetObservationText(
  observation: { limit: number | null; spent: number | null },
  noDataLabel: string,
): string {
  if (observation.limit === null || observation.spent === null) {
    return noDataLabel;
  }

  return `${observation.spent} / ${observation.limit}`;
}

function BudgetProgressBlock({
  progress,
  labels,
}: {
  progress: BudgetBreachProgressDto;
  labels: HitlDecisionControlsLabels;
}): ReactElement {
  const noData = labels.budgetProgressNoData ?? "No data";

  return (
    <div
      className="grid gap-2 rounded-[8px] border border-line bg-paper px-3 py-2"
      data-testid="budget-progress"
    >
      <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {labels.budgetProgressLabel ?? "Progress"}
      </p>
      <div className="grid grid-cols-1 gap-2 text-[11.5px] text-ink-2 sm:grid-cols-2">
        <span className="font-mono">
          {labels.budgetProgressBudget ?? "Budget"}:{" "}
          {budgetObservationText(
            progress.budgetByDimension[progress.breach.dimension],
            noData,
          )}{" "}
          (+{progress.breach.overshootPct}%)
        </span>
        <span className="font-mono">
          {labels.budgetProgressNodes ?? "Nodes"}:{" "}
          {progress.nodes.completed === null || progress.nodes.total === null
            ? noData
            : `${progress.nodes.completed} / ${progress.nodes.total}`}
        </span>
        <span className="font-mono">
          {labels.budgetProgressDiff ?? "Diff"}:{" "}
          {progress.diff === null
            ? noData
            : `${progress.diff.filesChanged} files, +${progress.diff.insertions} / -${progress.diff.deletions}`}
        </span>
        <span className="font-mono">
          {labels.budgetProgressGates ?? "Gates"}:{" "}
          {`${progress.gates.satisfied} satisfied, ${progress.gates.failed} failed, ${progress.gates.open} open`}
        </span>
        <span className="font-mono">
          {labels.budgetProgressWallclock ?? "Wall-clock"}:{" "}
          {progress.wallclockMinutes === null
            ? noData
            : `${progress.wallclockMinutes}m`}
        </span>
        <span className="font-mono">
          {labels.budgetProgressResumes ?? "Resumes"}: {progress.resumeCount}
        </span>
      </div>
    </div>
  );
}

const CRITICALITY_PILL: Record<"low" | "medium" | "high" | "critical", string> =
  {
    low: "border-line text-mute bg-ivory",
    medium: "border-amber-line bg-amber-soft text-amber",
    high: "border-[color-mix(in_oklab,var(--amber)_60%,var(--red-500))] bg-[color-mix(in_oklab,var(--amber-soft)_70%,transparent)] text-[color-mix(in_oklab,var(--amber)_70%,var(--red-500))]",
    critical: "border-red-500/40 bg-red-500/10 text-red-500",
  };

function CriticalityBadge({
  criticality,
  labels,
}: {
  criticality: "low" | "medium" | "high" | "critical";
  labels: HitlDecisionControlsLabels;
}): ReactElement {
  const levelLabel =
    labels[`criticality.${criticality}` as keyof HitlDecisionControlsLabels];

  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {labels.criticalityLabel}
      </span>
      <span
        className={clsx(
          "rounded-full border px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em]",
          CRITICALITY_PILL[criticality],
        )}
      >
        {levelLabel}
      </span>
    </div>
  );
}

function ConfidenceInput({
  confidence,
  label,
  onChange,
  disabled,
}: {
  confidence: string;
  label: string;
  onChange: (v: string) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <label
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
        htmlFor="hitl-confidence"
      >
        {label}
      </label>
      <input
        className="w-20 rounded-[7px] border border-line bg-paper px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-amber"
        disabled={disabled}
        id="hitl-confidence"
        max={1}
        min={0}
        step={0.1}
        type="number"
        value={confidence}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FormFieldControl({
  field,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  field: HitlFormFieldView;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
}): ReactElement {
  const options = field.options ?? [];

  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
        htmlFor={`hitl-form-field-${field.name}`}
      >
        {field.label ?? field.name}
        {field.required ? " *" : ""}
      </label>
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt}
              className={clsx(
                "rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                value === opt
                  ? "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2"
                  : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
                disabled && "opacity-60",
              )}
              disabled={disabled}
              type="button"
              onClick={() => onChange(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="rounded-[7px] border border-line bg-paper px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-amber"
        disabled={disabled}
        id={`hitl-form-field-${field.name}`}
        placeholder={placeholder}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ConsensusHitlCard({
  view,
  labels,
  comments,
  disabled,
  compact,
  onCommentsChange,
  onDecision,
}: {
  view: ConsensusHitlView;
  labels: HitlDecisionControlsLabels;
  comments: string;
  disabled: boolean;
  compact?: boolean;
  onCommentsChange: (v: string) => void;
  onDecision: (decision: string) => void;
}): ReactElement {
  const hasDecision = (decision: string): boolean =>
    view.allowedDecisions.includes(decision);
  const canProvideResolution = hasDecision("provide-resolution");
  const canRerunRound = hasDecision("re-run-round");
  const canAbort = hasDecision("abort");
  const resolutionBlank = comments.trim().length === 0;

  return (
    <div
      className={clsx("flex flex-col", compact ? "gap-2.5" : "gap-3")}
      data-testid="consensus-hitl-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-amber">
          {labels.consensusTitle ?? "Consensus resolution"}
        </p>
        <span
          className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em] text-ink-2"
          data-testid="consensus-round"
        >
          {labeledNumber(labels.consensusRound ?? "Round $n", view.round)}
        </span>
      </div>

      {view.drafts.length > 0 ? (
        <div className="grid gap-2" data-testid="consensus-drafts">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {labels.consensusDrafts ?? "Drafts"}
          </p>
          {view.drafts.map((draft, index) => (
            <article
              key={`${draft.decision}-${index}`}
              className="rounded-[8px] border border-line bg-paper px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <b className="min-w-0 break-words text-[12.5px] font-semibold text-ink">
                  {draft.label ||
                    labeledNumber(
                      labels.consensusDraftFallback ?? "Draft $n",
                      index + 1,
                    )}
                </b>
                {hasDecision(draft.decision) ? (
                  <button
                    className={clsx(
                      "ml-auto rounded-lg border border-amber bg-amber px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                      disabled && "opacity-60",
                    )}
                    data-testid={`consensus-pick-draft-${index + 1}`}
                    disabled={disabled}
                    type="button"
                    onClick={() => onDecision(draft.decision)}
                  >
                    {labeledNumber(
                      labels.consensusPickDraft ?? "Use draft $n",
                      index + 1,
                    )}
                  </button>
                ) : null}
              </div>
              {draft.excerpt ? (
                <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-[1.5] text-ink-2">
                  {draft.excerpt}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      <div className="grid gap-1.5" data-testid="consensus-disagreements">
        <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {labels.consensusDisagreements ?? "Disagreements"}
        </p>
        {view.disagreements.length > 0 ? (
          <ul className="grid gap-1.5">
            {view.disagreements.map((item) => (
              <li
                key={`${item.axis}-${item.summary ?? ""}`}
                className="rounded-[8px] border border-amber-line bg-amber-soft px-3 py-2"
              >
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.04em] text-amber">
                  {item.axis}
                </span>
                {item.summary ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-[1.5] text-ink-2">
                    {item.summary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-[8px] border border-line bg-ivory px-3 py-2 text-[12px] text-mute">
            {labels.consensusNoDisagreements ?? "No material disagreements"}
          </p>
        )}
      </div>

      {view.debateExcerpt ? (
        <div className="grid gap-1.5" data-testid="consensus-debate-log">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {labels.consensusDebateLog ?? "Debate log"}
          </p>
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-ivory px-3 py-2 text-[12px] leading-[1.5] text-ink-2">
            {view.debateExcerpt}
          </p>
        </div>
      ) : null}

      {canProvideResolution ? (
        <div className="grid gap-1.5">
          <label
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
            htmlFor="hitl-consensus-resolution"
          >
            {labels.consensusResolutionLabel ?? "Human resolution"}
          </label>
          <textarea
            className={clsx(
              "rounded-[10px] border border-line bg-paper p-3 text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]",
              compact ? "min-h-[72px]" : "min-h-[110px]",
            )}
            data-testid="consensus-resolution-input"
            disabled={disabled}
            id="hitl-consensus-resolution"
            placeholder={
              labels.consensusResolutionPlaceholder ??
              "Write the trusted resolution for synthesis."
            }
            value={comments}
            onChange={(e) => onCommentsChange(e.target.value)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canProvideResolution ? (
          <button
            className={clsx(
              "rounded-lg border border-amber bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
              (disabled || resolutionBlank) && "opacity-60",
            )}
            data-testid="consensus-provide-resolution"
            disabled={disabled || resolutionBlank}
            type="button"
            onClick={() => onDecision("provide-resolution")}
          >
            {labels.consensusProvideResolution ?? "Use resolution"}
          </button>
        ) : null}
        {canRerunRound ? (
          <button
            className={clsx(
              "rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2",
              disabled && "opacity-60",
            )}
            data-testid="consensus-rerun-round"
            disabled={disabled}
            type="button"
            onClick={() => onDecision("re-run-round")}
          >
            {labels.consensusRerunRound ?? "Run another round"}
          </button>
        ) : null}
        {canAbort ? (
          <button
            className={clsx(
              "rounded-lg border border-rose-300 bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-rose-600 hover:border-rose-400 hover:bg-rose-50",
              disabled && "opacity-60",
            )}
            data-testid="consensus-abort"
            disabled={disabled}
            type="button"
            onClick={() => onDecision("abort")}
          >
            {labels.consensusAbort ?? "Abort"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function HitlDecisionControls({
  kind,
  reviewSchema,
  options,
  schema,
  criticality,
  reviewCounts,
  showConfidence,
  confidence,
  comments,
  jsonValue,
  formValues,
  budgetCeiling,
  budgetProgress,
  availableOptions,
  claimStage,
  budgetParkMode,
  budgetBranchName,
  budgetDropWorkspace,
  disabled,
  compact,
  error,
  labels,
  onConfidenceChange,
  onCommentsChange,
  onJsonChange,
  onFormFieldChange,
  onBudgetCeilingChange,
  onBudgetRaise,
  onBudgetRestart,
  onBudgetParkModeChange,
  onBudgetBranchNameChange,
  onBudgetPark,
  onBudgetDropWorkspaceChange,
  onBudgetAbandon,
  onDecision,
  onSendBack,
  onOption,
  onSubmitJson,
  onSubmitForm,
}: HitlDecisionControlsProps): ReactElement {
  const formFields = kind === "form" ? formFieldsFromSchema(schema) : null;
  const budgetBreach =
    kind === "budget_breach" ? budgetBreachFromSchema(schema) : null;
  const hookTrip = kind === "hook_trip" ? hookTripFromSchema(schema) : null;
  const consensusHitl =
    kind === "human" ? consensusHitlFromSchema(schema) : null;
  const decisionLabel = (d: string): string => {
    if (d === "approve") return labels.decisionApprove;
    if (d === "rework") return labels.decisionRework;

    return d;
  };

  const isReworkDecision = (d: string): boolean => {
    if (!reviewSchema) return false;
    const transitions = reviewSchema.transitions ?? {};
    const reworkTargets = reviewSchema.reworkTargets ?? [];

    return (
      Object.hasOwn(transitions, d) && reworkTargets.includes(transitions[d])
    );
  };

  // ADR-071 D5 gate panel: loop chip + exhaustion boundary from the
  // server-stamped schema fields; open/outdated badges + approve soft-warn
  // from the server-computed counts. Approve is NEVER blocked.
  const loopInfo = reviewLoopInfo(reviewSchema);
  const reworkExhausted = loopInfo?.exhausted ?? false;
  const openCount = reviewCounts?.openCount ?? 0;
  const outdatedCount = reviewCounts?.outdatedCount ?? 0;
  const exhaustedText =
    loopInfo?.exhausted && labels.reviewReworkExhausted
      ? fillTemplate(labels.reviewReworkExhausted, {
          $m: loopInfo.totalVisits,
        })
      : null;
  const reworkLocked = (d: string): boolean =>
    reworkExhausted && isReworkDecision(d);
  const budgetAvailableOptions =
    kind === "budget_breach" ? (availableOptions ?? []) : [];
  const budgetRaiseOption = optionById(budgetAvailableOptions, "raise");
  const budgetRestartOption = optionById(budgetAvailableOptions, "restart");
  const budgetParkOption = optionById(budgetAvailableOptions, "park");
  const budgetAbandonOption = optionById(budgetAvailableOptions, "abandon");
  const selectedParkMode = budgetParkMode ?? "snapshot";

  return (
    <div className={clsx("flex flex-col", compact ? "gap-2" : "gap-3")}>
      {criticality ? (
        <CriticalityBadge criticality={criticality} labels={labels} />
      ) : null}

      {reviewSchema ? (
        <>
          {loopInfo !== null || openCount > 0 || outdatedCount > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {loopInfo && labels.reviewLoopChip ? (
                <span
                  className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em] text-ink-2"
                  data-testid="review-loop-chip"
                >
                  {fillTemplate(labels.reviewLoopChip, {
                    $n: loopInfo.gateAttempt,
                    $m: loopInfo.totalVisits,
                  })}
                </span>
              ) : null}
              {openCount > 0 && labels.reviewOpenCount ? (
                <span
                  className="rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em] text-amber"
                  data-testid="review-open-count"
                >
                  {fillTemplate(labels.reviewOpenCount, { $count: openCount })}
                </span>
              ) : null}
              {outdatedCount > 0 && labels.reviewOutdatedCount ? (
                <span
                  className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em] text-mute"
                  data-testid="review-outdated-count"
                >
                  {fillTemplate(labels.reviewOutdatedCount, {
                    $count: outdatedCount,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          <label
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
            htmlFor="hitl-review-comments"
          >
            {labels.reviewComments}
          </label>
          <textarea
            className={clsx(
              "rounded-[10px] border border-line bg-paper p-3 text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]",
              compact ? "min-h-[60px]" : "min-h-[90px]",
            )}
            disabled={disabled}
            id="hitl-review-comments"
            placeholder={labels.reviewCommentsPlaceholder}
            value={comments}
            onChange={(e) => onCommentsChange(e.target.value)}
          />
          {openCount > 0 && labels.reviewApproveOpenWarn ? (
            <p
              className="font-mono text-[11px] leading-[1.5] text-amber"
              data-testid="review-approve-open-warn"
            >
              {fillTemplate(labels.reviewApproveOpenWarn, {
                $count: openCount,
              })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(reviewSchema.allowedDecisions ?? []).map((d) => (
              <button
                key={d}
                className={clsx(
                  "rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                  isReworkDecision(d)
                    ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                    : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                  (disabled || reworkLocked(d)) && "opacity-60",
                )}
                disabled={disabled || reworkLocked(d)}
                title={
                  reworkLocked(d) ? (exhaustedText ?? undefined) : undefined
                }
                type="button"
                onClick={() => onDecision(d)}
              >
                {decisionLabel(d)}
              </button>
            ))}
            <button
              className={clsx(
                "rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2",
                (disabled || reworkExhausted) && "opacity-60",
              )}
              disabled={disabled || reworkExhausted}
              title={reworkExhausted ? (exhaustedText ?? undefined) : undefined}
              type="button"
              onClick={onSendBack}
            >
              {labels.sendBackWithComments}
            </button>
          </div>
          {exhaustedText ? (
            <p
              className="font-mono text-[11px] leading-[1.5] text-mute"
              data-testid="review-rework-exhausted"
            >
              {exhaustedText}
            </p>
          ) : null}
          {showConfidence ? (
            <ConfidenceInput
              confidence={confidence}
              disabled={disabled}
              label={labels.confidenceLabel}
              onChange={onConfidenceChange}
            />
          ) : null}
        </>
      ) : consensusHitl ? (
        <ConsensusHitlCard
          comments={comments}
          compact={compact}
          disabled={disabled}
          labels={labels}
          view={consensusHitl}
          onCommentsChange={onCommentsChange}
          onDecision={onDecision}
        />
      ) : kind === "permission" ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt.optionId}
              className={clsx(
                "rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
                opt.optionId.includes("deny")
                  ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                  : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                disabled && "opacity-60",
              )}
              disabled={disabled}
              type="button"
              onClick={() => onOption(opt.optionId)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : kind === "infra_recovery" ? (
        <div className="flex flex-wrap gap-2">
          <button
            className={clsx(
              "rounded-lg border border-amber bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
              disabled && "opacity-60",
            )}
            disabled={disabled}
            type="button"
            onClick={() => onOption("retry")}
          >
            {labels.infraRecoveryRetry ?? "Retry"}
          </button>
          <button
            className={clsx(
              "rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2",
              disabled && "opacity-60",
            )}
            disabled={disabled}
            type="button"
            onClick={() => onOption("abandon")}
          >
            {labels.infraRecoveryAbandon ?? "Abandon"}
          </button>
        </div>
      ) : kind === "budget_breach" && budgetBreach ? (
        <div className="flex flex-col gap-3" data-testid="budget-breach-card">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-amber">
              {labels.budgetBreachTitle ?? "Budget breach"}
            </p>
            {claimStage ? (
              <span
                className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.04em] text-mute"
                data-testid="budget-claim-stage"
              >
                {fillStringTemplate(labels.budgetClaimStage ?? "$stage", {
                  $stage:
                    labels[
                      `budgetClaimStage.${claimStage}` as keyof HitlDecisionControlsLabels
                    ] ?? claimStage,
                })}
              </span>
            ) : null}
          </div>
          <p
            className="rounded-[8px] border border-amber-line bg-amber-soft px-3 py-2 text-[12.5px] leading-[1.5] text-ink-2"
            data-testid="budget-breach-summary"
          >
            {fillStringTemplate(
              labels.budgetBreachSummary ??
                "$scope $meter reached $current of $limit.",
              {
                $scope:
                  labels[
                    `budgetScope.${budgetBreach.scope}` as keyof HitlDecisionControlsLabels
                  ] ?? budgetBreach.scope,
                $meter:
                  labels[
                    `budgetMeter.${budgetBreach.meter}` as keyof HitlDecisionControlsLabels
                  ] ?? budgetBreach.meter,
                $current: String(budgetBreach.current),
                $limit: String(budgetBreach.limit),
              },
            )}
          </p>
          {budgetProgress ? (
            <BudgetProgressBlock labels={labels} progress={budgetProgress} />
          ) : null}
          {budgetRaiseOption ? (
            <div className="flex flex-col gap-1.5">
              <label
                className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
                htmlFor="hitl-budget-ceiling"
              >
                {labels.budgetNewCeiling ?? "New ceiling"}
              </label>
              <input
                className="w-40 rounded-[7px] border border-line bg-paper px-2 py-1.5 font-mono text-[12.5px] text-ink outline-none focus:border-amber"
                data-testid="budget-breach-ceiling"
                disabled={disabled}
                id="hitl-budget-ceiling"
                inputMode="numeric"
                type="text"
                value={budgetCeiling ?? ""}
                onChange={(e) => onBudgetCeilingChange?.(e.target.value)}
              />
            </div>
          ) : null}
          {budgetParkOption ? (
            <div className="flex flex-col gap-2 rounded-[8px] border border-line bg-paper px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {budgetParkOption.modes.includes("snapshot") ? (
                  <button
                    className={clsx(
                      "rounded-md border px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]",
                      selectedParkMode === "snapshot"
                        ? "border-amber bg-amber text-white"
                        : "border-line bg-ivory text-ink-2 hover:bg-paper",
                      disabled && "opacity-60",
                    )}
                    data-testid="budget-park-mode-snapshot"
                    disabled={disabled}
                    type="button"
                    onClick={() => onBudgetParkModeChange?.("snapshot")}
                  >
                    {labels.budgetParkModeSnapshot ?? "Snapshot"}
                  </button>
                ) : null}
                {budgetParkOption.modes.includes("export") ? (
                  <button
                    className={clsx(
                      "rounded-md border px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]",
                      selectedParkMode === "export"
                        ? "border-amber bg-amber text-white"
                        : "border-line bg-ivory text-ink-2 hover:bg-paper",
                      disabled && "opacity-60",
                    )}
                    data-testid="budget-park-mode-export"
                    disabled={disabled}
                    type="button"
                    onClick={() => onBudgetParkModeChange?.("export")}
                  >
                    {labels.budgetParkModeExport ?? "Export branch"}
                  </button>
                ) : null}
              </div>
              {selectedParkMode === "export" ? (
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {labels.budgetParkBranchName ?? "Branch name"}
                  </span>
                  <input
                    className="rounded-[7px] border border-line bg-paper px-2 py-1.5 font-mono text-[12.5px] text-ink outline-none focus:border-amber"
                    data-testid="budget-park-branch"
                    disabled={disabled}
                    placeholder={
                      labels.budgetParkBranchPlaceholder ??
                      "maister/budget-parked"
                    }
                    type="text"
                    value={budgetBranchName ?? ""}
                    onChange={(e) => onBudgetBranchNameChange?.(e.target.value)}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          {budgetAbandonOption?.dropAllowed ? (
            <label className="inline-flex items-center gap-2 font-mono text-[11px] text-mute">
              <input
                checked={budgetDropWorkspace === true}
                className="h-3.5 w-3.5"
                data-testid="budget-drop-workspace"
                disabled={disabled}
                type="checkbox"
                onChange={(e) =>
                  onBudgetDropWorkspaceChange?.(e.target.checked)
                }
              />
              {labels.budgetDropWorkspace ?? "Drop workspace now"}
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {budgetRaiseOption ? (
              <button
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-lg border border-amber bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                  disabled && "opacity-60",
                )}
                data-testid="budget-breach-raise"
                disabled={disabled}
                type="button"
                onClick={() => onBudgetRaise?.()}
              >
                <ArrowUturnRightIcon className="h-3.5 w-3.5" />
                {labels.budgetRaiseResume ?? budgetRaiseOption.label}
              </button>
            ) : null}
            {budgetRestartOption ? (
              <button
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:border-mute hover:text-ink",
                  disabled && "opacity-60",
                )}
                data-testid="budget-breach-restart"
                disabled={disabled}
                type="button"
                onClick={() => onBudgetRestart?.()}
              >
                <ArrowPathIcon className="h-3.5 w-3.5" />
                {labels.budgetRestart ?? budgetRestartOption.label}
              </button>
            ) : null}
            {budgetParkOption ? (
              <button
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:border-mute hover:text-ink",
                  disabled && "opacity-60",
                )}
                data-testid="budget-breach-park"
                disabled={disabled}
                type="button"
                onClick={() => onBudgetPark?.()}
              >
                <ArchiveBoxIcon className="h-3.5 w-3.5" />
                {labels.budgetPark ?? budgetParkOption.label}
              </button>
            ) : null}
            {budgetAbandonOption ? (
              <button
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-rose-600 hover:border-rose-400 hover:bg-rose-50",
                  disabled && "opacity-60",
                )}
                data-testid="budget-breach-abandon"
                disabled={disabled}
                type="button"
                onClick={() => {
                  if (onBudgetAbandon) onBudgetAbandon();
                  else onOption("abandon");
                }}
              >
                {budgetDropWorkspace ? (
                  <TrashIcon className="h-3.5 w-3.5" />
                ) : (
                  <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                )}
                {labels.budgetAbandon ?? budgetAbandonOption.label}
              </button>
            ) : null}
          </div>
        </div>
      ) : kind === "hook_trip" && hookTrip ? (
        <div className="flex flex-col gap-3" data-testid="hook-trip-card">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-amber">
            {labels.hookTripTitle ?? "Guardrail trip"}
          </p>
          <p
            className="rounded-[8px] border border-amber-line bg-amber-soft px-3 py-2 text-[12.5px] leading-[1.5] text-ink-2"
            data-testid="hook-trip-summary"
          >
            {fillStringTemplate(
              labels.hookTripSummary ??
                '"$rule" guardrail tripped — resume the run or abort.',
              {
                $rule:
                  labels[
                    `hookTripRule.${hookTrip.rule}` as keyof HitlDecisionControlsLabels
                  ] ?? hookTrip.rule,
              },
            )}
          </p>
          {hookTrip.toolCallTitle ? (
            <p
              className="font-mono text-[11px] text-mute"
              data-testid="hook-trip-tool-call"
            >
              {fillStringTemplate(
                labels.hookTripToolCall ?? "Last tool: $title",
                { $title: hookTrip.toolCallTitle },
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              className={clsx(
                "rounded-lg border border-amber bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
                disabled && "opacity-60",
              )}
              data-testid="hook-trip-resume"
              disabled={disabled}
              type="button"
              onClick={() => onOption("resume")}
            >
              {labels.hookTripResume ?? "Resume"}
            </button>
            <button
              className={clsx(
                "rounded-lg border border-rose-300 bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-rose-600 hover:border-rose-400 hover:bg-rose-50",
                disabled && "opacity-60",
              )}
              data-testid="hook-trip-abort"
              disabled={disabled}
              type="button"
              onClick={() => onOption("abort")}
            >
              {labels.hookTripAbort ?? "Abort"}
            </button>
          </div>
        </div>
      ) : formFields ? (
        <div className={clsx("flex flex-col", compact ? "gap-2" : "gap-3")}>
          <p className="text-[12px] text-mute">{labels.formInstructions}</p>
          {formFields.map((field) => (
            <FormFieldControl
              key={field.name}
              disabled={disabled}
              field={field}
              placeholder={labels.formCustomPlaceholder}
              value={formValues[field.name] ?? ""}
              onChange={(v) => onFormFieldChange(field.name, v)}
            />
          ))}
          <button
            className="mt-1 inline-flex w-max items-center rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:bg-amber-2 disabled:opacity-60"
            disabled={disabled}
            type="button"
            onClick={onSubmitForm}
          >
            {labels.submit}
          </button>
        </div>
      ) : (
        <>
          <label
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
            htmlFor="hitl-json-response"
          >
            {labels.responseLabel}
          </label>
          <p className="text-[12px] text-mute">{labels.responseHint}</p>
          <textarea
            aria-label={labels.responseLabel}
            className={clsx(
              "rounded-[10px] border border-line bg-paper p-3 font-mono text-[12.5px] text-ink outline-none focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)]",
              compact ? "min-h-[60px]" : "min-h-[120px]",
            )}
            disabled={disabled}
            id="hitl-json-response"
            value={jsonValue}
            onChange={(e) => onJsonChange(e.target.value)}
          />
          {schema != null ? (
            <details className="text-[11.5px] text-mute">
              <summary className="cursor-pointer font-mono uppercase tracking-[0.06em]">
                {labels.schemaLabel}
              </summary>
              <pre className="mt-2 overflow-auto rounded-lg border border-line-soft bg-ivory p-3 text-[11px] text-ink-2">
                {JSON.stringify(schema, null, 2)}
              </pre>
            </details>
          ) : null}
          {showConfidence ? (
            <ConfidenceInput
              confidence={confidence}
              disabled={disabled}
              label={labels.confidenceLabel}
              onChange={onConfidenceChange}
            />
          ) : null}
          <button
            className="mt-1 inline-flex w-max items-center rounded-full bg-amber px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-all hover:bg-amber-2 disabled:opacity-60"
            disabled={disabled}
            type="button"
            onClick={onSubmitJson}
          >
            {labels.submit}
          </button>
        </>
      )}

      {error ? (
        <p
          aria-live="assertive"
          className="font-mono text-[12px] text-[#d9534f]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
