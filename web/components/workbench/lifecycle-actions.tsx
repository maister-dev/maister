"use client";

import type { RunKind } from "@/lib/db/schema";
import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { ReactElement, ReactNode } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

export interface WorkbenchLifecycleActionsProps {
  runId: string;
  runKind: RunKind;
  actions: WorkbenchLifecycleActionId[];
  className?: string;
  variant?: "compact" | "detail" | "icon";
}

type UiActionId = WorkbenchLifecycleActionId | "snapshotCommit";

type HandoffMetadata = {
  ok: true;
  runId: string;
  branch: string;
  dirty: boolean;
  remotes: string[];
  defaultRemote: string | null;
  suggestedHandoffBranch: string;
  checkoutCommands: string[];
};

type SnapshotResult = {
  ok: true;
  runId: string;
  branch: string;
  commit: string;
  snapshotCreated: boolean;
};

type HandoffResult = {
  ok: true;
  runId: string;
  branch: string;
  handoffBranch: string;
  remote: string;
  pushedRef: string;
  headCommit: string;
  checkoutCommands: string[];
};

type ExportResult = {
  ok: true;
  runId: string;
  branch: string;
  remote: string;
  pushedRef: string;
  snapshotCreated: boolean;
  checkoutCommands: string[];
};

type ActionResult =
  | { kind: "snapshot"; data: SnapshotResult }
  | { kind: "export"; data: ExportResult }
  | { kind: "handoff"; data: HandoffResult };

type LifecycleErrorBody = {
  code?: string;
  message?: string;
  retryHint?: string;
  pushRejected?: "non_fast_forward";
  canForce?: boolean;
};

type LifecycleErrorState = {
  code: string;
  message: string | null;
  retryHint: string | null;
  pushRejected: "non_fast_forward" | null;
  canForce: boolean;
};

const ACTION_PATH: Record<WorkbenchLifecycleActionId, string> = {
  stop: "stop",
  archive: "archive",
  drop: "drop",
  exportBranch: "export-branch",
};

// Glyphs for the compact `icon` variant — one per UI action, rendered inside a
// 16×16 stroke svg. The accessible name comes from the `tooltip.*` key, so the
// svg itself is aria-hidden.
const actionIcons: Record<UiActionId, ReactNode> = {
  stop: <rect height="8" rx="1" width="8" x="4" y="4" />,
  archive: (
    <>
      <rect height="3" rx="1" width="11" x="2.5" y="3" />
      <path d="M3.5 6v6.5h9V6M6.5 9h3" />
    </>
  ),
  drop: (
    <path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.6 9h5.8l.6-9M6.5 6.5v4M9.5 6.5v4" />
  ),
  snapshotCommit: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 2v3.6M8 10.4V14" />
    </>
  ),
  exportBranch: <path d="M8 11V3M5 6l3-3 3 3M3.5 13h9" />,
};

const buttonBase =
  "inline-flex items-center rounded-md border font-mono font-bold uppercase tracking-[0.06em] transition-colors disabled:opacity-60";

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

