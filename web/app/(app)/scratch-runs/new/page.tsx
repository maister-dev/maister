import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { ScratchLauncher } from "@/components/scratch/scratch-launcher";

export default async function NewScratchRunPage(): Promise<ReactElement> {
  const t = await getTranslations("scratch");

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("eyebrow")}
        </div>
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] text-ink">
          {t("newTitle")}
        </h1>
        <p className="max-w-[66ch] text-[13.5px] leading-[1.5] text-mute">
          {t("newSubtitle")}
        </p>
      </header>

      <ScratchLauncher />
    </div>
  );
}
