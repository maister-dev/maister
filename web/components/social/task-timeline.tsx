import type { ReactElement } from "react";
import type { TimelineItem } from "@/lib/queries/task-detail";

import { MarkdownBody } from "@/components/social/markdown-body";
import { LocalTime } from "@/components/ui/local-time";

export interface TaskTimelineLabels {
  empty: string;
  formerUser: string;
  system: string;
  viaLibrarian: string;
  // (ADR-151) `%agents%` is the comma-joined list of resolved-but-unsummonable
  // agent ids.
  mentionNotSummonable: string;
  event: Record<string, string>;
}

function actorLabel(
  actor: { type: string; label: string },
  labels: TaskTimelineLabels,
): string {
  if (actor.type === "system") return labels.system;
  if (actor.label === "former user") return labels.formerUser;

  return actor.label;
}

function activityText(
  item: Extract<TimelineItem, { kind: "activity" }>,
  labels: TaskTimelineLabels,
): string {
  const template = labels.event[item.eventKind] ?? item.eventKind;
  const payload = item.payload;
  const ref =
    typeof payload.toRef === "string"
      ? payload.toRef
      : typeof payload.fromKey === "string"
        ? payload.fromKey
        : "";
  const attempt =
    typeof payload.attemptNumber === "number"
      ? String(payload.attemptNumber)
      : "";
  // (ADR-151) agent_summon_suppressed names the agent it skipped.
  const agent = typeof payload.agentId === "string" ? payload.agentId : "";

  const pr =
    typeof payload.prNumber === "number" ? String(payload.prNumber) : "";
  const reason = typeof payload.reason === "string" ? payload.reason : "";

  return template
    .replace("%ref%", ref)
    .replace("%attempt%", attempt)
    .replace("%agent%", agent)
    .replace("%pr%", pr)
    .replace("%reason%", reason);
}

function timestamp(at: Date): ReactElement {
  return (
    <span className="font-mono text-[10px] text-mute">
      <LocalTime iso={at} />
    </span>
  );
}

// D10: the outcome-bearing facts read first in a long history.
const EMPHASIZED_EVENTS = new Set(["task_completed", "run_pr_merged"]);

type ActivityItem = Extract<TimelineItem, { kind: "activity" }>;
type TimelineEntry =
  | { kind: "single"; item: TimelineItem }
  | { kind: "group"; eventKind: string; items: ActivityItem[] };

// Consecutive system events of the same kind collapse into one row; each entry
// stays reachable inside it. People's events and comments are never grouped.
function groupEntries(items: TimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const item of items) {
    const last = entries.at(-1);
    const groupable = item.kind === "activity" && item.actor.type === "system";

    if (groupable && last) {
      if (last.kind === "group" && last.eventKind === item.eventKind) {
        last.items.push(item);
        continue;
      }
      if (
        last.kind === "single" &&
        last.item.kind === "activity" &&
        last.item.actor.type === "system" &&
        last.item.eventKind === item.eventKind
      ) {
        entries[entries.length - 1] = {
          kind: "group",
          eventKind: item.eventKind,
          items: [last.item, item],
        };
        continue;
      }
    }
    entries.push({ kind: "single", item });
  }

  return entries;
}

function ActivityRow({
  item,
  labels,
}: {
  item: ActivityItem;
  labels: TaskTimelineLabels;
}): ReactElement {
  return (
    <li
      className={
        EMPHASIZED_EVENTS.has(item.eventKind)
          ? "flex items-baseline justify-between gap-2 rounded-md border border-line bg-ivory px-3 py-1.5"
          : "flex items-baseline justify-between gap-2 px-3 py-1"
      }
      data-timeline-kind="activity"
    >
      <span className="text-[12px] text-ink-2">
        <span className="font-semibold text-ink">
          {actorLabel(item.actor, labels)}
        </span>{" "}
        {activityText(item, labels)}
      </span>
      {timestamp(item.createdAt)}
    </li>
  );
}

export function TaskTimeline({
  items,
  labels,
}: {
  items: TimelineItem[];
  labels: TaskTimelineLabels;
}): ReactElement {
  if (items.length === 0) {
    return <p className="text-[13px] text-mute">{labels.empty}</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {groupEntries(items).map((entry) => {
        if (entry.kind === "group") {
          return (
            <li key={entry.items[0].id} data-timeline-group={entry.eventKind}>
              <details>
                <summary className="cursor-pointer px-3 py-1 text-[12px] text-ink-2">
                  <span className="font-semibold text-ink">
                    {labels.system}
                  </span>{" "}
                  {labels.event[entry.eventKind] ?? entry.eventKind} ×
                  {entry.items.length}
                </summary>
                <ol className="flex flex-col gap-1 pl-3">
                  {entry.items.map((item) => (
                    <ActivityRow key={item.id} item={item} labels={labels} />
                  ))}
                </ol>
              </details>
            </li>
          );
        }
        const item = entry.item;

        return item.kind === "comment" ? (
          <li
            key={item.id}
            className="rounded-lg border border-line bg-paper p-3"
            data-timeline-kind="comment"
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold text-ink">
                {actorLabel(item.actor, labels)}
                {item.via === "librarian" ? ` · ${labels.viaLibrarian}` : ""}
              </span>
              {timestamp(item.createdAt)}
            </div>
            <MarkdownBody text={item.body} />
            {/* (ADR-151) Only the mentions that will NOT run are explained —
                a successful summon has its run as the evidence. */}
            {(item.mentionedAgents ?? []).some((a) => !a.summonable) ? (
              <p className="mt-1.5 text-[11px] leading-[1.45] text-mute">
                {labels.mentionNotSummonable.replace(
                  "%agents%",
                  (item.mentionedAgents ?? [])
                    .filter((a) => !a.summonable)
                    .map((a) => a.id)
                    .join(", "),
                )}
              </p>
            ) : null}
          </li>
        ) : (
          <ActivityRow key={item.id} item={item} labels={labels} />
        );
      })}
    </ol>
  );
}
