export const CONFIG_PERSIST_STATES = [
  "previewed",
  "preparing",
  "prepared",
  "publishing",
  "committed",
  "noop",
  "stale",
  "failed",
  "recovery_required",
] as const;

export const CONFIG_PUSH_STATES = [
  "previewed",
  "pending",
  "succeeded",
  "failed",
  "unknown",
  "stale",
] as const;

export type ConfigPersistState = (typeof CONFIG_PERSIST_STATES)[number];
export type ConfigPushState = (typeof CONFIG_PUSH_STATES)[number];

export type ExportPackage = {
  id: string;
  source: string;
  version: string;
  path?: string;
  resolvedRevision: string;
};

export type ExportProjection = {
  name: string;
  mainBranch: string;
  branchPrefix: string;
  publicBranchTemplate: string;
  defaultRunnerId: string | null;
  promotionMode: string | null;
  packages: ExportPackage[];
};

export type ConfigRepositorySnapshot = {
  repoPath: string;
  commonDirectory: string;
  branch: string;
  head: string | null;
  manifestDigest: string | null;
  manifestMode: string | null;
  indexEntries: string;
  status: string;
  authorName: string;
  authorEmail: string;
  usedDefaultAuthor: boolean;
  configDigest?: string;
};

export type ConfigPersistSnapshot = {
  version: 1;
  projectId: string;
  actorUserId: string;
  exportRevision: string;
  projection: ExportProjection;
  repository: ConfigRepositorySnapshot;
  proposedDigest: string;
  diffDigest: string;
  contentDirectory: string;
  message: string;
};

export type ConfigPushSnapshot = {
  version: 1;
  operationId: string;
  commitSha: string;
  destination: string;
  destinationFingerprint: string;
  remoteBase: string | null;
  outgoingShas: string[];
};
