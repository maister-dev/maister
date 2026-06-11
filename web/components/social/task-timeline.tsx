import type { ReactElement } from "react";

import type { TimelineItem } from "@/lib/queries/task-detail";

import { MarkdownBody } from "@/components/social/markdown-body";

export interface TaskTimelineLabels {
  empty: string;
  formerUser: string;
  system: string;
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

  return template.replace("{ref}", ref).replace("{attempt}", attempt);
}

function timestamp(at: Date): ReactElement {
  return (
    <time
      dateTime={at.toISOString()}
      className="font-mono text-[10px] text-mute"
      suppressHydrationWarning
    >
      {at.toISOString().slice(0, 16).replace("T", " ")}
    </time>
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
      {items.map((item) =>
        item.kind === "comment" ? (
          <li
            key={item.id}
            className="rounded-lg border border-line bg-paper p-3"
            data-timeline-kind="comment"
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold text-ink">
                {actorLabel(item.actor, labels)}
              </span>
              {timestamp(item.createdAt)}
            </div>
            <MarkdownBody text={item.body} />
          </li>
        ) : (
          <li
            key={item.id}
            className="flex items-baseline justify-between gap-2 px-3 py-1"
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
        ),
      )}
    </ol>
  );
}
