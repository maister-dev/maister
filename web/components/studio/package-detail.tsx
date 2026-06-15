"use client";

import type { FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import type { PackageBom, StudioFlowGraph } from "@/lib/queries/packages";
import type { PackageVersion } from "@/lib/studio/group-packages";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";

export type PackageDetailView = {
  name: string;
  sourceUrl: string;
  isLocal: boolean;
  versions: PackageVersion[];
  bom: PackageBom;
};

const BOM_KINDS: { key: keyof PackageBom; label: string }[] = [
  { key: "flows", label: "kindFlows" },
  { key: "agents", label: "kindAgents" },
  { key: "skills", label: "kindSkills" },
  { key: "mcps", label: "kindMcps" },
  { key: "rules", label: "kindRules" },
];

export function PackageDetail({
  pkg,
  canManage,
  canTrust,
  flowGraphs,
  graphLabels,
}: {
  pkg: PackageDetailView;
  canManage: boolean;
  canTrust: boolean;
  flowGraphs: StudioFlowGraph[];
  graphLabels: FlowGraphViewLabels;
}) {
  const t = useTranslations("studio");
  const newest = pkg.versions[0];
  const nonEmptyKinds = BOM_KINDS.filter(({ key }) => pkg.bom[key].length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-[16px] border border-line bg-paper px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[20px] font-semibold text-ink">{pkg.name}</h2>
          <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
            {pkg.isLocal ? t("localBadge") : t("installedBadge")}
          </span>
          {newest ? (
            <span className="font-mono text-[11px] text-mute">
              {newest.versionLabel}
            </span>
          ) : null}
        </div>
        <div className="truncate font-mono text-[11.5px] text-mute">
          {pkg.sourceUrl}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {canManage ? (
            <Link
              className="rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
              href="/projects"
            >
              {t("attach")}
            </Link>
          ) : null}
          {canTrust ? (
            <Link
              className="rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
              href="/studio/sources"
            >
              {t("trust")}
            </Link>
          ) : null}
          {canManage ? (
            <span
              className="cursor-default rounded-[10px] border border-dashed border-line px-3 py-1.5 text-[12.5px] text-mute"
              title={t("reworkHint")}
            >
              {t("rework")}
            </span>
          ) : null}
        </div>
      </div>

      <section className="flex flex-col gap-3" data-testid="package-preview">
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("previewTitle")}
        </h3>
        {flowGraphs.length > 0 ? (
          flowGraphs.map((graph) => (
            <div key={graph.flowId} className="flex flex-col gap-1.5">
              <div className="font-mono text-[11px] text-ink-2">
                {graph.flowId}
              </div>
              <div className="h-[340px] overflow-hidden rounded-[14px] border border-line bg-paper">
                <FlowGraphViewSection
                  labels={graphLabels}
                  layout={graph.layout}
                  topology={graph.topology}
                />
              </div>
            </div>
          ))
        ) : (
          <p className="rounded-[14px] border border-dashed border-line bg-paper px-5 py-8 text-center text-[12.5px] text-mute">
            {t("previewEmpty")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("bomTitle")}
        </h3>
        {nonEmptyKinds.length > 0 ? (
          <div className="flex flex-col gap-4">
            {nonEmptyKinds.map(({ key, label }) => (
              <div key={key} className="flex flex-col gap-1.5">
                <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-mute">
                  {t(label)} ({pkg.bom[key].length})
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {pkg.bom[key].map((item) => (
                    <li
                      key={item.id}
                      className="rounded-full bg-ivory px-2.5 py-1 font-mono text-[11.5px] text-ink-2"
                    >
                      {item.id}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-mute">{t("bomEmpty")}</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("versionsTitle")}
        </h3>
        <ul className="flex list-none flex-col gap-1.5">
          {pkg.versions.map((version) => (
            <li
              key={version.installId}
              className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-paper px-4 py-2.5"
            >
              <span className="font-mono text-[12px] font-semibold text-ink">
                {version.versionLabel}
              </span>
              <span className="font-mono text-[10.5px] text-mute">
                {version.trustStatus}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
