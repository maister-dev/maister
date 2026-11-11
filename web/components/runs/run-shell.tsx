"use client";

import type { ReactNode } from "react";

import { useState } from "react";
import clsx from "clsx";

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
  inspector: ReactNode;
  children?: ReactNode;
}

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
  defaultInspectorOpen = true,
  inspector,
  children,
}: RunShellProps): ReactNode {
  const peek = useRunPeek();
  const peeking = !!peek?.ready && peek.selected !== null;
  const [inspectorOpen, setInspectorOpen] = useState(defaultInspectorOpen);

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
        onToggleInspector={() => setInspectorOpen((open) => !open)}
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
          {children}
        </main>
        {inspectorOpen ? (
          <aside
            className="min-w-0 max-w-full border-t border-line pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0"
            data-testid="run-shell-inspector"
            hidden={peeking}
          >
            {inspector}
          </aside>
        ) : null}
        {peeking ? <RunPeekPanel /> : null}
      </div>
    </section>
  );
}
