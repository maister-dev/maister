import type { ReactElement } from "react";
import type { ObservatoryLabels } from "@/components/observatory/types";

export function FlowLedgerScope({
  labels,
}: {
  labels: ObservatoryLabels;
}): ReactElement {
  return (
    <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-mute">
      {labels.flowRuns}
    </span>
  );
}

export function FlowLedgerNotApplicable({
  labels,
}: {
  labels: ObservatoryLabels;
}): ReactElement {
  return (
    <section
      className="rounded-[14px] border border-line bg-paper p-5"
      data-testid="observatory-flow-ledger-na"
    >
      <FlowLedgerScope labels={labels} />
      <p className="mt-3 text-sm text-mute">{labels.flowLedgerOnly}</p>
    </section>
  );
}
