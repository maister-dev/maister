"use client";

import type { ReactElement, ReactNode } from "react";
import type { Components } from "react-markdown";

import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Safe-by-default markdown (ADR-078 D10): remark-only, NO rehype-raw — raw
// HTML in a comment body renders as text, never as markup. Mirrors the
// scratch-transcript wrapper; kept separate so scratch styling stays
// untouched (deliberate small duplication).
export type MarkdownBodyVariant = "default" | "compact";

type CodeElementProps = {
  className?: string;
  children?: ReactNode;
};

function languageOf(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");

  return match?.[1]?.toLowerCase() ?? null;
}

function languageFromPreChildren(children: ReactNode): string | null {
  const childArray = Children.toArray(children);
  const onlyChild = childArray.length === 1 ? childArray[0] : null;

  if (!isValidElement<CodeElementProps>(onlyChild)) return null;

  return languageOf(onlyChild.props.className);
}

function CodeBlockPreview({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const language = languageFromPreChildren(children);

  return (
    <div
      data-markdown-code-block
      className="my-2 overflow-hidden rounded-lg border border-line bg-[color-mix(in_oklab,var(--ivory)_70%,var(--paper))]"
    >
      {language ? (
        <div className="border-b border-line-soft bg-paper px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-mute">
          {language}
        </div>
      ) : null}
      <pre className="m-0 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-ink-2">
        {children}
      </pre>
    </div>
  );
}

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
      <code className={`${className ?? ""} font-mono text-[12px]`}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-ivory px-1 py-px font-mono text-[12px] text-ink">
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <CodeBlockPreview>{children}</CodeBlockPreview>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
};

const ROOT_CLASS_BY_VARIANT: Record<MarkdownBodyVariant, string> = {
  compact:
    "min-w-0 break-words font-mono text-[11px] leading-[1.45] tracking-[0.01em] text-mute [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-2 [&_h1]:text-[12px] [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-[11.5px] [&_h2]:font-semibold [&_p]:my-1",
  default:
    "text-[13px] leading-[1.6] text-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-3 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-[14px] [&_h2]:font-semibold [&_p]:my-1.5",
};

export function MarkdownBody({
  text,
  variant = "default",
}: {
  text: string;
  variant?: MarkdownBodyVariant;
}): ReactElement {
  return (
    <div className={ROOT_CLASS_BY_VARIANT[variant]}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
