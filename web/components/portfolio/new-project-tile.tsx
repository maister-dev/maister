import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

export async function NewProjectTile({
  canCreate,
}: {
  canCreate: boolean;
}): Promise<ReactElement> {
  const t = await getTranslations("portfolio");

  const content = (
    <>
      <span className="mb-3.5 inline-flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-dashed border-amber-line bg-paper font-mono text-[22px] font-normal leading-none text-amber transition-transform group-hover:rotate-90 group-hover:border-solid group-hover:bg-amber group-hover:text-white">
        +
      </span>
      <h3 className="mb-1 text-[15px] font-semibold tracking-[-0.01em] text-ink">
        {t("newProject")}
      </h3>
      <p className="m-0 font-mono text-[10.5px] leading-normal tracking-[0.04em] text-mute">
        {canCreate ? t("newProjectSub") : t("askAdmin")}
      </p>
    </>
  );

  const className =
    "group flex min-h-[240px] flex-col items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-line bg-[repeating-linear-gradient(45deg,transparent_0_12px,color-mix(in_oklab,var(--line)_30%,transparent)_12px_13px)] px-6 py-8 text-center transition-colors";

  return canCreate ? (
    <Link
      className={`${className} cursor-pointer hover:border-amber hover:bg-amber-soft`}
      href="/projects/new"
    >
      {content}
    </Link>
  ) : (
    <section className={`${className} opacity-70`}>{content}</section>
  );
}
