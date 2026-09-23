"use client";

import type { RunKind } from "@/lib/db/schema";
import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  CodeBracketIcon,
  PencilSquareIcon,
  StopIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { useRunPageStream } from "@/components/runs/run-stream-provider";
import {
  WorkbenchGitPanel,
  type WorkbenchGitSyncDefaults,
} from "@/components/workbench/git-panel";
import { isMaisterErrorCode } from "@/lib/errors-core";
import {
  gitPanelHref,
  gitPanelSectionFor,
  isGitPanelSection,
  type GitPanelSection,
} from "@/lib/workbench-git/panel-link";

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
  workspaceAvailable?: boolean;
  // Detail variant: the git panel's update seeds (ADR-181 D9).
  syncDefaults?: WorkbenchGitSyncDefaults | null;
}

type UiActionId =
  | WorkbenchLifecycleActionId
  | "open"
  | "rename"
  | "stopArchive"
  | "stopDrop"
  | "menu";

type CombinedActionId = "stopArchive" | "stopDrop";

// The ids this component POSTs itself; every other id is a git action, which is
// only ever a way INTO the run git panel (ADR-181 D16).
type OwnActionId = "stop" | "archive" | "drop";

const OWN_ACTIONS: readonly OwnActionId[] = ["stop", "archive", "drop"];

function isOwnAction(id: WorkbenchLifecycleActionId): id is OwnActionId {
  return (OWN_ACTIONS as readonly string[]).includes(id);
}

// Small leading glyph per rail-menu item.
const MENU_ICON: Partial<Record<UiActionId, typeof TrashIcon>> = {
  open: ArrowTopRightOnSquareIcon,
  rename: PencilSquareIcon,
  stop: StopIcon,
  stopArchive: ArchiveBoxArrowDownIcon,
  archive: ArchiveBoxIcon,
  stopDrop: TrashIcon,
  drop: TrashIcon,
  snapshotCommit: CheckIcon,
  discardChanges: TrashIcon,
  exportBranch: ArrowUpTrayIcon,
  update: ArrowPathIcon,
  openPr: CodeBracketIcon,
  finalizePr: CheckIcon,
  reattach: ArrowPathIcon,
};

// ADR-181 D17: the slice of git-state the archive/drop guard renders.
type GuardState = {
  publishedRemote: string | null;
  publicBranch: string | null;
  dirty: { tracked: number; untracked: number } | null;
  unpushedCommits: number | null;
  aheadBehind: {
    base: { ahead: number } | null;
    target: { ahead: number } | null;
  };
};

type LifecycleErrorBody = {
  code?: string;
  message?: string;
  retryHint?: string;
  reason?: string;
  pushRejected?: "non_fast_forward";
  canForce?: boolean;
};

type LifecycleErrorState = {
  code: string;
  message: string | null;
  retryHint: string | null;
  reason: string | null;
  pushRejected: "non_fast_forward" | null;
  canForce: boolean;
};

const ACTION_PATH: Record<OwnActionId, string> = {
  stop: "stop",
  archive: "archive",
  drop: "drop",
};

const buttonBase =
  "inline-flex items-center rounded-md border font-mono font-bold uppercase tracking-[0.06em] transition-colors disabled:opacity-60";

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

function endpointFor(input: {
  runId: string;
  runKind: RunKind;
  action: OwnActionId | CombinedActionId;
}): string {
  if (input.action === "stop" && input.runKind === "scratch") {
    return `/api/scratch-runs/${input.runId}/stop`;
  }

  if (input.action === "stopArchive") {
    return `/api/runs/${input.runId}/stop-archive`;
  }

  if (input.action === "stopDrop") {
    return `/api/runs/${input.runId}/stop-drop`;
  }

  return `/api/runs/${input.runId}/${ACTION_PATH[input.action]}`;
}

// ADR-181 D17: what exists on NO remote — commits past the publication (or
// past the base when never published) and uncommitted files.
function unpushedCounts(state: GuardState | null): {
  commits: number;
  files: number;
} {
  if (!state) return { commits: 0, files: 0 };

  const commits =
    state.unpushedCommits ??
    (state.publicBranch === null
      ? (state.aheadBehind.base?.ahead ?? state.aheadBehind.target?.ahead ?? 0)
      : 0);
  const files = state.dirty ? state.dirty.tracked + state.dirty.untracked : 0;

  return { commits, files };
}

