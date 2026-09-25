import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";
import type { WorkbenchRunStatus } from "@/lib/workbench-lifecycle/policy";
import type { HitlAnswerState } from "@/lib/hitl-response-contract";

import { deriveWorkbenchLifecycleActions } from "@/lib/workbench-lifecycle/policy";
import {
  resolveHitlErrorMessage,
  type HitlErrorMessage,
} from "@/lib/ui-error-message";

// Client-safe scratch-detail shapes + pure status helpers shared by the
// scratch conversation, composer, and permission-panel components (M35 T3.2).
// No server-only imports — this module is consumed by client components.

export type ScratchDialogStatus =
  | "Starting"
  | "WaitingForUser"
  | "Running"
  | "NeedsInput"
  | "Review"
  | "Crashed"
  | "Done"
  | "Abandoned";

export type AttachmentKind = "issue_url" | "file_path" | "text_note";
export type StoredAttachmentKind = AttachmentKind | "uploaded_file";

export type ScratchMessage = {
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  // ADR-182: how a user row reached the agent (null on older and non-user rows).
  delivery?: ScratchMessageDelivery | null;
};

export type ScratchMessageDelivery = "queued" | "prompted" | "steered";

export type ScratchAttachment = {
  id: string;
  runId: string;
  messageId: string | null;
  kind: StoredAttachmentKind;
  label: string | null;
  value: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  artifactRef: string | null;
};

export type HitlOption = {
  optionId: string;
  label: string;
};

export type ScratchDetail = {
  run: {
    id: string;
    projectId: string | null;
    projectSlug: string | null;
    capabilityAgent: AdapterId | null;
    runnerSnapshot: { capabilityAgent: AdapterId } | null;
    status: WorkbenchRunStatus;
    currentStepId: string | null;
    startedAt: string;
    endedAt: string | null;
    createdByDisplayName: string | null;
  };
  scratch: {
    name: string | null;
    workMode: "auto" | "plan_first" | "manual_approval";
    reasoningEffort: "low" | "high" | "extra" | "ultra";
    planMode: "off" | "plan-first";
    linkedIssueUrl: string | null;
    baseBranch: string;
    baseCommit: string;
    targetBranch: string | null;
    dialogStatus: ScratchDialogStatus;
    errorCode: string | null;
    errorMessage: string | null;
  };
  workspace: {
    id?: string;
    branch: string;
    removedAt: string | null;
  } | null;
  messages: ScratchMessage[];
  attachments: ScratchAttachment[];
  pendingHitl: {
    hitlRequestId: string;
    kind: "permission" | "form" | "human";
    prompt: string;
    schema: unknown;
    options: HitlOption[];
    answerState: "open" | "answer_stored";
    storedResponse:
      | { optionId: string }
      | { response: unknown; confidence?: number }
      | null;
  } | null;
  capabilityProfile: {
    selectedMcpIds: string[];
    selectedSkillIds: string[];
    selectedRuleIds: string[];
    restrictions: Record<string, unknown>;
    downgradeNotes: Record<string, unknown> | null;
  } | null;
};

export type ComposerAttachment = {
  kind: AttachmentKind;
  label: string;
  value: string;
};

export type ApiError = {
  code?: string;
  message?: string;
  details?: { reason?: string; causeCode?: string };
};

export function errorText(payload: ApiError | null): string {
  void payload;

  return "errorGeneric";
}

export function hitlErrorText(
  payload: ApiError | null,
  answerState: HitlAnswerState,
): HitlErrorMessage {
  return resolveHitlErrorMessage({
    code: payload?.code,
    details: payload?.details,
    surface: "scratch",
    answerState,
  });
}

export function canSend(status: ScratchDialogStatus): boolean {
  return status === "WaitingForUser";
}

// ADR-182 D-D1: a project scratch dialog accepts a message while its agent is
// busy — the server steers it into the running turn or queues it.
export function canSendWhileBusy(status: ScratchDialogStatus): boolean {
  return status === "Running" || status === "Starting";
}

// A crashed run can be resumed by typing a message (routes Send to /recover,
// which respawns + resumes via session/resume). Attachments/files stay
// message-only.
export function canRecover(status: ScratchDialogStatus): boolean {
  return status === "Crashed";
}

export function canCompose(status: ScratchDialogStatus): boolean {
  return canSend(status) || canRecover(status);
}

export function lifecycleActionsForScratchDetail(
  detail: ScratchDetail,
): WorkbenchLifecycleActionId[] {
  return deriveWorkbenchLifecycleActions({
    runKind: "scratch",
    runStatus: detail.run.status,
    scratchDialogStatus: detail.scratch.dialogStatus,
    hasWorkspace: detail.workspace !== null,
    workspaceRemoved: detail.workspace?.removedAt !== null,
    workspaceArchived: false,
    // ADR-160: a scratch run can never hold a rework claim (flow-only).
    claimOwnerUserId: null,
    viewerUserId: null,
  })
    .filter((action) => action.enabled)
    .map((action) => action.id);
}

export function attachmentSummary(attachment: ScratchAttachment): string {
  if (attachment.kind === "uploaded_file") {
    const hash = attachment.sha256 ? attachment.sha256.slice(0, 10) : "";

    return `${attachment.fileName ?? attachment.label ?? "file"} · ${
      attachment.mimeType ?? "application/octet-stream"
    } · ${attachment.byteSize ?? 0} bytes${hash ? ` · ${hash}` : ""}`;
  }

  return attachment.label
    ? `${attachment.label}: ${attachment.value}`
    : attachment.value;
}
