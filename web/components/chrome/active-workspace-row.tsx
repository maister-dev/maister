"use client";

import type {
  RailWorkspaceRow,
  RailWorkspaceTone,
} from "@/lib/queries/portfolio";
import type { ReactElement, ReactNode } from "react";

import {
  CpuChipIcon,
  PencilIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";

import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

// needs / waiting use the warm --attention token (the only warm accent besides
// --danger); running keeps the shared pulse keyframe from globals.css.
const dotByTone: Record<RailWorkspaceTone, string> = {
  running: "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]",
  waiting: "bg-attention",
  needs: "bg-attention",
  human: "bg-ink-2",
  review: "bg-accent-2",
  crashed: "bg-danger",
};

const chipClass =
  "inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-line bg-ivory px-1.5 py-px font-mono text-[9.5px] text-mute";

// Server-translated, per-row display strings. Built in left-rail.tsx so the
// presentational view stays hook-free (unit-testable via renderToStaticMarkup).
export interface ActiveWorkspaceRowLabels {
  statusWord: string;
  attention: boolean;
  flowLabel: string | null;
  flowTooltip: string | null;
  flowAria: string | null;
  runnerLabel: string | null;
  runnerTooltip: string | null;
  runnerAria: string | null;
  issueLabel: string | null;
  issueAria: string | null;
  ttlTone: "warning" | "due" | null;
  ttlLabel: string | null;
  ttlCountdown: string | null;
  archivedLabel: string | null;
  rename: {
    action: string;
    placeholder: string;
    confirm: string;
    cancel: string;
    busy: string;
    error: string;
  };
}

function FlowIcon(): ReactElement {
  return (
    <WrenchScrewdriverIcon
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0"
      data-testid="flow-chip-icon"
    />
  );
}

function RunnerIcon(): ReactElement {
  return (
    <CpuChipIcon
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0"
      data-testid="runner-chip-icon"
    />
  );
}

function RenamePencilIcon(): ReactElement {
  return (
    <PencilIcon
      aria-hidden="true"
      className="h-3.5 w-3.5"
      data-testid="rename-pencil-icon"
    />
  );
}

interface ViewProps {
  tone: RailWorkspaceTone;
  name: string;
  runHref: string;
  time: string;
  issueHref: string | null;
  labels: ActiveWorkspaceRowLabels;
  nameSlot?: ReactNode;
  renameButton?: ReactNode;
  actions?: ReactNode;
}

// Pure presentational row — NO hooks. Two-line compact layout from preformatted
// props. The name link, KEY-N link, rename pencil, and lifecycle icon buttons
// are siblings of one another (never nested interactive elements).
export function ActiveWorkspaceRowView({
  tone,
  name,
  runHref,
  time,
  issueHref,
  labels,
  nameSlot,
  renameButton,
  actions,
}: ViewProps): ReactElement {
  return (
    <div
      className="group relative flex flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors hover:bg-ivory focus-within:bg-ivory"
      data-testid="active-workspace-row"
    >
      <div className="flex items-center gap-2">
        <span
          aria-label={labels.statusWord}
          className={clsx("h-2 w-2 shrink-0 rounded-full", dotByTone[tone])}
          data-status-tone={tone}
          role="img"
          title={labels.statusWord}
        />
        {nameSlot ?? (
          <Link
            className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold tracking-[-0.005em] text-ink hover:text-amber"
            href={runHref}
          >
            {name}
          </Link>
        )}
        {labels.attention ? (
          <span
            className="shrink-0 font-mono text-[10px] font-semibold tracking-[0.02em] text-attention"
            data-testid="status-word"
          >
            {labels.statusWord}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1">
          <span
            className="font-mono text-[10px] tracking-[0.04em] text-mute-2 group-hover:hidden group-focus-within:hidden"
            data-testid="row-time"
          >
            {time}
          </span>
          <div className="hidden items-center gap-1 group-hover:flex group-focus-within:flex">
            {renameButton}
            {actions}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-4">
        {labels.flowLabel ? (
          <span
            aria-label={labels.flowAria ?? undefined}
            className={chipClass}
            data-testid="flow-chip"
            title={labels.flowTooltip ?? undefined}
          >
            <FlowIcon />
            <span className="truncate">{labels.flowLabel}</span>
          </span>
        ) : null}
        {labels.runnerLabel ? (
          <span
            aria-label={labels.runnerAria ?? undefined}
            className={chipClass}
            data-testid="runner-chip"
            title={labels.runnerTooltip ?? undefined}
          >
            <RunnerIcon />
            <span className="truncate">{labels.runnerLabel}</span>
          </span>
        ) : null}
        {issueHref && labels.issueLabel ? (
          <Link
            aria-label={labels.issueAria ?? undefined}
            className={clsx(chipClass, "hover:border-mute hover:text-ink-2")}
            data-testid="issue-chip"
            href={issueHref}
          >
            {labels.issueLabel}
          </Link>
        ) : null}
        {labels.ttlTone && labels.ttlLabel ? (
          <span
            className={clsx(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[0.06em]",
              labels.ttlTone === "due"
                ? "border-red-300 bg-red-50 text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
                : "border-amber-line bg-amber-soft text-attention",
            )}
            data-testid="ttl-badge"
            data-ttl-state={labels.ttlTone}
          >
            <span
              className={clsx(
                "h-[5px] w-[5px] rounded-full",
                labels.ttlTone === "due" ? "bg-red-500" : "bg-attention",
              )}
            />
            {labels.ttlLabel}
            {labels.ttlCountdown ? (
              <span
                suppressHydrationWarning
                className="font-normal normal-case tracking-normal"
              >
                · {labels.ttlCountdown}
              </span>
            ) : null}
          </span>
        ) : null}
        {labels.archivedLabel ? (
          <span
            className="inline-flex items-center rounded-full border border-line bg-ivory px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-mute"
            data-testid="ttl-archived"
          >
            {labels.archivedLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Thin client wrapper: owns the scratch rename input (PATCH → router.refresh)
// and supplies the lifecycle icon-action cluster as a slot to the pure view.
export function ActiveWorkspaceRow({
  row,
  labels,
}: {
  row: RailWorkspaceRow;
  labels: ActiveWorkspaceRowLabels;
}): ReactElement {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(row.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the rename field when it opens — focus follows the explicit pencil
  // click (so jsx-a11y/no-autofocus stays satisfied), never on page load.
  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const canRename = row.runKind === "scratch";

  async function submit(): Promise<void> {
    const trimmed = value.trim();

    if (trimmed.length < 1 || trimmed.length > 200) {
      setError(labels.rename.error);

      return;
    }
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/scratch-runs/${row.runId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!res.ok) {
        setError(labels.rename.error);

        return;
      }

      setRenaming(false);
      router.refresh();
    } catch {
      setError(labels.rename.error);
    } finally {
      setBusy(false);
    }
  }

  function cancel(): void {
    setRenaming(false);
    setValue(row.name);
    setError(null);
  }

  const nameSlot = renaming ? (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <input
        ref={inputRef}
        aria-label={labels.rename.placeholder}
        className="min-w-0 flex-1 rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[11.5px] text-ink outline-none focus:border-amber"
        data-testid="rename-input"
        disabled={busy}
        placeholder={labels.rename.placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
      <button
        className="inline-flex h-[26px] items-center rounded-md border border-amber bg-amber px-2 font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
        data-testid="rename-save"
        disabled={busy}
        type="button"
        onClick={() => void submit()}
      >
        {busy ? labels.rename.busy : labels.rename.confirm}
      </button>
      <button
        className="inline-flex h-[26px] items-center rounded-md border border-line bg-paper px-2 font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2 disabled:opacity-60"
        disabled={busy}
        type="button"
        onClick={cancel}
      >
        {labels.rename.cancel}
      </button>
    </span>
  ) : undefined;

  const renameButton =
    canRename && !renaming ? (
      <button
        aria-label={labels.rename.action}
        className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
        data-testid="rename-pencil"
        title={labels.rename.action}
        type="button"
        onClick={() => {
          setValue(row.name);
          setRenaming(true);
        }}
      >
        <RenamePencilIcon />
      </button>
    ) : undefined;

  const actions =
    row.lifecycleActions.length > 0 ? (
      <WorkbenchLifecycleActions
        actions={row.lifecycleActions}
        runId={row.runId}
        runKind={row.runKind}
        variant="icon"
      />
    ) : undefined;

  return (
    <>
      <ActiveWorkspaceRowView
        actions={actions}
        issueHref={row.issueHref}
        labels={labels}
        name={row.name}
        nameSlot={nameSlot}
        renameButton={renameButton}
        runHref={row.href}
        time={row.time}
        tone={row.statusTone}
      />
      {error ? (
        <p
          className="px-2.5 pb-1 font-mono text-[9.5px] font-semibold text-attention"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
