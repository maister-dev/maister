"use client";

import type { Key, ReactElement } from "react";
import type { LaunchStage } from "@/lib/runs/launch-progress";
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
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
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

import { readLaunchStream } from "@/lib/runs/launch-progress";
import {
  blindShipLockedOptions,
  expandExecutionPolicy,
} from "@/lib/runs/execution-policy";

type DeliveryPolicyStrategy =
  | "merge"
  | "rebase_merge"
  | "pull_request"
  | "ai_rebase_merge";

type DeliveryPolicyPush = "never" | "on_success";
type DeliveryPolicyTrigger = "manual" | "auto_on_ready";

type DeliveryPolicy = {
  strategy: DeliveryPolicyStrategy;
  push: DeliveryPolicyPush;
  trigger: DeliveryPolicyTrigger;
  targetBranch: string;
};

type LaunchFlowOption = {
  id: string;
  refId: string;
  name: string;
  version: string | null;
  enabled: boolean;
  isTaskDefault: boolean;
};

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

type LaunchOptions = {
  launchability: {
    launchable: boolean;
    reason: string;
    blockers: Array<{ kind: string; label: string }>;
  };
  flows: LaunchFlowOption[];
  runners: LaunchRunnerOption[];
  selectedFlowId: string;
  selectedRunnerId: string | null;
  branches: string[];
  defaultBaseBranch: string | null;
  defaultTargetBranch: string | null;
  deliveryPolicyDefault: DeliveryPolicy;
  executionPolicyDefault: ExecutionPolicy;
  task: { projectSlug: string; number: number };
};

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
  flow_missing: "launchUnavailableReason.flowMissing",
  incompatible: "launchUnavailableReason.incompatible",
  not_enabled: "launchUnavailableReason.notEnabled",
  no_revision: "launchUnavailableReason.noRevision",
  not_installed: "launchUnavailableReason.notInstalled",
  setup_failed: "launchUnavailableReason.setupFailed",
  setup_pending: "launchUnavailableReason.setupPending",
  target_terminal: "launchUnavailableReason.targetTerminal",
  unsupported_schema: "launchUnavailableReason.unsupportedSchema",
};

export interface LaunchPopoverProps {
  taskId: string;
  label: string;
  disabledLabel: string;
  disabledReason?: string;
  hasRuns?: boolean;
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

  return key ? translate(key) : reason;
}

