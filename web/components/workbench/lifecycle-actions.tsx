"use client";

import type { RunKind } from "@/lib/db/schema";
import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxIcon,
  ArrowTopRightOnSquareIcon,
  PencilSquareIcon,
  StopIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import clsx from "clsx";

export interface WorkbenchLifecycleActionsProps {
  runId: string;
  runKind: RunKind;
  actions: WorkbenchLifecycleActionId[];
  className?: string;
  variant?: "compact" | "detail" | "menu";
  // Rail `menu` variant extras: the run link for "Open run", the linked-task
  // KEY-N chip in the sheet/rename header, and the current name seeding rename.
  runHref?: string;
  taskKey?: string | null;
  taskNumber?: number | null;
  runLabel?: string;
}

type UiActionId =
  | WorkbenchLifecycleActionId
  | "snapshotCommit"
  | "open"
  | "rename"
  | "stopArchive"
  | "stopDrop"
  | "menu";

type CombinedActionId = "stopArchive" | "stopDrop";

// Small leading glyph per rail-menu item.
const MENU_ICON: Partial<Record<UiActionId, typeof TrashIcon>> = {
  open: ArrowTopRightOnSquareIcon,
  rename: PencilSquareIcon,
  stop: StopIcon,
  stopArchive: ArchiveBoxArrowDownIcon,
  archive: ArchiveBoxIcon,
  stopDrop: TrashIcon,
  drop: TrashIcon,
};

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
  action: WorkbenchLifecycleActionId | CombinedActionId;
}): string {
  if (input.action === "stop" && input.runKind === "scratch") {
    return `/api/scratch-runs/${input.runId}/stop`;
  }

  if (input.action === "stopArchive") {
    return `/api/runs/${input.runId}/stop-archive`;
  }

  if (input.action === "stopDrop") {
    // Scratch Stop & drop reuses the single-transaction discard route.
    return input.runKind === "scratch"
      ? `/api/scratch-runs/${input.runId}/discard`
      : `/api/runs/${input.runId}/stop-drop`;
  }

  return `/api/runs/${input.runId}/${ACTION_PATH[input.action]}`;
}

function renderActions(
  actions: WorkbenchLifecycleActionId[],
): (WorkbenchLifecycleActionId | "snapshotCommit")[] {
  return actions.flatMap((action) =>
    action === "exportBranch" ? ["snapshotCommit", "exportBranch"] : [action],
  );
}

