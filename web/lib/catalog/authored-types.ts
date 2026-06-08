import type {
  AuthoredCapabilityKind,
  AuthoredCapabilityLifecycle,
} from "@/lib/db/schema";

export type { AuthoredCapabilityKind, AuthoredCapabilityLifecycle };

export type AuthoredCapabilityBody = Record<string, unknown>;

export type AuthoredFlowPackageFileKind =
  | "asset"
  | "skill"
  | "rule"
  | "script"
  | "agent_definition"
  | "schema"
  | "template"
  | "readme"
  | "setup";

export type AuthoredFlowPackageFile = {
  kind: AuthoredFlowPackageFileKind;
  path: string;
  content: string;
};

export type AuthoredFlowPackageMetadata = {
  slug: string;
  name: string;
  description?: string;
  versionLabel?: string;
};

export type AuthoredFlowPackageValidationIssueCode =
  | "yaml_parse"
  | "schema"
  | "graph"
  | "unsafe_path"
  | "duplicate_path"
  | "path_conflict"
  | "unsupported_kind"
  | "binary_content";

export type AuthoredFlowPackageValidationIssue = {
  code: AuthoredFlowPackageValidationIssueCode;
  path: string;
  message: string;
};

export type AuthoredFlowPackageValidation = {
  status: "valid" | "invalid" | "unknown";
  issueCount: number;
  issues: AuthoredFlowPackageValidationIssue[];
  manifestDigest: string | null;
  contentHash: string | null;
};

export type AuthoredFlowPackageBody = {
  flowYaml: string;
  manifest: AuthoredCapabilityBody | null;
  packageMetadata: AuthoredFlowPackageMetadata;
  files: AuthoredFlowPackageFile[];
  validation: AuthoredFlowPackageValidation;
};

export type AuthoredCapability = {
  id: string;
  projectId: string;
  kind: AuthoredCapabilityKind;
  slug: string;
  title: string;
  lifecycle: AuthoredCapabilityLifecycle;
  draftVersion: number;
  currentDraftRevisionId: string | null;
  currentPublishedRevisionId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthoredCapabilityRevision = {
  id: string;
  capabilityId: string;
  projectId: string;
  kind: AuthoredCapabilityKind;
  revisionNumber: number;
  lifecycle: AuthoredCapabilityLifecycle;
  draftVersion: number;
  title: string;
  body: AuthoredCapabilityBody;
  manifest: AuthoredCapabilityBody | null;
  schemaVersion: number;
  contentHash: string;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
};

export type AuthoredCapabilityDetail = {
  capability: AuthoredCapability;
  draft: AuthoredCapabilityRevision | null;
  published: AuthoredCapabilityRevision | null;
  revisions: AuthoredCapabilityRevision[];
};

export type CreateAuthoredCapabilityInput = {
  kind: AuthoredCapabilityKind;
  slug: string;
  title: string;
  body?: AuthoredCapabilityBody;
  manifest?: AuthoredCapabilityBody | null;
  schemaVersion?: number;
};

export type UpdateAuthoredDraftInput = {
  title?: string;
  body?: AuthoredCapabilityBody;
  manifest?: AuthoredCapabilityBody | null;
  schemaVersion?: number;
  expectedDraftVersion: number;
};
