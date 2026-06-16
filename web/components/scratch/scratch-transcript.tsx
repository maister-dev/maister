"use client";

import type { ReactElement } from "react";
import type { Components } from "react-markdown";
import type {
  ScratchToolPayload,
  ScratchToolStatus,
} from "@/lib/scratch-runs/transcript";

import { useMemo, useState } from "react";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { parseScratchMessageContent } from "@/lib/scratch-runs/transcript";

export type TranscriptRole = "user" | "assistant" | "tool" | "system";

export type TranscriptMessage = {
  id: string;
  role: TranscriptRole;
  content: string;
  createdAt: string;
};

export type TranscriptAttachmentBadge = {
  id: string;
  text: string;
};

export type TranscriptLabels = {
  thinking: string;
  rawEvent: string;
  input: string;
  result: string;
  copy: string;
  copied: string;
  toolCount: (name: string, count: number) => string;
};

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
    const isBlock = (className ?? "").includes("language-");

    return isBlock ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-ivory px-1 py-px font-mono text-[12px] text-ink">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-auto rounded-lg border border-line-soft bg-paper p-3 font-mono text-[12px] leading-[1.5] text-ink-2">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
};

function Markdown({ text }: { text: string }): ReactElement {
  return (
    <div className="scratch-markdown text-[13px] leading-[1.6] text-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-3 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-[14px] [&_h2]:font-semibold [&_p]:my-1.5">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({
  text,
  labels,
}: {
  text: string;
  labels: TranscriptLabels;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="flex-none rounded border border-line bg-paper px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.08em] text-mute opacity-0 transition hover:border-amber hover:text-amber group-hover:opacity-100"
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? labels.copied : labels.copy}
    </button>
  );
}

function statusDot(status: ScratchToolStatus): string {
  switch (status) {
    case "completed":
      return "bg-accent-4";
    case "in_progress":
      return "bg-amber";
    case "failed":
      return "bg-[#d9534f]";
    case "pending":
      return "bg-mute";
  }
}

function prettyInput(rawInput: unknown): string {
  if (rawInput == null) return "";
  if (typeof rawInput === "string") return rawInput;

  try {
    return JSON.stringify(rawInput, null, 2);
  } catch {
    return String(rawInput);
  }
}

function ToolRow({
  tool,
  labels,
}: {
  tool: ScratchToolPayload;
  labels: TranscriptLabels;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const inputText = prettyInput(tool.rawInput);
  const hasDetail = inputText.length > 0 || tool.result.length > 0;

  return (
    <li className="group rounded-md border border-line bg-paper">
      <button
        className={clsx(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11.5px]",
          hasDetail ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!hasDetail}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={clsx(
            "h-1.5 w-1.5 flex-none rounded-full",
            statusDot(tool.status),
          )}
        />
        <span className="flex-none font-semibold text-ink">{tool.name}</span>
        {tool.arg ? (
          <span className="min-w-0 flex-1 truncate text-mute">{tool.arg}</span>
        ) : (
          <span className="flex-1" />
        )}
        {hasDetail ? (
          <span className="flex-none text-mute">{open ? "▾" : "▸"}</span>
        ) : null}
      </button>
      {open && hasDetail ? (
        <div className="border-t border-line-soft px-2.5 py-2">
          {inputText ? (
            <div className="group mb-2">
              <div className="mb-1 flex items-center justify-between font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-mute">
                {labels.input}
                <CopyButton labels={labels} text={inputText} />
              </div>
              <pre className="overflow-auto rounded border border-line-soft bg-ivory p-2 font-mono text-[11px] leading-[1.5] text-ink-2">
                {inputText}
              </pre>
            </div>
          ) : null}
          {tool.result ? (
            <div className="group">
              <div className="mb-1 flex items-center justify-between font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-mute">
                {labels.result}
                <CopyButton labels={labels} text={tool.result} />
              </div>
              <pre className="max-h-[320px] overflow-auto rounded border border-line-soft bg-ivory p-2 font-mono text-[11px] leading-[1.5] text-ink-2">
                {tool.result}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ToolGroup({
  tools,
  labels,
  autoOpen,
}: {
  tools: ScratchToolPayload[];
  labels: TranscriptLabels;
  autoOpen: boolean;
}): ReactElement {
  const counts = useMemo(() => {
    const byName = new Map<string, number>();

    for (const tool of tools)
      byName.set(tool.name, (byName.get(tool.name) ?? 0) + 1);

    return [...byName.entries()];
  }, [tools]);
  // null = follow autoOpen (active group expands while the turn runs, then
  // collapses); once the user clicks, the explicit choice sticks.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? autoOpen;
  const shell =
    "rounded-lg border border-line bg-[color-mix(in_oklab,var(--ivory)_45%,var(--paper))] p-2";

  // Single call: render the row directly (no group-level collapse needed).
  if (tools.length === 1) {
    return (
      <div className={shell}>
        <ul className="flex list-none flex-col gap-1 p-0">
          <ToolRow labels={labels} tool={tools[0]} />
        </ul>
      </div>
    );
  }

  // Multiple calls: collapse to the count summary; expand to the rows on click.
  return (
    <div className={shell}>
      <button
        className="flex w-full items-center gap-1.5 px-0.5 text-left"
        type="button"
        onClick={() => setOverride(!open)}
      >
        <span className="flex-none font-mono text-[10px] text-mute">
          {open ? "▾" : "▸"}
        </span>
        <span className="flex flex-1 flex-wrap gap-1.5">
          {counts.map(([name, count]) => (
            <span
              key={name}
              className="rounded-full border border-line bg-paper px-2 py-px font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-mute"
            >
              {labels.toolCount(name, count)}
            </span>
          ))}
        </span>
      </button>
      {open ? (
        <ul className="mt-1.5 flex list-none flex-col gap-1 p-0">
          {tools.map((tool, index) => (
            <ToolRow key={index} labels={labels} tool={tool} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ThoughtBlock({
  text,
  labels,
}: {
  text: string;
  labels: TranscriptLabels;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-dashed border-line bg-ivory/40 px-3 py-2">
      <button
        className="flex w-full items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-mute"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{labels.thinking}</span>
      </button>
      {open ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.55] text-mute">
          {text}
        </p>
      ) : null}
    </div>
  );
}

function LegacyRow({
  text,
  labels,
}: {
  text: string;
  labels: TranscriptLabels;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-line-soft bg-ivory/30 px-2.5 py-1.5">
      <button
        className="flex w-full items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-mute"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{labels.rawEvent}</span>
      </button>
      {open ? (
        <pre className="mt-1 max-h-[240px] overflow-auto font-mono text-[10px] leading-[1.4] text-mute">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

type TranscriptBlock =
  | { kind: "message"; message: TranscriptMessage }
  | { kind: "tools"; key: string; tools: ScratchToolPayload[] };

export function ScratchTranscript({
  messages,
  labels,
  running = false,
  userLabel,
  assistantLabel,
  renderAttachments,
}: {
  messages: TranscriptMessage[];
  labels: TranscriptLabels;
  running?: boolean;
  userLabel?: string | null;
  assistantLabel?: string | null;
  renderAttachments?: (messageId: string) => ReactElement | null;
}): ReactElement {
  const blocks = useMemo<TranscriptBlock[]>(() => {
    const result: TranscriptBlock[] = [];

    for (const message of messages) {
      const parsed = parseScratchMessageContent(message.role, message.content);

      // Token usage is surfaced as a header meter, not an inline bubble.
      if (parsed.kind === "usage") continue;

      if (parsed.kind === "tool") {
        const last = result[result.length - 1];

        if (last && last.kind === "tools") {
          last.tools.push(parsed.tool);
        } else {
          result.push({ kind: "tools", key: message.id, tools: [parsed.tool] });
        }

        continue;
      }

      result.push({ kind: "message", message });
    }

    return result;
  }, [messages]);
  const lastToolGroupKey = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];

      if (block.kind === "tools") return block.key;
    }

    return null;
  }, [blocks]);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      {blocks.map((block) => {
        if (block.kind === "tools") {
          return (
            <ToolGroup
              key={block.key}
              autoOpen={running && block.key === lastToolGroupKey}
              labels={labels}
              tools={block.tools}
            />
          );
        }

        const message = block.message;
        const parsed = parseScratchMessageContent(
          message.role,
          message.content,
        );
        const attachments = renderAttachments?.(message.id) ?? null;

        if (parsed.kind === "thought") {
          return (
            <ThoughtBlock key={message.id} labels={labels} text={parsed.text} />
          );
        }

        if (parsed.kind === "permission") {
          return (
            <div
              key={message.id}
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11.5px] text-amber"
            >
              {parsed.prompt}
            </div>
          );
        }

        if (parsed.kind === "legacy") {
          return (
            <LegacyRow key={message.id} labels={labels} text={parsed.text} />
          );
        }

        if (parsed.kind !== "text") return null;

        const isUser = message.role === "user";

        return (
          <article
            key={message.id}
            className={clsx(
              "group max-w-[88%] rounded-lg border px-3 py-2.5",
              isUser
                ? "ml-auto border-amber-line bg-amber-soft text-ink"
                : "border-line bg-paper text-ink",
            )}
          >
            <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              <span>
                {isUser
                  ? (userLabel ?? message.role)
                  : (assistantLabel ?? message.role)}
              </span>
              <div className="flex items-center gap-2">
                {!isUser ? (
                  <CopyButton labels={labels} text={parsed.text} />
                ) : null}
                <span suppressHydrationWarning>
                  {new Date(message.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
            {parsed.markdown ? (
              <Markdown text={parsed.text} />
            ) : (
              <p className="whitespace-pre-wrap text-[13px] leading-[1.55]">
                {parsed.text}
              </p>
            )}
            {attachments}
          </article>
        );
      })}
    </div>
  );
}
