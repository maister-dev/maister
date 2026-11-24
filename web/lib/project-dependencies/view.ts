import type { ProjectDependencyKind } from "./types";

export interface ProjectDependencyView {
  id: string;
  kind: ProjectDependencyKind;
  ref: string;
  generation: number;
  source: string;
  version: string;
  path: string | null;
  attempt: number | null;
  state:
    "pending" | "running" | "succeeded" | "failed" | "recovery_required" | null;
  stage: string | null;
  reason: string | null;
  effectiveAttachmentId: string | null;
  effectiveRevision: string | null;
  resolvedRevision: string | null;
  memberRef: string | null;
  readiness:
    | "unresolved"
    | "awaiting_trust"
    | "setup_pending"
    | "setup_failed"
    | "recovery_required"
    | "installed";
  actions: { edit: boolean; retry: boolean; recoverSetup: boolean };
}

export interface AttemptReceipt {
  declarationId: string;
  generation: number;
  attempt: number;
}
