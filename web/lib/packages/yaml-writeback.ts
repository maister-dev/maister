import "server-only";

import { stringify } from "yaml";

import { maisterYamlV2Schema } from "@/lib/config.schema";
import { DEFAULT_PUBLIC_BRANCH_TEMPLATE } from "@/lib/workbench-git/public-branch-name";

export type PackagesPinEntry = {
  id: string;
  source: string;
  version: string;
  path?: string;
};

export type SerializeProjectInput = {
  name: string;
  mainBranch: string;
  branchPrefix: string;
  // ADR-181: absent = the column default, like an absent YAML key.
  publicBranchTemplate?: string;
  taskQualificationOverride?: "legacy" | "required" | null;
  defaultRunnerId: string | null;
  promotionMode: string | null;
};

export type SerializeProjectAttachments = {
  flows?: { id: string; source: string; version: string; runner?: string }[];
  packages?: { id: string; source: string; version: string; path?: string }[];
};

// ADR-093: render a DB-only project's config to a complete, schema-valid
// maister.yaml v2 for initial configuration. Defaults are omitted for a clean file;
// the result is round-tripped through maisterYamlV2Schema before returning.
export function serializeProjectConfig(
  project: SerializeProjectInput,
  attachments?: SerializeProjectAttachments,
): string {
  const projectBlock: Record<string, unknown> = { name: project.name };

  if (project.mainBranch !== "main") {
    projectBlock.main_branch = project.mainBranch;
  }
  if (project.branchPrefix !== "maister/") {
    projectBlock.branch_prefix = project.branchPrefix;
  }
  if (
    project.publicBranchTemplate !== undefined &&
    project.publicBranchTemplate !== DEFAULT_PUBLIC_BRANCH_TEMPLATE
  ) {
    projectBlock.public_branch_template = project.publicBranchTemplate;
  }
  if (project.taskQualificationOverride) {
    projectBlock.task_qualification = project.taskQualificationOverride;
  }
  if (project.defaultRunnerId) {
    projectBlock.default_runner = project.defaultRunnerId;
  }
  if (project.promotionMode) {
    projectBlock.promotion = { mode: project.promotionMode };
  }

  const doc: Record<string, unknown> = {
    schemaVersion: 2,
    project: projectBlock,
    flows: attachments?.flows ?? [],
  };

  if (attachments?.packages && attachments.packages.length > 0) {
    doc.packages = attachments.packages;
  }

  // Self-check: fail loudly here rather than write an invalid manifest.
  maisterYamlV2Schema.parse(doc);

  return stringify(doc);
}
