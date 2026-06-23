"use client";

import type { ReactElement } from "react";

import { TaskInlineEditableField } from "@/components/board/task-card-editing";
import { MarkdownBody } from "@/components/social/markdown-body";

export interface TaskDetailPromptEditorProps {
  slug: string;
  taskNumber: number;
  prompt: string;
  canEdit: boolean;
}

export function TaskDetailPromptEditor({
  slug,
  taskNumber,
  prompt,
  canEdit,
}: TaskDetailPromptEditorProps): ReactElement {
  return (
    <TaskInlineEditableField
      multiline
      canEdit={canEdit}
      className="text-[13px] leading-[1.6] text-ink"
      field="prompt"
      renderView={(value) => <MarkdownBody text={value} />}
      slug={slug}
      taskNumber={taskNumber}
      value={prompt}
    />
  );
}