// Rail `menu` variant: the ordered action-sheet items per run state. Plain Stop
// stops the run and leaves the worktree; snapshot/push/handoff stay in the run
// card. Combined Stop & * are flow + scratch only (agent gets plain Stop only).
function railMenuItems(
  actions: WorkbenchLifecycleActionId[],
  runKind: RunKind,
): UiActionId[] {
  const items: UiActionId[] = ["open"];

  if (runKind === "scratch") items.push("rename");

  if (actions.includes("stop")) {
    items.push("stop");

    if (runKind === "flow" || runKind === "scratch") {
      items.push("stopArchive", "stopDrop");
    }

    return items;
  }

  if (actions.includes("archive")) items.push("archive");
  if (actions.includes("drop")) items.push("drop");

  return items;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

// Anchored-popover position from the trigger's rect: clamped horizontally to the
// viewport; opens upward when there is not enough room below.
function anchoredPopoverStyle(rect: DOMRect): CSSProperties {
  const width = 256; // matches w-64
  const margin = 8;
  const left = Math.max(
    margin,
    Math.min(rect.left, window.innerWidth - width - margin),
  );
  const spaceBelow = window.innerHeight - rect.bottom;

  if (spaceBelow < 280 && rect.top > spaceBelow) {
    return { left, bottom: window.innerHeight - rect.top + 4 };
  }

  return { left, top: rect.bottom + 4 };
}

// Shared lifecycle dialog. `detail`/`compact` variants render a centered modal;
// the rail `menu` variant passes `anchorRect` to render a small popover anchored
// to the `⋯` trigger. Either way it portals to <body> so it escapes the rail's
// `overflow-y-auto` clip AND the row's `focus-within` group (otherwise opening it
// keeps the row visually "selected" and covers the run link).
function DialogShell({
  title,
  cancel,
  children,
  footer,
  onClose,
  anchorRect,
  bare = false,
}: {
  title: string;
  cancel: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  anchorRect?: DOMRect | null;
  bare?: boolean;
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const anchored = anchorRect != null;

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

    // A small anchored popover must not lock page scroll; only the centered
    // modal does.
    const previousOverflow = document.body.style.overflow;

    if (!anchored) document.body.style.overflow = "hidden";

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
      if (!anchored) document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [anchored]);

  if (typeof document === "undefined") return null;

  const dialogBox = (
    <div
      ref={dialogRef}
      aria-labelledby={bare ? undefined : "workbench-lifecycle-dialog-title"}
      aria-modal={anchored || bare ? undefined : "true"}
      className={clsx(
        "z-10 flex flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-2xl",
        anchored
          ? bare
            ? "fixed max-h-[70vh] w-56"
            : "fixed max-h-[70vh] w-64"
          : "relative max-h-[86vh] w-full max-w-[520px]",
      )}
      role={bare ? "menu" : "dialog"}
      style={anchored ? anchoredPopoverStyle(anchorRect) : undefined}
    >
      {bare ? (
        <div className="flex-1 overflow-auto py-1">{children}</div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );

  return createPortal(
    anchored ? (
      <div className="fixed inset-0 z-[220]">
        <button
          aria-label={cancel}
          className="absolute inset-0 cursor-default"
          tabIndex={-1}
          type="button"
          onClick={onClose}
        />
        {dialogBox}
      </div>
    ) : (
      <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
        <button
          aria-label={cancel}
          className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.48)] backdrop-blur-sm"
          tabIndex={-1}
          type="button"
          onClick={onClose}
        />
        {dialogBox}
      </div>
    ),
    document.body,
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
  runHref,
  taskKey,
  taskNumber,
  runLabel,
}: WorkbenchLifecycleActionsProps): ReactElement | null {
  const t = useTranslations("workbenchLifecycle");
  // The rename modal reuses the existing portfolio.rename copy.
  const tp = useTranslations("portfolio");
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
  const [renameValue, setRenameValue] = useState(runLabel ?? "");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // `menu` variant: the `⋯` trigger lives inside the row's `focus-within` group,
  // so the dialog is portaled out and anchored to this container's rect.
  const containerRef = useRef<HTMLDivElement>(null);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);

  // Focus the rename field when its panel opens — follows the explicit menu
  // click, never on load, so jsx-a11y/no-autofocus stays satisfied.
  useEffect(() => {
    if (dialogAction === "rename") renameInputRef.current?.focus();
  }, [dialogAction]);

  // The `menu` variant always offers at least "Open run", so it renders even
  // with no lifecycle actions; other variants hide when there is nothing to do.
  if (variant !== "menu" && actions.length === 0) return null;

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
    if (variant === "menu" && containerRef.current) {
      setMenuAnchorRect(containerRef.current.getBoundingClientRect());
    }
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

  async function postAction(
    action: WorkbenchLifecycleActionId | CombinedActionId,
  ): Promise<void> {
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

  async function submitRename(): Promise<void> {
    const trimmed = renameValue.trim();

    if (trimmed.length < 1 || trimmed.length > 200) {
      setErrorState({
        code: "PRECONDITION",
        message: null,
        retryHint: null,
        pushRejected: null,
        canForce: false,
      });

      return;
    }
    setBusyAction("rename");
    setErrorState(null);

    try {
      const res = await fetch(`/api/scratch-runs/${runId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!res.ok) {
        setErrorState(
          errorStateFromBody(await readJson<LifecycleErrorBody>(res)),
        );

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

  const displayActions = variant === "menu" ? [] : renderActions(actions);
  const menuItems = railMenuItems(actions, runKind);
  const error = compactErrorText(t, errorState);
  const handoffBranchValid = isValidHandoffBranch(handoffBranch);
  const remoteValid = isValidRemoteName(remote);
  const forcePushAvailable =
    errorState?.pushRejected === "non_fast_forward" && errorState.canForce;
  const exportDirty = metadata?.dirty === true;

  return (
    <div
      ref={containerRef}
      className={clsx(
        "flex flex-wrap items-center gap-1.5",
        variant === "detail" && "gap-2",
        className,
      )}
      data-testid="workbench-lifecycle-actions"
    >
      {variant === "menu" ? (
        <button
          aria-label={t("tooltip.menu")}
          className={clsx(
            buttonBase,
            "h-[26px] w-[26px] justify-center border-line bg-paper p-0 text-mute hover:border-mute hover:text-ink-2",
          )}
          data-testid="rail-menu-trigger"
          disabled={busyAction !== null}
          title={t("tooltip.menu")}
          type="button"
          onClick={() => openDialog("menu")}
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <circle cx="3" cy="8" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="13" cy="8" r="1.3" />
          </svg>
        </button>
      ) : null}
      {displayActions.map((action) => {
        const label = t(`action.${action}`);

        return (
          <button
            key={action}
            className={clsx(
              buttonBase,
              variant === "detail"
                ? "px-3 py-1.5 text-[10.5px]"
                : "px-2 py-1 text-[9.5px]",
              action === "drop"
                ? "border-amber-line bg-amber-soft text-amber hover:bg-ivory"
                : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
              busyAction === action && "opacity-60",
            )}
            disabled={busyAction !== null}
            type="button"
            onClick={() => openDialog(action)}
          >
            {busyAction === action ? t("busy", { action: label }) : label}
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
          anchorRect={dialogAction === "menu" ? menuAnchorRect : null}
          bare={dialogAction === "menu"}
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
              dialogAction === "drop" ||
              dialogAction === "stopArchive" ||
              dialogAction === "stopDrop" ? (
                <button
                  className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                  disabled={busyAction !== null}
                  type="button"
                  onClick={() => void postAction(dialogAction)}
                >
                  {t("dialog.confirm")}
                </button>
              ) : null}
              {dialogAction === "rename" ? (
                <button
                  className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                  data-testid="rename-save"
                  disabled={
                    busyAction !== null || renameValue.trim().length === 0
                  }
                  type="button"
                  onClick={() => void submitRename()}
                >
                  {tp("rename.confirm")}
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
          title={
            dialogAction === "rename"
              ? tp("rename.title")
              : t(`dialog.title.${dialogAction}`)
          }
          onClose={closeDialog}
        >
          <div className="flex flex-col gap-3 text-[12px] leading-[1.45] text-ink-2">
            {dialogAction === "stop" ||
            dialogAction === "archive" ||
            dialogAction === "drop" ||
            dialogAction === "stopArchive" ||
            dialogAction === "stopDrop" ? (
              <p>{t(`dialog.body.${dialogAction}`)}</p>
            ) : null}
            {dialogAction === "menu" ? (
              <div className="flex flex-col" data-testid="rail-action-sheet">
                {menuItems.map((item) => {
                  const Icon = MENU_ICON[item];
                  const danger = item === "drop" || item === "stopDrop";
                  const itemClass = clsx(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[11px]",
                    danger
                      ? "text-amber hover:bg-amber-soft"
                      : "text-ink-2 hover:bg-ivory hover:text-ink",
                  );

                  return item === "open" ? (
                    <Link
                      key={item}
                      className={itemClass}
                      data-testid="menu-open"
                      href={runHref ?? "#"}
                      role="menuitem"
                    >
                      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
                      {t("action.open")}
                    </Link>
                  ) : (
                    <button
                      key={item}
                      className={itemClass}
                      data-testid={`menu-${item}`}
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        if (item === "rename") setRenameValue(runLabel ?? "");
                        openDialog(item);
                      }}
                    >
                      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
                      {t(`action.${item}`)}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {dialogAction === "rename" ? (
              <>
                {taskKey && taskNumber !== null ? (
                  <span className="inline-flex w-fit items-center rounded-full border border-line bg-ivory px-1.5 py-px font-mono text-[9.5px] text-mute">
                    {taskKey}-{taskNumber}
                  </span>
                ) : null}
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {tp("rename.placeholder")}
                  </span>
                  <input
                    ref={renameInputRef}
                    className={inputClass}
                    data-testid="rename-input"
                    maxLength={200}
                    placeholder={tp("rename.placeholder")}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitRename();
                      }
                    }}
                  />
                </label>
              </>
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
