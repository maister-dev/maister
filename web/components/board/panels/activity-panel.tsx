import type { ActivityEvent } from "@/lib/queries/activity";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import clsx from "clsx";

export interface ActivityPanelProps {
  events: ActivityEvent[];
}

const AVA: Record<ActivityEvent["agent"], string> = {
  claude: "bg-amber",
  codex: "bg-accent-3",
  gemini: "bg-accent-2",
  opencode: "bg-ink-2",
  dev: "bg-accent-4",
};

function avaInitials(agent: ActivityEvent["agent"]): string {
  if (agent === "claude") return "cl";
  if (agent === "codex") return "cx";
  if (agent === "gemini") return "gm";
  if (agent === "opencode") return "oc";

  return "dv";
}

export async function ActivityPanel({
  events,
}: ActivityPanelProps): Promise<ReactElement> {
  const t = await getTranslations("nav");
  const tBoard = await getTranslations("board");

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("activity")}
        </h2>
        <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
          {tBoard("asOf")}{" "}
          <b className="font-semibold text-ink-2">{tBoard("justNow")}</b> ·{" "}
          {events.length} events
        </span>
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-line bg-line">
        {events.map((event) => (
          <div
            key={event.id}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-3.5 bg-paper px-4 py-3 transition-colors hover:bg-ivory"
          >
            <span
              className={clsx(
                "inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg font-mono text-[9.5px] font-extrabold tracking-[0.02em] text-white",
                AVA[event.agent],
              )}
            >
              {avaInitials(event.agent)}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] leading-[1.4] tracking-[-0.005em] text-ink">
                <b className="font-semibold">{event.title}</b>
                {event.code ? (
                  <code className="ml-1.5 rounded border border-line bg-ivory px-[5px] py-px font-mono text-[11px] text-ink-2">
                    {event.code}
                  </code>
                ) : null}
              </div>
              <div className="mt-[3px] truncate font-mono text-[10px] tracking-[0.02em] text-mute">
                {event.meta}
              </div>
            </div>
            <span className="whitespace-nowrap font-mono text-[10.5px] tracking-[0.02em] text-mute-2">
              {event.time}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
