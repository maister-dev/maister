import type { ReactElement } from "react";

import { RawDiff } from "@/components/runs/raw-diff";

// M27/T-A6: the draft-vs-published `flow.yaml` diff. Provider-free (RawDiff is a
// plain <pre>), so it renders under renderToStaticMarkup. The side-by-side
// topology panels are composed at the page level from the read model's
// published/draft topologies (the read-only FlowGraphView is run-scoped); this
// component owns the YAML diff surface + the no-change empty state.
export function FlowDraftDiffText({
  diff,
  emptyLabel,
}: {
  diff: string;
  emptyLabel: string;
}): ReactElement {
  if (diff === "") {
    return (
      <p
        className="rounded-lg border border-line bg-paper p-4 font-mono text-[11px] text-mute"
        data-testid="flow-draft-diff-empty"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div data-testid="flow-draft-diff">
      <RawDiff diff={diff} />
    </div>
  );
}
