"use client";

import type { ReactElement, ReactNode } from "react";

import { createContext, useContext, useState } from "react";
import { useTranslations } from "next-intl";

import { AgentRetryBatchControl } from "@/components/agents/agent-retry-batch-control";

type RetrySelection = {
  selected: ReadonlySet<string>;
  toggle: (runId: string) => void;
};
const SelectionContext = createContext<RetrySelection | null>(null);

export function AgentRetryHistorySelection({
  slug,
  agentId,
  runIds,
  canRetry,
  children,
}: {
  slug: string;
  agentId: string;
  runIds: string[];
  canRetry: boolean;
  children: ReactNode;
}): ReactElement {
  const t = useTranslations("agentActivity");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const allSelected =
    runIds.length > 0 && runIds.every((id) => selected.has(id));

  function toggle(runId: string): void {
    setSelected(
      (previous) =>
        new Set(
          previous.has(runId)
            ? [...previous].filter((id) => id !== runId)
            : [...previous, runId],
        ),
    );
  }

  return (
    <SelectionContext.Provider value={{ selected, toggle }}>
      <div className="space-y-3">
        {canRetry ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-ivory p-3"
            data-testid="agent-retry-history-toolbar"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={allSelected}
                disabled={runIds.length === 0}
                type="checkbox"
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(runIds))
                }
              />
              {t("selectFailedOnPage")}
            </label>
            <AgentRetryBatchControl
              agentId={agentId}
              runIds={[...selected].filter((id) => runIds.includes(id))}
              slug={slug}
            />
            <AgentRetryBatchControl agentId={agentId} slug={slug} />
          </div>
        ) : null}
        {children}
      </div>
    </SelectionContext.Provider>
  );
}

export function AgentRetryHistoryCheckbox({
  runId,
}: {
  runId: string;
}): ReactElement | null {
  const t = useTranslations("agentActivity");
  const selection = useContext(SelectionContext);

  if (!selection) return null;

  return (
    <input
      aria-label={t("selectFailedRun", { runId: runId.slice(0, 8) })}
      checked={selection.selected.has(runId)}
      type="checkbox"
      onChange={() => selection.toggle(runId)}
    />
  );
}
