import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { getSessionUser } from "@/lib/authz";
import {
  hostToolStatus,
  reposRoot,
  worktreesRoot,
} from "@/lib/instance-config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");

  return { title: t("title") };
}

export default async function SettingsPage(): Promise<ReactElement> {
  const t = await getTranslations("settings");
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";

  const tools = isAdmin ? await hostToolStatus() : [];

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("title")}
        </div>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("title")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("sub")}
        </p>
      </header>

      <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
        {isAdmin ? (
          <dl className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                {t("repoHome")}
              </dt>
              <dd className="m-0 break-all font-mono text-[13px] leading-[1.5] text-ink">
                {reposRoot()}
              </dd>
            </div>

            <div className="flex flex-col gap-1.5">
              <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                {t("worktreesRoot")}
              </dt>
              <dd className="m-0 break-all font-mono text-[13px] leading-[1.5] text-ink">
                {worktreesRoot()}
              </dd>
            </div>

            <div className="flex flex-col gap-1.5">
              <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                {t("hostTools")}
              </dt>
              <dd className="m-0 flex flex-col gap-1">
                {tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-baseline justify-between gap-3 font-mono text-[13px] leading-[1.5]"
                  >
                    <span className="text-ink">{tool.name}</span>
                    <span className="text-mute">
                      {tool.available
                        ? `${tool.version} (${t("available")})`
                        : t("unavailable")}
                    </span>
                  </div>
                ))}
              </dd>
            </div>

            <p className="text-[11.5px] leading-[1.5] text-mute">
              {t("envNote")}
            </p>
          </dl>
        ) : (
          <p className="text-[13.5px] leading-[1.55] text-mute">
            {t("forbidden")}
          </p>
        )}
      </div>
    </div>
  );
}
