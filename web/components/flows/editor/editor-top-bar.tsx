"use client";

import type { ReactElement, ReactNode } from "react";

import clsx from "clsx";

export type EditorDrawerKind = "files" | "yaml" | "diff";

export type EditorTopBarLabels = {
  save: string;
  publish: string;
  valid: string;
  issues: string; // non-ICU "$count issues"
  ready: string;
  notReady: string;
  titleLabel: string;
  graph: string;
  files: string;
  yaml: string;
  diff: string;
};

type Tone = "amber" | "good" | "danger" | "mute";

const PILL_TONE: Record<Tone, string> = {
  amber: "border-amber-line bg-amber-soft text-amber",
  good: "border-line bg-ivory text-good",
  danger: "border-danger-line bg-danger-soft text-danger",
  mute: "border-line bg-paper text-mute",
};

function Pill({
  tone,
  testid,
  children,
}: {
  tone: Tone;
  testid?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <span
      className={clsx(
        "shrink-0 rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em]",
        PILL_TONE[tone],
      )}
      data-testid={testid}
    >
      {children}
    </span>
  );
}

function DrawerToggle({
  active,
  testid,
  onClick,
  children,
}: {
  active: boolean;
  testid: string;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      aria-pressed={active}
      className={clsx(
        "rounded-md border px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em]",
        active
          ? "border-amber-line bg-amber-soft text-amber"
          : "border-line bg-paper text-ink-2 hover:bg-ivory",
      )}
      data-testid={testid}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Compact editor top bar (T1.4): identity + editable title, lifecycle /
// validation / readiness chips, Save + Publish (server actions via the parent
// form / formAction seam), and the drawer toggles. Presentational — the parent
// owns state + the <form>. The drawer toggles keep the legacy `flow-tab-*`
// testids so the existing editor e2e flows (open YAML, return to graph) stay
// valid against the always-on canvas + overlay drawers.
export function EditorTopBar({
  labels,
  project,
  kind,
  lifecycleLabel,
  title,
  onTitleChange,
  canManage,
  hasDraft,
  validation,
  readinessReady,
  publishDisabled,
  publishAction,
  openDrawer,
  onToggleDrawer,
  onCloseDrawers,
}: {
  labels: EditorTopBarLabels;
  project: string;
  kind: string;
  lifecycleLabel: string;
  title: string;
  onTitleChange: (value: string) => void;
  canManage: boolean;
  hasDraft: boolean;
  validation: { ok: boolean; issueCount: number } | null;
  readinessReady: boolean;
  publishDisabled: boolean;
  publishAction: (formData: FormData) => void | Promise<void>;
  openDrawer: EditorDrawerKind | null;
  onToggleDrawer: (kind: EditorDrawerKind) => void;
  onCloseDrawers: () => void;
}): ReactElement {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-paper px-3 py-2"
      data-testid="flow-editor-topbar"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="hidden truncate font-mono text-[10px] uppercase tracking-[0.08em] text-mute sm:inline">
          {project} · {kind}
        </span>
        <input
          aria-label={labels.titleLabel}
          className="min-w-[140px] max-w-[280px] rounded-md border border-line bg-ivory px-2 py-1 text-[12.5px] text-ink outline-none focus:border-amber disabled:opacity-70"
          disabled={!canManage}
          name="title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <Pill testid="topbar-lifecycle" tone="amber">
          {lifecycleLabel}
        </Pill>
        {validation ? (
          <Pill
            testid="topbar-validation"
            tone={validation.ok ? "good" : "danger"}
          >
            {validation.ok
              ? labels.valid
              : labels.issues.replace("$count", String(validation.issueCount))}
          </Pill>
        ) : null}
        <Pill testid="topbar-readiness" tone={readinessReady ? "good" : "mute"}>
          {readinessReady ? labels.ready : labels.notReady}
        </Pill>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {canManage ? (
          <button
            className="rounded-md bg-ink px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-paper hover:bg-ink-2"
            data-testid="topbar-save"
            type="submit"
          >
            {labels.save}
          </button>
        ) : null}
        {canManage && hasDraft ? (
          <button
            className="rounded-md border border-amber-line bg-amber-soft px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-amber hover:bg-paper disabled:opacity-50"
            data-testid="topbar-publish"
            disabled={publishDisabled}
            formAction={publishAction}
            type="submit"
          >
            {labels.publish}
          </button>
        ) : null}
        <div className="flex items-center gap-1">
          <DrawerToggle
            active={openDrawer === null}
            testid="flow-tab-graph"
            onClick={onCloseDrawers}
          >
            {labels.graph}
          </DrawerToggle>
          <DrawerToggle
            active={openDrawer === "files"}
            testid="flow-tab-files"
            onClick={() => onToggleDrawer("files")}
          >
            {labels.files}
          </DrawerToggle>
          <DrawerToggle
            active={openDrawer === "yaml"}
            testid="flow-tab-yaml"
            onClick={() => onToggleDrawer("yaml")}
          >
            {labels.yaml}
          </DrawerToggle>
          <DrawerToggle
            active={openDrawer === "diff"}
            testid="flow-tab-diff"
            onClick={() => onToggleDrawer("diff")}
          >
            {labels.diff}
          </DrawerToggle>
        </div>
      </div>
    </div>
  );
}
