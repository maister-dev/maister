import "server-only";

import type {
  ScratchAttachmentKind,
  ScratchDialogStatus,
  ScratchMessageRole,
  ScratchPlanMode,
  ScratchReasoningEffort,
  ScratchWorkMode,
} from "@/lib/db/schema";

import { z } from "zod";

export const scratchPlanModeSchema = z.enum(["off", "plan-first"]);
export const scratchWorkModeSchema = z.enum([
  "auto",
  "plan_first",
  "manual_approval",
]);
export const scratchReasoningEffortSchema = z.enum([
  "low",
  "high",
  "extra",
  "ultra",
]);

export const scratchAttachmentInputSchema = z.object({
  kind: z.enum(["issue_url", "file_path", "text_note"]),
  label: z.string().max(200).optional(),
  value: z.string().min(1).max(20_000),
});
const optionalNonEmptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().min(1).max(255).optional(),
);

export const scratchLaunchInputSchema = z
  .object({
    projectId: z.string().uuid(),
    baseBranch: z.string().min(1).max(255),
    branchName: optionalNonEmptyString,
    name: z.string().max(200).optional(),
    executorId: z.string().uuid(),
    workMode: scratchWorkModeSchema.optional(),
    reasoningEffort: scratchReasoningEffortSchema.default("high"),
    planMode: scratchPlanModeSchema.optional(),
    prompt: z.string().min(1).max(60_000),
    linkedTaskId: z.string().uuid().optional(),
    linkedIssueUrl: z.string().url().max(2048).optional(),
    attachments: z.array(scratchAttachmentInputSchema).max(20).default([]),
    capabilities: z
      .object({
        mcpIds: z.array(z.string().min(1)).optional(),
        skillIds: z.array(z.string().min(1)).optional(),
        ruleIds: z.array(z.string().min(1)).optional(),
        agentDefinitionIds: z.array(z.string().min(1)).optional(),
        restrictionIds: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  })
  .strict();

export const scratchMessageInputSchema = z
  .object({
    content: z.string().min(1).max(60_000),
    attachments: z.array(scratchAttachmentInputSchema).max(20).default([]),
  })
  .strict();

export type ScratchAttachmentInput = {
  kind: Exclude<ScratchAttachmentKind, "uploaded_file">;
  label?: string;
  value: string;
};
export type ScratchUploadedFileInput = {
  fileName: string;
  mimeType: string;
  byteSize: number;
  bytes: Uint8Array;
};
export type StoredScratchAttachment = {
  kind: ScratchAttachmentKind;
  label: string | null;
  value: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  storagePath: string | null;
};

export type ScratchLaunchInput = z.infer<typeof scratchLaunchInputSchema>;
export type ScratchMessageInput = z.infer<typeof scratchMessageInputSchema>;

export type ScratchMessageDraft = {
  sequence: number;
  role: ScratchMessageRole;
  content: string;
  supervisorEventId?: string;
};

export type ScratchRunState = {
  runId: string;
  runStatus: string;
  dialogStatus: ScratchDialogStatus;
  supervisorSessionId: string | null;
};

export type PromptPolicy = {
  planMode: ScratchPlanMode;
  workMode?: ScratchWorkMode;
  reasoningEffort?: ScratchReasoningEffort;
  prompt: string;
};
