"use client";

import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
type PromoteMode = "local_merge" | "rebase_merge" | "pull_request";

export function ScratchInspectorActions({
  runId,
  lifecycleActions,
  promoteTargetBranch,
}: ScratchInspectorActionsProps): ReactElement {
  const t = useTranslations("scratch");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [mode, setMode] = useState<PromoteMode>("local_merge");

  async function promote(): Promise<void> {
    setPending(true);
    setError(null);
    setDone(false);

    try {
      const response = await fetch(`/api/runs/${runId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          targetBranch: promoteTargetBranch,
        }),
      });

      if (!response.ok) {
        setError(errorText(await response.json().catch(() => null)));

        return;
      }
      // A web-tier merge emits no ACP session/update, so the live conversation
      // SSE won't refresh on its own — re-fetch the server layout to reflect the
      // promoted state (status fact, lifecycle actions) and confirm to the user.
      setDone(true);
      router.refresh();
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
      <div className="flex flex-col gap-1.5 rounded-[6px] border border-line bg-paper p-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("promoteMode")}
          </span>
          <select
            aria-label={t("promoteMode")}
            className="rounded-[6px] border border-line bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-amber"
            data-testid="scratch-promote-mode"
            disabled={pending}
            value={mode}
            onChange={(event) => setMode(event.target.value as PromoteMode)}
          >
            <option value="local_merge">{t("promoteModeLocalMerge")}</option>
            <option value="rebase_merge">{t("promoteModeRebaseMerge")}</option>
            <option value="pull_request">{t("promoteModePullRequest")}</option>
          </select>
        </label>
        <span className="font-mono text-[10px] text-mute">
          {t("promoteInto", { branch: promoteTargetBranch })}
        </span>
        <button
          className="rounded-[6px] border border-line bg-paper px-3 py-2 text-[12px] font-semibold text-ink-2 hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="scratch-promote"
          disabled={pending}
          type="button"
          onClick={() => void promote()}
        >
          {pending ? t("pendingAction", { action: "promote" }) : t("promote")}
        </button>
      </div>
      {error ? (
        <p className="font-mono text-[10.5px] text-[#d9534f]" role="alert">
          {error}
        </p>
      ) : null}
      {done && !error ? (
        <p className="font-mono text-[10.5px] text-accent-4" role="status">
          {t("promoted")}
        </p>
      ) : null}
    </section>
  );
}
