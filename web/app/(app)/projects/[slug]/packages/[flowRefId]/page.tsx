import type { FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import type {
  FlowPackageDetail,
  FlowRevisionDetail,
} from "@/lib/queries/flow-packages";
import type { ReactElement } from "react";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";
import { FlowRunnerReconfigurationControl } from "@/components/board/panels/flow-runner-reconfiguration-control";
import {
  CodeEditor,
  type CodeEditorKind,
} from "@/components/flows/code-editor";
import { FlowYamlDisclosure } from "@/components/flows/flow-yaml-disclosure";
import {
  PackageForkButton,
  type ForkButtonLabels,
} from "@/components/flows/package-fork-button";
import {
  PackageBundleMissingNotice,
  PackageFileView,
  PackageViewerHeader,
  type PackageFileReadState,
  type PackageFileViewLabels,
  type PackageViewerHeaderLabels,
} from "@/components/flows/package-viewer";
import {
  getProjectRole,
  getSessionUser,
  requireProjectAction,
} from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildFlowNodeTooltipsFromManifest } from "@/lib/flows/graph/node-tooltips";
import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
} from "@/lib/flows/package-content";
import {
  presentationLayout,
  type FlowLayout,
} from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { getFlowPackageDetail } from "@/lib/queries/flow-packages";
import { getProjectPackageAttachments } from "@/lib/queries/packages";
import { getFlowRunnerBindingScope } from "@/lib/queries/project";

interface PageProps {
  params: Promise<{ slug: string; flowRefId: string }>;
  searchParams: Promise<{
    rev?: string | string[];
    file?: string | string[];
  }>;
}

function firstParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