// Rail `menu` variant: the ordered action-sheet items per run state. Plain Stop
// stops the run and leaves the worktree. Writable agent workspaces use the same
// combined actions; no-workspace agents keep plain Stop because there is no
// worktree to preserve or remove. ADR-181 D16: every enabled git action is a
// DEEP LINK into the run git panel, never a blind mutation from a menu.
function railMenuItems(
  actions: WorkbenchLifecycleActionId[],
  runKind: RunKind,
  workspaceAvailable: boolean,
): UiActionId[] {
  const items: UiActionId[] = ["open"];

  if (runKind === "scratch") items.push("rename");

  if (actions.includes("stop")) {
    items.push("stop");

    if (
      runKind === "flow" ||
      runKind === "scratch" ||
      (runKind === "agent" && workspaceAvailable)
    ) {
      items.push("stopArchive", "stopDrop");
    }

    return items;
  }

  for (const id of actions) {
    if (!isOwnAction(id)) items.push(id);
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
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <h2
              className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-ink"
              id="workbench-lifecycle-dialog-title"
            >
              {title}
            </h2>
            <button
              aria-label={cancel}
              className="font-mono text-[14px] text-mute hover:text-ink"
              type="button"
              onClick={onClose}
            >
              ✕
            </button>
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
    code: body?.code ?? "UNKNOWN",
    message: body?.message ?? null,
    retryHint: body?.retryHint ?? null,
    reason: body?.reason ?? null,
    pushRejected: body?.pushRejected ?? null,
    canForce: body?.canForce === true,
  };
}

function networkErrorState(): LifecycleErrorState {
  return {
    code: "EXECUTOR_UNAVAILABLE",
    message: null,
    retryHint: null,
    reason: null,
    pushRejected: null,
    canForce: false,
  };
}

function compactErrorText(
  t: ReturnType<typeof useTranslations>,
  error: LifecycleErrorState | null,
): string | null {
  if (!error) return null;

  if (error.reason === "workspace_git_identity_invalid")
    return t("errors.workspace_git_identity_invalid");
  if (error.reason === "workspace_preservation_failed")
    return t("errors.workspace_preservation_failed");
  if (isMaisterErrorCode(error.code) && t.has(`errors.${error.code}`))
    return t(`errors.${error.code}`);

  return t("error");
}

