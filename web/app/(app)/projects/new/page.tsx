import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { NewProjectForm } from "@/components/projects/new-project-form";
import { getSessionUser } from "@/lib/authz";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");

  return { title: t("addTitle") };
}

export default async function NewProjectPage(): Promise<ReactElement> {
  const t = await getTranslations("projects");
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("addTitle")}
        </div>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("addTitle")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("addSub")}
        </p>
      </header>

      <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
        {isAdmin ? (
          <NewProjectForm />
        ) : (
          <p className="text-[13.5px] leading-[1.55] text-mute">
            {t("errorForbidden")}
          </p>
        )}
      </div>
    </div>
  );
}
