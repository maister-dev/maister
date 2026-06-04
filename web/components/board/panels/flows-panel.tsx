import type { ProjectFlow } from "@/lib/queries/project";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import clsx from "clsx";

export interface FlowsPanelProps {
  flows: ProjectFlow[];
}

const GLYPH: Record<string, string> = {
  bugfix: "bg-amber",
  "spec-clarify": "bg-accent-2",
  autonomous: "bg-accent-3",
  refactor: "bg-accent-4",
};

export async function FlowsPanel({
  flows,
}: FlowsPanelProps): Promise<ReactElement> {
  const t = await getTranslations("nav");

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("flows")}
        </h2>
        <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
          {flows.length} configured
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {flows.map((flow) => (
          <div
            key={flow.id}
            className="cursor-pointer rounded-xl border border-line bg-paper p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-mute hover:shadow-[var(--shadow-md)]"
          >
            <div className="mb-2.5 flex items-center justify-between gap-2.5">
              <span className="inline-flex items-center gap-2 font-mono text-[13px] font-bold text-ink">
                <span
                  className={clsx(
                    "h-[9px] w-[9px] rounded-[3px]",
                    GLYPH[flow.ref] ?? "bg-amber",
                  )}
                />
                {flow.ref}
              </span>
              <span className="rounded-full border border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft px-[7px] py-[3px] font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-accent-4">
                on
              </span>
            </div>
            <div className="mb-3 font-mono text-[11px] leading-[1.5] text-mute">
              {flow.source} · {flow.version}
            </div>
            <div className="flex items-center justify-between border-t border-dashed border-line-soft pt-2.5 font-mono text-[10px] tracking-[0.02em] text-mute">
              <span>
                <b className="font-semibold text-ink-2">{flow.stepCount}</b>{" "}
                steps
              </span>
              <span>runner defaults</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
