import type { ProjectPageData } from "@/lib/queries/project";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import clsx from "clsx";

export interface SettingsPanelProps {
  data: ProjectPageData;
  isAdmin: boolean;
}

export async function SettingsPanel({
  data,
  isAdmin,
}: SettingsPanelProps): Promise<ReactElement> {
  const t = await getTranslations("nav");
  const tCommon = await getTranslations("common");
  const tBoard = await getTranslations("board");

  const { project, defaultAgent, defaultExecutorRef, flows } = data;
  const defaultFlow = flows.find((f) => f.overrideRef === null) ?? flows[0];

  // Settings rows. A settings-write API is out of POC scope, so the
  // "change" affordance is rendered (admin only) but disabled.
  const rows: { k: string; d: string; v: string }[] = [
    {
      k: tBoard("defaultAgent"),
      // FIXME(i18n): no setting-description keys — English fallbacks inline.
      d: "used for new runs unless overridden per-task",
      v: defaultExecutorRef
        ? `${defaultAgent ?? "—"} · ${defaultExecutorRef}`
        : "—",
    },
    {
      // FIXME(i18n): no "defaultFlow" key — English fallback inline.
      k: "Default flow",
      d: "applied when launching from backlog",
      v: defaultFlow?.ref ?? "—",
    },
    {
      // FIXME(i18n): no "concurrency" key — English fallback inline.
      k: "Concurrency limit",
      d: "max simultaneous running workspaces",
      v: process.env.MAISTER_MAX_CONCURRENT_RUNS ?? "3",
    },
    {
      // FIXME(i18n): no "branchPrefix" key — English fallback inline.
      k: "Branch prefix",
      d: "applied to every worktree branch",
      v: project.branchPrefix,
    },
  ];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("settings")}
        </h2>
        <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
          {project.slug}
        </span>
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-line bg-line">
        {rows.map((row) => (
          <div
            key={row.k}
            className="flex items-center justify-between gap-4 bg-paper px-[18px] py-[15px]"
          >
            <div>
              <div className="text-[13px] font-semibold tracking-[-0.005em] text-ink">
                {row.k}
              </div>
              <div className="mt-[3px] font-mono text-[10.5px] tracking-[0.02em] text-mute">
                {row.d}
              </div>
            </div>
            <div className="inline-flex items-center gap-2 font-mono text-[11.5px] font-semibold text-ink-2">
              {row.v}
              {isAdmin ? (
                <span
                  aria-disabled
                  className={clsx(
                    "cursor-not-allowed font-mono text-[10px] font-bold tracking-[0.04em] text-amber opacity-50",
                  )}
                  // FIXME: no settings-write API in POC — control is inert.
                  title="admin"
                >
                  {tCommon("change")}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
