"use client";

import type {
  CheckStrictness,
  ExecutionPolicy,
  ExecutionPolicyOverrides,
  ExecutionPreset,
  HumanGateAutonomy,
  PromotionTrigger,
} from "@/lib/runs/execution-policy";
import type {
  DeliveryPolicy,
  DeliveryPolicyStrategy,
} from "@/lib/runs/delivery-policy";
import type {
  RelationCandidate,
  RelationsEditorLabels,
} from "@/components/social/relations-editor";
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import type { TaskRelationView } from "@/lib/social/relations";

import {
  CheckIcon,
  PencilSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";

import { MarkdownBody } from "@/components/social/markdown-body";
import { RelationsEditor } from "@/components/social/relations-editor";
import {
  TaskMarkdownEditor,
  type TaskMarkdownEditorLabels,
} from "@/components/social/task-markdown-editor";
import {
  blindShipLockedOptions,
  expandExecutionPolicy,
} from "@/lib/runs/execution-policy";

type EditableTaskField = "title" | "prompt";
type PromotionMode = "" | "local_merge" | "pull_request";
type ExecutionPresetChoice = "" | ExecutionPreset;

type LaunchFlowOption = {
  id: string;
  name: string;
  enabled: boolean;
  disabledReason?: string | null;
};

type LaunchRunnerOption = {
  id: string;
  adapter: string;
  capabilityAgent: string;
  model: string;
  readinessStatus: string;
  enabled: boolean;
};

type LaunchOptions = {
  flows: LaunchFlowOption[];
  runners: LaunchRunnerOption[];
  selectedRunnerId: string | null;
  defaultBaseBranch: string | null;
  defaultTargetBranch: string | null;
  deliveryPolicyDefault: DeliveryPolicy;
  executionPolicyDefault: ExecutionPolicy;
  branches: string[];
};

type TaskEditErrorBody = {
  code?: string;
  message?: string;
};

type TranslationFn = (key: string) => string;

const DELIVERY_STRATEGY_LABEL: Record<DeliveryPolicyStrategy, string> = {
  merge: "strategyMerge",
  rebase_merge: "strategyRebaseMerge",
  pull_request: "strategyPullRequest",
  ai_rebase_merge: "strategyAiRebaseMerge",
};

const EXECUTION_PRESET_LABEL: Record<ExecutionPreset, string> = {
  supervised: "execPresetSupervised",
  assisted: "execPresetAssisted",
  unattended: "execPresetUnattended",
};

const FLOW_DISABLED_REASON_LABEL: Record<string, string> = {
  incompatible: "editFlowIncompatible",
  no_revision: "editFlowNoRevision",
  not_enabled: "editFlowNotEnabled",
  not_installed: "editFlowNotInstalled",
  setup_failed: "editFlowSetupFailed",
  setup_pending: "editFlowSetupPending",
  unsupported_schema: "editFlowUnsupportedSchema",
};

export type TaskEditableTarget = {
  taskId: string;
  number: number;
  keyRef: string;
  title: string;
  prompt: string;
  flowId: string | null;
  runnerId: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  promotionMode: "local_merge" | "pull_request" | null;
  executionPolicy: ExecutionPolicy | null;
  relations: TaskRelationView[];
};

export interface TaskInlineEditableFieldProps {
  slug: string;
  taskNumber: number;
  field: EditableTaskField;
  value: string;
  canEdit: boolean;
  className?: string;
  href?: string;
  multiline?: boolean;
  renderView?: (value: string) => ReactNode;
}

export interface TaskCardEditModalProps {
  card: TaskEditableTarget;
  slug: string;
  canEdit: boolean;
  relationCandidates: RelationCandidate[];
  triggerClassName?: string;
}

function taskApiPath(slug: string, taskNumber: number): string {
  return `/api/projects/${encodeURIComponent(slug)}/tasks/${taskNumber}`;
}

function readErrorCode(body: TaskEditErrorBody | null): string | null {
  return body?.code ?? body?.message ?? null;
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  disabled?: boolean;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
        {props.label}
      </span>
      <select
        className="h-9 w-full min-w-0 rounded-md border border-line-soft bg-paper px-2 font-mono text-[11px] text-ink outline-none transition focus:border-amber disabled:cursor-not-allowed disabled:opacity-60"
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map((option) => (
          <option
            key={option.value || "__empty"}
            disabled={option.disabled}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function errorLabel(code: string | null, tBoard: TranslationFn): string {
  if (code === "CONFIG") return tBoard("editErrorConfig");
  if (code === "UNAUTHORIZED" || code === "PASSWORD_CHANGE_REQUIRED") {
    return tBoard("editErrorForbidden");
  }
  if (code === "PRECONDITION" || code === "CONFLICT") {
    return tBoard("editErrorPrecondition");
  }

  return tBoard("editErrorGeneric");
}

function relationLabels(tTaskDetail: TranslationFn): RelationsEditorLabels {
  return {
    title: tTaskDetail("relationsTitle"),
    empty: tTaskDetail("relationsEmpty"),
    add: tTaskDetail("relationsAdd"),
    adding: tTaskDetail("relationsAdding"),
    numberPlaceholder: tTaskDetail("relationsNumberPlaceholder"),
    searchPlaceholder: tTaskDetail("relationsSearchPlaceholder"),
    searchNoResults: tTaskDetail("relationsSearchNoResults"),
    remove: tTaskDetail("relationsRemove"),
    kindOut: {
      blocks: tTaskDetail("relationKind.blocks"),
      depends_on: tTaskDetail("relationKind.dependsOn"),
      parent_of: tTaskDetail("relationKind.parentOf"),
      requires: tTaskDetail("relationKind.requires"),
    },
    kindIn: {
      blocks: tTaskDetail("relationKindInverse.blocks"),
      depends_on: tTaskDetail("relationKindInverse.dependsOn"),
      parent_of: tTaskDetail("relationKindInverse.parentOf"),
      requires: tTaskDetail("relationKindInverse.requires"),
    },
    errorConfig: tTaskDetail("relationsErrorConfig"),
    errorNotFound: tTaskDetail("relationsErrorNotFound"),
    errorForbidden: tTaskDetail("errorForbidden"),
    errorGeneric: tTaskDetail("errorGeneric"),
  };
}

function runnerLabel(runner: LaunchRunnerOption): string {
  return `${runner.id} · ${runner.model}`;
}

function flowDisabledReasonLabel(
  flow: LaunchFlowOption,
  tBoard: TranslationFn,
): string {
  if (!flow.disabledReason) return tBoard("editFlowUnavailable");

  return tBoard(
    FLOW_DISABLED_REASON_LABEL[flow.disabledReason] ?? "editFlowUnavailable",
  );
}

function flowOptionLabel(
  flow: LaunchFlowOption,
  tBoard: TranslationFn,
): string {
  if (flow.enabled) return flow.name;

  return `${flow.name} · ${flowDisabledReasonLabel(flow, tBoard)}`;
}

function markdownEditorLabels(tBoard: TranslationFn): TaskMarkdownEditorLabels {
  return {
    visual: tBoard("markdownVisual"),
    source: tBoard("markdownSource"),
    loading: tBoard("markdownLoading"),
    empty: tBoard("markdownEmpty"),
    textarea: tBoard("editDescriptionLabel"),
    toolbar: {
      undo: tBoard("markdownToolbar.undo"),
      redo: tBoard("markdownToolbar.redo"),
      heading1: tBoard("markdownToolbar.heading1"),
      heading2: tBoard("markdownToolbar.heading2"),
      quote: tBoard("markdownToolbar.quote"),
      bold: tBoard("markdownToolbar.bold"),
      italic: tBoard("markdownToolbar.italic"),
      inlineCode: tBoard("markdownToolbar.inlineCode"),
      codeBlock: tBoard("markdownToolbar.codeBlock"),
      bulletList: tBoard("markdownToolbar.bulletList"),
      numberedList: tBoard("markdownToolbar.numberedList"),
      link: tBoard("markdownToolbar.link"),
      linkPrompt: tBoard("markdownToolbar.linkPrompt"),
      divider: tBoard("markdownToolbar.divider"),
    },
  };
}

function expandFlowOptions(
  flowId: string,
  options: LaunchOptions | null,
): LaunchFlowOption[] {
  const flows = options?.flows ?? [];

  if (!flowId || flows.some((flow) => flow.id === flowId)) return flows;

  return [
    ...flows,
    {
      id: flowId,
      name: flowId,
      enabled: false,
      disabledReason: "no_revision",
    },
  ];
}

function expandRunnerOptions(
  runnerId: string,
  options: LaunchOptions | null,
): LaunchRunnerOption[] {
  const runners = options?.runners ?? [];

  if (!runnerId || runners.some((runner) => runner.id === runnerId)) {
    return runners;
  }

  return [
    ...runners,
    {
      id: runnerId,
      adapter: runnerId,
      capabilityAgent: runnerId,
      model: runnerId,
      readinessStatus: "Ready",
      enabled: true,
    },
  ];
}

type ExecutionPolicySetters = {
  setExecPreset: (value: ExecutionPresetChoice) => void;
  setExecChecks: (value: CheckStrictness) => void;
  setExecHumanGate: (value: HumanGateAutonomy) => void;
  setExecPromotion: (value: PromotionTrigger) => void;
};

function applyExecutionPolicyAxes(
  policy: ExecutionPolicy,
  setters: Omit<ExecutionPolicySetters, "setExecPreset">,
): void {
  const expanded = expandExecutionPolicy(policy);

  setters.setExecChecks(expanded.checks);
  setters.setExecHumanGate(expanded.humanGate);
  setters.setExecPromotion(expanded.promotion);
}

function resetExecutionPolicy(
  policy: ExecutionPolicy | null,
  setters: ExecutionPolicySetters,
): void {
  if (!policy) {
    setters.setExecPreset("");
    applyExecutionPolicyAxes({ preset: "supervised" }, setters);

    return;
  }

  setters.setExecPreset(policy.preset);
  applyExecutionPolicyAxes(policy, setters);
}

function buildExecutionPolicy(args: {
  initialPolicy: ExecutionPolicy | null;
  preset: ExecutionPresetChoice;
  checks: CheckStrictness;
  humanGate: HumanGateAutonomy;
  promotion: PromotionTrigger;
}): ExecutionPolicy | null {
  if (args.preset === "") return null;

  const base = expandExecutionPolicy({ preset: args.preset });
  const preservedOverrides: ExecutionPolicyOverrides =
    args.initialPolicy?.preset === args.preset
      ? { ...(args.initialPolicy.overrides ?? {}) }
      : {};

  if (args.checks === base.checks) {
    delete preservedOverrides.checks;
  } else {
    preservedOverrides.checks = args.checks;
  }

  if (args.humanGate === base.humanGate) {
    delete preservedOverrides.humanGate;
  } else {
    preservedOverrides.humanGate = args.humanGate;
  }

  if (args.promotion === base.promotion) {
    delete preservedOverrides.promotion;
  } else {
    preservedOverrides.promotion = args.promotion;
  }

  return Object.keys(preservedOverrides).length > 0
    ? { preset: args.preset, overrides: preservedOverrides }
    : { preset: args.preset };
}

export function TaskInlineEditableField({
  slug,
  taskNumber,
  field,
  value,
  canEdit,
  className,
  href,
  multiline = false,
  renderView,
}: TaskInlineEditableFieldProps): ReactElement {
  const tBoard = useTranslations("board");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) return;
    setDraft(value);
  }, [editing, value]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function cancel(): void {
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  async function save(): Promise<void> {
    const trimmed = draft.trim();

    if (trimmed.length === 0) {
      setError(tBoard("editValidationRequired"));

      return;
    }

    setError(null);
    setBusy(true);

    const body = field === "title" ? { title: trimmed } : { prompt: trimmed };

    try {
      const res = await fetch(taskApiPath(slug, taskNumber), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = (await res
          .json()
          .catch(() => null)) as TaskEditErrorBody | null;

        setError(errorLabel(readErrorCode(err), tBoard));

        return;
      }

      setEditing(false);
      startTransition(() => router.refresh());
    } catch {
      setError(tBoard("editErrorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void save();
  }

  function onKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();

      return;
    }

    if (
      multiline &&
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      void save();
    }
  }

  if (editing) {
    return (
      <form
        className={clsx("flex w-full min-w-0 flex-col gap-1", className)}
        onSubmit={onSubmit}
      >
        {multiline ? (
          <TaskMarkdownEditor
            autoFocusOnMount
            disabled={busy || pending}
            labels={markdownEditorLabels(tBoard)}
            textareaClassName="min-h-[96px] text-[11px] leading-[1.45]"
            value={draft}
            onCancelShortcut={cancel}
            onChange={setDraft}
            onSubmitShortcut={save}
          />
        ) : (
          <input
            ref={inputRef as RefObject<HTMLInputElement>}
            className="h-8 w-full min-w-0 rounded-md border border-amber bg-paper px-2 text-[13px] font-semibold leading-[1.35] text-ink outline-none"
            disabled={busy || pending}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <div className="flex items-center gap-1.5">
          <button
            aria-label={tBoard("editSave")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-line bg-paper text-ink transition hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || pending}
            type="submit"
          >
            <CheckIcon className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label={tBoard("editCancel")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-line bg-paper text-mute transition hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || pending}
            type="button"
            onClick={cancel}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
          {error ? (
            <span className="text-[11px] font-medium text-danger" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      </form>
    );
  }

  const editLabel =
    field === "title" ? tBoard("editTitle") : tBoard("editDescription");
  const content = renderView ? (
    renderView(value)
  ) : multiline && field === "prompt" ? (
    <MarkdownBody text={value} variant="compact" />
  ) : href ? (
    <Link
      className="min-w-0 break-words align-middle hover:text-amber hover:underline"
      href={href}
    >
      {value}
    </Link>
  ) : (
    <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
  );

  return (
    <div
      className={clsx("group/edit flex min-w-0 items-start gap-1.5", className)}
    >
      <div className="min-w-0 flex-1">{content}</div>
      {canEdit ? (
        <button
          aria-label={editLabel}
          className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-md border border-transparent text-mute opacity-0 transition hover:border-line hover:bg-ivory hover:text-amber group-hover/edit:opacity-100 focus:opacity-100"
          type="button"
          onClick={() => setEditing(true)}
        >
          <PencilSquareIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function TaskCardEditModal({
  card,
  slug,
  canEdit,
  relationCandidates,
  triggerClassName,
}: TaskCardEditModalProps): ReactElement | null {
  const tBoard = useTranslations("board");
  const tCommon = useTranslations("common");
  const tLaunch = useTranslations("launch");
  const tRun = useTranslations("run");
  const tTaskDetail = useTranslations("taskDetail");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [prompt, setPrompt] = useState(card.prompt);
  const [flowId, setFlowId] = useState(card.flowId ?? "");
  const [runnerId, setRunnerId] = useState(card.runnerId ?? "");
  const [baseBranch, setBaseBranch] = useState(card.baseBranch ?? "");
  const [targetBranch, setTargetBranch] = useState(card.targetBranch ?? "");
  const [promotionMode, setPromotionMode] = useState<PromotionMode>(
    card.promotionMode ?? "",
  );
  const [execPreset, setExecPreset] = useState<ExecutionPresetChoice>(
    card.executionPolicy?.preset ?? "",
  );
  const [execChecks, setExecChecks] = useState<CheckStrictness>("strict");
  const [execHumanGate, setExecHumanGate] = useState<HumanGateAutonomy>("stop");
  const [execPromotion, setExecPromotion] =
    useState<PromotionTrigger>("manual");
  const dialogId = useId();
  const branchListId = useId();
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    openerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    setTitle(card.title);
    setPrompt(card.prompt);
    setFlowId(card.flowId ?? "");
    setRunnerId(card.runnerId ?? "");
    setBaseBranch(card.baseBranch ?? "");
    setTargetBranch(card.targetBranch ?? "");
    setPromotionMode(card.promotionMode ?? "");
    setOptions(null);
    setOptionsError(false);
    setError(null);
    resetExecutionPolicy(card.executionPolicy, {
      setExecPreset,
      setExecChecks,
      setExecHumanGate,
      setExecPromotion,
    });
  }, [card, open]);

  useEffect(() => {
    if (!open || options) return;

    const controller = new AbortController();

    setLoadingOptions(true);
    setOptionsError(false);

    fetch(
      `/api/runs/launch-options?taskId=${encodeURIComponent(card.taskId)}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));

        return (await res.json()) as LaunchOptions;
      })
      .then((payload) => setOptions(payload))
      .catch(() => {
        if (!controller.signal.aborted) setOptionsError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingOptions(false);
      });

    return () => controller.abort();
  }, [card.taskId, open, options]);

  useEffect(() => {
    if (
      !open ||
      card.executionPolicy !== null ||
      execPreset !== "" ||
      !options
    ) {
      return;
    }

    applyExecutionPolicyAxes(options.executionPolicyDefault, {
      setExecChecks,
      setExecHumanGate,
      setExecPromotion,
    });
  }, [card.executionPolicy, execPreset, open, options]);

  useEffect(() => {
    if (!open) return;

    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [close, open]);

  function onExecPresetChange(value: ExecutionPresetChoice): void {
    setExecPreset(value);

    if (value === "") {
      applyExecutionPolicyAxes(
        options?.executionPolicyDefault ?? {
          preset: "supervised",
        },
        {
          setExecChecks,
          setExecHumanGate,
          setExecPromotion,
        },
      );

      return;
    }

    const expanded = expandExecutionPolicy({ preset: value });

    setExecChecks(expanded.checks);
    setExecHumanGate(expanded.humanGate);
    setExecPromotion(expanded.promotion);
  }

  async function save(): Promise<void> {
    const nextTitle = title.trim();
    const nextPrompt = prompt.trim();

    if (nextTitle.length === 0 || nextPrompt.length === 0) {
      setError(tBoard("editValidationRequired"));

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(taskApiPath(slug, card.number), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          prompt: nextPrompt,
          flowId: flowId || null,
          runnerId: runnerId || null,
          baseBranch: baseBranch.trim() || null,
          targetBranch: targetBranch.trim() || null,
          promotionMode: promotionMode || null,
          executionPolicy: buildExecutionPolicy({
            initialPolicy: card.executionPolicy,
            preset: execPreset,
            checks: execChecks,
            humanGate: execHumanGate,
            promotion: execPromotion,
          }),
        }),
      });

      if (!res.ok) {
        const err = (await res
          .json()
          .catch(() => null)) as TaskEditErrorBody | null;

        setError(errorLabel(readErrorCode(err), tBoard));

        return;
      }

      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError(tBoard("editErrorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const flowOptions = expandFlowOptions(flowId, options);
  const hasLaunchableFlowOptions = flowOptions.some((flow) => flow.enabled);
  const runnerOptions = expandRunnerOptions(runnerId, options);
  const disabled = busy || pending;
  const execDisabled = execPreset === "";
  const defaultRunner =
    options?.selectedRunnerId && options.selectedRunnerId.length > 0
      ? (runnerOptions.find(
          (runner) => runner.id === options.selectedRunnerId,
        ) ?? null)
      : null;
  const defaultRunnerLabel = defaultRunner
    ? runnerLabel(defaultRunner)
    : (options?.selectedRunnerId ?? null);
  const runnerDefaultOptionLabel = defaultRunnerLabel
    ? tBoard("editDefaultValue", { value: defaultRunnerLabel })
    : tLaunch("runnerDefault");
  const baseBranchDefaultValue =
    options?.defaultBaseBranch ??
    options?.defaultTargetBranch ??
    options?.branches[0] ??
    null;
  const baseBranchDefaultLabel = baseBranchDefaultValue
    ? tBoard("editDefaultValue", { value: baseBranchDefaultValue })
    : tBoard("editBaseBranchPlaceholder");
  const effectiveBaseBranch = baseBranch.trim() || baseBranchDefaultValue;
  const targetBranchDefaultLabel = effectiveBaseBranch
    ? tBoard("editDefaultValue", { value: effectiveBaseBranch })
    : tBoard("editTargetBranchPlaceholder");
  const deliveryStrategyDefaultLabel = options?.deliveryPolicyDefault
    ? tBoard("editDefaultValue", {
        value: tLaunch(
          DELIVERY_STRATEGY_LABEL[options.deliveryPolicyDefault.strategy],
        ),
      })
    : tBoard("editPromotionDefault");
  const executionPresetDefaultLabel = options?.executionPolicyDefault
    ? tBoard("editDefaultValue", {
        value: tLaunch(
          EXECUTION_PRESET_LABEL[options.executionPolicyDefault.preset],
        ),
      })
    : tBoard("editExecutionPolicyDefault");
  const execLocks = blindShipLockedOptions({
    checks: execChecks,
    humanGate: execHumanGate,
    promotion: execPromotion,
  });
  const modal = open
    ? createPortal(
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-[rgba(22,20,15,0.46)] p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            aria-labelledby={dialogId}
            aria-modal="true"
            className="relative grid max-h-[calc(100vh-32px)] w-full max-w-[1080px] grid-cols-1 overflow-hidden rounded-[14px] border border-line bg-paper shadow-[0_26px_80px_-30px_rgba(22,20,15,0.42)] lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[minmax(0,1fr)]"
            role="dialog"
          >
            <button
              ref={closeRef}
              aria-label={tBoard("editClose")}
              className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-paper text-mute shadow-sm transition hover:border-amber hover:text-amber"
              disabled={disabled}
              type="button"
              onClick={close}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
            <div className="min-h-0 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
                <div className="min-w-0 pr-10">
                  <div className="min-w-0">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-amber">
                      {card.keyRef}
                    </span>
                    <h2
                      className="m-0 mt-1 text-xl font-semibold leading-tight tracking-[-0.01em] text-ink"
                      id={dialogId}
                    >
                      {tBoard("editTask")}
                    </h2>
                  </div>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
                    {tBoard("editTitleLabel")}
                  </span>
                  <input
                    className="min-h-10 rounded-md border border-line-soft bg-ivory px-3 py-2 text-[18px] font-semibold leading-tight text-ink outline-none transition focus:border-amber"
                    disabled={disabled}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <div className="flex min-h-[290px] flex-col gap-1.5">
                  <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
                    {tBoard("editDescriptionLabel")}
                  </span>
                  <TaskMarkdownEditor
                    className="min-h-[250px] flex-1 bg-ivory"
                    disabled={disabled}
                    labels={markdownEditorLabels(tBoard)}
                    textareaClassName="min-h-[200px] flex-1 bg-ivory"
                    value={prompt}
                    onChange={setPrompt}
                  />
                </div>

                {error ? (
                  <p
                    className="m-0 text-[12px] font-medium text-danger"
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}
              </div>
            </div>

            <aside className="min-h-0 overflow-hidden border-t border-line bg-ivory lg:border-l lg:border-t-0">
              <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="m-0 text-sm font-semibold text-ink">
                    {tBoard("editProperties")}
                  </h3>
                  {loadingOptions ? (
                    <span className="font-mono text-[10px] text-mute">
                      {tBoard("editOptionsLoading")}
                    </span>
                  ) : null}
                </div>
                {optionsError ? (
                  <p
                    className="m-0 rounded-md border border-[color-mix(in_oklab,var(--attention)_45%,var(--line))] bg-[color-mix(in_oklab,var(--attention)_14%,var(--paper))] px-2 py-1.5 text-[11px] font-medium text-attention"
                    role="status"
                  >
                    {tBoard("editOptionsUnavailable")}
                  </p>
                ) : null}
                <div className="grid gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <SelectField
                      disabled={disabled || loadingOptions || optionsError}
                      label={tLaunch("flow")}
                      options={[
                        { value: "", label: tBoard("editNoFlow") },
                        ...flowOptions.map((flow) => ({
                          value: flow.id,
                          label: flowOptionLabel(flow, tBoard),
                          disabled: !flow.enabled,
                        })),
                      ]}
                      value={flowId}
                      onChange={setFlowId}
                    />
                    {flowOptions.length > 0 && !hasLaunchableFlowOptions ? (
                      <p className="m-0 font-mono text-[10px] leading-snug text-mute">
                        {tBoard("editNoLaunchableFlows")}
                      </p>
                    ) : null}
                  </div>
                  <SelectField
                    disabled={disabled || loadingOptions || optionsError}
                    label={tLaunch("runner")}
                    options={[
                      { value: "", label: runnerDefaultOptionLabel },
                      ...runnerOptions.map((runner) => ({
                        value: runner.id,
                        label: runnerLabel(runner),
                        disabled:
                          !runner.enabled || runner.readinessStatus !== "Ready",
                      })),
                    ]}
                    value={runnerId}
                    onChange={setRunnerId}
                  />
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
                      {tRun("baseBranch")}
                    </span>
                    <input
                      className="h-9 w-full min-w-0 rounded-md border border-line-soft bg-paper px-2 font-mono text-[11px] text-ink outline-none transition focus:border-amber disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={disabled}
                      list={branchListId}
                      placeholder={baseBranchDefaultLabel}
                      value={baseBranch}
                      onChange={(event) => setBaseBranch(event.target.value)}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
                      {tRun("targetBranch")}
                    </span>
                    <input
                      className="h-9 w-full min-w-0 rounded-md border border-line-soft bg-paper px-2 font-mono text-[11px] text-ink outline-none transition focus:border-amber disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={disabled}
                      list={branchListId}
                      placeholder={targetBranchDefaultLabel}
                      value={targetBranch}
                      onChange={(event) => setTargetBranch(event.target.value)}
                    />
                    <datalist id={branchListId}>
                      {(options?.branches ?? []).map((branch) => (
                        <option key={branch} value={branch} />
                      ))}
                    </datalist>
                  </label>
                  <SelectField<PromotionMode>
                    disabled={disabled}
                    label={tBoard("editDeliveryStrategyLabel")}
                    options={[
                      { value: "", label: deliveryStrategyDefaultLabel },
                      {
                        value: "local_merge",
                        label: tBoard("editPromotionLocalMerge"),
                      },
                      {
                        value: "pull_request",
                        label: tLaunch("promotionPullRequest"),
                      },
                    ]}
                    value={promotionMode}
                    onChange={setPromotionMode}
                  />
                </div>

                <div className="border-t border-line-soft pt-3">
                  <div className="grid gap-3">
                    <SelectField<ExecutionPresetChoice>
                      disabled={disabled}
                      label={tLaunch("execPreset")}
                      options={[
                        {
                          value: "",
                          label: executionPresetDefaultLabel,
                        },
                        {
                          value: "supervised",
                          label: tLaunch("execPresetSupervised"),
                        },
                        {
                          value: "assisted",
                          label: tLaunch("execPresetAssisted"),
                        },
                        {
                          value: "unattended",
                          label: tLaunch("execPresetUnattended"),
                        },
                      ]}
                      value={execPreset}
                      onChange={onExecPresetChange}
                    />
                    <SelectField<CheckStrictness>
                      disabled={disabled || execDisabled}
                      label={tLaunch("execChecks")}
                      options={[
                        { value: "strict", label: tLaunch("execChecksStrict") },
                        {
                          value: "advisory",
                          label: tLaunch("execChecksAdvisory"),
                          disabled: execLocks.relaxedChecksDisabled,
                        },
                        {
                          value: "skip",
                          label: tLaunch("execChecksSkip"),
                          disabled: execLocks.relaxedChecksDisabled,
                        },
                      ]}
                      value={execChecks}
                      onChange={setExecChecks}
                    />
                    <SelectField<HumanGateAutonomy>
                      disabled={disabled || execDisabled}
                      label={tLaunch("execHumanGate")}
                      options={[
                        {
                          value: "stop",
                          label: tLaunch("execHumanGateStop"),
                        },
                        {
                          value: "auto_pass",
                          label: tLaunch("execHumanGateAutoPass"),
                          disabled: execLocks.autoPassDisabled,
                        },
                      ]}
                      value={execHumanGate}
                      onChange={setExecHumanGate}
                    />
                    <SelectField<PromotionTrigger>
                      disabled={disabled || execDisabled}
                      label={tBoard("editExecutionPromotionLabel")}
                      options={[
                        {
                          value: "manual",
                          label: tLaunch("execPromotionManual"),
                        },
                        {
                          value: "auto_on_ready",
                          label: tLaunch("execPromotionAuto"),
                          disabled: execLocks.autoPromoteDisabled,
                        },
                      ]}
                      value={execPromotion}
                      onChange={setExecPromotion}
                    />
                  </div>
                </div>

                <div className="border-t border-line-soft pt-3">
                  <RelationsEditor
                    canEdit={!disabled}
                    labels={relationLabels(tTaskDetail)}
                    relationCandidates={relationCandidates}
                    relations={card.relations}
                    slug={slug}
                    taskNumber={card.number}
                  />
                </div>

                <div className="mt-auto flex items-center justify-end gap-2 border-t border-line-soft pt-3">
                  <button
                    className="rounded-md border border-line bg-paper px-3 py-1.5 text-[12px] font-semibold text-mute transition hover:border-mute hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    type="button"
                    onClick={close}
                  >
                    {tCommon("cancel")}
                  </button>
                  <button
                    className="rounded-md border border-amber bg-amber px-3 py-1.5 text-[12px] font-semibold text-paper transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    type="button"
                    onClick={() => void save()}
                  >
                    {busy || pending ? tBoard("editSaving") : tCommon("save")}
                  </button>
                </div>
              </div>
            </aside>
          </section>
        </div>,
        document.body,
      )
    : null;

  if (!canEdit) return null;

  const triggerClass =
    triggerClassName ??
    "inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border border-line bg-paper text-mute opacity-0 transition hover:border-amber hover:text-amber group-hover/task:opacity-100 focus:opacity-100";

  return (
    <>
      <button
        ref={openerRef}
        aria-label={tBoard("editTask")}
        className={triggerClass}
        data-testid="task-card-edit-trigger"
        type="button"
        onClick={() => setOpen(true)}
      >
        <PencilSquareIcon className="h-4 w-4" />
      </button>
      {modal}
    </>
  );
}
