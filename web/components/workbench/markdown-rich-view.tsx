import type { ReactElement, ReactNode } from "react";
import type { Components } from "react-markdown";

import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MermaidDiagram } from "@/components/workbench/mermaid-diagram";

type CodeElementProps = {
  className?: string;
  children?: ReactNode;
};

const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"] as const;

export function isMarkdownRichPath(path: string): boolean {
  const lower = path.toLowerCase();

  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function textFromNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromNode).join("");
  }
  if (isValidElement<CodeElementProps>(node)) {
    return textFromNode(node.props.children);
  }

  return "";
}

function languageOf(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");

  return match?.[1]?.toLowerCase() ?? null;
}

const markdownComponents: Components = {
  a: ({ children, href }) => (
    <a
      className="text-amber underline decoration-amber-line underline-offset-2 hover:text-amber-2"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const lang = languageOf(className);

    return lang ? (
      <code className={`${className ?? ""} font-mono`}>{children}</code>
    ) : (
      <code className="rounded bg-ivory px-1 py-px font-mono text-[12px] text-ink">
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    const onlyChild = Children.only(children);

    if (isValidElement<CodeElementProps>(onlyChild)) {
      const lang = languageOf(onlyChild.props.className);

      if (lang === "mermaid") {
        return (
          <MermaidDiagram source={textFromNode(onlyChild.props.children)} />
        );
      }
    }

    return (
      <pre className="my-3 overflow-auto rounded-[8px] border border-line bg-paper p-3 font-mono text-[12px] leading-[1.5] text-ink-2">
        {children}
      </pre>
    );
  },
  table: ({ children }) => (
    <div className="my-3 overflow-auto">
      <table className="min-w-full border-collapse text-[12px]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-ivory px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-line px-2 py-1 align-top">{children}</td>
  ),
};

export function MarkdownRichView({
  source,
  path,
}: {
  source: string;
  path: string;
}): ReactElement {
  return (
    <article
      className="markdown-rich-view max-h-[520px] overflow-auto rounded-[8px] border border-line bg-paper px-6 py-5 text-[14px] leading-[1.65] text-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-amber-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-2 [&_h1]:mb-3 [&_h1]:text-[26px] [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-[19px] [&_h2]:font-bold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-[16px] [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2.5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6"
      data-path={path}
      data-testid="markdown-rich-view"
    >
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}
