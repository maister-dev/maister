"use client";

import type { Key, ReactElement } from "react";
import type { FlowRunnerSlotPreview } from "@/lib/acp-runners/flow-preflight";
import type { ConsensusRunnerSlotPreview } from "@/lib/acp-runners/consensus-preflight";
import type {
  DeliveryPolicy,
  DeliveryPolicyPush,
  DeliveryPolicyStrategy,
  DeliveryPolicyTrigger,
} from "@/lib/runs/delivery-policy";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { TaskQualificationSummary } from "@/lib/tasks/qualification-queries";
import type { NodeEnforcementRefusal } from "@/lib/flows/enforcement-refusal";
import type {
  BudgetAxis,
  BudgetLimits,
  BudgetScope,
  CheckStrictness,
  ExecutionPolicy,
  ExecutionPolicyOverrides,
  ExecutionPreset,
  HumanGateAutonomy,
  PromotionTrigger,
} from "@/lib/runs/execution-policy";

import { Button, ListBox, Select } from "@heroui/react";
import {
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { useTaskLaunchIntent } from "./use-task-launch-intent";
import { TaskEnforcementRefusalNotice } from "./task-enforcement-refusal-notice";
import {
  TaskLaunchIntentStatus,
  taskLaunchReasonKey,
} from "./task-launch-intent-status";

import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";
import { TaskQualificationSourceFailureNotice } from "@/components/agents/task-qualification-source-failure-notice";
import { deliveryPolicyForLaunch } from "@/lib/runs/delivery-policy";
import { readLaunchErrorDetails } from "@/lib/runs/launch-progress";
import {
  blindShipLockedOptions,
  expandExecutionPolicy,
} from "@/lib/runs/execution-policy";
import { describeScheduledLaunchTime } from "@/lib/scheduled-launches/time";
import { useIsClient } from "@/lib/use-is-client";

type LaunchFlowOption = {
  id: string;
  refId: string;
  name: string;
  version: string | null;
  enabled: boolean;
  isTaskDefault: boolean;
};

// M39 Stream B (ADR-107): a project's attached centralized package with a newer
// cut and/or uncut Studio edits — the launch dialog's per-package choice.
// ADR-132: `try_once` = run this launch on the newer cut WITHOUT moving the
// project pin (offered exactly when `adopt` is).
type VersionChoice = "keep" | "adopt" | "cut_and_adopt" | "try_once";

type AvailablePackageVersion = {
  packageInstallId: string;
  attachmentId: string;
  localPackageId: string;
  newerCutInstallId: string | null;
  packageName: string;
  localPackageName: string;
  currentVersionLabel: string;
  newerVersionLabel: string | null;
  hasUncutEdits: boolean;
  offeredOptions: VersionChoice[];
};

export function deriveInitialDisclosureState({
  hasNewerCut,
  hasUncutEdits,
}: {
  hasNewerCut: boolean;
  hasUncutEdits: boolean;
}): boolean {
  return hasNewerCut || hasUncutEdits;
}

type LaunchRunnerOption = {
  id: string;
  label: string;
  adapter: string;
  capabilityAgent: string;
  model: string;
  readinessStatus: string;
  enabled: boolean;
  pinnedModel: { model: string; source: string };
};

type RunnerResolutionWarning = {
  code: "runner_intent_soft_mismatch";
  slotKey: string;
  sessionName?: string;
  requested: {
    capabilityAgent: string;
    model?: string;
    providerKind?: string;
  };
  launched: {
    runnerId: string;
    capabilityAgent: string;
    model: string;
    providerKind: string;
  };
  message: string;
};

type LaunchSessionOption = {
  sessionName: string;
  runnerId: string | null;
  label: string | null;
  overridable: boolean;
  warning: RunnerResolutionWarning | null;
};

type LaunchVerdict = {
  launchable: boolean;
  reason: string;
  incompatibilityReason?: string | null;
};

type LaunchOptions = {
  enforcementRefusal?: NodeEnforcementRefusal | null;
  launchability: {
    launchable: boolean;
    reason: string;
    blockers: Array<{ kind: string; label: string }>;
  };
  // ADR-119: additive force-relaunch verdict. Present on every response, but
  // typed optional so an older/partial payload still gates via launchability.
  relaunch?: LaunchVerdict;
  flows: LaunchFlowOption[];
  runners: LaunchRunnerOption[];
  sessions?: LaunchSessionOption[];
  runnerSlots?: FlowRunnerSlotPreview[];
  consensusRunnerSlots?: ConsensusRunnerSlotPreview[];
  selectedFlowRevisionId?: string | null;
  canConfigureRunnerBindings?: boolean;
  canManagePackages?: boolean;
  canCutPackages?: boolean;
  selectedFlowId: string;
  selectedRunnerId: string | null;
  selectedRunnerWarning?: RunnerResolutionWarning | null;
  branches: string[];
  defaultBaseBranch: string | null;
  defaultTargetBranch: string | null;
  deliveryPolicyDefault: DeliveryPolicy;
  executionPolicyDefault: ExecutionPolicy;
  availablePackageVersions: AvailablePackageVersion[];
  task: {
    projectSlug: string;
    projectId: string;
    number: number;
    flowId?: string | null;
    revision: number;
  };
  settingsToken: string;
  qualification: TaskQualificationSummary | null;
  activeLaunch: TaskLaunchReceipt | null;
};

// Only the non-keep choices are sent — the server treats keep (and an absent
// map) identically as "launch on the pin".
function nonKeepPackageVersions(
  choices: Record<string, VersionChoice>,
): Record<string, VersionChoice> | undefined {
  const entries = Object.entries(choices).filter(([, v]) => v !== "keep");

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

type SelectOption<T extends string> = {
  id: T;
  label: string;
  disabled?: boolean;
};

const LAUNCH_UNAVAILABLE_REASON_KEY: Record<string, string> = {
  blocked: "launchUnavailableReason.blocked",
  busy: "launchUnavailableReason.busy",
  crashed: "launchUnavailableReason.crashed",
  flagged: "launchUnavailableReason.flagged",
  clarification_pending: "launchUnavailableReason.clarificationPending",
  flow_missing: "launchUnavailableReason.flowMissing",
  incompatible: "launchUnavailableReason.incompatible",
  not_enabled: "launchUnavailableReason.notEnabled",
  no_revision: "launchUnavailableReason.noRevision",
  not_installed: "launchUnavailableReason.notInstalled",
  setup_failed: "launchUnavailableReason.setupFailed",
  setup_pending: "launchUnavailableReason.setupPending",
  target_terminal: "launchUnavailableReason.targetTerminal",
  unsupported_schema: "launchUnavailableReason.unsupportedSchema",
  runner_unresolved: "launchUnavailableReason.runnerUnresolved",
  queue_paused: "launchUnavailableReason.queuePaused",
  launch_task_held: "launchUnavailableReason.flagged",
};

type LaunchPreviewSelection = {
  flowId: string;
  runnerId: string;
  packageVersions?: string;
};

export function launchPreviewMatches(
  preview: LaunchPreviewSelection | null,
  selection: LaunchPreviewSelection,
): boolean {
  return (
    preview?.flowId === selection.flowId &&
    preview.runnerId === selection.runnerId &&
    (preview.packageVersions ?? "") === (selection.packageVersions ?? "")
  );
}

export function runnerLaunchErrorLabel(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("details" in error)) return null;

  return readLaunchErrorDetails(error.details)?.label ?? null;
}

export function launchPreconditionMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  const candidate = error as { code?: unknown; message?: unknown };

  if (
    candidate.code !== "PRECONDITION" ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }

  const message = candidate.message.trim();

  return message.length > 0 ? message : null;
}

export interface LaunchPopoverProps {
  taskId: string;
  label: string;
  disabledLabel: string;
  disabledReason?: string;
  hasRuns?: boolean;
  // ADR-119: the runs-history "Run again" button. When true, the create gate
  // reads the `relaunch` (force) verdict and the POST carries allowConcurrent.
  forceRelaunch?: boolean;
}

// ADR-119: the verdict the create button gates on — the force `relaunch` verdict
// in force mode (falls back to `launchability` for an older payload), else the
// manual `launchability` verdict.
export function effectiveLaunchVerdict<
  L extends LaunchVerdict,
  R extends LaunchVerdict,
>(options: { launchability: L; relaunch?: R }, forceRelaunch: boolean): L | R {
  if (forceRelaunch && options.relaunch) return options.relaunch;

  return options.launchability;
}

