import type { ArtifactContentIssuesLabels } from "@/components/flows/editor-validation-summary";
import type { FlowEditorTabsLabels } from "@/components/flows/flow-editor-tabs";
import type { FlowGraphEditorLabels } from "@/components/flows/flow-graph-editor";
import type { FormSchemaBuilderLabels } from "@/components/flows/artifact-editors/form-schema-builder";
import type { FrontmatterArtifactEditorLabels } from "@/components/flows/artifact-editors/frontmatter-artifact-editor";
import type { McpTemplateEditorLabels } from "@/components/flows/artifact-editors/mcp-template-editor";
import type { ScriptArtifactEditorLabels } from "@/components/flows/artifact-editors/script-artifact-editor";
import type { AuthoredFlowPackageFileKind } from "@/lib/catalog/authored-types";
import type { PackageManifestFormLabels } from "@/lib/local-packages/manifest";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { LocalPackageDiffLabels } from "@/components/studio/local-package-diff-drawer";
import type { ChangeReviewDialogLabels } from "@/components/studio/change-review-dialog";
import type { DiffViewLabels } from "@/components/workbench/diff-view";

import { buildNodeSideFormLabels } from "@/lib/flows/node-side-form-labels";

// Shared label builders for the flow editor surfaces, reused by the authored-flow
// editor page and the local-package editor page (M36). Each takes a next-intl
// translator (`t` for the `flows` namespace, `te` for `flowEditor`) so it is
// framework-agnostic and callable from either an RSC or a client boundary.
type T = (key: string, values?: Record<string, string | number>) => string;

// The shared <DiffView> labels, from the `workbench.diff` namespace (`td`). The
// M36 local-package git-diff drawer reuses the run-diff renderer verbatim.
export function diffViewLabels(td: T): DiffViewLabels {
  return {
    empty: td("empty"),
    bodyUnavailable: td("bodyUnavailable"),
    added: td("added"),
    removed: td("removed"),
    displayMode: td("displayMode"),
    rich: td("rich"),
    raw: td("raw"),
    filterFiles: td("filterFiles"),
    filterFilesPlaceholder: td("filterFilesPlaceholder"),
    filterNoMatches: td("filterNoMatches"),
    showFiles: td("showFiles"),
    hideFiles: td("hideFiles"),
    refresh: td("refresh"),
    viewMode: td("viewMode"),
    split: td("split"),
    unified: td("unified"),
    truncated: td("truncated"),
  };
}

// The git-diff drawer's commit/discard top-bar labels (`studio.local.diff`).
export function localPackageDiffLabels(tld: T): LocalPackageDiffLabels {
  return {
    title: tld("title"),
    changed: tld("changed"),
    clean: tld("clean"),
    error: tld("error"),
    commit: tld("commit"),
    commitMessagePlaceholder: tld("commitMessagePlaceholder"),
    discard: tld("discard"),
    discardConfirm: tld("discardConfirm"),
    committing: tld("committing"),
    discarding: tld("discarding"),
    committed: tld("committed"),
    discarded: tld("discarded"),
    actionFailed: tld("actionFailed"),
  };
}

// The shared change-review/commit modal labels (`studio.local.changeReview.*`).
// Lives here (server-safe) rather than in the `"use client"` dialog module,
// because the editor page (an RSC) calls it during render — a function exported
// from a client module is a client reference and throws when called server-side.
export function buildChangeReviewLabels(t: T): ChangeReviewDialogLabels {
  return {
    title: t("local.changeReview.title"),
    changed: t("local.changeReview.changed"),
    clean: t("local.changeReview.clean"),
    loadError: t("local.changeReview.loadError"),
    messageLabel: t("local.changeReview.messageLabel"),
    messagePlaceholder: t("local.changeReview.messagePlaceholder"),
    commit: t("local.changeReview.commit"),
    committing: t("local.changeReview.committing"),
    cancel: t("local.changeReview.cancel"),
    invalidTitle: t("local.changeReview.invalidTitle"),
  };
}

export function packageFileKindLabels(
  t: T,
): Record<AuthoredFlowPackageFileKind, string> {
  return {
    asset: t("packageFileKind.asset"),
    agent_definition: t("packageFileKind.agent_definition"),
    manifest: t("packageFileKind.manifest"),
    readme: t("packageFileKind.readme"),
    rule: t("packageFileKind.rule"),
    schema: t("packageFileKind.schema"),
    script: t("packageFileKind.script"),
    setup: t("packageFileKind.setup"),
    skill: t("packageFileKind.skill"),
    subagent: t("packageFileKind.subagent"),
    template: t("packageFileKind.template"),
  };
}

