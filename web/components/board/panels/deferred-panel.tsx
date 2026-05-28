import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

export interface DeferredPanelProps {
  kind: "prs" | "mcps";
}

export async function DeferredPanel({
  kind,
}: DeferredPanelProps): Promise<ReactElement> {
  const t = await getTranslations("board");
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {kind === "prs" ? tNav("prs") : tNav("mcps")}
        </h2>
      </div>
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-line bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))] px-6 py-14 text-center">
        <span className="rounded-full border border-line bg-paper px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
          {tCommon("deferred")}
        </span>
        <p className="m-0 max-w-[44ch] font-mono text-[12px] leading-[1.6] text-mute">
          {kind === "prs" ? t("prsDeferred") : t("mcpsDeferred")}
        </p>
      </div>
    </section>
  );
}
