import type { AuthoredCapabilityRevision } from "@/lib/catalog/authored-types";
import type { AuthoredFlowPackageBody } from "@/lib/catalog/authored-types";
import type { ArtifactContentIssuesLabels } from "@/components/flows/editor-validation-summary";
import type { FlowEditorTabsLabels } from "@/components/flows/flow-editor-tabs";
import type { FlowGraphEditorLabels } from "@/components/flows/flow-graph-editor";
import type { FormSchemaBuilderLabels } from "@/components/flows/artifact-editors/form-schema-builder";
import type { FrontmatterArtifactEditorLabels } from "@/components/flows/artifact-editors/frontmatter-artifact-editor";
import type { ScriptArtifactEditorLabels } from "@/components/flows/artifact-editors/script-artifact-editor";
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
import {
  PackageFilesEditor,
  type PackageFilesEditorLabels,
} from "@/components/flows/package-files-editor";
import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
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
  te: Awaited<ReturnType<typeof getTranslations>>,
): PackageFilesEditorLabels {
  return {
    addFile: t("addPackageFile"),
    cancel: t("packageFilePathEdit.cancel"),
    content: t("packageFileContent"),
    editPathTitle: t("packageFilePathEdit.title"),
    kind: t("packageFileKindLabel"),
    noFiles: t("packageFilesEmpty"),
    path: t("packageFilePath"),
    pathError: {
      unsafe_path: t("packageFilePathEdit.error.unsafe_path"),
      duplicate_path: t("packageFilePathEdit.error.duplicate_path"),
      path_conflict: t("packageFilePathEdit.error.path_conflict"),
    },
    removeFile: t("removePackageFile"),
    renamePath: t("packageFilePathEdit.rename"),
    save: t("packageFilePathEdit.save"),
    frontmatter: frontmatterArtifactEditorLabels(te),
    script: scriptArtifactEditorLabels(te),
    formSchema: formSchemaBuilderLabels(te),
    contentIssues: artifactContentIssuesLabels(te),
  };
}

function frontmatterArtifactEditorLabels(
  te: Awaited<ReturnType<typeof getTranslations>>,
): FrontmatterArtifactEditorLabels {
  return {
    frontmatterHeading: te("artifacts.frontmatterHeading"),
    bodyHeading: te("artifacts.bodyHeading"),
    name: te("artifacts.name"),
    description: te("artifacts.description"),
    agentWorkspace: te("artifacts.agentWorkspace"),
    agentWorkspaceRef: te("artifacts.agentWorkspaceRef"),
    agentMode: te("artifacts.agentMode"),
    agentTriggers: te("artifacts.agentTriggers"),
    agentRiskTier: te("artifacts.agentRiskTier"),
    agentRunner: te("artifacts.agentRunner"),
    agentRecommendedHeading: te("artifacts.agentRecommendedHeading"),
    agentRecommendedRunner: te("artifacts.agentRecommendedRunner"),
    agentRecommendedCronExpr: te("artifacts.agentRecommendedCronExpr"),
    agentRecommendedCronTz: te("artifacts.agentRecommendedCronTz"),
    agentRecommendedEvents: te("artifacts.agentRecommendedEvents"),
    allowedPaths: te("artifacts.allowedPaths"),
    forbiddenPaths: te("artifacts.forbiddenPaths"),
    allowedCommands: te("artifacts.allowedCommands"),
    requireStructuredResponse: te("artifacts.requireStructuredResponse"),
    listHint: te("artifacts.listHint"),
    guardrailNotice: te("artifacts.guardrailNotice"),
    malformedNotice: te("artifacts.malformedNotice"),
    rawHeading: te("artifacts.rawHeading"),
  };
}

function scriptArtifactEditorLabels(
  te: Awaited<ReturnType<typeof getTranslations>>,
): ScriptArtifactEditorLabels {
  return {
    editorAriaLabel: te("artifacts.scriptEditorAriaLabel"),
    trustBannerTitle: te("artifacts.scriptTrustBannerTitle"),
    trustBanner: te("artifacts.scriptTrustBanner"),
  };
}

