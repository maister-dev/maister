import "server-only";

import type {
  ScratchAttachmentKind,
  ScratchDialogStatus,
  ScratchMessageRole,
  ScratchPlanMode,
} from "@/lib/db/schema";

import { z } from "zod";

export const scratchPlanModeSchema = z.enum(["off", "plan-first"]);

export const scratchAttachmentInputSchema = z.object({
  kind: z.enum(["issue_url", "file_path", "text_note"]),
  label: z.string().max(200).optional(),
  value: z.string().min(1).max(20_000),
});

export const scratchLaunchInputSchema = z
  .object({
    projectId: z.string().uuid(),
    baseBranch: z.string().min(1).max(255),
    branchName: z.string().min(1).max(255),
    name: z.string().max(200).optional(),
    executorId: z.string().uuid(),
    planMode: scratchPlanModeSchema,
    prompt: z.string().min(1).max(60_000),
    linkedTaskId: z.string().uuid().optional(),
    linkedIssueUrl: z.string().url().max(2048).optional(),
    attachments: z.array(scratchAttachmentInputSchema).max(20).default([]),
    capabilities: z
      .object({
        mcpIds: z.array(z.string().min(1)).optional(),
        skillIds: z.array(z.string().min(1)).optional(),
        ruleIds: z.array(z.string().min(1)).optional(),
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
  kind: ScratchAttachmentKind;
  label?: string;
  value: string;
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
  prompt: string;
};
