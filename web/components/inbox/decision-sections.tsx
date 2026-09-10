import type { DecisionCardLabels } from "@/components/inbox/decision-card";
import type { DecisionItem } from "@/lib/queries/decisions";
import type { ReactElement } from "react";

import { DecisionCard } from "@/components/inbox/decision-card";

type NonHitlDecision = Extract<
  DecisionItem,
  { kind: "crashed" | "promotable" | "flagged" }
>;

export interface DecisionSectionsLabels extends DecisionCardLabels {
  promotableTitle: string;
  crashedTitle: string;
  flaggedTitle: string;
}

// The three decision populations that are NOT a pending HITL request. They were
// invisible before this milestone: a run ready to promote, a crashed run owing
// recover-or-discard, and a task triage flagged for a human. Each is blocked on
// the reader now, which is what earns them a place beside the HITL queue.
export function DecisionSections({
  items,
  labels,
}: {
  items: DecisionItem[];
  labels: DecisionSectionsLabels;
}): ReactElement | null {
  const byKind = (kind: NonHitlDecision["kind"]): NonHitlDecision[] =>
    items.filter((item): item is NonHitlDecision => item.kind === kind);
  const sections = [
    { kind: "promotable" as const, title: labels.promotableTitle },
    { kind: "crashed" as const, title: labels.crashedTitle },
    { kind: "flagged" as const, title: labels.flaggedTitle },
  ].flatMap((section) => {
    const rows = byKind(section.kind);

    return rows.length > 0 ? [{ ...section, rows }] : [];
  });

  if (sections.length === 0) return null;

  return (
    <>
      {sections.map((section) => (
        <section
          key={section.kind}
          aria-label={section.title}
          data-testid={`decision-section-${section.kind}`}
        >
          <h2 className="mb-3.5 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink">
            {section.title.replace("$count", String(section.rows.length))}
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {section.rows.map((item) => (
              <DecisionCard key={item.id} item={item} labels={labels} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