// ADR-181 D16: the run detail's entry into the git panel. Its own component so
// that ONLY the detail surface subscribes to the URL (`?git=<section>` opens the
// panel on load) and to the run stream — a rail row or a card never re-renders
// on a query change.
function DetailGitHost({
  runId,
  runKind,
  label,
  syncDefaults,
}: {
  runId: string;
  runKind: RunKind;
  label: string;
  syncDefaults: WorkbenchGitSyncDefaults | null;
}): ReactElement {
  const searchParams = useSearchParams();
  const urlSection = searchParams?.get("git") ?? null;
  const initialSection: GitPanelSection | null = isGitPanelSection(urlSection)
    ? urlSection
    : null;
  const [open, setOpen] = useState(initialSection !== null);

  // A deep link on the same page (the review panel's "Sync branch") changes the
  // query without remounting this host, so the section it names opens here.
  useEffect(() => {
    if (initialSection !== null) setOpen(true);
  }, [initialSection]);
  // The run page's stream ticks re-read git-state (debounced in the panel).
  const { eventCount } = useRunPageStream(runId, false);

  return (
    <>
      <button
        aria-expanded={open}
        className={clsx(
          buttonBase,
          "gap-1.5 border-line bg-paper px-3 py-1.5 text-[10.5px] text-mute hover:border-mute hover:text-ink-2",
        )}
        data-testid="workbench-git-open"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <CodeBracketIcon aria-hidden="true" className="h-3.5 w-3.5" />
        {label}
      </button>
      {open ? (
        <div className="w-full">
          <WorkbenchGitPanel
            initialSection={initialSection}
            refreshTick={eventCount}
            runId={runId}
            runKind={runKind}
            syncDefaults={syncDefaults}
          />
        </div>
      ) : null}
    </>
  );
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
  workspaceAvailable = false,
  syncDefaults = null,
}: WorkbenchLifecycleActionsProps): ReactElement | null {
  const t = useTranslations("workbenchLifecycle");
  const tg = useTranslations("workbenchGit");
  // The rename modal reuses the existing portfolio.rename copy.
  const tp = useTranslations("portfolio");
  const router = useRouter();
  const [dialogAction, setDialogAction] = useState<UiActionId | null>(null);
  const [busyAction, setBusyAction] = useState<UiActionId | null>(null);
  const [errorState, setErrorState] = useState<LifecycleErrorState | null>(
    null,
  );
  const [guard, setGuard] = useState<GuardState | null>(null);
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

  // ADR-181 D17: the archive/drop confirmation shows what exists on no remote.
  // Best effort: a failed read just leaves the plain confirmation.
  async function loadGuard(): Promise<void> {
    setGuard(null);

    try {
      const res = await fetch(`/api/runs/${runId}/git-state`);

      if (!res.ok) return;
      setGuard(await readJson<GuardState>(res));
    } catch {
      /* no guard — the destructive op still preserves the work locally */
    }
  }

  function openDialog(action: UiActionId): void {
    if (variant === "menu" && containerRef.current) {
      setMenuAnchorRect(containerRef.current.getBoundingClientRect());
    }
    setDialogAction(action);
    setErrorState(null);
    setGuard(null);

    if (action === "archive" || action === "drop") void loadGuard();
  }

  function closeDialog(): void {
    if (busyAction !== null) return;

    setDialogAction(null);
    setErrorState(null);
  }

  // D17 "Publish, then archive/drop": the destructive op runs only after the
  // publish answered 200 — a refused publish leaves the worktree untouched.
  async function publishThenRemove(action: "archive" | "drop"): Promise<void> {
    const { files } = unpushedCounts(guard);

    setBusyAction("exportBranch");
    setErrorState(null);

    try {
      const res = await fetch(`/api/runs/${runId}/export-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          remote: guard?.publishedRemote ?? "origin",
          snapshotDirty: files > 0,
          commitMessage:
            files > 0 ? t("defaultCommitMessage", { runId }) : null,
          force: false,
        }),
      });

      if (!res.ok) {
        setErrorState(
          errorStateFromBody(await readJson<LifecycleErrorBody>(res)),
        );

        return;
      }
    } catch {
      setErrorState(networkErrorState());

      return;
    } finally {
      setBusyAction(null);
    }

    await postAction(action);
  }

  async function postAction(
    action: OwnActionId | CombinedActionId,
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
        reason: null,
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

  const displayActions =
    variant === "menu" ? [] : actions.filter((id) => isOwnAction(id));
  const gitActions = actions.filter((id) => !isOwnAction(id));
  const menuItems = railMenuItems(actions, runKind, workspaceAvailable);
  const error = compactErrorText(t, errorState);
  const unpushed = unpushedCounts(guard);
  const guardShown = unpushed.commits > 0 || unpushed.files > 0;

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
              action === "stop"
                ? "border-[#d9534f]/40 bg-[#d9534f]/10 text-[#d9534f] hover:bg-[#d9534f] hover:text-white"
                : action === "drop"
                  ? "border-amber-line bg-amber-soft text-amber hover:bg-ivory"
                  : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
              busyAction === action && "opacity-60",
            )}
            disabled={busyAction !== null}
            title={action === "stop" ? t("tooltip.stop") : undefined}
            type="button"
            onClick={() => openDialog(action)}
          >
            {busyAction === action ? t("busy", { action: label }) : label}
          </button>
        );
      })}
      {variant === "detail" && gitActions.length > 0 ? (
        <DetailGitHost
          label={tg("title")}
          runId={runId}
          runKind={runKind}
          syncDefaults={syncDefaults}
        />
      ) : null}
      {variant === "compact"
        ? gitActions.map((id) => {
            const href = gitPanelHref({ runId, runKind, actionId: id });

            return href ? (
              <Link
                key={id}
                className={clsx(
                  buttonBase,
                  "border-line bg-paper px-2 py-1 text-[9.5px] text-mute hover:border-mute hover:text-ink-2",
                )}
                data-testid={`card-git-${id}`}
                href={href}
              >
                {t(`action.${id}`)}
              </Link>
            ) : null;
          })
        : null}
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
              {(dialogAction === "archive" || dialogAction === "drop") &&
              guardShown &&
              actions.includes("exportBranch") ? (
                <button
                  className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
                  data-testid="lifecycle-publish-then-remove"
                  disabled={busyAction !== null}
                  type="button"
                  onClick={() => void publishThenRemove(dialogAction)}
                >
                  {tg(`guard.publishThen.${dialogAction}`)}
                </button>
              ) : null}
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
            {(dialogAction === "archive" || dialogAction === "drop") &&
            guardShown ? (
              <p
                className="rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[10px] text-amber"
                data-testid="lifecycle-unpushed"
              >
                {tg("guard.unpushed", {
                  commits: unpushed.commits,
                  files: unpushed.files,
                })}
              </p>
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

                  const gitHref =
                    item === "open" || item === "rename" || item === "menu"
                      ? null
                      : gitPanelSectionFor(item) !== null
                        ? gitPanelHref({ runId, runKind, actionId: item })
                        : null;

                  if (gitHref) {
                    return (
                      <Link
                        key={item}
                        className={itemClass}
                        data-testid={`menu-${item}`}
                        href={gitHref}
                        role="menuitem"
                      >
                        {Icon ? (
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                        ) : null}
                        {t(`action.${item}`)}
                      </Link>
                    );
                  }

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
            {error ? (
              <div className="flex flex-col gap-1 font-mono text-[10px] font-semibold text-amber">
                <p>{error}</p>
              </div>
            ) : null}
          </div>
        </DialogShell>
      ) : null}
    </div>
  );
}
