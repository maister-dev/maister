import type { FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import type { FlowNodeInspectorLabels } from "@/components/studio/flow-node-inspector";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import { StudioFlowViewer } from "@/components/studio/studio-flow-viewer";
import { requireSession } from "@/lib/authz";
import { buildNodeSideFormLabels } from "@/lib/flows/node-side-form-labels";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";
import { getStudioFlowDetail } from "@/lib/studio/flow-detail";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

// Read-only flow-graph labels (same `workbench.graph.*` namespace as the run
// layout). The static viewer never overlays run status; the node-status map is
// supplied for parity with the run-coupled view.
function buildGraphLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): FlowGraphViewLabels {
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

type PageProps = { params: Promise<{ ref: string; flowId: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { flowId } = await params;

  return { title: decodeURIComponent(flowId) };
}

export default async function StudioFlowDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { ref, flowId: rawFlowId } = await params;
  const decodedRef = decodeURIComponent(ref);
  const flowId = decodeURIComponent(rawFlowId);

  const user = await requireSession();
  const resolution = await resolveStudioPackageByRef(
    user.id,
    user.role,
    decodedRef,
  );

  if (resolution.status === "not-found") notFound();

  const t = await getTranslations("studio");
  const packageHref = `/studio/packages/${encodeURIComponent(decodedRef)}`;

  if (resolution.status === "ambiguous") {
    // Same collision surface as the package detail page — pick the source first.
    notFound();
  }

  const detail = await getStudioFlowDetail(resolution.installId, flowId);

  if (!detail || detail.flowYaml === null) {
    if (!detail || detail.compiled === null) {
      // Unknown flow id / missing bundle → 404 (the BOM never linked here).
      notFound();
    }
  }

  const tWorkbench = await getTranslations("workbench");
  const tEditor = await getTranslations("flowEditor");

  const inspectorLabels: FlowNodeInspectorLabels = {
    listTitle: t("viewer.flowNodesTitle"),
    listHint: t("viewer.flowNodeListHint"),
    inspectorTitle: t("viewer.nodeInspectorTitle"),
    readOnlyNotice: t("viewer.readOnlyNotice"),
    nodeForm: buildNodeSideFormLabels(tEditor),
  };

  const compiled = detail?.compiled ?? null;
  const graphAvailable = Boolean(
    compiled && compiled.topology.nodes.length > 0,
  );
  // Edit = fork-to-local (installed packages are immutable). Surface it only to
  // catalog managers, mirroring the package-detail gate.
  const projects = await getAccessibleProjects(user.id, user.role);
  const canManage = projects.some((project) => project.canManageCatalog);

  return (
    <div className="w-full">
      <Link
        className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
        href={packageHref}
      >
        {t("viewer.backToPackage")}
      </Link>

      <header className="mb-6">
        <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {decodedRef} · {t("viewer.flowDetailTitle")}
        </div>
        <h1 className="m-0 text-[26px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {flowId}
        </h1>
      </header>

      <StudioFlowViewer
        flowYaml={detail?.flowYaml ?? null}
        forkRef={canManage ? decodedRef : undefined}
        graphAvailable={graphAvailable}
        graphLabels={buildGraphLabels(tWorkbench)}
        graphTitle={t("viewer.flowGraphTitle")}
        graphUnavailableLabel={t("viewer.flowGraphUnavailable")}
        inspectorLabels={inspectorLabels}
        layout={compiled?.layout ?? null}
        nodes={compiled?.nodes ?? []}
        topology={compiled?.topology ?? null}
        yamlTitle={t("viewer.flowYamlTitle")}
      />
    </div>
  );
}
