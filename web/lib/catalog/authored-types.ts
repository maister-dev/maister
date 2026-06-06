import type {
  AuthoredCapabilityKind,
  AuthoredCapabilityLifecycle,
} from "@/lib/db/schema";

export type { AuthoredCapabilityKind, AuthoredCapabilityLifecycle };

export type AuthoredCapabilityBody = Record<string, unknown>;

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