function formSchemaBuilderLabels(
  te: Awaited<ReturnType<typeof getTranslations>>,
): FormSchemaBuilderLabels {
  return {
    builderTab: te("artifacts.formSchema.builderTab"),
    jsonTab: te("artifacts.formSchema.jsonTab"),
    previewHeading: te("artifacts.formSchema.previewHeading"),
    fieldName: te("artifacts.formSchema.fieldName"),
    fieldLabel: te("artifacts.formSchema.fieldLabel"),
    fieldType: te("artifacts.formSchema.fieldType"),
    fieldRequired: te("artifacts.formSchema.fieldRequired"),
    fieldOptions: te("artifacts.formSchema.fieldOptions"),
    addField: te("artifacts.formSchema.addField"),
    addNestedField: te("artifacts.formSchema.addNestedField"),
    removeField: te("artifacts.formSchema.removeField"),
    moveUp: te("artifacts.formSchema.moveUp"),
    moveDown: te("artifacts.formSchema.moveDown"),
    invalidJson: te("artifacts.formSchema.invalidJson"),
    noFields: te("artifacts.formSchema.noFields"),
    type: {
      string: te("artifacts.formSchema.type.string"),
      number: te("artifacts.formSchema.type.number"),
      boolean: te("artifacts.formSchema.type.boolean"),
      enum: te("artifacts.formSchema.type.enum"),
      array: te("artifacts.formSchema.type.array"),
      object: te("artifacts.formSchema.type.object"),
    },
    preview: {
      criticalityLabel: te("artifacts.formSchema.preview.criticalityLabel"),
      "criticality.low": te("artifacts.formSchema.preview.criticality.low"),
      "criticality.medium": te(
        "artifacts.formSchema.preview.criticality.medium",
      ),
      "criticality.high": te("artifacts.formSchema.preview.criticality.high"),
      "criticality.critical": te(
        "artifacts.formSchema.preview.criticality.critical",
      ),
      confidenceLabel: te("artifacts.formSchema.preview.confidenceLabel"),
      reviewComments: te("artifacts.formSchema.preview.reviewComments"),
      decisionApprove: te("artifacts.formSchema.preview.decisionApprove"),
      decisionRework: te("artifacts.formSchema.preview.decisionRework"),
      sendBackWithComments: te(
        "artifacts.formSchema.preview.sendBackWithComments",
      ),
      responseLabel: te("artifacts.formSchema.preview.responseLabel"),
      responseHint: te("artifacts.formSchema.preview.responseHint"),
      schemaLabel: te("artifacts.formSchema.preview.schemaLabel"),
      submit: te("artifacts.formSchema.preview.submit"),
      reviewCommentsPlaceholder: te(
        "artifacts.formSchema.preview.reviewCommentsPlaceholder",
      ),
      formInstructions: te("artifacts.formSchema.preview.formInstructions"),
      formCustomPlaceholder: te(
        "artifacts.formSchema.preview.formCustomPlaceholder",
      ),
    },
  };
}

function artifactContentIssuesLabels(
  te: Awaited<ReturnType<typeof getTranslations>>,
): ArtifactContentIssuesLabels {
  return {
    clean: te("artifacts.contentIssues.clean"),
    blockTitle: te("artifacts.contentIssues.blockTitle"),
    warnTitle: te("artifacts.contentIssues.warnTitle"),
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
      skills: te("nodeForm.skills"),
      restrictions: te("nodeForm.restrictions"),
      mcps: te("nodeForm.mcps"),
      enforcement: {
        title: te("nodeForm.enforcement.title"),
        mcps: te("nodeForm.enforcement.mcps"),
        tools: te("nodeForm.enforcement.tools"),
        skills: te("nodeForm.enforcement.skills"),
        restrictions: te("nodeForm.enforcement.restrictions"),
        permissionMode: te("nodeForm.enforcement.permissionMode"),
        workspaceAccess: te("nodeForm.enforcement.workspaceAccess"),
      },
      timeoutMs: te("nodeForm.timeoutMs"),
      environmentPolicy: te("nodeForm.environmentPolicy"),
      failureClass: te("nodeForm.failureClass"),
      decisions: te("nodeForm.decisions"),
      criticality: te("nodeForm.criticality"),
      roles: te("nodeForm.roles"),
      assignees: te("nodeForm.assignees"),
      allowTakeover: te("nodeForm.allowTakeover"),
      outputSchema: te("nodeForm.outputSchema"),
      outputRequired: te("nodeForm.outputRequired"),
      presentation: te("nodeForm.presentation"),
      presentationWidth: te("nodeForm.presentationWidth"),
      presentationHeight: te("nodeForm.presentationHeight"),
      presentationColor: te("nodeForm.presentationColor"),
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
    edgeModal: {
      title: te("edgeModal.title"),
      outcome: te("edgeModal.outcome"),
      suggestionsHint: te("edgeModal.suggestionsHint"),
      freeTextHint: te("edgeModal.freeTextHint"),
      retargetWarning: te("edgeModal.retargetWarning"),
      confirm: te("edgeModal.confirm"),
      cancel: te("edgeModal.cancel"),
      suggestion: {
        success: te("edgeModal.suggestion.success"),
        failure: te("edgeModal.suggestion.failure"),
        rework: te("edgeModal.suggestion.rework"),
        takeover: te("edgeModal.suggestion.takeover"),
      },
    },
    toggleProperties: te("toggleProperties"),
  };

  return {
    diffEmpty: te("diff.empty"),
    syncError: te("page.syncError"),
    topBar: {
      save: te("topBar.save"),
      publish: te("topBar.publish"),
      valid: te("topBar.valid"),
      issues: te("topBar.issues"),
      ready: te("topBar.ready"),
      notReady: te("topBar.notReady"),
      titleLabel: te("topBar.titleLabel"),
      graph: te("drawer.graph"),
      files: te("drawer.files"),
      yaml: te("drawer.yaml"),
      diff: te("drawer.diff"),
    },
    editor,
  };
}
