import "server-only";

import type { RepoBlobResult } from "@/lib/worktree";
import type { ReactElement } from "react";

import pino from "pino";

import {
  isMarkdownRichPath,
  MarkdownRichView,
} from "@/components/workbench/markdown-rich-view";
import { highlightToHtml, langFromPath } from "@/lib/highlight/shiki";

const log = pino({
  name: "code-view",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface CodeViewLabels {
  tooLarge: string;
  binary: string;
  empty: string;
  notFound?: string;
}

export interface CodeViewProps {
  blob: RepoBlobResult;
  labels: CodeViewLabels;
  path?: string;
}

const STATE_CLASS =
  "rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute";

export async function CodeView({
  blob,
  labels,
  path,
}: CodeViewProps): Promise<ReactElement> {
  switch (blob.kind) {
    case "text": {
      if (blob.content === "") {
        return (
          <div className={STATE_CLASS} data-testid="file-empty">
            {labels.empty}
          </div>
        );
      }

      if (path && isMarkdownRichPath(path)) {
        return <MarkdownRichView path={path} source={blob.content} />;
      }

      const lang = langFromPath(path ?? "");

      log.debug(
        { lang, byteLen: Buffer.byteLength(blob.content, "utf8") },
        "code-view render",
      );

      const html = await highlightToHtml(blob.content, lang);

      return (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          className="code-view max-h-[480px] overflow-auto rounded-[8px] border border-line bg-paper text-[12px]"
          data-line-numbers=""
          data-testid="code-view"
        />
      );
    }
    case "too-large":
      return (
        <div className={STATE_CLASS} data-testid="file-too-large">
          {labels.tooLarge} ({blob.size} bytes)
        </div>
      );
    case "binary":
      return (
        <div className={STATE_CLASS} data-testid="file-binary">
          {labels.binary}
        </div>
      );
    case "not-found":
      return (
        <div className={STATE_CLASS} data-testid="file-not-found" role="alert">
          {labels.notFound}
        </div>
      );
  }
}
