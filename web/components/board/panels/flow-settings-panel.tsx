import type { SettingsNodeView } from "@/lib/flows/settings-view";
import type { EnforcementSnapshotEntry } from "@/lib/db/schema";
import type { ReactElement } from "react";

import clsx from "clsx";

export type { SettingsNodeView } from "@/lib/flows/settings-view";

export interface FlowSettingsPanelLabels {
  title: string;
  // Honesty caption: verdicts are the flow author's DECLARED intent. M11c does
  // not materialize settings — nothing here is delivered to the agent yet (M14).
  declaredIntentNote: string;
  verdictEnforced: string;
  verdictInstructed: string;
  verdictRefused: string;
  noConstraints: string;
  refusalReason: string;
  classLabel: (cls: EnforcementSnapshotEntry["class"]) => string;
}

export interface FlowSettingsPanelProps {
  nodes: SettingsNodeView[];
  refusalReason?: string | null;
  labels: FlowSettingsPanelLabels;
}

type Verdict = EnforcementSnapshotEntry["verdict"];

function verdictLabel(
  verdict: Verdict,
  labels: FlowSettingsPanelLabels,
): string {
  if (verdict === "enforced") return labels.verdictEnforced;
  if (verdict === "refused") return labels.verdictRefused;

  return labels.verdictInstructed;
}

function verdictTone(verdict: Verdict): string {
  if (verdict === "enforced") {
    return "border-[color-mix(in_oklab,var(--accent-4)_40%,var(--line))] bg-accent-4-soft text-accent-4";
  }
  if (verdict === "refused") {
    return "border-amber-line bg-amber-soft text-amber";
  }

  return "border-line bg-paper text-mute";
}

export function FlowSettingsPanel({
  nodes,
  refusalReason,
  labels,
}: FlowSettingsPanelProps): ReactElement {
  return (
    <section className="mt-8">
      <h2 className="mb-1 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
        {labels.title}
      </h2>

      <p className="mb-3 font-mono text-[10.5px] leading-[1.5] text-mute">
        {labels.declaredIntentNote}
      </p>

      {refusalReason ? (
        <div className="mb-3 rounded-[10px] border border-amber-line bg-amber-soft px-3.5 py-2.5 font-mono text-[11px] leading-[1.5] text-amber">
          <span className="font-bold uppercase tracking-[0.06em]">
            {labels.refusalReason}
          </span>{" "}
          <span className="text-ink-2">{refusalReason}</span>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2.5">
        {/* T-C2: only nodes that actually declare constraints are shown — the
            "no restricted capabilities" filler is removed from this surface
            (a node's restriction state reads from its canvas glyph instead). */}
        {nodes
          .filter((node) => node.classes.length > 0)
          .map((node) => (
            <li
              key={node.nodeId}
              className="rounded-[10px] border border-line bg-paper px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2 font-mono text-[12.5px] font-bold tracking-[-0.005em] text-ink">
                <span className="min-w-0 truncate">{node.nodeId}</span>
                <span className="flex-none font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  {node.nodeType}
                </span>
              </div>

              {
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {node.classes.map((c) => (
                    <li
                      key={c.class}
                      className="inline-flex items-center gap-1.5 font-mono text-[11px]"
                    >
                      <span className="text-ink-2">
                        {labels.classLabel(c.class)}
                      </span>
                      <span
                        className={clsx(
                          "rounded-full border px-2 py-[2px] text-[9px] font-bold uppercase tracking-[0.06em]",
                          verdictTone(c.verdict),
                        )}
                      >
                        {verdictLabel(c.verdict, labels)}
                      </span>
                    </li>
                  ))}
                </ul>
              }
            </li>
          ))}
      </ul>
    </section>
  );
}