function isValidHandoffBranch(value: string): boolean {
  return (
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.length <= 255 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function isValidRemoteName(value: string): boolean {
  return (
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.length <= 255 &&
    !value.startsWith("-")
  );
}

function endpointFor(input: {
  runId: string;
  runKind: RunKind;
  action: WorkbenchLifecycleActionId;
}): string {
  if (input.action === "stop" && input.runKind === "scratch") {
    return `/api/scratch-runs/${input.runId}/stop`;
  }

  return `/api/runs/${input.runId}/${ACTION_PATH[input.action]}`;
}

function renderActions(actions: WorkbenchLifecycleActionId[]): UiActionId[] {
  return actions.flatMap((action) =>
    action === "exportBranch" ? ["snapshotCommit", "exportBranch"] : [action],
  );
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

function DialogShell({
  title,
  cancel,
  children,
  footer,
  onClose,
}: {
  title: string;
  cancel: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
      <button
        aria-label={cancel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.48)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="workbench-lifecycle-dialog-title"
        aria-modal="true"
        className="relative z-10 flex max-h-[86vh] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-2xl"
        role="dialog"
      >
        <div className="border-b border-line px-4 py-3">
          <h2
            className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-ink"
            id="workbench-lifecycle-dialog-title"
          >
            {title}
          </h2>
        </div>
        <div className="flex-1 overflow-auto px-4 py-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

function errorStateFromBody(
  body: LifecycleErrorBody | null,
): LifecycleErrorState {
  return {
    code: body?.code ?? "CRASH",
    message: body?.message ?? null,
    retryHint: body?.retryHint ?? null,
    pushRejected: body?.pushRejected ?? null,
    canForce: body?.canForce === true,
  };
}

function networkErrorState(): LifecycleErrorState {
  return {
    code: "EXECUTOR_UNAVAILABLE",
    message: null,
    retryHint: null,
    pushRejected: null,
    canForce: false,
  };
}

function compactErrorText(
  t: ReturnType<typeof useTranslations>,
  error: LifecycleErrorState | null,
): string | null {
  if (!error) return null;

  const base = t("errorWithCode", { code: error.code });

  return error.message ? `${base}: ${error.message}` : base;
}

export function WorkbenchLifecycleActions({
  runId,
  runKind,
  actions,
  className,
  variant = "compact",
}: WorkbenchLifecycleActionsProps): ReactElement | null {
  const t = useTranslations("workbenchLifecycle");
  const router = useRouter();
  const [dialogAction, setDialogAction] = useState<UiActionId | null>(null);
  const [busyAction, setBusyAction] = useState<UiActionId | null>(null);
  const [errorState, setErrorState] = useState<LifecycleErrorState | null>(
    null,
  );
  const [metadata, setMetadata] = useState<HandoffMetadata | null>(null);
  const [commitMessage, setCommitMessage] = useState(
    t("defaultCommitMessage", { runId }),
  );
  const [remote, setRemote] = useState("origin");
  const [handoffBranch, setHandoffBranch] = useState(
    `maister/handoff/${runId}`,
  );
  const [result, setResult] = useState<ActionResult | null>(null);

  if (actions.length === 0) return null;

  async function loadMetadata(): Promise<void> {
    setErrorState(null);

    const res = await fetch(`/api/runs/${runId}/handoff-metadata`);

    if (!res.ok) {
      const body = await readJson<LifecycleErrorBody>(res);

      setErrorState(errorStateFromBody(body));

      return;
    }

    const body = await readJson<HandoffMetadata>(res);

    if (!body) {
      setErrorState(errorStateFromBody(null));

      return;
    }

    setMetadata(body);
    setRemote(body.defaultRemote ?? "");
    setHandoffBranch(body.suggestedHandoffBranch);
  }

  function openDialog(action: UiActionId): void {
    setDialogAction(action);
    setErrorState(null);
    setResult(null);

    if (action === "snapshotCommit" || action === "exportBranch") {
      void loadMetadata();
    }
  }

  function closeDialog(): void {
    if (busyAction !== null) return;

    setDialogAction(null);
    setErrorState(null);
    setResult(null);
  }

  async function postAction(action: WorkbenchLifecycleActionId): Promise<void> {
    setBusyAction(action);
    setErrorState(null);

    try {
      const res = await fetch(endpointFor({ runId, runKind, action }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const body = await readJson<LifecycleErrorBody>(res);

        setErrorState(errorStateFromBody(body));

        return;
      }

      setDialogAction(null);
      router.refresh();
    } catch {
      setErrorState(networkErrorState());
    } finally {
      setBusyAction(null);
    }
  }

  async function snapshotCommit(): Promise<void> {
    setBusyAction("snapshotCommit");
    setErrorState(null);

    try {
      const res = await fetch(`/api/runs/${runId}/snapshot-commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitMessage }),
      });

      if (!res.ok) {
        const body = await readJson<LifecycleErrorBody>(res);

        setErrorState(errorStateFromBody(body));

        return;
      }

      const body = await readJson<SnapshotResult>(res);

      if (!body) {
        setErrorState(errorStateFromBody(null));

        return;
      }

      setResult({ kind: "snapshot", data: body });
      await loadMetadata();
      router.refresh();
    } catch {
      setErrorState(networkErrorState());
    } finally {
      setBusyAction(null);
    }
  }

  async function pushRunBranch(force: boolean): Promise<void> {
    setBusyAction("exportBranch");
    setErrorState(null);

    try {
      const res = await fetch(`/api/runs/${runId}/export-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          remote,
          snapshotDirty: false,
          commitMessage: null,
          force,
        }),
      });

      if (!res.ok) {
        const body = await readJson<LifecycleErrorBody>(res);

        setErrorState(errorStateFromBody(body));

        return;
      }

      const body = await readJson<ExportResult>(res);

      if (!body) {
        setErrorState(errorStateFromBody(null));

        return;
      }

      setResult({ kind: "export", data: body });
      await loadMetadata();
      router.refresh();
    } catch {
      setErrorState(networkErrorState());
    } finally {
      setBusyAction(null);
    }
  }

  async function createHandoffBranch(): Promise<void> {
    setBusyAction("exportBranch");
    setErrorState(null);

    try {
      const res = await fetch(`/api/runs/${runId}/handoff-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remote, handoffBranch }),
      });

      if (!res.ok) {
        const body = await readJson<LifecycleErrorBody>(res);

        setErrorState(errorStateFromBody(body));

        return;
      }

      const body = await readJson<HandoffResult>(res);

      if (!body) {
        setErrorState(errorStateFromBody(null));

        return;
      }

      setResult({ kind: "handoff", data: body });
      router.refresh();
    } catch {
      setErrorState(networkErrorState());
    } finally {
      setBusyAction(null);
    }
  }

  const displayActions = renderActions(actions);
  const error = compactErrorText(t, errorState);
  const handoffBranchValid = isValidHandoffBranch(handoffBranch);
  const remoteValid = isValidRemoteName(remote);
  const forcePushAvailable =
    errorState?.pushRejected === "non_fast_forward" && errorState.canForce;
  const exportDirty = metadata?.dirty === true;

  return (
    <div
      className={clsx(
        "flex flex-wrap items-center gap-1.5",
        variant === "detail" && "gap-2",
        className,
      )}
      data-testid="workbench-lifecycle-actions"
    >
      {displayActions.map((action) => {
        const label = t(`action.${action}`);
        const tooltip = variant === "icon" ? t(`tooltip.${action}`) : undefined;

        return (
          <button
            key={action}
            aria-label={tooltip}
            className={clsx(
              buttonBase,
              variant === "icon"
                ? "h-[26px] w-[26px] justify-center p-0"
                : variant === "detail"
                  ? "px-3 py-1.5 text-[10.5px]"
                  : "px-2 py-1 text-[9.5px]",
              action === "drop"
                ? "border-amber-line bg-amber-soft text-amber hover:bg-ivory"
                : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
              busyAction === action && "opacity-60",
            )}
            disabled={busyAction !== null}
            title={tooltip}
            type="button"
            onClick={() => openDialog(action)}
          >
            {variant === "icon" ? (
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                viewBox="0 0 16 16"
              >
                {actionIcons[action]}
              </svg>
            ) : busyAction === action ? (
              t("busy", { action: label })
            ) : (
              label
            )}
          </button>
        );
      })}
      {error ? (
        <span
          aria-live="assertive"
          className="font-mono text-[9.5px] font-semibold text-amber"
          role="alert"
        >
          {error}
        </span>
      ) : null}
      {dialogAction ? (
        <DialogShell
          cancel={t("dialog.cancel")}
          footer={
            <>
              <button
                className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
                disabled={busyAction !== null}
                type="button"
                onClick={closeDialog}
              >
                {t("dialog.cancel")}
              </button>
              {dialogAction === "stop" ||
              dialogAction === "archive" ||
              dialogAction === "drop" ? (
                <button
                  className={clsx(
                    "rounded-md border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white disabled:opacity-60",
                    dialogAction === "drop"
                      ? "border-amber bg-amber hover:bg-amber-2"
                      : "border-amber bg-amber hover:bg-amber-2",
                  )}
                  disabled={busyAction !== null}
                  type="button"
                  onClick={() => void postAction(dialogAction)}
                >
                  {t("dialog.confirm")}
                </button>
              ) : null}
              {dialogAction === "snapshotCommit" ? (
                <button
                  className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                  disabled={
                    busyAction !== null ||
                    !commitMessage.trim() ||
                    metadata?.dirty === false
                  }
                  type="button"
                  onClick={() => void snapshotCommit()}
                >
                  {t("dialog.commit")}
                </button>
              ) : null}
              {dialogAction === "exportBranch" ? (
                <>
                  {exportDirty ? (
                    <button
                      className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                      disabled={busyAction !== null || !commitMessage.trim()}
                      type="button"
                      onClick={() => void snapshotCommit()}
                    >
                      {t("dialog.commit")}
                    </button>
                  ) : (
                    <button
                      className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                      disabled={
                        busyAction !== null || !remoteValid || metadata === null
                      }
                      type="button"
                      onClick={() => void pushRunBranch(forcePushAvailable)}
                    >
                      {forcePushAvailable
                        ? t("dialog.forcePush")
                        : t("dialog.push")}
                    </button>
                  )}
                  <button
                    className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2 disabled:opacity-60"
                    disabled={
                      busyAction !== null ||
                      !remoteValid ||
                      !handoffBranchValid ||
                      exportDirty ||
                      metadata === null
                    }
                    type="button"
                    onClick={() => void createHandoffBranch()}
                  >
                    {t("dialog.handoff")}
                  </button>
                </>
              ) : null}
            </>
          }
          title={t(`dialog.title.${dialogAction}`)}
          onClose={closeDialog}
        >
          <div className="flex flex-col gap-3 text-[12px] leading-[1.45] text-ink-2">
            {dialogAction === "stop" ||
            dialogAction === "archive" ||
            dialogAction === "drop" ? (
              <p>{t(`dialog.body.${dialogAction}`)}</p>
            ) : null}
            {dialogAction === "snapshotCommit" ? (
              <>
                {metadata?.dirty === false ? (
                  <p className="rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[10px] text-mute">
                    {t("dialog.clean")}
                  </p>
                ) : null}
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {t("dialog.commitMessage")}
                  </span>
                  <textarea
                    className={clsx(inputClass, "min-h-[90px] py-2")}
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            {dialogAction === "exportBranch" ? (
              <>
                {metadata?.dirty ? (
                  <p className="rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[10px] text-amber">
                    {t("dialog.dirty")}
                  </p>
                ) : null}
                {metadata?.dirty ? (
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                      {t("dialog.commitMessage")}
                    </span>
                    <textarea
                      className={clsx(inputClass, "min-h-[90px] py-2")}
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                    />
                  </label>
                ) : null}
                {metadata ? (
                  <p className="rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[10px] text-mute">
                    {t("dialog.runBranch", { branch: metadata.branch })}
                  </p>
                ) : null}
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {t("dialog.remote")}
                  </span>
                  <select
                    className={inputClass}
                    value={remote}
                    onChange={(event) => {
                      setErrorState(null);
                      setRemote(event.target.value);
                    }}
                  >
                    {(metadata?.remotes ?? [remote]).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  {remote && !remoteValid ? (
                    <span className="font-mono text-[10px] text-amber">
                      {t("dialog.invalidRemote")}
                    </span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {t("dialog.handoffBranch")}
                  </span>
                  <input
                    className={inputClass}
                    value={handoffBranch}
                    onChange={(event) => {
                      setErrorState(null);
                      setHandoffBranch(event.target.value);
                    }}
                  />
                  {handoffBranch && !handoffBranchValid ? (
                    <span className="font-mono text-[10px] text-amber">
                      {t("dialog.invalidBranch")}
                    </span>
                  ) : null}
                  <span className="font-mono text-[10px] text-mute">
                    {t("dialog.handoffHelp")}
                  </span>
                </label>
              </>
            ) : null}
            {result?.kind === "snapshot" ? (
              <p className="rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[10px] text-mute">
                {t("dialog.snapshotDone", { commit: result.data.commit })}
              </p>
            ) : null}
            {result?.kind === "export" ? (
              <div className="rounded-md border border-line bg-ivory p-3">
                <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                  {result.data.pushedRef}
                </div>
                <div className="flex flex-col gap-1">
                  {result.data.checkoutCommands.map((command) => (
                    <div
                      key={command}
                      className="flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                        {command}
                      </code>
                      <button
                        className="font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-amber"
                        type="button"
                        onClick={() =>
                          void navigator.clipboard?.writeText(command)
                        }
                      >
                        {t("dialog.copy")}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {result?.kind === "handoff" ? (
              <div className="rounded-md border border-line bg-ivory p-3">
                <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                  {result.data.pushedRef}
                </div>
                <div className="flex flex-col gap-1">
                  {result.data.checkoutCommands.map((command) => (
                    <div
                      key={command}
                      className="flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                        {command}
                      </code>
                      <button
                        className="font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-amber"
                        type="button"
                        onClick={() =>
                          void navigator.clipboard?.writeText(command)
                        }
                      >
                        {t("dialog.copy")}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {error ? (
              <div className="flex flex-col gap-1 font-mono text-[10px] font-semibold text-amber">
                <p>{error}</p>
                {errorState?.retryHint ? <p>{errorState.retryHint}</p> : null}
              </div>
            ) : null}
          </div>
        </DialogShell>
      ) : null}
    </div>
  );
}
