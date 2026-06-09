import type { ResolvedCapabilitySet } from "@/lib/db/schema";
import type { ReactElement } from "react";

export type ResolvedCapabilitySetLabels = {
  title: string;
  flowRevision: string;
  flowOrigin: string;
  capabilities: string;
  mcps: string;
  empty: string;
  origin: { authored: string; git: string };
};

const ROW_CLS =
  "flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-ink-2";
const KEY_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";

// M27/T-B6: read-only view of the run's launch-frozen resolved capability set
// (runs.resolved_capability_set). Provider-free, so it renders under
// renderToStaticMarkup. The set is snapshotted at launch and never mutates for
// the life of the run (in-flight immutability), so this is purely informational.
export function ResolvedCapabilitySetPanel({
  resolved,
  labels,
}: {
  resolved: ResolvedCapabilitySet;
  labels: ResolvedCapabilitySetLabels;
}): ReactElement {
  return (
    <section
      className="mt-6 rounded-xl border border-line bg-paper p-4"
      data-testid="resolved-capability-set"
    >
      <h2 className="m-0 mb-3 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink">
        {labels.title}
      </h2>

      <div className="grid gap-1.5">
        <div className={ROW_CLS}>
          <span className={KEY_CLS}>{labels.flowRevision}</span>
          <span className="break-all" data-testid="resolved-flow-revision">
            {resolved.flowRevisionId}
          </span>
        </div>
        <div className={ROW_CLS}>
          <span className={KEY_CLS}>{labels.flowOrigin}</span>
          <span data-testid="resolved-flow-origin">
            {labels.origin[resolved.flowOrigin]}
          </span>
        </div>
      </div>

      <h3 className={`${KEY_CLS} mt-4`}>{labels.capabilities}</h3>
      {resolved.capabilities.length === 0 ? (
        <p className="m-0 font-mono text-[10px] text-mute">{labels.empty}</p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {resolved.capabilities.map((cap) => (
            <li
              key={`${cap.kind}:${cap.refId}`}
              className={ROW_CLS}
              data-testid={`resolved-cap-${cap.refId}`}
            >
              <span className="text-mute">{cap.kind}</span>
              <span className="break-all text-ink-2">{cap.refId}</span>
              <span className="text-mute">{cap.sha ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className={`${KEY_CLS} mt-4`}>{labels.mcps}</h3>
      {resolved.mcps.length === 0 ? (
        <p className="m-0 font-mono text-[10px] text-mute">{labels.empty}</p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {resolved.mcps.map((mcp) => (
            <li
              key={mcp.refId}
              className={ROW_CLS}
              data-testid={`resolved-mcp-${mcp.refId}`}
            >
              <span className="break-all text-ink-2">{mcp.refId}</span>
              <span className="text-mute">{mcp.scope}</span>
              <span className="text-mute">{mcp.sha ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
