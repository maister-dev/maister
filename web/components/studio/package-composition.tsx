"use client";

import type { PackageBom } from "@/lib/queries/package-bom";
import type { CompositionKind } from "@/lib/local-packages/composition";
import type { ReactElement, ReactNode } from "react";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  buildGraphLabels,
  FlowPreviewCard,
} from "@/components/studio/package-detail";
import { ElementCard } from "@/components/studio/element-card";
import {
  PackageTabs,
  type PackageTabDescriptor,
} from "@/components/studio/package-tabs";
import {
  COMPOSITION_TAB_IDS,
  compositionCounts,
  compositionTabHref,
  flowCanvasHref,
  inlineSelectHref,
  resolveCompositionTab,
  skillScreenHref,
  type CompositionTabId,
} from "@/lib/local-packages/composition";

const TAB_LABEL_KEY: Record<CompositionTabId, string> = {
  flows: "viewer.tabFlows",
  skills: "viewer.tabSkills",
  subagents: "viewer.tabSubagents",
  agents: "viewer.tabAgents",
  mcps: "viewer.tabMcps",
  rules: "viewer.tabRules",
  files: "viewer.tabFiles",
};

// The tabbed-by-kind composition landing for the local-package editor (ADR-115).
// Reuses the installed viewer's PackageTabs + ElementCard + FlowPreviewCard over
// the local BOM. Flows route to the canvas, skills to a dedicated screen, the
// remaining kinds open inline (master-detail). Files is always present and hosts
// the file-manager (`filesEditor` slot, owned by the parent which holds the draft).
export function PackageComposition({
  packageId,
  name,
  bom,
  fileCount,
  readOnly,
  filesEditor,
  inlineDetail,
}: {
  packageId: string;
  name: string;
  bom: PackageBom;
  fileCount: number;
  readOnly: boolean;
  // The Files-tab content (the parent owns the editable draft + its editor).
  filesEditor: ReactNode;
  // The inline editor panel for the selected element (Phase 3). When omitted, a
  // read-only summary of the selected element is shown.
  inlineDetail?: ReactNode;
}): ReactElement {
  const t = useTranslations("studio");
  const tWorkbench = useTranslations("workbench");
  const searchParams = useSearchParams();

  const counts = compositionCounts(bom);
  const activeTab = resolveCompositionTab(searchParams.get("tab"), bom);
  const selectedId = searchParams.get("sel");

  const tabs: PackageTabDescriptor[] = COMPOSITION_TAB_IDS.map((id) => ({
    id,
    label: t(TAB_LABEL_KEY[id]),
    count: id === "files" ? fileCount : counts[id as CompositionKind],
  }));

  const totalForActive =
    activeTab === "files" ? fileCount : counts[activeTab as CompositionKind];

  const cardLabels = {
    view: t("viewer.view"),
    fork: t("viewer.fork"),
    forkPhase2Hint: t("viewer.forkPhase2Hint"),
  };

  const cards = buildCompositionCards({
    packageId,
    activeTab,
    bom,
    cardLabels,
    filesEditor,
    inlineDetail,
    selectedId,
    readOnly,
    t,
    graphLabels: buildGraphLabels(tWorkbench),
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto rounded-xl border border-line bg-paper p-4"
      data-testid="package-composition"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[16px] font-semibold text-ink">{name}</h2>
        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
          {t("localBadge")}
        </span>
      </header>

      <PackageTabs
        activeTab={activeTab}
        cards={cards}
        hrefFor={(tab) =>
          compositionTabHref(packageId, tab as CompositionTabId)
        }
        labels={{
          loadMore: t("viewer.loadMore"),
          next: t("viewer.pageNext"),
          page: t("viewer.page"),
          paginationLabel: t("viewer.paginationLabel"),
          previous: t("viewer.pagePrev"),
          showingCount: t.raw("viewer.showingCount"),
          tabEmpty: t("viewer.tabEmpty"),
        }}
        layout={activeTab === "skills" ? "grid" : "stack"}
        page={1}
        pageSize={PACKAGE_TAB_PAGE_SIZE_LOCAL}
        tabs={tabs}
        totalForActive={totalForActive}
      />
    </div>
  );
}

// Local composition has small N — render every member (no pagination).
const PACKAGE_TAB_PAGE_SIZE_LOCAL = 10_000;

type TFn = ReturnType<typeof useTranslations>;

function buildCompositionCards({
  packageId,
  activeTab,
  bom,
  cardLabels,
  filesEditor,
  inlineDetail,
  selectedId,
  readOnly,
  t,
  graphLabels,
}: {
  packageId: string;
  activeTab: CompositionTabId;
  bom: PackageBom;
  cardLabels: { view: string; fork: string; forkPhase2Hint: string };
  filesEditor: ReactNode;
  inlineDetail?: ReactNode;
  selectedId: string | null;
  readOnly: boolean;
  t: TFn;
  graphLabels: ReturnType<typeof buildGraphLabels>;
}): ReactNode {
  switch (activeTab) {
    case "files":
      return (
        <div data-readonly={readOnly} data-testid="composition-files">
          {filesEditor}
        </div>
      );
    case "flows":
      return bom.flows.map((flow) => (
        <FlowPreviewCard
          key={flow.id}
          flow={flow}
          graphLabels={graphLabels}
          href={flowCanvasHref(packageId, flow.path)}
          t={t}
        />
      ));
    case "skills":
      return bom.skills.map((skill) => (
        <ElementCard
          key={skill.id}
          description={skill.description || null}
          href={skillScreenHref(packageId, skill.id)}
          labels={cardLabels}
          meta={t("viewer.skillMeta", {
            files: skill.fileCount,
            subfolders: skill.subfolderCount,
          })}
          name={skill.id}
        />
      ));
    default:
      return (
        <InlineMasterDetail
          bom={bom}
          cardLabels={cardLabels}
          inlineDetail={inlineDetail}
          kind={activeTab}
          packageId={packageId}
          selectedId={selectedId}
          t={t}
        />
      );
  }
}

// Card-list + side editor for the inline kinds (subagents / agents / mcps /
// rules). The card list links to `?sel=`; the detail panel renders the parent's
// `inlineDetail` slot (the real editor, Phase 3) or a read-only summary.
function InlineMasterDetail({
  packageId,
  kind,
  bom,
  selectedId,
  cardLabels,
  inlineDetail,
  t,
}: {
  packageId: string;
  kind: CompositionKind;
  bom: PackageBom;
  selectedId: string | null;
  cardLabels: { view: string; fork: string; forkPhase2Hint: string };
  inlineDetail?: ReactNode;
  t: TFn;
}): ReactElement {
  const items = inlineItems(kind, bom, t);

  return (
    <div
      className="grid gap-3 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]"
      data-testid="composition-master-detail"
    >
      <div className="flex flex-col gap-2" data-testid="composition-card-list">
        {items.map((item) => (
          <ElementCard
            key={item.id}
            description={item.description}
            href={inlineSelectHref(packageId, kind, item.id)}
            labels={cardLabels}
            meta={item.meta}
            name={item.id}
          />
        ))}
      </div>
      <div
        className="min-h-0 rounded-[12px] border border-line bg-ivory p-3"
        data-testid="composition-inline-detail"
      >
        {inlineDetail ??
          (selectedId ? (
            <InlineSummary
              item={items.find((i) => i.id === selectedId)}
              selectedId={selectedId}
              t={t}
            />
          ) : (
            <p className="m-0 font-mono text-[11px] text-mute">
              {t("composition.selectHint")}
            </p>
          ))}
      </div>
    </div>
  );
}

type InlineItem = {
  id: string;
  description: string | null;
  meta: string | null;
};

function inlineItems(
  kind: CompositionKind,
  bom: PackageBom,
  t: TFn,
): InlineItem[] {
  switch (kind) {
    case "subagents":
      return bom.subagents.map((s) => ({
        id: s.id,
        description: s.description || t("viewer.subagentNoDescription"),
        meta: s.path,
      }));
    case "agents":
      return bom.platformAgents.map((a) => ({
        id: a.id,
        description: a.description || null,
        meta: a.path,
      }));
    case "mcps":
      return bom.mcps.map((m) => ({ id: m.id, description: null, meta: null }));
    case "rules":
      return bom.rules.map((r) => ({
        id: r.id,
        description: null,
        meta: r.path,
      }));
    default:
      return [];
  }
}

function InlineSummary({
  item,
  selectedId,
  t,
}: {
  item: InlineItem | undefined;
  selectedId: string;
  t: TFn;
}): ReactElement {
  if (!item) {
    return (
      <p className="m-0 font-mono text-[11px] text-mute">
        {t("composition.notFound")}
      </p>
    );
  }

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="composition-inline-summary"
    >
      <h3 className="m-0 text-[14px] font-semibold text-ink">{selectedId}</h3>
      {item.description ? (
        <p className="m-0 text-[12px] leading-[1.45] text-ink-2">
          {item.description}
        </p>
      ) : null}
      {item.meta ? (
        <p className="m-0 font-mono text-[11px] text-mute">{item.meta}</p>
      ) : null}
    </div>
  );
}