// The flow-graph view labels: reuse the `workbench.graph.*` namespace (same as
// the run layout). The static viewer never overlays run status, so the `node`
// status map only needs the keys the renderer reads when present — supplied for
// parity with the run-coupled view.
function buildGraphLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): FlowGraphViewLabels {
  return {
    title: t("graph.title"),
    empty: t("graph.empty"),
    currentNode: t("graph.currentNode"),
    sessionChip: t("graph.sessionChip"),
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

// Compile the stored manifest into a static topology + presentation layout. A
// compile THROW (a malformed/legacy manifest) degrades to yaml-only with a
// notice — it MUST NOT 500 the page (expectation 8.1.4).
function buildStaticGraph(revision: FlowRevisionDetail): {
  topology: ReturnType<typeof buildGraphTopology>;
  layout: FlowLayout;
  nodeTooltips: Record<string, string>;
} | null {
  try {
    return {
      topology: buildGraphTopology(compileManifest(revision.manifest)),
      layout: presentationLayout(revision.manifest),
      nodeTooltips: buildFlowNodeTooltipsFromManifest(revision.manifest),
    };
  } catch {
    return null;
  }
}

export default async function FlowPackageViewerPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { slug, flowRefId } = await params;
  const { rev: rawRev, file: rawFile } = await searchParams;

  const user = await getSessionUser();

  if (!user) notFound();

  const detail: FlowPackageDetail | null = await getFlowPackageDetail(
    slug,
    flowRefId,
  );

  if (!detail) notFound();

  // `readRepoFiles` (member) gates every disk read (§4.1, §6.5). The authz call
  // is the boundary; map a denial to notFound() so existence stays hidden from
  // under-privileged users (board/observatory convention).
  try {
    await requireProjectAction(detail.project.id, "readRepoFiles");
  } catch (err) {
    // requireProjectAction → requireActiveSession can throw the session-state
    // codes too; map every authz denial to notFound() rather than a 500.
    if (
      isMaisterError(err) &&
      (err.code === "UNAUTHORIZED" ||
        err.code === "UNAUTHENTICATED" ||
        err.code === "ACCOUNT_INACTIVE" ||
        err.code === "PASSWORD_CHANGE_REQUIRED")
    ) {
      notFound();
    }
    throw err;
  }

  // Fork slot (T2.3) is gated on manageCatalog; the route, not this flag, is the
  // real boundary. Global admins are implicit owners.
  const role =
    user.role === "admin"
      ? "owner"
      : await getProjectRole(user.id, detail.project.id);
  const canManageCatalog = role === "owner" || role === "admin";

  // Revision selection: `?rev=<id>` must belong to THIS flow+project (the query
  // already source-scoped the list); a foreign/unknown id → notFound. Default =
  // the flow's enabled revision, else the most-recently-installed.
  const requestedRev = firstParam(rawRev);
  let revision: FlowRevisionDetail | undefined;

  if (requestedRev) {
    revision = detail.revisions.find((r) => r.id === requestedRev);
    if (!revision) notFound();
  } else {
    revision =
      detail.revisions.find((r) => r.id === detail.flow.enabledRevisionId) ??
      detail.revisions.at(-1);
  }

  if (!revision) notFound();

  const t = await getTranslations("packages");
  const tViewer = await getTranslations("packages.viewer");
  const tWorkbench = await getTranslations("workbench");
  const tStudio = await getTranslations("studio");

  const headerLabels: PackageViewerHeaderLabels = {
    versionLabel: t("versionLabel"),
    resolvedRevision: t("revisionLabel"),
    enablement: t("state"),
    trust: t("trust"),
    execTrust: tViewer("execTrust"),
    trustUntrusted: t("untrusted"),
    trustTrusted: t("trusted"),
    trustTrustedByPolicy: t("trustedByPolicy"),
    execUntrusted: tViewer("execUntrusted"),
    execTrusted: tViewer("execTrusted"),
  };

  const fileLabels: PackageFileViewLabels = {
    binary: tViewer("fileBinary"),
    tooLarge: tViewer("fileTooLarge"),
    notFound: tViewer("fileNotFound"),
    bundleMissing: tViewer("fileBundleMissing"),
    emptyPrompt: tViewer("fileEmptyPrompt"),
  };

  const forkLabels: ForkButtonLabels = {
    fork: tViewer("fork.fork"),
    pending: tViewer("fork.pending"),
    errorConflict: tViewer("fork.errorConflict"),
    errorConfig: tViewer("fork.errorConfig"),
    errorUnauthorized: tViewer("fork.errorUnauthorized"),
    errorGeneric: tViewer("fork.errorGeneric"),
  };

  const staticGraph = buildStaticGraph(revision);

  // Disk reads: server-side ONLY, off the resolved `installedPath` (never the
  // DTO). The bundle dir being gone degrades gracefully (8.1.3).
  const listing = await listInstalledPackageFiles({
    installedPath: revision.installedPath,
  });

  const selectedFilePath = firstParam(rawFile);
  let selectedFile: PackageFileReadState | null = null;

  if (selectedFilePath) {
    const read = await readInstalledPackageFile(
      { installedPath: revision.installedPath },
      selectedFilePath,
    );

    selectedFile =
      read.state === "text"
        ? {
            state: "text",
            content: read.content ?? "",
            kind: read.kind ?? "asset",
          }
        : { state: read.state };
  }

  const dto = detail.dto;

  // M42 (ADR-114): per-flow connect-time runner-slot bindings — scoped to the
  // ENABLED revision (what launch resolves + the PATCH route validates against).
  // Admin/owner-only (binding is an `editSettings` action).
  const enabledRevisionId = detail.flow.enabledRevisionId ?? null;
  const bindingScope =
    canManageCatalog && enabledRevisionId
      ? await getFlowRunnerBindingScope(detail.project.id, enabledRevisionId)
      : null;

  // The package that owns this flow (its name is the Studio package ref), used
  // to deep-link into the Studio flow viewer. Resolved from the project's
  // attachments by which package's manifest declares this flow id.
  const attachments = await getProjectPackageAttachments(detail.project.id);
  const studioPackageName =
    attachments.find((att) => att.flows.includes(flowRefId))?.packageName ??
    null;
  const studioFlowHref = studioPackageName
    ? `/studio/packages/${encodeURIComponent(studioPackageName)}/flows/${encodeURIComponent(flowRefId)}`
    : null;

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          className="inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
          href={`/projects/${slug}?tab=packages`}
        >
          {tViewer("backToPackages")}
        </Link>
        {studioFlowHref ? (
          <Link
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
            data-testid="open-flow-in-studio"
            href={studioFlowHref}
          >
            {tStudio("openInStudio")}
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </div>

      <PackageViewerHeader
        enablementState={dto.enablementState}
        execTrust={revision.execTrust}
        flowRef={dto.ref}
        labels={headerLabels}
        resolvedRevision={revision.resolvedRevision}
        trustStatus={dto.trustStatus}
        versionLabel={revision.versionLabel}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <section>
            <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
              {tViewer("graphTitle")}
            </h2>
            {staticGraph && staticGraph.topology.nodes.length > 0 ? (
              <FlowGraphViewSection
                labels={buildGraphLabels(tWorkbench)}
                layout={staticGraph.layout}
                nodeTooltips={staticGraph.nodeTooltips}
                topology={staticGraph.topology}
              />
            ) : (
              <p
                className="rounded-lg border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute"
                data-testid="package-graph-unavailable"
              >
                {staticGraph
                  ? tViewer("graphEmpty")
                  : tViewer("graphUnavailable")}
              </p>
            )}
          </section>

          {listing.bundleMissing ? (
            <section>
              <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
                {tViewer("flowYamlTitle")}
              </h2>
              <PackageBundleMissingNotice message={tViewer("bundleMissing")} />
            </section>
          ) : (
            <>
              <section>
                {listing.flowYaml !== null ? (
                  <FlowYamlDisclosure
                    ariaLabel={tViewer("flowYamlTitle")}
                    title={tViewer("flowYamlTitle")}
                    value={listing.flowYaml}
                  />
                ) : (
                  <>
                    <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
                      {tViewer("flowYamlTitle")}
                    </h2>
                    <PackageBundleMissingNotice
                      message={tViewer("fileNotFound")}
                    />
                  </>
                )}
              </section>

              <section>
                <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
                  {tViewer("filesTitle")}
                </h2>
                {listing.files.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
                    {tViewer("filesEmpty")}
                  </p>
                ) : (
                  <ul
                    className="mb-4 flex flex-col gap-1.5"
                    data-testid="package-file-list"
                  >
                    {listing.files.map((file) => {
                      const isSelected = file.path === selectedFilePath;

                      return (
                        <li key={file.path}>
                          <Link
                            aria-current={isSelected ? "true" : undefined}
                            className={
                              isSelected
                                ? "flex items-center justify-between gap-3 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-ink"
                                : "flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-ivory px-3 py-2 font-mono text-[11px] text-ink-2 hover:border-line"
                            }
                            href={`/projects/${slug}/packages/${flowRefId}?rev=${revision.id}&file=${encodeURIComponent(file.path)}`}
                          >
                            <span className="truncate">{file.path}</span>
                            <span className="shrink-0 rounded-full border border-line bg-paper px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-mute">
                              {file.kind}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <PackageFileView
                  editor={
                    selectedFile?.state === "text" ? (
                      <CodeEditor
                        readOnly
                        ariaLabel={selectedFilePath ?? undefined}
                        kind={selectedFile.kind as CodeEditorKind}
                        value={selectedFile.content}
                      />
                    ) : undefined
                  }
                  labels={fileLabels}
                  relPath={selectedFilePath}
                  state={selectedFile}
                />
              </section>
            </>
          )}
        </div>

        <aside className="space-y-4">
          {bindingScope ? (
            <div data-testid="package-runner-bindings">
              <FlowRunnerReconfigurationControl
                allResolvedLabel={tViewer("runnerBindingAllResolved")}
                heading={tViewer("runnerBindingTitle")}
                hint={tViewer("runnerBindingHint")}
                projectSlug={slug}
                remaps={bindingScope.remaps}
                runners={bindingScope.runners}
                slotLabels={bindingScope.slotLabels}
              />
            </div>
          ) : null}

          {canManageCatalog ? (
            <section
              className="rounded-xl border border-amber-line bg-amber-soft p-4"
              data-testid="package-fork-slot"
            >
              <h2 className="m-0 mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-amber">
                {tViewer("forkToEdit")}
              </h2>
              <p className="m-0 mb-3 font-mono text-[10.5px] leading-[1.5] text-amber">
                {tViewer("forkHint")}
              </p>
              <PackageForkButton
                flowRefId={flowRefId}
                labels={forkLabels}
                projectSlug={slug}
                revisionId={revision.id}
              />
            </section>
          ) : null}

          <section className="rounded-xl border border-line bg-paper p-4">
            <h2 className="m-0 mb-3 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink">
              {tViewer("revisionsTitle")}
            </h2>
            <ol className="m-0 list-none space-y-2 p-0">
              {dto.revisions.map((r) => {
                const isCurrent = r.id === revision.id;
                const isEnabled = r.id === dto.enabledRevisionId;

                return (
                  <li key={r.id}>
                    <Link
                      aria-current={isCurrent ? "true" : undefined}
                      className={
                        isCurrent
                          ? "block rounded-lg border border-amber-line bg-amber-soft px-3 py-2"
                          : "block rounded-lg border border-line-soft bg-ivory px-3 py-2 hover:border-line"
                      }
                      href={`/projects/${slug}/packages/${flowRefId}?rev=${r.id}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-bold text-ink">
                          {r.versionLabel}
                        </span>
                        {isEnabled ? (
                          <span className="shrink-0 rounded-full border border-amber-line bg-paper px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-amber">
                            {tViewer("revisionEnabled")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-[10px] text-mute">
                        {r.resolvedRevision.slice(0, 12)}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
