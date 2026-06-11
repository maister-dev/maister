"use client";

import type { ReactElement, ReactNode } from "react";
import type { Components } from "react-markdown";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Safe-by-default markdown (ADR-078 D10): remark-only, NO rehype-raw — raw
// HTML in a comment body renders as text, never as markup. Mirrors the
// scratch-transcript wrapper; kept separate so scratch styling stays
// untouched (deliberate small duplication).
const components: Components = {
  a: ({ href, children }) => (
    <a
      className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
      href={href}
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = Boolean(className);

    return isBlock ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-ivory px-1 py-px font-mono text-[12px] text-ink">
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="my-2 overflow-auto rounded-lg border border-line-soft bg-paper p-3 font-mono text-[12px] leading-[1.5] text-ink-2">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
};

export function MarkdownBody({ text }: { text: string }): ReactElement {
  return (
    <div className="text-[13px] leading-[1.6] text-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-3 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-[14px] [&_h2]:font-semibold [&_p]:my-1.5">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
