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

type ExportPackage<Revision extends string | null> = {
  id: string;
  source: string;
  version: string;
  path?: string;
  resolvedRevision: Revision;
};

export type ExportProjection<Revision extends string | null = string | null> = {
  name: string;
  mainBranch: string;
  branchPrefix: string;
  publicBranchTemplate: string;
  taskQualificationOverride?: "legacy" | "required" | null;
  defaultRunnerId: string | null;
  promotionMode: string | null;
  packages: ExportPackage<Revision>[];
};

export type ConfigRepositorySnapshot = {
  repoPath: string;
  commonDirectory: string;
  branch: string;
  head: string | null;
  manifestDigest: string | null;
  manifestMode: string | null;
  /** Base64 of Git-quoted ASCII index entries; delimiters and arbitrary path bytes are lossless. */
  indexEntries: string;
  status: string;
  authorName: string;
  authorEmail: string;
  usedDefaultAuthor: boolean;
  configDigest?: string;
  signingRequired?: boolean;
};

export type LocalPackageWitness = { id: string; digest: string };

export type ConfigPersistSnapshot = (
  | { version: 1; projection: ExportProjection<string> }
  | {
      version: 2;
      projection: ExportProjection;
      localWitnesses: LocalPackageWitness[];
    }
) & {
  projectId: string;
  actorUserId: string;
  exportRevision: string;
  registeredRepoPath: string;
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
  url: string;
  policyDigest: string;
  originalHook: string | null;
  hookDigest: string | null;
  contentDirectory: string;
  gateDigest: string;
  gateFiles: Record<"gate.cjs" | "pre-push", string>;
};
