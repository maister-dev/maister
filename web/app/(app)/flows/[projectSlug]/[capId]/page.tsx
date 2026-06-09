import type { AuthoredCapabilityRevision } from "@/lib/catalog/authored-types";
import type { AuthoredFlowPackageBody } from "@/lib/catalog/authored-types";
import type { FlowEditorTabsLabels } from "@/components/flows/flow-editor-tabs";
import type { FlowGraphEditorLabels } from "@/components/flows/flow-graph-editor";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { stringify as stringifyYaml } from "yaml";

import {
  publishAuthoredFlowAction,
  updateAuthoredFlowAction,
} from "@/app/(app)/flows/actions";
import { FlowEditorTabs } from "@/components/flows/flow-editor-tabs";
import {
  PackageFilesEditor,
  type PackageFilesEditorLabels,
} from "@/components/flows/package-files-editor";
import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { isAuthoredFlowPackageFileKind } from "@/lib/flows/package-authoring";
import { buildAuthoredFlowDiff } from "@/lib/queries/authored-flow-diff";
import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";
import { getProjectBySlug } from "@/lib/queries/project";

type PageProps = {
  params: Promise<{ projectSlug: string; capId: string }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { capId } = await params;
  const t = await getTranslations("flows");

  return { title: t("detailTitle", { id: capId }) };
}

