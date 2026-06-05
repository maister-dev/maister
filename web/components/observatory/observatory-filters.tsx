"use client";

import type { ReactElement } from "react";
import type { ObservatoryFilterProps } from "@/components/observatory/types";

import { Button, Input } from "@heroui/react";

export function ObservatoryFilters({
  current,
  labels,
}: ObservatoryFilterProps): ReactElement {
  return (
    <form
      aria-label={labels.filters}
      className="mb-5 grid grid-cols-1 gap-3 rounded-lg border border-line bg-paper p-3 md:grid-cols-[1fr_1fr_1fr_1fr_120px_auto]"
      method="get"
    >
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.flow}
        <Input
          fullWidth
          className="font-mono text-xs"
          defaultValue={current.flowId ?? ""}
          name="flowId"
          placeholder={labels.all}
          variant="secondary"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.node}
        <Input
          fullWidth
          className="font-mono text-xs"
          defaultValue={current.nodeId ?? ""}
          name="nodeId"
          placeholder={labels.all}
          variant="secondary"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.artifactKind}
        <Input
          fullWidth
          className="font-mono text-xs"
          defaultValue={current.artifactKind ?? ""}
          name="artifactKind"
          placeholder={labels.all}
          variant="secondary"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {labels.artifactDefId}
        <Input
          fullWidth
          className="font-mono text-xs"
          defaultValue={current.artifactDefId ?? ""}
          name="artifactDefId"
          placeholder={labels.all}
          variant="secondary"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-ink">
        {`${labels.lookback} (${labels.days})`}
        <Input
          fullWidth
          className="font-mono text-xs"
          defaultValue={String(current.windowDays)}
          min={1}
          name="windowDays"
          type="number"
          variant="secondary"
        />
      </label>
      <div className="flex items-end">
        <Button
          className="h-9 font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
          size="sm"
          type="submit"
          variant="primary"
        >
          {labels.apply}
        </Button>
      </div>
    </form>
  );
}
