export const dependencyKinds = [
  "package",
  "flow",
  "capability_import",
] as const;
export type ProjectDependencyKind = (typeof dependencyKinds)[number];

export type ProjectDependencyPin = {
  source: string;
  version: string;
  path?: string;
  runner?: string;
  trust?: "explicit";
  roleRefs?: string[];
  capabilityRefIds?: {
    mcp: string[];
    skill: string[];
    restriction: string[];
    setting: string[];
  };
};

export type ProjectDependencyInput = {
  kind: ProjectDependencyKind;
  logicalId: string;
  ordinal: number;
  desired: ProjectDependencyPin;
};

export const dependencyAttemptStatuses = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "recovery_required",
] as const;

export const dependencyStages = [
  "resolve",
  "install",
  "attach",
  "setup",
  "projection",
] as const;

export type DependencyCheckpoint = {
  retryCount?: number;
  installId?: string;
  contentWitness?: string;
  setupMaterialKey?: string;
};
