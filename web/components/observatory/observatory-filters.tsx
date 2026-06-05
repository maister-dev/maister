import type { ReactElement } from "react";

import type { ObservatoryFilterProps } from "@/components/observatory/types";

export function ObservatoryFilters({
  current,
  labels,
}: ObservatoryFilterProps): ReactElement {
  return (
    <form
      className="mb-5 grid grid-cols-1 gap-3 rounded-lg border border-line bg-paper p-3 md:grid-cols-[1fr_1fr_120px_auto]"
      method="get"
    >
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.flow}
        <input
          className="h-9 rounded-md border border-line bg-ivory px-3 font-mono text-xs text-ink outline-none focus:border-amber"
          defaultValue={current.flowId ?? ""}
          name="flowId"
          placeholder={labels.all}
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.node}
        <input
          className="h-9 rounded-md border border-line bg-ivory px-3 font-mono text-xs text-ink outline-none focus:border-amber"
          defaultValue={current.nodeId ?? ""}
          name="nodeId"
          placeholder={labels.all}
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.lookback}
        <input
          className="h-9 rounded-md border border-line bg-ivory px-3 font-mono text-xs text-ink outline-none focus:border-amber"
          defaultValue={String(current.windowDays)}
          min={1}
          name="windowDays"
          type="number"
        />
      </label>
      <div className="flex items-end">
        <button
          className="h-9 rounded-md bg-ink px-4 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-paper hover:bg-ink-2"
          type="submit"
        >
          {labels.apply}
        </button>
      </div>
    </form>
  );
}
