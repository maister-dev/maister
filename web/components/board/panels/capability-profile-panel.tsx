import type { ReactElement } from "react";

import clsx from "clsx";

export interface CapabilityProfilePanelLabels {
  title: string;
  // Honesty caption: the plan is RECORDED at launch; nothing here is verified as
  // live-enforced yet (ADR-041 — all enforcement_snapshot verdicts are still
  // `instructed` until a live spike). Threaded so EN/RU stay in one catalog.
  subtitle: string;
  digestLabel: string;
  revisionLabel: string;
  enforcedLabel: string;
  instructedLabel: string;
  refusedLabel: string;
  cleanupFailedLabel: string;
  trustThirdParty: string;
  noProfiles: string;
  classLabel: (c: string) => string;
}

export interface CapabilityProfileNodeView {
  nodeId: string;
  nodeType: string;
  profileDigest: string;
  resolvedRevisions: {
    refId: string;
    kind: string;
    sha: string;
    trustStatus?: "untrusted" | "trusted" | "trusted_by_policy" | null;
  }[];
  enforcedClasses: string[];
  instructedClasses: string[];
  refusedClasses: string[];
  cleanupFailed: boolean;
}

export interface CapabilityProfilePanelProps {
  nodes: CapabilityProfileNodeView[];
  labels: CapabilityProfilePanelLabels;
}

type ClassTone = "enforced" | "instructed" | "refused";

function classTone(tone: ClassTone): string {
  if (tone === "enforced") {
    return "border-[color-mix(in_oklab,var(--accent-4)_40%,var(--line))] bg-accent-4-soft text-accent-4";
  }
  if (tone === "refused") {
    return "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300";
  }

  return "border-amber-line bg-amber-soft text-amber";
}

function ClassChips({
  groupLabel,
  tone,
  classes,
  classLabel,
}: {
  groupLabel: string;
  tone: ClassTone;
  classes: string[];
  classLabel: (c: string) => string;
}): ReactElement | null {
  if (classes.length === 0) return null;

  return (
    <div className="mt-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
        {groupLabel}
      </span>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {classes.map((c) => (
          <li
            key={c}
            className={clsx(
              "rounded-full border px-2 py-[2px] font-mono text-[11px]",
              classTone(tone),
            )}
          >
            {classLabel(c)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CapabilityProfilePanel({
  nodes,
  labels,
}: CapabilityProfilePanelProps): ReactElement {
  return (
    <section className="mt-8">
      <h2 className="mb-1 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
        {labels.title}
      </h2>

      <p className="mb-3 font-mono text-[10.5px] leading-[1.5] text-mute">
        {labels.subtitle}
      </p>

      {nodes.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-line px-3.5 py-3 font-mono text-[11px] text-mute">
          {labels.noProfiles}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {nodes.map((node) => (
            <li
              key={node.nodeId}
              className="rounded-[10px] border border-line bg-paper px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2 font-mono text-[12.5px] font-bold tracking-[-0.005em] text-ink">
                <span className="min-w-0 truncate">{node.nodeId}</span>
                <span className="flex-none font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  {node.nodeType}
                </span>
                {node.cleanupFailed ? (
                  <span
                    aria-label={labels.cleanupFailedLabel}
                    className="flex-none rounded-full border border-red-300 bg-red-50 px-2 py-[2px] text-[9px] font-bold uppercase tracking-[0.06em] text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                    role="status"
                  >
                    {labels.cleanupFailedLabel}
                  </span>
                ) : null}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-mute">
                <span className="uppercase tracking-[0.08em]">
                  {labels.digestLabel}
                </span>
                <span className="text-ink-2">
                  {node.profileDigest.slice(0, 12)}
                </span>
              </div>

              {node.resolvedRevisions.length > 0 ? (
                <div className="mt-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                    {labels.revisionLabel}
                  </span>
                  <ul className="mt-1 flex flex-col gap-1">
                    {node.resolvedRevisions.map((rev) => (
                      <li
                        key={`${rev.kind}/${rev.refId}@${rev.sha}`}
                        className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-2"
                      >
                        <span>
                          {rev.kind}/{rev.refId} @ {rev.sha.slice(0, 12)}
                        </span>
                        {rev.trustStatus === "untrusted" ? (
                          <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-[1px] text-[9px] font-bold uppercase tracking-[0.06em] text-amber">
                            {labels.trustThirdParty}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <ClassChips
                classLabel={labels.classLabel}
                classes={node.enforcedClasses}
                groupLabel={labels.enforcedLabel}
                tone="enforced"
              />
              <ClassChips
                classLabel={labels.classLabel}
                classes={node.instructedClasses}
                groupLabel={labels.instructedLabel}
                tone="instructed"
              />
              <ClassChips
                classLabel={labels.classLabel}
                classes={node.refusedClasses}
                groupLabel={labels.refusedLabel}
                tone="refused"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
