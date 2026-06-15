"use client";

import type { ReactNode } from "react";

import { useState } from "react";
import clsx from "clsx";

import {
  RunHeader,
  type RunHeaderLabels,
  type RunHeaderProps,
} from "@/components/runs/run-header";

export type RunShellLabels = RunHeaderLabels;

export interface RunShellProps {
  title: string;
  subtitle?: string;
  status: string;
  branch?: string | null;
  targetBranch?: string | null;
  changeSummary?: RunHeaderProps["changeSummary"];
  labels: RunShellLabels;
  defaultInspectorOpen?: boolean;
  inspector: ReactNode;
  children?: ReactNode;
}

export function RunShell({
  title,
  subtitle,
  status,
  branch,
  targetBranch,
  changeSummary,
  labels,
  defaultInspectorOpen = true,
  inspector,
  children,
}: RunShellProps): ReactNode {
  const [inspectorOpen, setInspectorOpen] = useState(defaultInspectorOpen);

  return (
    <section
      className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 md:px-6"
      data-inspector-open={inspectorOpen ? "true" : "false"}
      data-testid="run-shell"
    >
      <RunHeader
        branch={branch}
        changeSummary={changeSummary}
        inspectorOpen={inspectorOpen}
        labels={labels}
        status={status}
        subtitle={subtitle}
        targetBranch={targetBranch}
        title={title}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      />
      <div
        className={clsx(
          "grid grid-cols-1 gap-4",
          inspectorOpen
            ? "xl:grid-cols-[minmax(0,1fr)_320px]"
            : "xl:grid-cols-1",
        )}
        data-testid="run-shell-body"
      >
        <main className="min-w-0" data-testid="run-shell-main">
          {children}
        </main>
        {inspectorOpen ? (
          <aside
            className="min-w-0 border-t border-line pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0"
            data-testid="run-shell-inspector"
          >
            {inspector}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