export function frontmatterArtifactEditorLabels(
  te: T,
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
    agentCapabilityProfile: te("artifacts.agentCapabilityProfile"),
    agentCapabilityProfileInvalid: te(
      "artifacts.agentCapabilityProfileInvalid",
    ),
    allowedPaths: te("artifacts.allowedPaths"),
    forbiddenPaths: te("artifacts.forbiddenPaths"),
    allowedCommands: te("artifacts.allowedCommands"),
    requireStructuredResponse: te("artifacts.requireStructuredResponse"),
    listHint: te("artifacts.listHint"),
    guardrailNotice: te("artifacts.guardrailNotice"),
    malformedNotice: te("artifacts.malformedNotice"),
    rawHeading: te("artifacts.rawHeading"),
    agentSchemaWarning: te("artifacts.agentSchemaWarning"),
    subagentSchemaWarning: te("artifacts.subagentSchemaWarning"),
  };
}

export function scriptArtifactEditorLabels(te: T): ScriptArtifactEditorLabels {
  return {
    editorAriaLabel: te("artifacts.scriptEditorAriaLabel"),
    trustBannerTitle: te("artifacts.scriptTrustBannerTitle"),
    trustBanner: te("artifacts.scriptTrustBanner"),
  };
}

export function mcpTemplateEditorLabels(te: T): McpTemplateEditorLabels {
  return {
    prefillHeading: te("artifacts.mcp.prefillHeading"),
    prefillHint: te("artifacts.mcp.prefillHint"),
    catalogLabel: te("artifacts.mcp.catalogLabel"),
    catalogPlaceholder: te("artifacts.mcp.catalogPlaceholder"),
    catalogEmpty: te("artifacts.mcp.catalogEmpty"),
    apply: te("artifacts.mcp.apply"),
    secretNotice: te("artifacts.mcp.secretNotice"),
    rawHeading: te("artifacts.mcp.rawHeading"),
    invalidNotice: te("artifacts.mcp.invalidNotice"),
  };
}

export function formSchemaBuilderLabels(te: T): FormSchemaBuilderLabels {
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

export function artifactContentIssuesLabels(
  te: T,
): ArtifactContentIssuesLabels {
  return {
    clean: te("artifacts.contentIssues.clean"),
    blockTitle: te("artifacts.contentIssues.blockTitle"),
    warnTitle: te("artifacts.contentIssues.warnTitle"),
  };
}

// `t` = `flows` namespace, `te` = `flowEditor`. `includeMcp` adds the MCP
// template surface labels (the local-package editor wires the `mcps/` surface).
export function packageFilesEditorLabels(
  t: T,
  te: T,
  includeMcp = false,
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
    manifest: manifestFormLabels(t),
    ...(includeMcp ? { mcp: mcpTemplateEditorLabels(te) } : {}),
  };
}

// The `maister-package.yaml` form labels (`flows.manifestForm.*`). ADR-105.
export function manifestFormLabels(t: T): PackageManifestFormLabels {
  return {
    heading: t("manifestForm.heading"),
    name: t("manifestForm.name"),
    displayTitle: t("manifestForm.displayTitle"),
    summary: t("manifestForm.summary"),
    flows: t("manifestForm.flows"),
    capabilities: t("manifestForm.capabilities"),
    mcps: t("manifestForm.mcps"),
    restrictions: t("manifestForm.restrictions"),
    formMode: t("manifestForm.formMode"),
    rawMode: t("manifestForm.rawMode"),
    parseError: t("manifestForm.parseError"),
    empty: t("manifestForm.empty"),
  };
}

export function buildFlowEditorTabsLabels(te: T): FlowEditorTabsLabels {
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
      orchestrator: te("toolbar.nodeType.orchestrator"),
      cli: te("toolbar.nodeType.cli"),
      check: te("toolbar.nodeType.check"),
      judge: te("toolbar.nodeType.judge"),
      consensus: te("toolbar.nodeType.consensus"),
      human: te("toolbar.nodeType.human"),
      form: te("toolbar.nodeType.form"),
    },
    gateKind,
    graph: { title: te("page.graphTab"), empty: "", currentNode: "", node: {} },
    nodeForm: buildNodeSideFormLabels(te),
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
