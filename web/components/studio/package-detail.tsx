"use client";

import type { ElementCardLabels } from "@/components/studio/element-card";
import type { PackageTabDescriptor } from "@/components/studio/package-tabs";
import type { PackageBom } from "@/lib/queries/packages";
import type { PackageVersion } from "@/lib/studio/group-packages";
import type { ReactNode } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { ElementCard } from "@/components/studio/element-card";
import {
  PACKAGE_TAB_PAGE_SIZE,
  PackageTabs,
} from "@/components/studio/package-tabs";

export type PackageDetailView = {
  name: string;
  sourceUrl: string;
  isLocal: boolean;
  versions: PackageVersion[];
  bom: PackageBom;
};

// Tab kinds in fixed display order. A kind whose count is 0 is dropped by
// PackageTabs (never rendered as an empty tab).
const TAB_KINDS = ["flows", "skills", "agents", "mcps", "rules"] as const;

type TabKind = (typeof TAB_KINDS)[number];

const TAB_LABEL_KEY: Record<TabKind, string> = {
  flows: "viewer.tabFlows",
  skills: "viewer.tabSkills",
  agents: "viewer.tabAgents",
  mcps: "viewer.tabMcps",
  rules: "viewer.tabRules",
};

function isTabKind(value: string): value is TabKind {
  return (TAB_KINDS as readonly string[]).includes(value);
}

export function PackageDetail({
  pkg,
  canManage,
  canTrust,
  basePath,
  activeTab,
  page,
}: {
  pkg: PackageDetailView;
  canManage: boolean;
  canTrust: boolean;
  // The package-detail route base (no query), e.g. `/studio/packages/aif`. Card
  // and tab links are built relative to it; no disk handle ever reaches here.
  basePath: string;
  activeTab: string;
  page: number;
}) {
  const t = useTranslations("studio");
  const newest = pkg.versions[0];

  const cardLabels: ElementCardLabels = {
    view: t("viewer.view"),
    fork: t("viewer.fork"),
    forkPhase2Hint: t("viewer.forkPhase2Hint"),
  };

  const counts: Record<TabKind, number> = {
    flows: pkg.bom.flows.length,
    skills: pkg.bom.skills.length,
    agents: pkg.bom.agents.length,
    mcps: pkg.bom.mcps.length,
    rules: pkg.bom.rules.length,
  };

  const tabs: PackageTabDescriptor[] = TAB_KINDS.map((kind) => ({
    id: kind,
    label: t(TAB_LABEL_KEY[kind]),
    count: counts[kind],
  }));

  // Resolved active tab: the requested one if it has members, else the first
  // non-empty kind (so a deep-link to an emptied tab still shows content).
  const resolvedTab: TabKind =
    isTabKind(activeTab) && counts[activeTab] > 0
      ? activeTab
      : (TAB_KINDS.find((kind) => counts[kind] > 0) ?? "flows");

  const totalForActive = counts[resolvedTab];
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * PACKAGE_TAB_PAGE_SIZE;
  const end = start + PACKAGE_TAB_PAGE_SIZE;

  const hrefFor = (tab: string, targetPage: number): string => {
    const params = new URLSearchParams();

    params.set("tab", tab);
    if (targetPage > 1) params.set("page", String(targetPage));

    return `${basePath}?${params.toString()}`;
  };

  const cards = buildCards({
    pkg,
    kind: resolvedTab,
    start,
    end,
    basePath,
    labels: cardLabels,
    t,
  });

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
          {/* Fork-to-local is wired in Phase 2 — rendered disabled with a hint.
              Import (⤓) stays ABSENT here: installed packages are immutable. */}
          {canManage ? (
            <span
              aria-disabled="true"
              className="cursor-default rounded-[10px] border border-dashed border-line px-3 py-1.5 text-[12.5px] text-mute"
              data-testid="package-fork-disabled"
              title={t("reworkHint")}
            >
              {t("rework")}
            </span>
          ) : null}
        </div>
      </div>

      <section className="flex flex-col gap-3" data-testid="package-bom">
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("bomTitle")}
        </h3>
        <PackageTabs
          activeTab={resolvedTab}
          cards={cards}
          hrefFor={hrefFor}
          labels={{
            loadMore: t("viewer.loadMore"),
            showingCount: t("viewer.showingCount"),
            tabEmpty: t("viewer.tabEmpty"),
          }}
          page={safePage}
          pageSize={PACKAGE_TAB_PAGE_SIZE}
          tabs={tabs}
          totalForActive={totalForActive}
        />
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

type TFn = ReturnType<typeof useTranslations>;

// Renders the page slice of cards for the active kind. Each member is a card
// (never a bare id chip); degraded members (empty meta) omit the meta line.
function buildCards({
  pkg,
  kind,
  start,
  end,
  basePath,
  labels,
  t,
}: {
  pkg: PackageDetailView;
  kind: TabKind;
  start: number;
  end: number;
  basePath: string;
  labels: ElementCardLabels;
  t: TFn;
}): ReactNode {
  switch (kind) {
    case "flows":
      return pkg.bom.flows.slice(start, end).map((flow) => (
        <ElementCard
          key={flow.id}
          href={`${basePath}/flows/${encodeURIComponent(flow.id)}`}
          labels={labels}
          meta={
            flow.engine
              ? t("viewer.flowMeta", {
                  nodes: flow.nodeCount,
                  gates: flow.gateCount,
                  engine: flow.engine,
                })
              : t("viewer.flowMetaNoEngine", {
                  nodes: flow.nodeCount,
                  gates: flow.gateCount,
                })
          }
          name={flow.id}
        />
      ));
    case "skills":
      return pkg.bom.skills.slice(start, end).map((skill) => (
        <ElementCard
          key={skill.id}
          href={`${basePath}/skills/${skill.id
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`}
          labels={labels}
          meta={t("viewer.skillMeta", {
            files: skill.fileCount,
            subfolders: skill.subfolderCount,
          })}
          name={skill.id}
        />
      ));
    case "agents":
      return pkg.bom.agents.slice(start, end).map((agent) => (
        <ElementCard
          key={agent.id}
          description={
            agent.triggers.length > 0
              ? agent.triggers
                  .map((trigger) => t(`viewer.trigger${capitalize(trigger)}`))
                  .join(" · ")
              : t("viewer.agentNoTriggers")
          }
          href={`${basePath}/agents/${encodeURIComponent(agent.id)}`}
          labels={labels}
          meta={
            agent.riskTier || agent.workspace
              ? t("viewer.agentRiskWorkspace", {
                  risk: agent.riskTier
                    ? t(`viewer.risk${capitalize(agent.riskTier)}`)
                    : "—",
                  workspace: agent.workspace
                    ? t(`viewer.workspace${capitalize(agent.workspace)}`)
                    : "—",
                })
              : null
          }
          name={agent.id}
        />
      ));
    case "mcps":
      return pkg.bom.mcps
        .slice(start, end)
        .map((mcp) => (
          <ElementCard
            key={mcp.id}
            href={basePath}
            labels={labels}
            name={mcp.id}
          />
        ));
    case "rules":
      return pkg.bom.rules
        .slice(start, end)
        .map((rule) => (
          <ElementCard
            key={rule.id}
            href={basePath}
            labels={labels}
            meta={`${t("viewer.rulePath")}: ${rule.path}`}
            name={rule.id}
          />
        ));
  }
}

// Maps an enum value (`read_only`, `repo_read`, `manual`) to its title-cased key
// suffix (`Read_only`, `Repo_read`, `Manual`) so it joins the `viewer.*` keys.
function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}
