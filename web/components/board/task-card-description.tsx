"use client";

import type { ReactElement } from "react";

import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

import { TaskInlineEditableField } from "@/components/board/task-card-editing";
import { MarkdownBody } from "@/components/social/markdown-body";
import { markdownExcerpt } from "@/lib/markdown-excerpt";

export interface TaskCardDescriptionProps {
  slug: string;
  taskNumber: number;
  prompt: string;
  canEdit: boolean;
}

export function CollapsibleDescription({
  text,
}: {
  text: string;
}): ReactElement {
  const tBoard = useTranslations("board");
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const excerpt = useMemo(() => markdownExcerpt(text), [text]);

  if (!excerpt.truncated) return <MarkdownBody text={text} variant="compact" />;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div id={bodyId}>
        {expanded ? (
          <MarkdownBody text={text} variant="compact" />
        ) : (
          <p className="min-w-0 break-words [overflow-wrap:anywhere]">
            {excerpt.text}
          </p>
        )}
      </div>
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="inline-flex w-fit items-center gap-1 rounded font-mono text-[10px] tracking-[0.04em] text-mute transition hover:text-amber focus:text-amber"
        type="button"
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? (
          <ChevronUpIcon className="h-3.5 w-3.5" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5" />
        )}
        {expanded ? tBoard("descriptionCollapse") : tBoard("descriptionExpand")}
      </button>
    </div>
  );
}

export function TaskCardDescription({
  slug,
  taskNumber,
  prompt,
  canEdit,
}: TaskCardDescriptionProps): ReactElement {
  return (
    <TaskInlineEditableField
      multiline
      canEdit={canEdit}
      className="font-mono text-[11px] leading-[1.45] tracking-[0.01em] text-mute"
      field="prompt"
      // `renderView` is invoked inside TaskInlineEditableField's render body,
      // and that component returns early while editing. A hook called here
      // would register as one of ITS hooks and be skipped on the editing
      // render — React then throws "Rendered fewer hooks than expected" the
      // moment the edit pencil is clicked. Construct an element and nothing
      // else; every hook lives inside CollapsibleDescription.
      renderView={(value) => <CollapsibleDescription text={value} />}
      slug={slug}
      taskNumber={taskNumber}
      value={prompt}
    />
  );
}
