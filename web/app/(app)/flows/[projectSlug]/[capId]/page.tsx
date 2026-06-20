import type { AuthoredCapabilityRevision } from "@/lib/catalog/authored-types";
import type { AuthoredFlowPackageBody } from "@/lib/catalog/authored-types";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { stringify as stringifyYaml } from "yaml";

import {
  publishAuthoredFlowAction,
  updateAuthoredFlowAction,
} from "@/app/(app)/flows/actions";
import { FlowEditorTabs } from "@/components/flows/flow-editor-tabs";
import { PackageFilesEditor } from "@/components/flows/package-files-editor";
import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import {
  buildFlowEditorTabsLabels,
  packageFileKindLabels,
  packageFilesEditorLabels,
} from "@/lib/flows/editor/editor-labels";
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
  const te = await getTranslations("flowEditor");
  const editorLabels = buildFlowEditorTabsLabels(te);
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
    <div className="flex h-[calc(100vh-200px)] min-h-[560px] w-full flex-col">
      <FlowEditorTabs
        canManage={canManage}
        canvasAvailable={canvasAvailable}
        capId={capId}
        diff={flowDiff}
        draftVersion={detail.capability.draftVersion}
        filesDrawer={
          <PackageFilesEditor
            disabled={!canManage}
            files={packageFiles}
            kindLabels={packageFileKindLabels(t)}
            labels={packageFilesEditorLabels(t, te)}
            manifest={(draftManifest as Record<string, unknown> | null) ?? null}
          />
        }
        hasDraft={detail.draft !== null}
        identity={{
          project: project.name,
          slug: detail.capability.slug,
          kind: "flow",
        }}
        initialManifest={canvasAvailable ? draftManifest : null}
        initialTitle={detail.capability.title}
        initialYaml={flowYaml}
        labels={editorLabels}
        layout={layout}
        lifecycleLabel={t(`lifecycle.${detail.capability.lifecycle}`)}
        projectSlug={projectSlug}
        publishAction={publishAuthoredFlowAction}
        readinessReady={isPackageValid}
        saveAction={updateAuthoredFlowAction}
        topology={topology}
      />
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
