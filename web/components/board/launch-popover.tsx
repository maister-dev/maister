"use client";

import type { Key, ReactElement } from "react";

import { Button, ListBox, Select } from "@heroui/react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

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
  task: { projectSlug: string; number: number };
};

type SelectOption<T extends string> = {
  id: T;
  label: string;
  disabled?: boolean;
};

export interface LaunchPopoverProps {
  taskId: string;
  label: string;
  disabledLabel: string;
  disabledReason?: string;
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
  return `${runner.id} · ${runner.adapter} · ${runner.model}`;
}

function selectedValue<T extends string>(key: Key | null, fallback: T): T {
  if (key === null) return fallback;

  return String(key) as T;
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

export function LaunchPopover({
  taskId,
  label,
  disabledLabel,
  disabledReason,
}: LaunchPopoverProps): ReactElement {
  const t = useTranslations("launch");
  const tRun = useTranslations("run");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        openerRef.current?.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
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

      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId,
          flowId,
          runnerId: runnerId || undefined,
          baseBranch: baseBranch || undefined,
          targetBranch: targetBranch || undefined,
          deliveryPolicy: currentPolicy,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;

        setError(data?.code ?? data?.message ?? "CRASH");

        return;
      }

      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
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
      label: `${flow.name}${flow.version ? ` · ${flow.version}` : ""}${
        flow.isTaskDefault ? ` · ${t("default")}` : ""
      }`,
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
    !baseBranch;

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

      {open ? (
        <div
          aria-labelledby={`${dialogId}-title`}
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-10"
          role="dialog"
        >
          <section
            className="w-full max-w-[620px] rounded-[12px] border border-line bg-paper p-4 shadow-[0_24px_80px_-28px_rgba(22,20,15,0.45)]"
            data-testid="task-launch-dialog"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2
                  className="text-[16px] font-semibold leading-tight text-ink"
                  id={`${dialogId}-title`}
                >
                  {t("title")}
                </h2>
                <p className="mt-1 font-mono text-[11px] text-mute">
                  {t("summary", {
                    branch: targetBranch || "-",
                    base: baseBranch || "-",
                  })}
                </p>
              </div>
              <Button
                ref={closeRef}
                className="border-line bg-ivory font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:text-ink"
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  openerRef.current?.focus();
                }}
              >
                {t("close")}
              </Button>
            </div>

            {loadingOptions ? (
              <p className="font-mono text-[12px] text-mute">{t("loading")}</p>
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
                          reason: options.launchability.reason,
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
                      (options.defaultBaseBranch ?? branchFallback(options)) ? (
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
                      <span className={fieldLabelClass}>{t("strategy")}</span>
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
                      <span className={fieldLabelClass}>{t("trigger")}</span>
                      <LaunchSelect
                        label={t("trigger")}
                        options={triggerOptions}
                        value={policyTrigger}
                        onChange={setPolicyTrigger}
                      />
                    </label>
                  </div>
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
                    className="border-line bg-ivory font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:text-ink"
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                  >
                    {t("close")}
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
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
