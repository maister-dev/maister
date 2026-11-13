"use client";

import type { ReactNode } from "react";

import { useRef, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";

import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";
import { buildRunHref, parseRunQueryState } from "@/lib/runs/run-query-state";
import { useRunPeek } from "@/components/runs/run-peek-controller";
import { RunPeekPanel } from "@/components/runs/run-peek-panel";
import {
  RunHeader,
  type RunHeaderLabels,
  type RunHeaderProps,
} from "@/components/runs/run-header";

export type RunShellLabels = RunHeaderLabels;

export interface RunShellProps {
  title: string;
  subtitle?: string;
  keyRef?: string | null;
  taskHref?: string | null;
  agentHistory?: { href: string; label: string };
  projectHref?: string | null;
  projectLabel?: string | null;
  taskPrompt?: string | null;
  status: string;
  branch?: string | null;
  targetBranch?: string | null;
  prState?: RunHeaderProps["prState"];
  prHasConflicts?: RunHeaderProps["prHasConflicts"];
  runId?: RunHeaderProps["runId"];
  canReopen?: RunHeaderProps["canReopen"];
  changeSummary?: RunHeaderProps["changeSummary"];
  budgetStatus?: RunHeaderProps["budgetStatus"];
  reviewHref?: RunHeaderProps["reviewHref"];
  promotionOperation?: RunHeaderProps["promotionOperation"];
  labels: RunShellLabels;
  defaultInspectorOpen?: boolean;
  hideChangeSummary?: boolean;
  outcome?: ReactNode;
  inspector: ReactNode;
  children?: ReactNode;
}

const compactInspectorQuery = "(max-width: 1279px)";

function subscribeCompactInspector(notify: () => void): () => void {
  const query = window.matchMedia(compactInspectorQuery);

  query.addEventListener("change", notify);

  return () => query.removeEventListener("change", notify);
}

const compactInspector = (): boolean =>
  window.matchMedia(compactInspectorQuery).matches;
const desktopInspector = (): boolean => false;

export function RunShell({
  title,
  subtitle,
  keyRef,
  taskHref,
  agentHistory,
  projectHref,
  projectLabel,
  taskPrompt,
  status,
  branch,
  targetBranch,
  prState,
  prHasConflicts,
  runId,
  canReopen,
  changeSummary,
  budgetStatus,
  reviewHref,
  promotionOperation,
  labels,
  defaultInspectorOpen = false,
  hideChangeSummary = false,
  outcome,
  inspector,
  children,
}: RunShellProps): ReactNode {
  const peek = useRunPeek();
  const peeking = !!peek?.ready && peek.selected !== null;
  const search = useSearchParams();
  const selected = parseRunQueryState(search).inspector;
  const inspectorOpen =
    selected === null ? defaultInspectorOpen : selected === "open";
  const compact = useSyncExternalStore(
    subscribeCompactInspector,
    compactInspector,
    desktopInspector,
  );
  const dialog = useRef<HTMLDivElement>(null);
  const overlay = inspectorOpen && compact && !peeking;

  function setInspectorOpen(open: boolean): void {
    const { pathname, search, hash } = window.location;
    const address = buildRunHref(pathname, search, {
      inspector: open ? "open" : "closed",
    });

    window.history.pushState(null, "", `${address}${hash}`);
  }

  useModalFocusTrap(dialog, () => setInspectorOpen(false), overlay);

  return (
    <section
      className={clsx(
        "flex w-full min-w-0 max-w-full flex-col gap-5 px-2 py-5 md:px-3 [overflow-anchor:none]",
        peeking && "overflow-x-clip",
      )}
      data-inspector-open={inspectorOpen ? "true" : "false"}
      data-testid="run-shell"
    >
      <RunHeader
        agentHistory={agentHistory}
        branch={branch}
        budgetStatus={budgetStatus}
        canReopen={canReopen}
        changeSummary={changeSummary}
        hideChangeSummary={hideChangeSummary}
        inspectorDisabledReason={
          peeking ? peek.t("inspectorSuspended") : undefined
        }
        inspectorOpen={inspectorOpen}
        keyRef={keyRef}
        labels={labels}
        prHasConflicts={prHasConflicts}
        projectHref={projectHref}
        projectLabel={projectLabel}
        promotionOperation={promotionOperation}
        prState={prState}
        reviewHref={reviewHref}
        runId={runId}
        status={status}
        subtitle={subtitle}
        targetBranch={targetBranch}
        taskHref={taskHref}
        taskPrompt={taskPrompt}
        title={title}
        onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
      />
      <div
        className={clsx(
          "grid min-w-0 max-w-full grid-cols-1 gap-4",
          peeking
            ? "2xl:grid-cols-[minmax(0,1fr)_480px]"
            : inspectorOpen
              ? "xl:grid-cols-[minmax(0,1fr)_380px]"
              : "xl:grid-cols-1",
        )}
        data-testid="run-shell-body"
      >
        <main className="min-w-0 max-w-full" data-testid="run-shell-main">
          {outcome}
          {children}
        </main>
        {inspectorOpen ? (
          <aside
            className={clsx(
              "min-w-0 max-w-full",
              overlay
                ? "fixed inset-0 z-[150] bg-black/40 p-3"
                : "border-l border-line pl-4",
            )}
            data-testid="run-shell-inspector"
            hidden={peeking}
          >
            <div
              ref={dialog}
              aria-label={overlay ? labels.closeInspector : undefined}
              aria-modal={overlay || undefined}
              className={
                overlay
                  ? "ml-auto flex h-full w-full max-w-lg flex-col overflow-auto rounded-xl bg-paper p-4 shadow-xl"
                  : undefined
              }
              role={overlay ? "dialog" : undefined}
              tabIndex={overlay ? -1 : undefined}
            >
              {overlay ? (
                <button
                  className="mb-3 self-end rounded-md border border-line px-3 py-1 text-sm"
                  type="button"
                  onClick={() => setInspectorOpen(false)}
                >
                  {labels.closeInspector}
                </button>
              ) : null}
              {inspector}
            </div>
          </aside>
        ) : null}
        {peeking ? <RunPeekPanel /> : null}
      </div>
    </section>
  );
}