// Selection data carries no admission authority. The caller chooses the explicit
// launch operation and adds the server revision/settings token separately.
export function buildLaunchBody(args: {
  taskId: string;
  flowId: string;
  runnerId: string;
  initialRunnerId: string | null;
  baseBranch: string;
  targetBranch: string;
  deliveryPolicy: DeliveryPolicy;
  executionPolicy: ExecutionPolicy;
  packageVersions?: Record<string, VersionChoice>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    taskId: args.taskId,
    flowId: args.flowId,
    deliveryPolicy: args.deliveryPolicy,
    executionPolicy: args.executionPolicy,
    packageVersions: nonKeepPackageVersions(args.packageVersions ?? {}),
  };

  if (args.runnerId && args.runnerId !== args.initialRunnerId)
    body.runnerId = args.runnerId;
  if (args.baseBranch) body.baseBranch = args.baseBranch;
  if (args.targetBranch) body.targetBranch = args.targetBranch;

  return body;
}

export function buildScheduledLaunchBody(args: {
  taskId: string;
  flowId: string;
  runnerId: string;
  initialRunnerId: string | null;
  baseBranch: string;
  targetBranch: string;
  deliveryPolicy: DeliveryPolicy;
  executionPolicy: ExecutionPolicy;
  packageVersions?: Record<string, VersionChoice>;
  scheduledLocalTime: string;
  timezone: string;
  disambiguation: "earlier" | "later";
}): {
  taskId: string;
  scheduledLocalTime: string;
  timezone: string;
  disambiguation: "earlier" | "later";
  launchRequest: Record<string, unknown>;
} {
  const { taskId: _taskId, ...launchRequest } = buildLaunchBody(args);

  return {
    taskId: args.taskId,
    scheduledLocalTime: args.scheduledLocalTime,
    timezone: args.timezone,
    disambiguation: args.disambiguation,
    launchRequest,
  };
}

function branchFallback(options: LaunchOptions): string {
  return (
    options.defaultBaseBranch ??
    options.defaultTargetBranch ??
    options.branches[0] ??
    "main"
  );
}

function runnerLabel(runner: LaunchRunnerOption): string {
  return `${runner.id} · ${runner.model}`;
}

function selectedValue<T extends string>(key: Key | null, fallback: T): T {
  if (key === null) return fallback;

  return String(key) as T;
}

export function launchUnavailableReasonMessage(
  reason: string,
  translate: (key: string) => string,
): string {
  const key = LAUNCH_UNAVAILABLE_REASON_KEY[reason];

  return translate(key ?? "launchUnavailableReason.technical");
}

export function launchVerdictReasonMessage(
  verdict: LaunchVerdict,
  translate: (key: string) => string,
): string {
  return (
    verdict.incompatibilityReason ??
    launchUnavailableReasonMessage(verdict.reason, translate)
  );
}

export function launchRunnerResolutionWarnings(
  options: Pick<
    LaunchOptions,
    "selectedRunnerId" | "selectedRunnerWarning" | "sessions"
  >,
  currentRunnerId: string,
): RunnerResolutionWarning[] {
  const warnings = new Map<string, RunnerResolutionWarning>();

  if (
    currentRunnerId === (options.selectedRunnerId ?? "") &&
    options.selectedRunnerWarning
  ) {
    warnings.set(
      options.selectedRunnerWarning.slotKey,
      options.selectedRunnerWarning,
    );
  }

  for (const session of options.sessions ?? []) {
    if (session.warning) warnings.set(session.warning.slotKey, session.warning);
  }

  return [...warnings.values()];
}

