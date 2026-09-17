"use client";

import type { ReactElement } from "react";

import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

import { MarkdownBody } from "@/components/social/markdown-body";
import { markdownExcerpt } from "@/lib/markdown-excerpt";

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
    <div className="flex min-w-0 flex-col gap-1 font-mono text-[11px] leading-[1.45] tracking-[0.01em] text-mute">
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
