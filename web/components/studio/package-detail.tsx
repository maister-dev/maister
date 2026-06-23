"use client";

import type { ElementCardLabels } from "@/components/studio/element-card";
import type { FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import type { PackageTabDescriptor } from "@/components/studio/package-tabs";
import type {
  PackageBom,
  PackageBomFlow,
  PackageBomFlowFrontmatter,
} from "@/lib/queries/packages";
import type { PackageVersion } from "@/lib/studio/group-packages";
import type { ReactElement, ReactNode } from "react";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";
import { ElementCard } from "@/components/studio/element-card";
import { ForkToEditButton } from "@/components/studio/fork-to-edit-button";
import {
  PACKAGE_TAB_PAGE_SIZE,
  PackageTabs,
} from "@/components/studio/package-tabs";
import { readApiError } from "@/lib/api-error";

export type PackageDetailView = {
  name: string;
  sourceUrl: string;
  isLocal: boolean;
  versions: PackageVersion[];
  bom: PackageBom;
};

// Tab kinds in fixed display order. A kind whose count is 0 is dropped by
// PackageTabs (never rendered as an empty tab).
const TAB_KINDS = [
  "flows",
  "skills",
  "agents",
  "subagents",
  "mcps",
  "rules",
] as const;

type TabKind = (typeof TAB_KINDS)[number];

const TAB_LABEL_KEY: Record<TabKind, string> = {
  flows: "viewer.tabFlows",
  skills: "viewer.tabSkills",
  agents: "viewer.tabAgents",
  subagents: "viewer.tabSubagents",
  mcps: "viewer.tabMcps",
  rules: "viewer.tabRules",
};

const EMPTY_FLOW_FRONTMATTER: PackageBomFlowFrontmatter = {
  title: null,
  summary: null,
  labels: [],
  routeWhen: null,
  links: [],
  sources: [],
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
}): ReactElement {
  const t = useTranslations("studio");
  const tWorkbench = useTranslations("workbench");
  const newest = pkg.versions[0];

  const cardLabels: ElementCardLabels = {
    view: t("viewer.view"),
    fork: t("viewer.fork"),
    forkPhase2Hint: t("viewer.forkPhase2Hint"),
  };

  const counts: Record<TabKind, number> = {
    flows: pkg.bom.flows.length,
    skills: pkg.bom.skills.length,
    agents: pkg.bom.platformAgents.length,
    subagents: pkg.bom.subagents.length,
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
    graphLabels: buildGraphLabels(tWorkbench),
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
          {canTrust && newest && newest.trustStatus === "untrusted" ? (
            <TrustButton installId={newest.installId} />
          ) : null}
          {/* Fork-to-local (M36 T2.4): clones the package into a new local
              package and opens the editor. Import (⤓) stays ABSENT here:
              installed packages are immutable. */}
          {canManage ? <ForkToEditButton refName={pkg.name} /> : null}
          {/* Customize (M39 A3): a deliberate divergent COPY (always fresh,
              named `<ref> (custom)`) — the centralized "diverge this package"
              escape hatch, distinct from the dedup'd fork-to-edit. */}
          {canManage ? <CustomizeButton refName={pkg.name} /> : null}
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
            // `t.raw` returns the un-interpolated template; PackageTabs fills
            // {shown}/{total} via formatTemplate. Plain `t()` would error on the
            // unprovided ICU args and fall back to the raw key path.
            showingCount: t.raw("viewer.showingCount"),
            tabEmpty: t("viewer.tabEmpty"),
          }}
          layout={resolvedTab === "flows" ? "stack" : "grid"}
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