function LaunchSelect<T extends string>(props: {
  label: string;
  value: T;
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
}: LaunchPopoverProps): ReactElement {
  const t = useTranslations("launch");
  const tRun = useTranslations("run");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launchStage, setLaunchStage] = useState<LaunchStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
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
  const [execBudgetOpen, setExecBudgetOpen] = useState(true);
  const dialogId = useId();
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const disabled = busy || pending || Boolean(disabledReason);

  useEffect(() => {
    if (!open || options) return;

    const controller = new AbortController();

    setLoadingOptions(true);
    setOptionsError(false);
    setError(null);

    fetch(`/api/runs/launch-options?taskId=${encodeURIComponent(taskId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));

        return (await res.json()) as LaunchOptions;
      })
      .then((payload) => {
        const fallback = branchFallback(payload);
        const base = payload.defaultBaseBranch ?? fallback;
        const target = payload.defaultTargetBranch ?? fallback;

        setOptions(payload);
        setFlowId(payload.selectedFlowId);
        setRunnerId(payload.selectedRunnerId ?? "");
        setBaseBranch(base);
        setTargetBranch(target);
        setPolicyStrategy(payload.deliveryPolicyDefault.strategy);
        setPolicyPush(payload.deliveryPolicyDefault.push);
        setPolicyTrigger(payload.deliveryPolicyDefault.trigger);

        const eff = expandExecutionPolicy(payload.executionPolicyDefault);

        setExecPreset(eff.preset);
        setExecChecks(eff.checks);
        setExecHumanGate(eff.humanGate);
        setExecPromotion(eff.promotion);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOptionsError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingOptions(false);
      });

    return () => controller.abort();
  }, [open, options, taskId]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        openerRef.current?.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const currentPolicy = useMemo<DeliveryPolicy>(
    () => ({
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
  }

  const budgetAxis = useMemo(() => pruneBudgetText(execBudget), [execBudget]);
  const currentExecutionPolicy = useMemo<ExecutionPolicy>(() => {
    const base = expandExecutionPolicy({ preset: execPreset });
    const overrides: ExecutionPolicyOverrides = {};

    if (execChecks !== base.checks) overrides.checks = execChecks;
    if (execHumanGate !== base.humanGate) overrides.humanGate = execHumanGate;
    if (execPromotion !== base.promotion) overrides.promotion = execPromotion;
    if (budgetAxis) overrides.budget = budgetAxis;

    return Object.keys(overrides).length > 0
      ? { preset: execPreset, overrides }
      : { preset: execPreset };
  }, [budgetAxis, execChecks, execHumanGate, execPreset, execPromotion]);

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

  // M34 (ADR-089): a flowless simple-intent task classifies `unconfigured` —
  // the user's flow pick is the set-up step and clears the gate locally.
  const unconfigured = options?.launchability.reason === "unconfigured";
  const setUpReady = unconfigured && flowId !== "";

  async function launch(): Promise<void> {
    if (!options) return;
    if (!options.launchability.launchable && !setUpReady) return;

    setBusy(true);
    setError(null);

    try {
      if (unconfigured) {
        // Owner answer #3: "Set up & launch" PATCHes the task's flow FIRST —
        // the task stays configured for every later launch.
        const patched = await fetch(
          `/api/projects/${options.task.projectSlug}/tasks/${options.task.number}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ flowId }),
          },
        );

        if (!patched.ok) {
          const data = (await patched.json().catch(() => null)) as {
            code?: string;
            message?: string;
          } | null;

          setError(data?.code ?? data?.message ?? "CRASH");

          return;
        }
      }

      setLaunchStage("precondition");

      const res = await fetch("/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          taskId,
          flowId,
          runnerId: runnerId || undefined,
          baseBranch: baseBranch || undefined,
          targetBranch: targetBranch || undefined,
          deliveryPolicy: currentPolicy,
          executionPolicy: currentExecutionPolicy,
        }),
      });

      // A pre-stream precondition failure stays a JSON error with its status.
      if (
        !(res.headers.get("content-type") ?? "").includes("text/event-stream")
      ) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;

        setError(data?.code ?? data?.message ?? "CRASH");

        return;
      }

      const streamed = await readLaunchStream<{
        runId: string;
        status: string;
      }>(res, setLaunchStage);

      if (streamed.error) {
        setError(streamed.error.code ?? streamed.error.message ?? "CRASH");

        return;
      }
      if (!streamed.result) {
        setError("CRASH");

        return;
      }

      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setLaunchStage(null);
      setBusy(false);
    }
  }

  const fieldLabelClass =
    "font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute";
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
  const branchOptions: Array<SelectOption<string>> =
    options?.branches.map((branch) => ({ id: branch, label: branch })) ?? [];
  const strategyOptions: Array<SelectOption<DeliveryPolicyStrategy>> = [
    { id: "merge", label: t("strategyMerge") },
    { id: "rebase_merge", label: t("strategyRebaseMerge") },
    { id: "pull_request", label: t("strategyPullRequest") },
    { id: "ai_rebase_merge", label: t("strategyAiRebaseMerge") },
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
  const createDisabled =
    busy ||
    pending ||
    loadingOptions ||
    optionsError ||
    !(options?.launchability.launchable || setUpReady) ||
    !flowId ||
    !baseBranch ||
    budgetInvalid;
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
    options && !options.launchability.launchable
      ? launchUnavailableReasonMessage(options.launchability.reason, (key) =>
          t(key),
        )
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
          onClick={() => setOpen(true)}
        >
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
                className="relative w-full max-w-[620px] rounded-[12px] border border-line bg-paper p-5 shadow-[0_24px_80px_-28px_rgba(22,20,15,0.45)]"
                data-testid="task-launch-dialog"
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
                      {t("summary", {
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

                {loadingOptions ? (
                  <p className="font-mono text-[12px] text-mute">
                    {t("loading")}
                  </p>
                ) : optionsError ? (
                  <p
                    aria-live="polite"
                    className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700"
                    role="alert"
                  >
                    {t("optionsError")}
                  </p>
                ) : options ? (
                  <div className="flex flex-col gap-4">
                    {!options.launchability.launchable ? (
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
                          label={t("flow")}
                          options={flowOptions}
                          value={flowId}
                          onChange={setFlowId}
                        />
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className={fieldLabelClass}>
                          {t("runnerModel")}
                          {runnerId !== (options.selectedRunnerId ?? "") ? (
                            <b className="ml-2 text-amber">{t("override")}</b>
                          ) : null}
                        </span>
                        <LaunchSelect
                          label={t("runnerModel")}
                          options={runnerOptions}
                          value={runnerId}
                          onChange={setRunnerId}
                        />
                        <span className="font-mono text-[10px] text-mute">
                          {t("pinnedModel", {
                            model:
                              options.runners.find((r) => r.id === runnerId)
                                ?.pinnedModel.model ?? "-",
                          })}
                        </span>
                      </label>

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

                      <label className="flex flex-col gap-1">
                        <span className={fieldLabelClass}>
                          {tRun("targetBranch")}
                          {targetBranch !==
                          (options.defaultTargetBranch ??
                            branchFallback(options)) ? (
                            <b className="ml-2 text-amber">{t("override")}</b>
                          ) : null}
                        </span>
                        <LaunchSelect
                          label={tRun("targetBranch")}
                          options={branchOptions}
                          value={targetBranch}
                          onChange={setTargetBranch}
                        />
                      </label>
                    </div>

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
                        <label className="flex flex-col gap-1">
                          <span className={fieldLabelClass}>{t("push")}</span>
                          <LaunchSelect
                            label={t("push")}
                            options={pushOptions}
                            value={policyPush}
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
                            value={policyTrigger}
                            onChange={setPolicyTrigger}
                          />
                        </label>
                      </div>
                    </div>

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
                              onChange={setExecChecks}
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
                              onChange={setExecHumanGate}
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
                              onChange={setExecPromotion}
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

                    <div className="flex justify-end gap-2 border-t border-line-soft pt-3">
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
                        {busy || pending
                          ? launchStage
                            ? {
                                precondition: t("launchStage.precondition"),
                                worktree_created: t(
                                  "launchStage.worktree_created",
                                ),
                                materializing: t("launchStage.materializing"),
                                spawning: t("launchStage.spawning"),
                                session_ready: t("launchStage.session_ready"),
                              }[launchStage]
                            : t("creating")
                          : t("createRun")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