export default async function FlowDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { projectSlug, capId } = await params;
  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(projectSlug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  const canManage = role === "owner" || role === "admin";
  const t = await getTranslations("flows");
  const detail = await getAuthoredCapabilityOrNotFound({ projectSlug, capId });
  const editableRevision = detail.draft ?? detail.published;
  const packageBody = editableRevision
    ? packageBodyFromRevision(editableRevision)
    : null;
  const flowYaml = packageBody?.flowYaml ?? "";
  const packageFiles = packageBody?.files ?? [];
  const isPackageValid = packageBody?.validation.status === "valid";

  // M27/T-A8: server-compile the draft for the canvas + diff (compile is
  // server-only). An invalid/legacy draft that fails to compile falls back to
  // the raw-YAML tab only.
  const editorLabels = buildFlowEditorTabsLabels(
    await getTranslations("flowEditor"),
  );
  const draftManifest = (detail.draft?.manifest ??
    detail.published?.manifest ??
    null) as FlowYamlV1 | null;
  const publishedManifest = (detail.published?.manifest ??
    null) as FlowYamlV1 | null;

  let canvasAvailable = false;
  let topology: GraphTopology | null = null;
  let layout: FlowLayout | null = null;
  let flowDiff = "";

  if (draftManifest) {
    try {
      const graph = buildAuthoredFlowGraph(
        draftManifest,
        detail.capability.draftVersion,
      );

      topology = graph.topology;
      layout = graph.layout;
      flowDiff = buildAuthoredFlowDiff(
        draftManifest,
        publishedManifest,
        detail.capability.draftVersion,
      ).diff;
      canvasAvailable = true;
    } catch {
      canvasAvailable = false;
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <header className="mb-6 grid grid-cols-1 items-end gap-5 border-b border-line pb-6 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <Link
            className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
            href="/flows"
          >
            {t("backToFlows")}
          </Link>
          <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
            {project.name}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
              {detail.capability.slug}
            </h1>
            <StatusPill
              label={t(`lifecycle.${detail.capability.lifecycle}`)}
              value={detail.capability.lifecycle}
            />
          </div>
          <p className="mt-1.5 max-w-[68ch] text-[13.5px] leading-[1.5] text-mute">
            {detail.capability.title}
          </p>
        </div>

        <div className="rounded-xl border border-amber-line bg-amber-soft px-4 py-3 font-mono text-[10.5px] leading-[1.5] text-amber">
          {t("localOnly")}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-xl border border-line bg-paper p-4">
          <form action={updateAuthoredFlowAction}>
            <input name="projectSlug" type="hidden" value={projectSlug} />
            <input name="capId" type="hidden" value={capId} />
            <input
              name="expectedDraftVersion"
              type="hidden"
              value={detail.capability.draftVersion}
            />

            <label className="mb-4 grid gap-1.5">
              <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
                {t("flowTitle")}
              </span>
              <input
                required
                className="rounded-md border border-line bg-ivory px-3 py-2.5 text-[13px] text-ink outline-none focus:border-amber disabled:opacity-70"
                defaultValue={detail.capability.title}
                disabled={!canManage}
                name="title"
              />
            </label>

            <div className="grid gap-1.5">
              <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
                flow.yaml
              </span>
              <FlowEditorTabs
                canvasAvailable={canvasAvailable}
                diff={flowDiff}
                disabled={!canManage}
                draftVersion={detail.capability.draftVersion}
                initialManifest={canvasAvailable ? draftManifest : null}
                initialYaml={flowYaml}
                labels={editorLabels}
                layout={layout}
                topology={topology}
              />
            </div>

            <section className="mt-4">
              <h2 className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
                {t("packageFiles")}
              </h2>
              <PackageFilesEditor
                disabled={!canManage}
                files={packageFiles}
                kindLabels={packageFileKindLabels(t)}
                labels={packageFilesEditorLabels(t)}
              />
            </section>

            {canManage ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
                <p className="m-0 max-w-[60ch] text-[12px] leading-[1.5] text-mute">
                  {t("saveHint")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-md bg-ink px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-paper hover:bg-ink-2"
                    type="submit"
                  >
                    {t("saveDraft")}
                  </button>
                </div>
              </div>
            ) : null}
          </form>

          {canManage && detail.draft ? (
            <form action={publishAuthoredFlowAction} className="mt-3">
              <input name="projectSlug" type="hidden" value={projectSlug} />
              <input name="capId" type="hidden" value={capId} />
              <input
                name="expectedDraftVersion"
                type="hidden"
                value={detail.capability.draftVersion}
              />
              <button
                className="rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-amber hover:bg-paper disabled:opacity-50"
                disabled={!isPackageValid}
                type="submit"
              >
                {t("publishLocal")}
              </button>
            </form>
          ) : null}
        </section>

        <aside className="space-y-4">
          <InfoPanel title={t("metadata")}>
            <InfoRow label={t("project")} value={project.name} />
            <InfoRow
              label={t("packageSlug")}
              value={
                packageBody?.packageMetadata.slug ?? detail.capability.slug
              }
            />
            <InfoRow
              label={t("packageName")}
              value={
                packageBody?.packageMetadata.name ?? detail.capability.title
              }
            />
            <InfoRow
              label={t("packageVersion")}
              value={packageBody?.packageMetadata.versionLabel ?? "none"}
            />
            <InfoRow
              label={t("draftVersion")}
              value={String(detail.capability.draftVersion)}
            />
            <InfoRow
              label={t("currentDraft")}
              value={
                detail.capability.currentDraftRevisionId?.slice(0, 12) ?? "none"
              }
            />
            <InfoRow
              label={t("published")}
              value={
                detail.capability.currentPublishedRevisionId?.slice(0, 12) ??
                "none"
              }
            />
          </InfoPanel>

          <InfoPanel title={t("validationTitle")}>
            <InfoRow
              label={t("validationStatus")}
              value={t(
                `validation.${packageBody?.validation.status ?? "unknown"}`,
              )}
            />
            <InfoRow
              label={t("validationIssues")}
              value={String(packageBody?.validation.issueCount ?? 0)}
            />
          </InfoPanel>

          <InfoPanel title={t("readinessTitle")}>
            <InfoRow
              label={t("publishReadiness")}
              value={
                isPackageValid ? t("readiness.ready") : t("readiness.notReady")
              }
            />
            <InfoRow
              label={t("exportReadiness")}
              value={
                isPackageValid ? t("readiness.ready") : t("readiness.notReady")
              }
            />
          </InfoPanel>

          <InfoPanel title={t("packageFiles")}>
            {packageFiles.length === 0 ? (
              <p className="m-0 font-mono text-[11px] text-mute">
                {t("packageFilesEmpty")}
              </p>
            ) : (
              <ol className="m-0 list-none space-y-2 p-0">
                {packageFiles.map((file) => (
                  <li
                    key={`${file.kind}:${file.path}`}
                    className="rounded-lg border border-line-soft bg-ivory px-3 py-2"
                  >
                    <div className="font-mono text-[11px] font-bold text-ink">
                      {file.path}
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-mute">
                      {t(packageFileKindLabelKey(file.kind))}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </InfoPanel>

          <InfoPanel title={t("revisions")}>
            {detail.revisions.length === 0 ? (
              <p className="m-0 font-mono text-[11px] text-mute">
                {t("noRevisions")}
              </p>
            ) : (
              <ol className="m-0 list-none space-y-2 p-0">
                {detail.revisions.map((revision) => (
                  <li
                    key={revision.id}
                    className="rounded-lg border border-line-soft bg-ivory px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] font-bold text-ink">
                        #{revision.revisionNumber}
                      </span>
                      <StatusPill
                        label={t(`lifecycle.${revision.lifecycle}`)}
                        value={revision.lifecycle}
                      />
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-mute">
                      {revision.contentHash.slice(0, 18)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </InfoPanel>
        </aside>
      </div>
    </div>
  );
}

async function getAuthoredCapabilityOrNotFound(args: {
  projectSlug: string;
  capId: string;
}): ReturnType<typeof getAuthoredCapability> {
  try {
    return await getAuthoredCapability(args);
  } catch (err) {
    if (isMaisterError(err) && err.code === "CONFIG") {
      notFound();
    }

    throw err;
  }
}

function packageBodyFromRevision(
  revision: AuthoredCapabilityRevision,
): AuthoredFlowPackageBody | null {
  const body = revision.body as Partial<AuthoredFlowPackageBody>;

  if (typeof body.flowYaml === "string") {
    return {
      flowYaml: body.flowYaml,
      manifest:
        body.manifest && typeof body.manifest === "object"
          ? body.manifest
          : revision.manifest,
      packageMetadata:
        body.packageMetadata &&
        typeof body.packageMetadata === "object" &&
        typeof body.packageMetadata.slug === "string" &&
        typeof body.packageMetadata.name === "string"
          ? body.packageMetadata
          : { slug: revision.capabilityId, name: revision.title },
      files: Array.isArray(body.files) ? body.files : [],
      validation:
        body.validation &&
        typeof body.validation === "object" &&
        typeof body.validation.status === "string"
          ? body.validation
          : {
              status: "unknown",
              issueCount: 0,
              issues: [],
              manifestDigest: null,
              contentHash: null,
            },
    };
  }

  if (revision.manifest !== null) {
    return {
      flowYaml: stringifyYaml(revision.manifest),
      manifest: revision.manifest,
      packageMetadata: { slug: revision.capabilityId, name: revision.title },
      files: [],
      validation: {
        status: "unknown",
        issueCount: 0,
        issues: [],
        manifestDigest: null,
        contentHash: null,
      },
    };
  }

  return null;
}

function packageFileKindLabelKey(kind: string): string {
  if (isAuthoredFlowPackageFileKind(kind)) {
    return `packageFileKind.${kind}`;
  }

  return "packageFileKind.unsupported";
}

function packageFileKindLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): Record<AuthoredFlowPackageBody["files"][number]["kind"], string> {
  return {
    asset: t("packageFileKind.asset"),
    agent_definition: t("packageFileKind.agent_definition"),
    readme: t("packageFileKind.readme"),
    rule: t("packageFileKind.rule"),
    schema: t("packageFileKind.schema"),
    script: t("packageFileKind.script"),
    setup: t("packageFileKind.setup"),
    skill: t("packageFileKind.skill"),
    template: t("packageFileKind.template"),
  };
}

function packageFilesEditorLabels(
  t: Awaited<ReturnType<typeof getTranslations>>,
): PackageFilesEditorLabels {
  return {
    addFile: t("addPackageFile"),
    content: t("packageFileContent"),
    kind: t("packageFileKindLabel"),
    path: t("packageFilePath"),
    removeFile: t("removePackageFile"),
  };
}

function buildFlowEditorTabsLabels(
  te: Awaited<ReturnType<typeof getTranslations>>,
): FlowEditorTabsLabels {
  const gateKind = {
    command_check: te("toolbar.gateKind.command_check"),
    skill_check: te("toolbar.gateKind.skill_check"),
    ai_judgment: te("toolbar.gateKind.ai_judgment"),
    artifact_required: te("toolbar.gateKind.artifact_required"),
    external_check: te("toolbar.gateKind.external_check"),
    human_review: te("toolbar.gateKind.human_review"),
  };

  const editor: FlowGraphEditorLabels = {
    addNode: te("toolbar.addNode"),
    removeNode: te("toolbar.removeNode"),
    addGate: te("toolbar.addGate"),
    selectNodeHint: te("toolbar.selectNodeHint"),
    nodeType: {
      ai_coding: te("toolbar.nodeType.ai_coding"),
      cli: te("toolbar.nodeType.cli"),
      check: te("toolbar.nodeType.check"),
      judge: te("toolbar.nodeType.judge"),
      human: te("toolbar.nodeType.human"),
    },
    gateKind,
    graph: { title: te("page.graphTab"), empty: "", currentNode: "", node: {} },
    nodeForm: {
      empty: te("nodeForm.empty"),
      action: te("nodeForm.action"),
      settings: te("nodeForm.settings"),
      gates: te("nodeForm.gates"),
      transitions: te("nodeForm.transitions"),
      rework: te("nodeForm.rework"),
      output: te("nodeForm.output"),
      prompt: te("nodeForm.prompt"),
      command: te("nodeForm.command"),
      model: te("nodeForm.model"),
      thinkingEffort: te("nodeForm.thinkingEffort"),
      permissionMode: te("nodeForm.permissionMode"),
      workspaceAccess: te("nodeForm.workspaceAccess"),
      timeoutMs: te("nodeForm.timeoutMs"),
      environmentPolicy: te("nodeForm.environmentPolicy"),
      failureClass: te("nodeForm.failureClass"),
      decisions: te("nodeForm.decisions"),
      criticality: te("nodeForm.criticality"),
      outputSchema: te("nodeForm.outputSchema"),
      outputRequired: te("nodeForm.outputRequired"),
      reworkAllowedTargets: te("nodeForm.reworkAllowedTargets"),
      reworkWorkspacePolicies: te("nodeForm.reworkWorkspacePolicies"),
      reworkMaxLoops: te("nodeForm.reworkMaxLoops"),
      reworkCommentsVar: te("nodeForm.reworkCommentsVar"),
      transitionOutcome: te("nodeForm.transitionOutcome"),
      transitionTarget: te("nodeForm.transitionTarget"),
      addTransition: te("nodeForm.addTransition"),
      removeTransition: te("nodeForm.removeTransition"),
      noTransitions: te("nodeForm.noTransitions"),
      noGates: te("nodeForm.noGates"),
      gate: {
        mode: te("gate.mode"),
        modeBlocking: te("gate.modeBlocking"),
        modeAdvisory: te("gate.modeAdvisory"),
        command: te("gate.command"),
        prompt: te("gate.prompt"),
        skill: te("gate.skill"),
        confidenceMin: te("gate.confidenceMin"),
        externalDescription: te("gate.externalDescription"),
        staleOnNewCommit: te("gate.staleOnNewCommit"),
        remove: te("gate.remove"),
        kind: gateKind,
      },
    },
    validation: {
      valid: te("validation.valid"),
      title: te("validation.title"),
    },
  };

  return {
    graphTab: te("page.graphTab"),
    yamlTab: te("page.yamlTab"),
    diffTab: te("page.diffTab"),
    diffEmpty: te("diff.empty"),
    editor,
  };
}

function InfoPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-xl border border-line bg-paper p-4">
      <h2 className="m-0 mb-3 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="border-t border-line-soft py-2 first:border-t-0 first:pt-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
        {label}
      </dt>
      <dd className="m-0 break-all font-mono text-[11.5px] font-semibold text-ink-2">
        {value}
      </dd>
    </div>
  );
}

function StatusPill({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  const muted = value === "ARCHIVED";

  return (
    <span
      className={
        muted
          ? "shrink-0 rounded-full border border-line bg-paper px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-mute"
          : "shrink-0 rounded-full border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-amber"
      }
    >
      {label}
    </span>
  );
}
