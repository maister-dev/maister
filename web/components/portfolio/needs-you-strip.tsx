import type { AgentRole } from "@/lib/queries/portfolio";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

export interface NeedsYouItem {
  projectSlug: string;
  agent: AgentRole;
  prompt: string;
  branch: string;
  time: string;
  runId: string;
}

export interface NeedsYouStripProps {
  items: NeedsYouItem[];
  count: number;
}

const agentBadge: Record<AgentRole, string> = {
  claude: "bg-amber text-white",
  codex: "bg-accent-3 text-white",
  dev: "bg-ink text-paper",
};

export async function NeedsYouStrip({
  items,
  count,
}: NeedsYouStripProps): Promise<ReactElement> {
  const t = await getTranslations("portfolio");
  const tHitl = await getTranslations("hitl");

  return (
    <section
      aria-label="Items needing review"
      className="mb-6 overflow-hidden rounded-[14px] border border-amber-line bg-[linear-gradient(180deg,color-mix(in_oklab,var(--amber-soft)_90%,transparent)_0%,color-mix(in_oklab,var(--amber-soft)_55%,var(--paper))_100%)]"
    >
      <div className="flex items-center justify-between px-[18px] pb-2 pt-3 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-amber">
        <span className="inline-flex items-center gap-2.5 before:h-1.5 before:w-1.5 before:rounded-full before:bg-amber before:content-[''] before:animate-[pulse-dot_2.2s_ease-out_infinite]">
          {t("needsStripTitle", { count })}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-px border-t border-amber-line bg-amber-line">
        {items.map((item) => (
          <Link
            key={item.runId}
            className="flex cursor-pointer items-center gap-3.5 bg-paper px-[18px] py-3.5 transition-colors hover:bg-[color-mix(in_oklab,var(--amber-soft)_30%,var(--paper))]"
            href={`/runs/${item.runId}`}
          >
            <div className="flex flex-none items-center self-stretch border-r border-line pr-3 font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
              <b className="text-[12px] font-semibold normal-case tracking-normal text-ink">
                {item.projectSlug}
              </b>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-[1.35] tracking-[-0.005em] text-ink">
                <span
                  className={clsx(
                    "mr-1.5 inline-flex items-center gap-1 rounded px-[7px] py-0.5 align-[1px] font-mono text-[10.5px] font-semibold tracking-[0.02em]",
                    agentBadge[item.agent],
                  )}
                >
                  {item.agent}
                </span>
                {item.prompt}
              </div>
              <div className="mt-[3px] font-mono text-[10.5px] tracking-[0.02em] text-mute">
                {item.branch} · {t("pausedAgo", { time: item.time })}
              </div>
            </div>
            <span className="inline-flex flex-none items-center gap-1 font-mono text-[11px] font-bold tracking-[0.04em] text-amber">
              {tHitl("review")} →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
