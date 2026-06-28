"use client";

import type { ElementCardLabels } from "@/components/studio/element-card";
import type { ProjectPackageContentView } from "@/lib/queries/project-package-contents";
import type { ReactElement } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  buildGraphLabels,
  FlowPreviewCard,
} from "@/components/studio/package-detail";

// Per-package contents on the project Packages tab: rich flow cards (reusing
// Studio's FlowPreviewCard) + a non-flow artifact count line. Flow cards link to
// the project-scoped per-flow viewer (`flow.id` === `flows.flowRefId`); the block
// header links to the Studio package view for the full skill/agent/MCP detail.
export function ProjectPackageContents({
  contents,
  slug,
}: {
  contents: ProjectPackageContentView[];
  slug: string;
}): ReactElement | null {
  const t = useTranslations("studio");
  const tWorkbench = useTranslations("workbench");
  const tPackages = useTranslations("packages");

  if (contents.length === 0) return null;

  const cardLabels: ElementCardLabels = {
    view: t("viewer.view"),
    fork: t("viewer.fork"),
    forkPhase2Hint: t("viewer.forkPhase2Hint"),
  };
  const graphLabels = buildGraphLabels(tWorkbench);

  return (
    <section className="mb-6 rounded-[16px] border border-line bg-paper p-6">
      <h3 className="mb-4 m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {tPackages("contentsTitle")}
      </h3>
      <div className="flex flex-col gap-6">
        {contents.map((pkg) => {
          const countParts = [
            pkg.counts.skills > 0
              ? tPackages("countSkills", { count: pkg.counts.skills })
              : null,
            pkg.counts.agents > 0
              ? tPackages("countAgents", { count: pkg.counts.agents })
              : null,
            pkg.counts.subagents > 0
              ? tPackages("countSubagents", { count: pkg.counts.subagents })
              : null,
            pkg.counts.mcps > 0
              ? tPackages("countMcps", { count: pkg.counts.mcps })
              : null,
            pkg.counts.rules > 0
              ? tPackages("countRules", { count: pkg.counts.rules })
              : null,
          ].filter((part): part is string => part !== null);

          return (
            <div
              key={pkg.packageName}
              className="rounded-[14px] border border-line-soft bg-ivory p-4"
              data-testid="package-contents-block"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-ink">
                    {pkg.packageName}
                  </span>
                  <span className="font-mono text-[11px] text-mute">
                    {pkg.versionLabel}
                  </span>
                </div>
                <Link
                  className="shrink-0 rounded-[8px] border border-line bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink hover:border-amber"
                  href={`/studio/packages/${encodeURIComponent(pkg.packageName)}`}
                >
                  {t("openInStudio")}
                </Link>
              </div>

              {pkg.flows.length > 0 ? (
                <div className="flex flex-col gap-4">
                  {pkg.flows.map((flow) => (
                    <FlowPreviewCard
                      key={flow.id}
                      flow={flow}
                      graphLabels={graphLabels}
                      href={`/projects/${slug}/packages/${encodeURIComponent(flow.id)}`}
                      labels={cardLabels}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}

              {countParts.length > 0 ? (
                <p className="mt-3 m-0 font-mono text-[11.5px] text-mute">
                  {countParts.join(" · ")}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