function LaunchSelect<T extends string>(props: {
  label: string;
  value: T;
  disabled?: boolean;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
}): ReactElement {
  const labelId = useId();

  return (
    <>
      <span className="sr-only" id={labelId}>
        {props.label}
      </span>
      <Select
        aria-labelledby={labelId}
        isDisabled={props.disabled}
        selectedKey={props.value}
        variant="secondary"
        onSelectionChange={(key) =>
          props.onChange(selectedValue(key, props.value))
        }
      >
        <Select.Trigger className="h-9 min-w-0 rounded-md border-line-soft bg-paper px-2 font-mono text-[11px] text-ink">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
          <ListBox aria-label={props.label}>
            {props.options.map((option) => (
              <ListBox.Item
                key={option.id}
                id={option.id}
                isDisabled={option.disabled}
                textValue={option.label}
              >
                {option.label}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </>
  );
}

function policyChanged(
  current: DeliveryPolicy,
  baseline: DeliveryPolicy,
): boolean {
  return (
    current.strategy !== baseline.strategy ||
    current.push !== baseline.push ||
    current.trigger !== baseline.trigger ||
    current.targetBranch !== baseline.targetBranch
  );
}

// Budget inputs are held as raw text so an in-progress / invalid value can be
// rejected inline (positive int only) before it is pruned into a BudgetAxis.
type BudgetField = keyof BudgetLimits;
type BudgetTextLimits = Partial<Record<BudgetField, string>>;
type BudgetTextAxis = Partial<Record<BudgetScope, BudgetTextLimits>>;

// Run/Task share the four token/failure fields; Tree adds wall-clock minutes.
const BUDGET_SCOPE_FIELDS: Record<BudgetScope, BudgetField[]> = {
  run: ["maxTokens", "hardMaxTokens", "warnAtPct", "consecutiveFailures"],
  task: ["maxTokens", "hardMaxTokens", "warnAtPct", "consecutiveFailures"],
  tree: [
    "maxTokens",
    "hardMaxTokens",
    "warnAtPct",
    "consecutiveFailures",
    "wallClockMinutes",
  ],
};

// A field value is "invalid" when it is non-empty and not a positive integer
// (empty = unlimited, allowed). warnAtPct additionally caps at 100.
export function isBudgetFieldInvalid(field: BudgetField, raw: string): boolean {
  const trimmed = raw.trim();

  if (trimmed === "") return false;
  const n = Number(trimmed);

  if (!Number.isInteger(n) || n <= 0) return true;

  return field === "warnAtPct" && n > 100;
}

export function budgetTextHasInvalid(text: BudgetTextAxis): boolean {
  return (Object.keys(BUDGET_SCOPE_FIELDS) as BudgetScope[]).some((scope) =>
    BUDGET_SCOPE_FIELDS[scope].some((field) =>
      isBudgetFieldInvalid(field, text[scope]?.[field] ?? ""),
    ),
  );
}

// Prune the raw text axis to a sparse BudgetAxis: only positive-int fields
// survive, only non-empty scopes are emitted — so the snapshot stays minimal.
export function pruneBudgetText(text: BudgetTextAxis): BudgetAxis | null {
  const axis: BudgetAxis = {};

  for (const scope of Object.keys(BUDGET_SCOPE_FIELDS) as BudgetScope[]) {
    const limits: BudgetLimits = {};

    for (const field of BUDGET_SCOPE_FIELDS[scope]) {
      const raw = (text[scope]?.[field] ?? "").trim();

      if (raw === "") continue;
      const n = Number(raw);

      if (Number.isInteger(n) && n > 0) limits[field] = n;
    }

    if (Object.keys(limits).length > 0) axis[scope] = limits;
  }

  return Object.keys(axis).length > 0 ? axis : null;
}

function launchBudgetText(budget: BudgetAxis): BudgetTextAxis {
  return Object.fromEntries(
    (Object.keys(BUDGET_SCOPE_FIELDS) as BudgetScope[]).map((scope) => [
      scope,
      Object.fromEntries(
        BUDGET_SCOPE_FIELDS[scope].flatMap((field) => {
          const value = budget[scope]?.[field];

          return value == null ? [] : [[field, String(value)]];
        }),
      ),
    ]),
  );
}

/** Overlay only edited fields, retaining ceilings the compact form does not expose. */
function editedLaunchBudget(
  budget: BudgetAxis,
  changes: BudgetTextAxis,
): BudgetAxis | null {
  const next: BudgetAxis = Object.fromEntries(
    Object.entries(budget).map(([scope, limits]) => [scope, { ...limits }]),
  );

  for (const scope of Object.keys(BUDGET_SCOPE_FIELDS) as BudgetScope[]) {
    if (!changes[scope]) continue;
    const limits = { ...next[scope] };

    for (const field of BUDGET_SCOPE_FIELDS[scope]) {
      const raw = changes[scope]?.[field];

      if (raw === undefined) continue;
      if (raw.trim() === "") delete limits[field];
      else if (!isBudgetFieldInvalid(field, raw)) limits[field] = Number(raw);
    }
    if (Object.keys(limits).length) next[scope] = limits;
    else delete next[scope];
  }

  return Object.keys(next).length ? next : null;
}

export function BudgetScopeFields(props: {
  scope: BudgetScope;
  heading: string;
  values: BudgetTextLimits;
  fieldLabels: Record<BudgetField, string>;
  fieldPlaceholders: Partial<Record<BudgetField, string>>;
  invalidLabel: string;
  onChange: (field: BudgetField, value: string) => void;
}): ReactElement {
  const inputId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
        {props.heading}
      </span>
      <div className="grid gap-2 md:grid-cols-2">
        {BUDGET_SCOPE_FIELDS[props.scope].map((field) => {
          const raw = props.values[field] ?? "";
          const invalid = isBudgetFieldInvalid(field, raw);
          const fieldId = `${inputId}-${field}`;

          return (
            <label key={field} className="flex flex-col gap-0.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.05em] text-mute">
                {props.fieldLabels[field]}
              </span>
              <input
                aria-invalid={invalid}
                className={clsx(
                  "h-8 rounded-md border bg-paper px-2 font-mono text-[11px] text-ink outline-none focus:border-amber",
                  invalid ? "border-red-300" : "border-line-soft",
                )}
                data-testid={`budget-${props.scope}-${field}`}
                id={fieldId}
                inputMode="numeric"
                placeholder={props.fieldPlaceholders[field] ?? ""}
                type="text"
                value={raw}
                onChange={(e) => props.onChange(field, e.target.value)}
              />
              {invalid ? (
                <span
                  className="font-mono text-[9px] text-red-500"
                  id={`${fieldId}-error`}
                  role="alert"
                >
                  {props.invalidLabel}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function LaunchPopover({
  taskId,
  label,
  disabledLabel,
  disabledReason,
  hasRuns = true,
  forceRelaunch = false,
}: LaunchPopoverProps): ReactElement {
  const t = useTranslations("launch");
  const tRun = useTranslations("run");
  const isClient = useIsClient();
  const statusUnavailableMessage = t("admission.reason.statusUnavailable");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [localBusy, setBusy] = useState(false);
  const intent = useTaskLaunchIntent(
    taskId,
    forceRelaunch ? "concurrent" : "ordinary",
  );
  const busy = localBusy || intent.busy;
  const [replacementDraft, setReplacement] = useState<{
    intentId: string;
    stateVersion: number;
  } | null>(null);
  const replacement =
    replacementDraft &&
    (!intent.receipt || intent.receipt.intentId === replacementDraft.intentId)
      ? replacementDraft
      : null;
  const tracking =
    !replacement && (intent.receipt !== null || intent.uncertain);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduledLocalTime, setScheduledLocalTime] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [scheduleDisambiguation, setScheduleDisambiguation] = useState<
    "earlier" | "later"
  >("later");
  const schedulePreview = useMemo(() => {
    if (!scheduledLocalTime || !scheduleTimezone) return null;

    try {
      return describeScheduledLaunchTime({
        scheduledLocalTime,
        timezone: scheduleTimezone,
        disambiguation: scheduleDisambiguation,
      });
    } catch {
      return null;
    }
  }, [scheduledLocalTime, scheduleDisambiguation, scheduleTimezone]);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const loadingOptions = open && options === null && !optionsError;
  const [previewSelection, setPreviewSelection] =
    useState<LaunchPreviewSelection | null>(null);
  const [previewRequestVersion, setPreviewRequestVersion] = useState(0);
  const [bindingChoices, setBindingChoices] = useState<Record<string, string>>(
    {},
  );
  const [savingBinding, setSavingBinding] = useState<string | null>(null);
  const [bindingFeedback, setBindingFeedback] = useState<
    Record<string, "saving" | "saved" | "failed">
  >({});
  const [flowId, setFlowId] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [policyStrategy, setPolicyStrategy] =
    useState<DeliveryPolicyStrategy>("merge");
  const [policyPush, setPolicyPush] = useState<DeliveryPolicyPush>("never");
  const [policyTrigger, setPolicyTrigger] =
    useState<DeliveryPolicyTrigger>("manual");
  const [execPreset, setExecPreset] = useState<ExecutionPreset>("supervised");
  const [execChecks, setExecChecks] = useState<CheckStrictness>("strict");
  const [execHumanGate, setExecHumanGate] = useState<HumanGateAutonomy>("stop");
  const [execPromotion, setExecPromotion] =
    useState<PromotionTrigger>("manual");
  const [execAdvancedOpen, setExecAdvancedOpen] = useState(false);
  // Budget axis raw text per scope/field (empty = unlimited). Kept as strings so
  // a half-typed / invalid value is rejected inline before it folds into the
  // policy; the prune step coerces to positive ints (NaN / ≤0 dropped).
  const [execBudget, setExecBudget] = useState<BudgetTextAxis>({});
  const [execBudgetOpen, setExecBudgetOpen] = useState(false);
  const [executionBaseline, setExecutionBaseline] =
    useState<ExecutionPolicy | null>(null);
  const [executionEdits, setExecutionEdits] = useState<
    ReadonlySet<"preset" | "checks" | "humanGate" | "promotion" | "budget">
  >(new Set());
  const [budgetChanges, setBudgetChanges] = useState<BudgetTextAxis>({});
  // M39 Stream B (ADR-107): per-package version-adopt choice (default keep).
  const [packageVersions, setPackageVersions] = useState<
    Record<string, VersionChoice>
  >({});
  const [packageVersionsOpen, setPackageVersionsOpen] = useState(false);
  const [setupNotice, setSetupNotice] = useState<string | null>(null);
  const packagePreview = useMemo(() => {
    const entries = Object.entries(packageVersions)
      .filter(([, choice]) => choice === "try_once")
      .sort(([left], [right]) => left.localeCompare(right));

    return entries.length ? JSON.stringify(Object.fromEntries(entries)) : "";
  }, [packageVersions]);
  const hasPackageSetup = Object.values(packageVersions).some(
    (choice) => choice === "adopt" || choice === "cut_and_adopt",
  );
  const dialogId = useId();
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useModalFocusTrap(dialogRef, () => setOpen(false), open);
  const disabled =
    !isClient || busy || pending || (Boolean(disabledReason) && !tracking);

  useEffect(() => {
    if (
      !forceRelaunch &&
      options?.activeLaunch &&
      !intent.receipt &&
      !intent.attempt
    )
      intent.observe(options.activeLaunch);
  }, [
    forceRelaunch,
    options?.activeLaunch,
    intent.receipt,
    intent.attempt,
    intent.observe,
  ]);

  useEffect(() => {
    if (
      !open ||
      forceRelaunch ||
      intent.errorReason !== "launch_already_reserved"
    )
      return;
    const controller = new AbortController();

    // A competing launch may have committed since the original preview. Show
    // its actual admission basis rather than treating our losing click as accepted.
    void fetch(
      `/api/runs/launch-options?taskId=${encodeURIComponent(taskId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Competing task launch status is unavailable");
        const payload = (await response.json()) as LaunchOptions;

        if (!controller.signal.aborted && payload.activeLaunch)
          intent.observe(payload.activeLaunch);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(statusUnavailableMessage);
      });

    return () => controller.abort();
  }, [
    forceRelaunch,
    intent.errorReason,
    intent.observe,
    open,
    statusUnavailableMessage,
    taskId,
  ]);

  useEffect(() => {
    if (!open || options) return;

    const controller = new AbortController();

    fetch(`/api/runs/launch-options?taskId=${encodeURIComponent(taskId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));

        return (await res.json()) as LaunchOptions;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const fallback = branchFallback(payload);
        const base = payload.defaultBaseBranch ?? fallback;
        const target = payload.defaultTargetBranch ?? fallback;

        setOptions(payload);
        setFlowId(payload.selectedFlowId);
        setRunnerId(payload.selectedRunnerId ?? "");
        setPreviewSelection({
          flowId: payload.selectedFlowId,
          runnerId: payload.selectedRunnerId ?? "",
        });
        setBaseBranch(base);
        setTargetBranch(target);
        setPolicyStrategy(payload.deliveryPolicyDefault.strategy);
        setPolicyPush(payload.deliveryPolicyDefault.push);
        setPolicyTrigger(payload.deliveryPolicyDefault.trigger);

        const eff = expandExecutionPolicy(payload.executionPolicyDefault);

        setExecutionBaseline(payload.executionPolicyDefault);
        setExecutionEdits(new Set());
        setBudgetChanges({});
        setExecBudget(launchBudgetText(eff.budget));
        setExecPreset(eff.preset);
        setExecChecks(eff.checks);
        setExecHumanGate(eff.humanGate);
        setExecPromotion(eff.promotion);
        setPackageVersions(
          Object.fromEntries(
            (payload.availablePackageVersions ?? []).map((v) => [
              v.packageInstallId,
              "keep" as VersionChoice,
            ]),
          ),
        );
        setPackageVersionsOpen(
          payload.availablePackageVersions.some((version) =>
            deriveInitialDisclosureState({
              hasNewerCut: version.newerVersionLabel !== null,
              hasUncutEdits: version.hasUncutEdits,
            }),
          ),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOptionsError(true);
      });

    return () => controller.abort();
  }, [open, options, taskId, previewRequestVersion]);

  useEffect(() => {
    if (
      !open ||
      !options ||
      launchPreviewMatches(previewSelection, {
        flowId,
        runnerId,
        packageVersions: packagePreview,
      })
    )
      return;

    const controller = new AbortController();
    const hasRunnerOverride =
      Boolean(runnerId) &&
      (flowId !== options.selectedFlowId ||
        runnerId !== (options.selectedRunnerId ?? ""));
    const query = new URLSearchParams({ taskId });

    if (flowId) query.set("flowId", flowId);
    if (hasRunnerOverride) query.set("runnerId", runnerId);
    if (packagePreview) query.set("packageVersions", packagePreview);

    fetch(`/api/runs/launch-options?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));

        return (await response.json()) as LaunchOptions;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const resolvedRunnerId = hasRunnerOverride
          ? runnerId
          : (payload.selectedRunnerId ?? "");

        setOptions({
          ...payload,
          selectedFlowId: options.selectedFlowId,
          selectedRunnerId: hasRunnerOverride
            ? options.selectedRunnerId
            : payload.selectedRunnerId,
        });
        if (!hasRunnerOverride) setRunnerId(resolvedRunnerId);
        setPreviewSelection({
          flowId,
          runnerId: resolvedRunnerId,
          packageVersions: packagePreview,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setOptionsError(true);
      });

    return () => controller.abort();
  }, [
    open,
    options,
    previewSelection,
    flowId,
    runnerId,
    packagePreview,
    taskId,
    previewRequestVersion,
  ]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (open && dialog && !dialog.contains(document.activeElement))
      (
        dialog.querySelector<HTMLElement>(
          "button:not([disabled]),select:not([disabled]),input:not([disabled])",
        ) ?? dialog
      ).focus();
  }, [open, tracking, loadingOptions, optionsError]);

  const publishesBranch = policyStrategy === "publish_branch";
  const currentPolicy = useMemo<DeliveryPolicy>(
    () =>
      deliveryPolicyForLaunch({
        strategy: policyStrategy,
        push: policyPush,
        trigger: policyTrigger,
        targetBranch: targetBranch || baseBranch || "main",
      }),
    [baseBranch, policyPush, policyStrategy, policyTrigger, targetBranch],
  );

  function onExecPresetChange(preset: ExecutionPreset): void {
    const eff = expandExecutionPolicy({ preset });

    setExecPreset(preset);
    setExecChecks(eff.checks);
    setExecHumanGate(eff.humanGate);
    setExecPromotion(eff.promotion);
    setExecutionEdits(
      (current) =>
        new Set([...current, "preset", "checks", "humanGate", "promotion"]),
    );
  }

  const budgetAxis = useMemo(
    () =>
      editedLaunchBudget(
        executionBaseline?.overrides?.budget ?? {},
        budgetChanges,
      ),
    [executionBaseline, budgetChanges],
  );
  const currentExecutionPolicy = useMemo<ExecutionPolicy>(() => {
    if (executionBaseline && executionEdits.size === 0)
      return executionBaseline;
    const base = expandExecutionPolicy({ preset: execPreset });
    const overrides: ExecutionPolicyOverrides = {
      ...executionBaseline?.overrides,
    };

    if (executionEdits.has("checks")) {
      if (execChecks === base.checks) delete overrides.checks;
      else overrides.checks = execChecks;
    }
    if (executionEdits.has("humanGate")) {
      if (execHumanGate === base.humanGate) delete overrides.humanGate;
      else overrides.humanGate = execHumanGate;
    }
    if (executionEdits.has("promotion")) {
      if (execPromotion === base.promotion) delete overrides.promotion;
      else overrides.promotion = execPromotion;
    }
    if (executionEdits.has("budget")) {
      if (budgetAxis) overrides.budget = budgetAxis;
      else delete overrides.budget;
    }

    return Object.keys(overrides).length
      ? { preset: execPreset, overrides }
      : { preset: execPreset };
  }, [
    budgetAxis,
    execChecks,
    execHumanGate,
    execPreset,
    execPromotion,
    executionBaseline,
    executionEdits,
  ]);

  // AC-UI-2: a non-numeric / negative token value blocks Create (positive ints
  // only; empty stays allowed). The hint below is informational only.
  const budgetInvalid = useMemo(
    () => budgetTextHasInvalid(execBudget),
    [execBudget],
  );
  // AC-UI-3: soft amber note when an unattended run carries no budget at all —
  // never disables Launch.
  const unattendedUnbounded =
    execPreset === "unattended" && budgetAxis === null;

  // A flowless task still saves the choice at launch after its selected Flow's
  // preview passes the same runner preflight as an ordinary launch.
  const unconfigured =
    options?.task.flowId === null ||
    options?.launchability.reason === "unconfigured";
  const runnerSlots =
    options?.runnerSlots ?? options?.consensusRunnerSlots ?? [];
  const previewPending =
    options !== null &&
    !launchPreviewMatches(previewSelection, {
      flowId,
      runnerId,
      packageVersions: packagePreview,
    });
  const hasFailedBinding = runnerSlots.some(
    (slot) =>
      bindingFeedback[`${options?.selectedFlowRevisionId}:${slot.slotKey}`] ===
      "failed",
  );

  async function saveRunnerBinding(
    slot: FlowRunnerSlotPreview,
    mappedRunnerId: string,
  ): Promise<void> {
    const revisionId = options?.selectedFlowRevisionId;

    if (
      !options?.canConfigureRunnerBindings ||
      !revisionId ||
      busy ||
      pending ||
      savingBinding ||
      previewPending ||
      optionsError
    )
      return;

    const key = `${revisionId}:${slot.slotKey}`;

    if (
      mappedRunnerId === (bindingChoices[key] ?? slot.mappedRunnerId ?? "") &&
      bindingFeedback[key] !== "failed"
    )
      return;

    setSavingBinding(key);
    setBindingChoices((current) => ({ ...current, [key]: mappedRunnerId }));
    setBindingFeedback((current) => ({ ...current, [key]: "saving" }));

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(options.task.projectSlug)}/flow-runner-remaps`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            flowRevisionId: revisionId,
            slotKey: slot.slotKey,
            mappedRunnerId: mappedRunnerId || null,
          }),
        },
      );

      if (!response.ok) throw new Error("runner binding save failed");
      setBindingFeedback((current) => ({ ...current, [key]: "saved" }));
      setPreviewSelection(null);
    } catch {
      setBindingFeedback((current) => ({ ...current, [key]: "failed" }));
    } finally {
      setSavingBinding(null);
    }
  }

  function retryPreview(): void {
    setOptionsError(false);
    setPreviewSelection(null);
    setPreviewRequestVersion((version) => version + 1);
  }

  async function applyPackageUpdate(
    pkg: AvailablePackageVersion,
  ): Promise<void> {
    if (!options || !options.canManagePackages || busy) return;
    const choice = packageVersions[pkg.packageInstallId];

    if (choice !== "adopt" && choice !== "cut_and_adopt") return;
    setBusy(true);
    setSetupNotice(null);
    setError(null);
    try {
      if (choice === "adopt" && !pkg.newerCutInstallId) {
        setError(t("admission.setupFailed"));

        return;
      }
      const response = await fetch(
        choice === "adopt"
          ? `/api/projects/${encodeURIComponent(options.task.projectSlug)}/packages/${encodeURIComponent(pkg.attachmentId)}/upgrade`
          : `/api/studio/local-packages/${encodeURIComponent(pkg.localPackageId)}/cut-version`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            choice === "adopt"
              ? { packageInstallId: pkg.newerCutInstallId }
              : { adoptInProjectIds: [options.task.projectId] },
          ),
        },
      );
      const payload = (await response.json()) as {
        adoptions?: Array<{ projectId: string; status: string }>;
      };

      if (!response.ok)
        setError(
          t(
            response.status === 403
              ? "admission.packageForbidden"
              : response.status === 409
                ? "admission.packageConflict"
                : "admission.setupFailed",
          ),
        );
      else if (
        choice === "cut_and_adopt" &&
        !payload.adoptions?.some(
          (adoption) =>
            adoption.projectId === options.task.projectId &&
            adoption.status === "adopted",
        )
      )
        setError(t("admission.setupPartial"));
      else setSetupNotice(t("admission.setupApplied"));
    } catch {
      setError(t("admission.setupUnknown"));
    } finally {
      // A cut can persist even if its adoption or response fails. Re-read the
      // real pin/options; never automatically repeat a cut or start execution.
      setPackageVersions((current) => ({
        ...current,
        [pkg.packageInstallId]: "keep",
      }));
      retryPreview();
      setBusy(false);
    }
  }

  async function launch(): Promise<void> {
    if (
      !options ||
      !effectiveLaunchVerdict(options, forceRelaunch).launchable ||
      previewPending ||
      savingBinding !== null ||
      hasFailedBinding ||
      optionsError
    )
      return;
    if (
      Object.values(packageVersions).some(
        (choice) => choice === "adopt" || choice === "cut_and_adopt",
      )
    )
      return;
    const selection = buildLaunchBody({
      taskId,
      flowId,
      runnerId,
      initialRunnerId:
        flowId === options.selectedFlowId ? options.selectedRunnerId : null,
      baseBranch,
      targetBranch,
      deliveryPolicy: currentPolicy,
      executionPolicy: currentExecutionPolicy,
      packageVersions,
    });
    const endpoint = replacement
      ? `/api/task-launch-intents/${encodeURIComponent(replacement.intentId)}/replace`
      : forceRelaunch
        ? "/api/task-launch-intents/concurrent"
        : "/api/task-launch-intents";

    await intent.submit(endpoint, {
      ...selection,
      expectedTaskRevision: options.task.revision,
      expectedSettingsToken: options.settingsToken,
      autoPromote: currentPolicy.trigger === "auto_on_ready",
      ...(replacement
        ? { expectedStateVersion: replacement.stateVersion }
        : {}),
    });
  }

  async function scheduleLaunch(): Promise<void> {
    if (!options || !scheduledLocalTime || !schedulePreview) return;
    if (
      !effectiveLaunchVerdict(options, forceRelaunch).launchable ||
      previewPending ||
      savingBinding !== null ||
      hasFailedBinding ||
      optionsError
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const scheduledLaunchBody = buildScheduledLaunchBody({
        taskId,
        flowId,
        runnerId,
        initialRunnerId:
          flowId === options.selectedFlowId ? options.selectedRunnerId : null,
        baseBranch,
        targetBranch,
        deliveryPolicy: currentPolicy,
        executionPolicy: currentExecutionPolicy,
        packageVersions,
        scheduledLocalTime,
        timezone: scheduleTimezone,
        disambiguation: scheduleDisambiguation,
      });
      const response = await fetch(
        `/api/projects/${encodeURIComponent(options.task.projectSlug)}/scheduled-launches`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(scheduledLaunchBody),
        },
      );

      if (!response.ok) {
        setError(t("scheduleError"));

        return;
      }

      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError(t("scheduleError"));
    } finally {
      setBusy(false);
    }
  }

  const fieldLabelClass =
    "font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute";
  const retryButtonClass =
    "h-7 gap-1.5 rounded-md border-line-soft bg-paper px-2 font-mono text-[10px] text-ink-2 hover:border-amber-line hover:bg-amber-soft hover:text-amber";
  const defaultPolicy = options?.deliveryPolicyDefault;
  const flowOptions: Array<SelectOption<string>> =
    options?.flows.map((flow) => ({
      id: flow.id,
      disabled: !flow.enabled,
      label: flow.name,
    })) ?? [];
  const runnerOptions: Array<SelectOption<string>> =
    options?.runners.map((runner) => ({
      id: runner.id,
      disabled: !runner.enabled || runner.readinessStatus !== "Ready",
      label: runnerLabel(runner),
    })) ?? [];
  const runnerResolutionWarnings = options
    ? launchRunnerResolutionWarnings(options, runnerId)
    : [];
  const branchOptions: Array<SelectOption<string>> =
    options?.branches.map((branch) => ({ id: branch, label: branch })) ?? [];
  const strategyOptions: Array<SelectOption<DeliveryPolicyStrategy>> = [
    { id: "merge", label: t("strategyMerge") },
    { id: "rebase_merge", label: t("strategyRebaseMerge") },
    { id: "pull_request", label: t("strategyPullRequest") },
    { id: "ai_rebase_merge", label: t("strategyAiRebaseMerge") },
    { id: "publish_branch", label: t("strategyPublishBranch") },
  ];
  const pushOptions: Array<SelectOption<DeliveryPolicyPush>> = [
    { id: "never", label: t("pushNever") },
    { id: "on_success", label: t("pushOnSuccess") },
  ];
  const triggerOptions: Array<SelectOption<DeliveryPolicyTrigger>> = [
    { id: "manual", label: t("triggerManual") },
    { id: "auto_on_ready", label: t("triggerAutoOnReady") },
  ];
  const execPresetOptions: Array<SelectOption<ExecutionPreset>> = [
    { id: "supervised", label: t("execPresetSupervised") },
    { id: "assisted", label: t("execPresetAssisted") },
    { id: "unattended", label: t("execPresetUnattended") },
  ];
  const execLocks = blindShipLockedOptions({
    checks: execChecks,
    humanGate: execHumanGate,
    promotion: execPromotion,
  });
  const execChecksOptions: Array<SelectOption<CheckStrictness>> = [
    { id: "strict", label: t("execChecksStrict") },
    {
      id: "advisory",
      label: t("execChecksAdvisory"),
      disabled: execLocks.relaxedChecksDisabled,
    },
    {
      id: "skip",
      label: t("execChecksSkip"),
      disabled: execLocks.relaxedChecksDisabled,
    },
  ];
  const execHumanGateOptions: Array<SelectOption<HumanGateAutonomy>> = [
    { id: "stop", label: t("execHumanGateStop") },
    {
      id: "auto_pass",
      label: t("execHumanGateAutoPass"),
      disabled: execLocks.autoPassDisabled,
    },
  ];
  const execPromotionOptions: Array<SelectOption<PromotionTrigger>> = [
    { id: "manual", label: t("execPromotionManual") },
    {
      id: "auto_on_ready",
      label: t("execPromotionAuto"),
      disabled: execLocks.autoPromoteDisabled,
    },
  ];
  const defaultExec = options
    ? expandExecutionPolicy(options.executionPolicyDefault)
    : null;
  const execChanged =
    defaultExec !== null &&
    (execPreset !== defaultExec.preset ||
      execChecks !== defaultExec.checks ||
      execHumanGate !== defaultExec.humanGate ||
      execPromotion !== defaultExec.promotion);
  const execGuardActive =
    execLocks.relaxedChecksDisabled ||
    execLocks.autoPassDisabled ||
    execLocks.autoPromoteDisabled;
  const showOverride =
    options !== null &&
    defaultPolicy !== undefined &&
    (flowId !== options.selectedFlowId ||
      runnerId !== (options.selectedRunnerId ?? "") ||
      baseBranch !== (options.defaultBaseBranch ?? branchFallback(options)) ||
      targetBranch !==
        (options.defaultTargetBranch ?? branchFallback(options)) ||
      policyChanged(currentPolicy, defaultPolicy));
  // ADR-119: in force-relaunch mode the create gate reads the `relaunch` verdict
  // (busy → launchable) instead of `launchability`; the busy/pending terms below
  // are the popover's own submit-in-flight flags, left untouched.
  const launchVerdict = options
    ? effectiveLaunchVerdict(options, forceRelaunch)
    : null;
  const createDisabled =
    busy ||
    pending ||
    loadingOptions ||
    optionsError ||
    Boolean(intent.attempt) ||
    intent.errorReason === "launch_storage_unavailable" ||
    !launchVerdict?.launchable ||
    previewPending ||
    savingBinding !== null ||
    hasFailedBinding ||
    !flowId ||
    !baseBranch ||
    hasPackageSetup ||
    budgetInvalid;
  const scheduleDisabled = createDisabled || schedulePreview === null;
  const budgetFieldLabels: Record<BudgetField, string> = {
    maxTokens: t("budgetMaxTokens"),
    hardMaxTokens: t("budgetHardMaxTokens"),
    warnAtPct: t("budgetWarnPct"),
    consecutiveFailures: t("budgetConsecutiveFailures"),
    wallClockMinutes: t("budgetWallClockMinutes"),
  };
  const budgetFieldPlaceholders: Partial<Record<BudgetField, string>> = {
    hardMaxTokens: t("budgetHardMaxHint"),
    warnAtPct: "80",
  };
  const launchUnavailableReason =
    launchVerdict && !launchVerdict.launchable
      ? launchVerdictReasonMessage(launchVerdict, (key) => t(key))
      : "";

  function onBudgetChange(
    scope: BudgetScope,
    field: BudgetField,
    value: string,
  ): void {
    setExecBudget((prev) => ({
      ...prev,
      [scope]: { ...(prev[scope] ?? {}), [field]: value },
    }));
    setBudgetChanges((prev) => ({
      ...prev,
      [scope]: { ...(prev[scope] ?? {}), [field]: value },
    }));
    setExecutionEdits((current) => new Set([...current, "budget"]));
  }

  return (
    <>
      <span title={error ?? disabledReason}>
        <Button
          ref={openerRef}
          className={clsx(
            "gap-1 border-transparent px-[9px] py-[5px] font-mono text-[10px] font-bold uppercase leading-none tracking-[0.06em] text-amber",
            "group-hover/task:border-amber-line group-hover/task:bg-amber-soft",
            "hover:!border-amber hover:!bg-amber hover:!text-white",
            disabled && "opacity-60",
          )}
          isDisabled={disabled}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            if (!options) setOptionsError(false);
            setOpen(true);
          }}
        >
          {forceRelaunch ? (
            <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
          ) : null}
          {error ?? (disabledReason ? disabledLabel : label)}
        </Button>
      </span>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-labelledby={`${dialogId}-title`}
              aria-modal="true"
              className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto px-4 py-10"
              role="dialog"
            >
              <button
                aria-label={t("close")}
                className="fixed inset-0 cursor-default bg-[rgba(22,20,15,0.48)] backdrop-blur-sm"
                tabIndex={-1}
                type="button"
                onClick={() => {
                  setOpen(false);
                  openerRef.current?.focus();
                }}
              />
              <section
                ref={dialogRef}
                aria-labelledby={`${dialogId}-title`}
                className="relative w-full max-w-[620px] rounded-[12px] border border-line bg-paper p-5 shadow-[0_24px_80px_-28px_rgba(22,20,15,0.45)]"
                data-testid="task-launch-dialog"
                tabIndex={-1}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2
                      className="text-[16px] font-semibold leading-tight text-ink"
                      id={`${dialogId}-title`}
                    >
                      {t(hasRuns ? "title" : "titleFirst")}
                    </h2>
                    <p className="mt-1 font-mono text-[11px] text-mute">
                      {publishesBranch
                        ? t("publishBranchSummary", { base: baseBranch || "-" })
                        : t("summary", {
                            branch: targetBranch || "-",
                            base: baseBranch || "-",
                          })}
                    </p>
                  </div>
                  <button
                    ref={closeRef}
                    aria-label={t("close")}
                    className="font-mono text-[14px] text-mute hover:text-ink"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      openerRef.current?.focus();
                    }}
                  >
                    ✕
                  </button>
                </div>

                {intent.conflict ? (
                  <p
                    className="mb-3 rounded-md border border-amber-line bg-amber-soft p-3 text-sm"
                    role="alert"
                  >
                    {t("admission.conflictNotAccepted")}{" "}
                    {t(`admission.existingBasis.${intent.conflict.basis}`)}{" "}
                    {intent.conflict.runId ? (
                      <a
                        className="underline"
                        href={`/runs/${encodeURIComponent(intent.conflict.runId)}`}
                      >
                        {t("admission.openExistingRun")}
                      </a>
                    ) : intent.conflict.intentId ? (
                      <button
                        className="underline"
                        disabled={busy}
                        type="button"
                        onClick={() => void intent.inspectConflict()}
                      >
                        {t("admission.inspectExistingLaunch")}
                      </button>
                    ) : null}
                  </p>
                ) : null}
                {tracking ? (
                  <TaskLaunchIntentStatus
                    busy={intent.busy}
                    errorReason={intent.errorReason}
                    receipt={intent.receipt}
                    uncertain={intent.uncertain}
                    onCancel={async () => {
                      if (!intent.receipt) return;
                      await intent.submit(
                        `/api/task-launch-intents/${encodeURIComponent(intent.receipt.intentId)}/cancel`,
                        {
                          expectedStateVersion: intent.receipt.stateVersion,
                        },
                      );
                    }}
                    onNewLaunch={() => {
                      intent.clearCompleted();
                      setOptions(null);
                      setOptionsError(false);
                    }}
                    onRefresh={intent.refresh}
                    onReplace={() => {
                      if (!intent.receipt) return;
                      setReplacement({
                        intentId: intent.receipt.intentId,
                        stateVersion: intent.receipt.stateVersion,
                      });
                      setOptions(null);
                      setOptionsError(false);
                    }}
                    onRetryRequest={intent.retryRequest}
                  />
                ) : loadingOptions ? (
                  <p className="font-mono text-[12px] text-mute">
                    {t("loading")}
                  </p>
                ) : optionsError && !options ? (
                  <p
                    aria-live="polite"
                    className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700"
                    role="alert"
                  >
                    {t("optionsError")}
                  </p>
                ) : options ? (
                  <fieldset
                    className="flex min-w-0 flex-col gap-4"
                    disabled={busy || Boolean(intent.attempt)}
                  >
                    <p
                      className="rounded-md border border-line-soft bg-ivory/50 px-3 py-2 text-sm text-ink-2"
                      role="note"
                    >
                      {t(
                        options.qualification?.freshness === "current" &&
                          options.qualification.decision === "ready"
                          ? "admission.triageAccepted"
                          : options.qualification?.freshness === "stale"
                            ? "admission.triageStale"
                            : options.qualification?.decision &&
                                options.qualification.decision !== "ready"
                              ? "admission.triageNegative"
                              : options.qualification?.sourceFailure ||
                                  options.qualification?.candidate
                                    ?.publicationReason ===
                                    "qualification_source_failed"
                                ? "admission.triageFailed"
                                : "admission.triageMissing",
                      )}
                    </p>
                    {options.qualification?.sourceFailure ? (
                      <TaskQualificationSourceFailureNotice
                        failure={options.qualification.sourceFailure}
                      />
                    ) : null}
                    {replacement ? (
                      <p role="note">
                        {t("admission.replaceHint")}{" "}
                        {t("admission.replacementRevision", {
                          previous:
                            intent.receipt?.taskRevision ??
                            options.task.revision,
                          current: options.task.revision,
                        })}
                      </p>
                    ) : null}
                    {options.enforcementRefusal ? (
                      <TaskEnforcementRefusalNotice
                        refusal={options.enforcementRefusal}
                      />
                    ) : intent.errorReason ===
                        "flow_settings_enforcement_refused" &&
                      intent.enforcementRefusal ? (
                      <TaskEnforcementRefusalNotice
                        refusal={intent.enforcementRefusal}
                      />
                    ) : intent.errorReason ? (
                      <p role="alert">
                        {t(taskLaunchReasonKey(intent.errorReason))}
                      </p>
                    ) : null}
                    {previewPending && !optionsError ? (
                      <p role="status">{t("loading")}</p>
                    ) : null}
                    {optionsError ? (
                      <div>
                        <p role="alert">{t("optionsError")}</p>
                        <Button
                          className={retryButtonClass}
                          isDisabled={busy || pending || savingBinding !== null}
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={retryPreview}
                        >
                          <ArrowPathIcon
                            aria-hidden="true"
                            className="size-4"
                          />
                          {t("retryPreview")}
                        </Button>
                      </div>
                    ) : null}
                    {!launchVerdict?.launchable ? (
                      <p className="rounded-[8px] border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-amber">
                        {unconfigured
                          ? t("unconfiguredHint")
                          : t("disabledReason", {
                              reason: launchUnavailableReason,
                            })}
                      </p>
                    ) : null}

                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="flex flex-col gap-1">
                        <span className={fieldLabelClass}>
                          {t("flow")}
                          {flowId !== options.selectedFlowId ? (
                            <b className="ml-2 text-amber">{t("override")}</b>
                          ) : null}
                        </span>
                        <LaunchSelect
                          disabled={busy || pending || savingBinding !== null}
                          label={t("flow")}
                          options={flowOptions}
                          value={flowId}
                          onChange={(value) => {
                            setOptionsError(false);
                            setFlowId(value);
                          }}
                        />
                      </label>

                      {options.runners.length > 0 ? (
                        <label className="flex flex-col gap-1">
                          <span className={fieldLabelClass}>
                            {t("runnerModel")}
                            {runnerId !== (options.selectedRunnerId ?? "") ? (
                              <b className="ml-2 text-amber">{t("override")}</b>
                            ) : null}
                          </span>
                          <LaunchSelect
                            disabled={busy || pending || savingBinding !== null}
                            label={t("runnerModel")}
                            options={runnerOptions}
                            value={runnerId}
                            onChange={(value) => {
                              setOptionsError(false);
                              setRunnerId(value);
                            }}
                          />
                          <span className="font-mono text-[10px] text-mute">
                            {t("pinnedModel", {
                              model:
                                options.runners.find((r) => r.id === runnerId)
                                  ?.pinnedModel.model ?? "-",
                            })}
                          </span>
                        </label>
                      ) : null}
                    </div>

                    {runnerSlots.length > 0 ? (
                      <div
                        className="rounded-[8px] border border-line-soft px-3 py-2 text-[12px]"
                        data-testid="launch-runner-slots"
                      >
                        <p className="font-semibold">{t("flowRunners")}</p>
                        <p className="mt-1 text-mute">
                          {t(
                            options.canConfigureRunnerBindings
                              ? "runnerBindingScope"
                              : "runnerBindingAdminNeeded",
                          )}
                        </p>
                        <ul className="mt-2 divide-y divide-line-soft">
                          {runnerSlots.map((slot) => {
                            const bindingKey = `${options.selectedFlowRevisionId}:${slot.slotKey}`;
                            const choice =
                              bindingChoices[bindingKey] ??
                              slot.mappedRunnerId ??
                              "";
                            const rowFeedback = bindingFeedback[bindingKey];

                            return (
                              <li
                                key={slot.slotKey}
                                className={clsx(
                                  "py-3 first:pt-1 last:pb-1",
                                  slot.errorCode ? "text-danger" : "text-mute",
                                )}
                              >
                                {slot.errorCode
                                  ? t("runnerSlotUnresolved", {
                                      role: slot.label,
                                    })
                                  : t("runnerSlotResolved", {
                                      role: slot.label,
                                      runner: slot.runnerId ?? "",
                                    })}
                                <p className="mt-1 text-mute">
                                  {slot.mappedRunnerId
                                    ? t("runnerBindingExplicit", {
                                        runner: slot.mappedRunnerId,
                                      })
                                    : t("runnerBindingAutomatic")}
                                </p>
                                {options.canConfigureRunnerBindings &&
                                options.selectedFlowRevisionId ? (
                                  <div className="mt-2 flex flex-wrap items-end gap-2">
                                    <label className="flex min-w-0 flex-1 flex-col gap-1">
                                      <span>
                                        {t("runnerBindingRunner", {
                                          role: slot.label,
                                        })}
                                      </span>
                                      <LaunchSelect
                                        disabled={
                                          busy ||
                                          pending ||
                                          savingBinding !== null ||
                                          previewPending ||
                                          optionsError
                                        }
                                        label={t("runnerBindingRunner", {
                                          role: slot.label,
                                        })}
                                        options={[
                                          {
                                            id: "",
                                            label: t("runnerBindingAutomatic"),
                                          },
                                          ...options.runners
                                            .filter(
                                              (runner) =>
                                                runner.enabled &&
                                                runner.readinessStatus ===
                                                  "Ready",
                                            )
                                            .map((runner) => ({
                                              id: runner.id,
                                              label: runnerLabel(runner),
                                            })),
                                        ]}
                                        value={choice}
                                        onChange={(value) =>
                                          void saveRunnerBinding(slot, value)
                                        }
                                      />
                                    </label>
                                  </div>
                                ) : null}
                                {savingBinding === bindingKey ? (
                                  <p
                                    className="mt-1.5 flex items-center gap-1.5 text-mute"
                                    role="status"
                                  >
                                    <ArrowPathIcon
                                      aria-hidden="true"
                                      className="size-3 animate-spin motion-reduce:animate-none"
                                    />
                                    {t("runnerBindingSaving")}
                                  </p>
                                ) : null}
                                {rowFeedback === "saved" ? (
                                  <p
                                    className="mt-1.5 flex items-center gap-1.5 text-mute"
                                    role="status"
                                  >
                                    <CheckIcon
                                      aria-hidden="true"
                                      className="size-3 text-accent-4"
                                    />
                                    {t("runnerBindingSaved")}
                                  </p>
                                ) : null}
                                {rowFeedback === "failed" ? (
                                  <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <p
                                      className="flex-1 text-danger"
                                      role="alert"
                                    >
                                      {t("runnerBindingSaveFailed")}
                                    </p>
                                    <Button
                                      aria-label={t("runnerBindingRetryRole", {
                                        role: slot.label,
                                      })}
                                      className={retryButtonClass}
                                      isDisabled={
                                        busy ||
                                        pending ||
                                        savingBinding !== null ||
                                        previewPending ||
                                        optionsError
                                      }
                                      size="sm"
                                      type="button"
                                      variant="outline"
                                      onClick={() =>
                                        void saveRunnerBinding(slot, choice)
                                      }
                                    >
                                      <ArrowPathIcon
                                        aria-hidden="true"
                                        className="size-3"
                                      />
                                      {t("runnerBindingRetry")}
                                    </Button>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                        {runnerSlots.some((slot) => slot.errorCode) ? (
                          <a
                            className="mt-2 inline-block underline"
                            href={`/projects/${encodeURIComponent(options.task.projectSlug)}?tab=settings`}
                          >
                            {t("configureRunnerBindings")}
                          </a>
                        ) : null}
                      </div>
                    ) : null}

                    <details
                      className="rounded-[10px] border border-line-soft bg-ivory/50 p-3"
                      data-testid="launch-advanced-options"
                    >
                      <summary className="cursor-pointer font-mono text-[11px] font-semibold text-mute hover:text-ink">
                        {t("advanced")}
                      </summary>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className={fieldLabelClass}>
                            {tRun("baseBranch")}
                            {baseBranch !==
                            (options.defaultBaseBranch ??
                              branchFallback(options)) ? (
                              <b className="ml-2 text-amber">{t("override")}</b>
                            ) : null}
                          </span>
                          <LaunchSelect
                            label={tRun("baseBranch")}
                            options={branchOptions}
                            value={baseBranch}
                            onChange={setBaseBranch}
                          />
                        </label>
                        {!publishesBranch ? (
                          <label className="flex flex-col gap-1">
                            <span className={fieldLabelClass}>
                              {tRun("targetBranch")}
                              {targetBranch !==
                              (options.defaultTargetBranch ??
                                branchFallback(options)) ? (
                                <b className="ml-2 text-amber">
                                  {t("override")}
                                </b>
                              ) : null}
                            </span>
                            <LaunchSelect
                              label={tRun("targetBranch")}
                              options={branchOptions}
                              value={targetBranch}
                              onChange={setTargetBranch}
                            />
                          </label>
                        ) : null}
                      </div>

                      {runnerResolutionWarnings.length > 0 ? (
                        <div
                          className="flex gap-2 rounded-[8px] border border-amber-line bg-amber-soft px-3 py-2 text-[12px] text-amber"
                          role="status"
                        >
                          <ExclamationTriangleIcon
                            aria-hidden="true"
                            className="mt-[1px] size-4 shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {t("runnerResolutionWarningTitle")}
                            </p>
                            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 font-mono text-[10px] leading-snug">
                              {runnerResolutionWarnings.map((warning) => (
                                <li key={warning.slotKey}>{warning.message}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ) : null}

                      {options.availablePackageVersions.length > 0 ? (
                        <details
                          className="rounded-[10px] border border-amber-line bg-amber-soft/40 p-3"
                          data-testid="launch-package-versions"
                          open={packageVersionsOpen}
                          onToggle={(event) =>
                            setPackageVersionsOpen(event.currentTarget.open)
                          }
                        >
                          <summary className="mb-1 flex cursor-pointer items-center justify-between gap-3">
                            <h3 className="text-[13px] font-semibold text-ink">
                              {t("packageVersions")}
                            </h3>
                            {Object.values(packageVersions).some(
                              (v) => v !== "keep",
                            ) ? (
                              <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-amber">
                                {t("override")}
                              </span>
                            ) : null}
                          </summary>
                          <p className="mb-2 font-mono text-[10px] text-mute">
                            {t("packageVersionsHint")}
                          </p>
                          <div className="flex flex-col gap-3">
                            {options.availablePackageVersions.map((pkg) => (
                              <div
                                key={pkg.packageInstallId}
                                className="flex flex-col gap-1"
                              >
                                <span className={fieldLabelClass}>
                                  {pkg.localPackageName}
                                  <span className="ml-2 font-normal normal-case text-mute">
                                    {pkg.newerVersionLabel
                                      ? t("packageVersionNewer", {
                                          current: pkg.currentVersionLabel,
                                          next: pkg.newerVersionLabel,
                                        })
                                      : t("packageVersionUncut", {
                                          current: pkg.currentVersionLabel,
                                        })}
                                  </span>
                                </span>
                                <LaunchSelect
                                  label={pkg.localPackageName}
                                  options={pkg.offeredOptions.map((opt) => ({
                                    id: opt,
                                    disabled:
                                      (opt === "adopt" &&
                                        !options.canManagePackages) ||
                                      (opt === "cut_and_adopt" &&
                                        !options.canCutPackages),
                                    label: t(`packageVersionOption.${opt}`),
                                  }))}
                                  value={
                                    packageVersions[pkg.packageInstallId] ??
                                    "keep"
                                  }
                                  onChange={(value: VersionChoice) =>
                                    setPackageVersions((prev) => ({
                                      ...prev,
                                      [pkg.packageInstallId]: value,
                                    }))
                                  }
                                />
                                {packageVersions[pkg.packageInstallId] ===
                                  "adopt" ||
                                packageVersions[pkg.packageInstallId] ===
                                  "cut_and_adopt" ? (
                                  <div className="flex flex-col gap-2">
                                    <p role="note">
                                      {t("admission.setupRequired")}
                                    </p>
                                    <Button
                                      isDisabled={
                                        busy ||
                                        (packageVersions[
                                          pkg.packageInstallId
                                        ] === "cut_and_adopt"
                                          ? !options.canCutPackages
                                          : !options.canManagePackages)
                                      }
                                      size="sm"
                                      type="button"
                                      variant="outline"
                                      onClick={() =>
                                        void applyPackageUpdate(pkg)
                                      }
                                    >
                                      {t("admission.applyPackage")}
                                    </Button>
                                  </div>
                                ) : null}
                                {packageVersions[pkg.packageInstallId] ===
                                "try_once" ? (
                                  <span className="font-mono text-[10px] text-mute">
                                    {t("packageVersionTryOnceHint")}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                            {setupNotice ? (
                              <p role="status">{setupNotice}</p>
                            ) : null}
                          </div>
                        </details>
                      ) : null}

                      <div className="rounded-[10px] border border-line-soft bg-ivory/50 p-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h3 className="text-[13px] font-semibold text-ink">
                            {t("deliveryPolicy")}
                          </h3>
                          {defaultPolicy &&
                          policyChanged(currentPolicy, defaultPolicy) ? (
                            <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-amber">
                              {t("override")}
                            </span>
                          ) : null}
                        </div>
                        <div className="grid gap-3 md:grid-cols-3">
                          <label className="flex flex-col gap-1">
                            <span className={fieldLabelClass}>
                              {t("strategy")}
                            </span>
                            <LaunchSelect
                              label={t("strategy")}
                              options={strategyOptions}
                              value={policyStrategy}
                              onChange={setPolicyStrategy}
                            />
                          </label>
                          {!publishesBranch ? (
                            <>
                              <label className="flex flex-col gap-1">
                                <span className={fieldLabelClass}>
                                  {t("push")}
                                </span>
                                <LaunchSelect
                                  label={t("push")}
                                  options={pushOptions}
                                  value={currentPolicy.push}
                                  onChange={setPolicyPush}
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className={fieldLabelClass}>
                                  {t("trigger")}
                                </span>
                                <LaunchSelect
                                  label={t("trigger")}
                                  options={triggerOptions}
                                  value={currentPolicy.trigger}
                                  onChange={setPolicyTrigger}
                                />
                              </label>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </details>

                    <div className="rounded-[10px] border border-line-soft bg-ivory/50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-[13px] font-semibold text-ink">
                          {t("executionControl")}
                        </h3>
                        {execChanged ? (
                          <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-amber">
                            {t("override")}
                          </span>
                        ) : null}
                      </div>
                      <div className="grid items-end gap-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className={fieldLabelClass}>
                            {t("execPreset")}
                          </span>
                          <LaunchSelect
                            label={t("execPreset")}
                            options={execPresetOptions}
                            value={execPreset}
                            onChange={onExecPresetChange}
                          />
                        </label>
                        <button
                          aria-expanded={execAdvancedOpen}
                          className="h-9 self-end text-left font-mono text-[10.5px] text-mute hover:text-ink"
                          type="button"
                          onClick={() => setExecAdvancedOpen((v) => !v)}
                        >
                          {execAdvancedOpen
                            ? t("execAdvancedHide")
                            : t("execAdvancedShow")}
                        </button>
                      </div>
                      {execAdvancedOpen ? (
                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          <label className="flex flex-col gap-1">
                            <span className={fieldLabelClass}>
                              {t("execChecks")}
                            </span>
                            <LaunchSelect
                              label={t("execChecks")}
                              options={execChecksOptions}
                              value={execChecks}
                              onChange={(value) => {
                                setExecChecks(value);
                                setExecutionEdits(
                                  (current) => new Set([...current, "checks"]),
                                );
                              }}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className={fieldLabelClass}>
                              {t("execHumanGate")}
                            </span>
                            <LaunchSelect
                              label={t("execHumanGate")}
                              options={execHumanGateOptions}
                              value={execHumanGate}
                              onChange={(value) => {
                                setExecHumanGate(value);
                                setExecutionEdits(
                                  (current) =>
                                    new Set([...current, "humanGate"]),
                                );
                              }}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className={fieldLabelClass}>
                              {t("execPromotion")}
                            </span>
                            <LaunchSelect
                              label={t("execPromotion")}
                              options={execPromotionOptions}
                              value={execPromotion}
                              onChange={(value) => {
                                setExecPromotion(value);
                                setExecutionEdits(
                                  (current) =>
                                    new Set([...current, "promotion"]),
                                );
                              }}
                            />
                          </label>
                        </div>
                      ) : null}
                      {execAdvancedOpen && execGuardActive ? (
                        <p className="mt-2 font-mono text-[10px] text-mute">
                          {t("execNoBlindShip")}
                        </p>
                      ) : null}
                    </div>

                    <div className="rounded-[10px] border border-line-soft bg-ivory/50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-[13px] font-semibold text-ink">
                          {t("budgetTitle")}
                        </h3>
                        <button
                          aria-expanded={execBudgetOpen}
                          className="font-mono text-[10.5px] text-mute hover:text-ink"
                          type="button"
                          onClick={() => setExecBudgetOpen((v) => !v)}
                        >
                          {execBudgetOpen ? t("budgetHide") : t("budgetShow")}
                        </button>
                      </div>
                      <p className="font-mono text-[10px] text-mute">
                        {t("budgetHint")}
                      </p>
                      {execBudgetOpen ? (
                        <div className="mt-3 flex flex-col gap-3">
                          {(["run", "task", "tree"] as const).map((scope) => (
                            <BudgetScopeFields
                              key={scope}
                              fieldLabels={budgetFieldLabels}
                              fieldPlaceholders={budgetFieldPlaceholders}
                              heading={t(`budgetScope.${scope}`)}
                              invalidLabel={t("budgetInvalid")}
                              scope={scope}
                              values={execBudget[scope] ?? {}}
                              onChange={(field, value) =>
                                onBudgetChange(scope, field, value)
                              }
                            />
                          ))}
                        </div>
                      ) : null}
                      {unattendedUnbounded ? (
                        <p
                          className="mt-2 flex items-start gap-1.5 rounded-[8px] border border-amber-line bg-amber-soft px-2.5 py-2 font-mono text-[10.5px] leading-[1.5] text-amber"
                          data-testid="budget-unattended-hint"
                          role="note"
                        >
                          <ExclamationTriangleIcon
                            aria-hidden="true"
                            className="mt-px h-3.5 w-3.5 shrink-0"
                          />
                          {t("budgetUnattendedHint")}
                        </p>
                      ) : null}
                    </div>

                    {showOverride ? (
                      <p className="font-mono text-[10.5px] text-amber">
                        {t("overrideHint")}
                      </p>
                    ) : null}

                    {error ? (
                      <p
                        aria-live="polite"
                        className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700"
                        role="alert"
                      >
                        {error}
                      </p>
                    ) : null}

                    {scheduleMode ? (
                      <div className="grid gap-3 rounded-[8px] border border-amber-line bg-amber-soft p-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className={fieldLabelClass}>
                            {t("scheduleWhen")}
                          </span>
                          <input
                            aria-label={t("scheduleWhen")}
                            className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                            min={new Date().toISOString().slice(0, 16)}
                            type="datetime-local"
                            value={scheduledLocalTime}
                            onChange={(event) =>
                              setScheduledLocalTime(event.target.value)
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={fieldLabelClass}>
                            {t("scheduleTimezone")}
                          </span>
                          <input
                            aria-label={t("scheduleTimezone")}
                            className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                            value={scheduleTimezone}
                            onChange={(event) =>
                              setScheduleTimezone(event.target.value)
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 md:col-span-2">
                          <span className={fieldLabelClass}>
                            {t("scheduleDst")}
                          </span>
                          <select
                            aria-label={t("scheduleDst")}
                            className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                            value={scheduleDisambiguation}
                            onChange={(event) =>
                              setScheduleDisambiguation(
                                event.target.value as "earlier" | "later",
                              )
                            }
                          >
                            <option value="earlier">
                              {t("scheduleEarlier")}
                            </option>
                            <option value="later">{t("scheduleLater")}</option>
                          </select>
                        </label>
                        <p className="md:col-span-2 font-mono text-[10px] text-amber">
                          {t("scheduleHint")}
                        </p>
                        {scheduledLocalTime && scheduleTimezone ? (
                          schedulePreview ? (
                            <p className="md:col-span-2 font-mono text-[10px] text-mute">
                              {t("scheduleResolvedAt", {
                                utc: schedulePreview.resolvedAt,
                              })}
                              {schedulePreview.isAmbiguous
                                ? ` ${t("scheduleAmbiguousPreview", {
                                    earlier: schedulePreview.earlierAt,
                                    later: schedulePreview.laterAt,
                                  })}`
                                : ""}
                            </p>
                          ) : (
                            <p
                              className="md:col-span-2 font-mono text-[10px] text-red-700"
                              role="alert"
                            >
                              {t("schedulePreviewInvalid")}
                            </p>
                          )
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex justify-end gap-2 border-t border-line-soft pt-3">
                      <Button
                        className="border border-amber-line bg-amber-soft font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-amber hover:bg-amber hover:text-white"
                        isDisabled={
                          busy ||
                          pending ||
                          (scheduleMode ? scheduleDisabled : createDisabled)
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (scheduleMode) {
                            void scheduleLaunch();
                          } else {
                            setScheduleMode(true);
                          }
                        }}
                      >
                        {busy && scheduleMode
                          ? t("scheduling")
                          : scheduleMode
                            ? t("confirmSchedule")
                            : t("scheduleRun")}
                      </Button>
                      <Button
                        className={clsx(
                          "bg-amber font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2",
                          createDisabled && "opacity-60",
                        )}
                        isDisabled={createDisabled}
                        size="sm"
                        type="button"
                        variant="primary"
                        onClick={() => void launch()}
                      >
                        {busy || pending ? t("creating") : t("createRun")}
                      </Button>
                    </div>
                  </fieldset>
                ) : null}
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
