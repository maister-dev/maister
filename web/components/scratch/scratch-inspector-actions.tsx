"use client";

import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";
import { errorText } from "@/lib/scratch-runs/dialog";

export interface ScratchInspectorActionsProps {
  runId: string;
  lifecycleActions: WorkbenchLifecycleActionId[];
  promoteTargetBranch: string;
}

// The scratch run's interactive action group inside the shared inspector
// (M35 T3.4): the derived lifecycle actions plus a local-merge promote, both
// calling the existing run routes. Replaces the former conversation sidebar's
// action block.
export function ScratchInspectorActions({
  runId,
  lifecycleActions,
  promoteTargetBranch,
}: ScratchInspectorActionsProps): ReactElement {
  const t = useTranslations("scratch");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function promote(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/runs/${runId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "local_merge",
          targetBranch: promoteTargetBranch,
        }),
      });

      if (!response.ok) {
        setError(errorText(await response.json().catch(() => null)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="scratch-inspector-actions"
    >
      {lifecycleActions.length > 0 ? (
        <WorkbenchLifecycleActions
          actions={lifecycleActions}
          className="rounded-[6px] border border-line bg-paper p-2"
          runId={runId}
          runKind="scratch"
          variant="detail"
        />
      ) : null}
      <button
        className="rounded-[6px] border border-line bg-paper px-3 py-2 text-[12px] font-semibold text-ink-2 hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="scratch-promote"
        disabled={pending}
        type="button"
        onClick={() => void promote()}
      >
        {pending ? t("pendingAction", { action: "promote" }) : t("promote")}
      </button>
      {error ? (
        <p className="font-mono text-[10.5px] text-[#d9534f]" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