// One-click platform trust from the package card (admin only). POSTs the newest
// install to the trust route and refreshes. Only rendered for an untrusted
// revision, so a trusted package shows no button (its versions list reads
// "trusted").
function TrustButton({ installId }: { installId: string }): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function trust(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/admin/package-installs/${encodeURIComponent(installId)}/trust`,
        { method: "POST" },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        className="rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-60"
        data-testid="package-trust"
        disabled={busy}
        type="button"
        onClick={() => void trust()}
      >
        {t("trust")}
      </button>
      {error ? (
        <span className="font-mono text-[10.5px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

// (M39 A3) "Customize" — make a deliberate divergent COPY of this package as a
// new centralized local package named `<ref> (custom)`, then open the editor.
// Distinct from fork-to-edit (which dedups to the canonical editable copy): a
// customize always creates a fresh, separately-editable copy.
function CustomizeButton({ refName }: { refName: string }): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function customize(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/studio/packages/${encodeURIComponent(refName)}/fork`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customize: true }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      const result = (await res.json()) as { localPackageId: string };

      router.push(`/studio/edit/${result.localPackageId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        className="rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-60"
        data-testid="package-customize"
        disabled={busy}
        title={t("customizeHint")}
        type="button"
        onClick={() => void customize()}
      >
        {t("customize")}
      </button>
      {error ? (
        <span className="font-mono text-[10.5px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

type TFn = ReturnType<typeof useTranslations>;

function buildGraphLabels(t: TFn): FlowGraphViewLabels {
  return {
    title: t("graph.title"),
    empty: t("graph.empty"),
    currentNode: t("graph.currentNode"),
    declaredGateSummary: t("graph.declaredGateSummary"),
    gateSummary: t("graph.gateSummary"),
    blockingGateSummary: t("graph.blockingGateSummary"),
    node: {
      Pending: t("graph.node.Pending"),
      Running: t("graph.node.Running"),
      Succeeded: t("graph.node.Succeeded"),
      Failed: t("graph.node.Failed"),
      NeedsInput: t("graph.node.NeedsInput"),
      Reworked: t("graph.node.Reworked"),
      Stale: t("graph.node.Stale"),
    },
    role: {
      agent: t("graph.role.agent"),
      command: t("graph.role.command"),
      check: t("graph.role.check"),
      judge: t("graph.role.judge"),
      human: t("graph.role.human"),
      form: t("graph.role.form"),
      terminal: t("graph.role.terminal"),
      other: t("graph.role.other"),
    },
    edge: {
      success: t("graph.edge.success"),
      default: t("graph.edge.default"),
      rework: t("graph.edge.rework"),
      reject: t("graph.edge.reject"),
      takeover: t("graph.edge.takeover"),
      approve: t("graph.edge.approve"),
      other: t("graph.edge.other"),
    },
  };
}

function hasFlowFrontmatter(frontmatter: PackageBomFlowFrontmatter): boolean {
  return (
    frontmatter.title !== null ||
    frontmatter.summary !== null ||
    frontmatter.labels.length > 0 ||
    frontmatter.routeWhen !== null ||
    frontmatter.links.length > 0 ||
    frontmatter.sources.length > 0
  );
}

function FlowPreviewCard({
  flow,
  href,
  labels,
  graphLabels,
  t,
}: {
  flow: PackageBomFlow;
  href: string;
  labels: ElementCardLabels;
  graphLabels: FlowGraphViewLabels;
  t: TFn;
}): ReactElement {
  const frontmatter = flow.frontmatter ?? EMPTY_FLOW_FRONTMATTER;
  const title = frontmatter.title ?? flow.id;
  const metadataPresent = hasFlowFrontmatter(frontmatter);

  return (
    <article
      className="grid min-w-0 gap-4 rounded-[14px] border border-line bg-paper p-4 transition-colors hover:border-amber lg:grid-cols-[minmax(0,1fr)_minmax(360px,45%)]"
      data-testid="flow-preview-card"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="m-0 text-[16px] font-semibold leading-tight text-ink">
              {title}
            </h4>
            {flow.engine ? (
              <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                {flow.engine}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-mute">
            {flow.id}
          </p>
        </div>

        {frontmatter.summary ? (
          <p className="m-0 max-w-[78ch] text-[13px] leading-[1.45] text-ink-2">
            {frontmatter.summary}
          </p>
        ) : null}

        <div className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
          <FlowPreviewStat
            label={t("viewer.flowNodes")}
            value={flow.nodeCount}
          />
          <FlowPreviewStat
            label={t("viewer.flowGates")}
            value={flow.gateCount}
          />
          <FlowPreviewStat
            label={t("viewer.flowFrontmatter")}
            value={
              metadataPresent
                ? t("viewer.flowFrontmatterYes")
                : t("viewer.flowFrontmatterNo")
            }
          />
        </div>

        <div className="rounded-[10px] border border-line-soft bg-ivory px-3 py-2">
          <div className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
            {t("viewer.flowFrontmatter")}
          </div>
          {metadataPresent ? (
            <div className="flex flex-col gap-2">
              {frontmatter.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {frontmatter.labels.map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-line bg-paper px-2 py-px font-mono text-[10px] text-ink-2"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
              {frontmatter.routeWhen ? (
                <p className="m-0 text-[12px] leading-snug text-ink-2">
                  <span className="font-semibold text-ink">
                    {t("viewer.flowRouteWhen")}:
                  </span>{" "}
                  {frontmatter.routeWhen}
                </p>
              ) : null}
              {frontmatter.links.length > 0 ? (
                <p className="m-0 text-[12px] leading-snug text-ink-2">
                  <span className="font-semibold text-ink">
                    {t("viewer.flowLinks")}:
                  </span>{" "}
                  {frontmatter.links.map((link) => link.title).join(", ")}
                </p>
              ) : null}
              {frontmatter.sources.length > 0 ? (
                <p className="m-0 text-[12px] leading-snug text-ink-2">
                  <span className="font-semibold text-ink">
                    {t("viewer.flowSources")}:
                  </span>{" "}
                  {frontmatter.sources
                    .map((source) => `${source.component} · ${source.origin}`)
                    .join(", ")}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-mute">
              {t("viewer.flowNoFrontmatter")}
            </p>
          )}
        </div>

        <Link
          className="inline-flex w-fit rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
          href={href}
        >
          {labels.view}
        </Link>
      </div>

      <div className="min-w-0">
        {flow.graph && flow.graph.topology.nodes.length > 0 ? (
          <FlowGraphViewSection
            heightClassName="h-[280px]"
            labels={graphLabels}
            layout={flow.graph.layout}
            nodeTooltips={flow.graph.nodeTooltips}
            topology={flow.graph.topology}
          />
        ) : (
          <div className="flex h-[280px] items-center justify-center rounded-[10px] border border-dashed border-line bg-ivory px-4 text-center font-mono text-[11px] text-mute">
            {t("viewer.flowPreviewUnavailable")}
          </div>
        )}
      </div>
    </article>
  );
}

function FlowPreviewStat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): ReactElement {
  return (
    <div className="bg-paper px-3 py-2">
      <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[12px] font-semibold text-ink">
        {value}
      </div>
    </div>
  );
}

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
  graphLabels,
}: {
  pkg: PackageDetailView;
  kind: TabKind;
  start: number;
  end: number;
  basePath: string;
  labels: ElementCardLabels;
  t: TFn;
  graphLabels: FlowGraphViewLabels;
}): ReactNode {
  switch (kind) {
    case "flows":
      return pkg.bom.flows
        .slice(start, end)
        .map((flow) => (
          <FlowPreviewCard
            key={flow.id}
            flow={flow}
            graphLabels={graphLabels}
            href={`${basePath}/flows/${encodeURIComponent(flow.id)}`}
            labels={labels}
            t={t}
          />
        ));
    case "skills":
      return pkg.bom.skills.slice(start, end).map((skill) => (
        <ElementCard
          key={skill.id}
          description={skill.description || null}
          forkPath={skill.path}
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
          refName={pkg.name}
        />
      ));
    case "agents":
      return pkg.bom.platformAgents.slice(start, end).map((agent) => (
        <ElementCard
          key={agent.id}
          description={
            agent.triggers.length > 0
              ? agent.triggers
                  .map((trigger) => t(`viewer.trigger${capitalize(trigger)}`))
                  .join(" · ")
              : t("viewer.agentNoTriggers")
          }
          forkPath={agent.path}
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
          refName={pkg.name}
        />
      ));
    case "subagents":
      return pkg.bom.subagents
        .slice(start, end)
        .map((subagent) => (
          <ElementCard
            key={subagent.id}
            description={
              subagent.description || t("viewer.subagentNoDescription")
            }
            forkPath={subagent.path}
            href={`${basePath}/subagents/${encodeURIComponent(subagent.id)}`}
            labels={labels}
            meta={t("viewer.subagentMeta")}
            name={subagent.id}
            refName={pkg.name}
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
            forkPath={rule.path}
            href={basePath}
            labels={labels}
            meta={`${t("viewer.rulePath")}: ${rule.path}`}
            name={rule.id}
            refName={pkg.name}
          />
        ));
  }
}

// Maps an enum value (`read_only`, `repo_read`, `manual`) to its title-cased key
// suffix (`Read_only`, `Repo_read`, `Manual`) so it joins the `viewer.*` keys.
function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}
