"use client";

import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  RefObject,
} from "react";
import type {
  TaskMarkdownEditorMode,
  TaskMarkdownToolbarLabels,
} from "@/components/social/task-markdown-toolbar";
import type { Editor } from "@tiptap/react";

import clsx from "clsx";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { TaskMarkdownToolbar } from "@/components/social/task-markdown-toolbar";

export type TaskMarkdownEditorLabels = {
  visual: string;
  source: string;
  loading: string;
  empty: string;
  textarea: string;
  toolbar: TaskMarkdownToolbarLabels;
};

export type { TaskMarkdownToolbarLabels };

type HtmlListContext = {
  kind: "ul" | "ol";
};

type TaskMarkdownEditorProps = {
  value: string;
  labels: TaskMarkdownEditorLabels;
  disabled?: boolean;
  autoFocusOnMount?: boolean;
  className?: string;
  textareaClassName?: string;
  onChange: (next: string) => void;
  onKeyDown?: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => void | Promise<void>;
  onSubmitShortcut?: () => void | Promise<void>;
  onCancelShortcut?: () => void;
};

const TaskRichMarkdownEditor = dynamic(
  () => import("@/components/social/task-rich-markdown-editor"),
  {
    loading: () => null,
    ssr: false,
  },
);

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownLines(value: string): string[] {
  return normalizeMarkdown(value).split("\n");
}

function indentLines(value: string, prefix: string): string {
  return markdownLines(value)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function inlineCode(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();

  if (!text) return "";

  const fence = text.includes("`") ? "``" : "`";

  return `${fence}${text}${fence}`;
}

function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) =>
      normalizeMarkdown(htmlNodeToMarkdown(cell, []))
        .replace(/\|/g, "\\|")
        .replace(/\n+/g, " "),
    ),
  );
  const firstRow = rows[0];

  if (!firstRow || firstRow.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const normalizeRow = (row: string[]): string[] =>
    Array.from({ length: width }, (_, index) => row[index] ?? "");
  const header = normalizeRow(firstRow);
  const body = rows.slice(1).map(normalizeRow);

  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function listItemMarkdown(
  value: string,
  prefix: string,
  depth: number,
): string {
  const lines = markdownLines(value);
  const firstLine = lines[0];

  if (!firstLine) return "";

  const indent = "  ".repeat(depth);
  const rest = lines.slice(1).map((line) => `${indent}  ${line}`);

  return [`${indent}${prefix}${firstLine}`, ...rest].join("\n");
}

function listToMarkdown(
  element: HTMLElement,
  kind: "ul" | "ol",
  lists: readonly HtmlListContext[],
): string {
  const nextLists = [...lists, { kind }];

  return Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() === "li")
    .map((item, index) => {
      const nested = normalizeMarkdown(htmlChildrenToMarkdown(item, nextLists));
      const prefix = kind === "ol" ? `${index + 1}. ` : "- ";

      return listItemMarkdown(nested, prefix, lists.length);
    })
    .filter(Boolean)
    .join("\n");
}

function htmlChildrenToMarkdown(
  node: Node,
  lists: readonly HtmlListContext[],
): string {
  return Array.from(node.childNodes)
    .map((child) => htmlNodeToMarkdown(child, lists))
    .join("");
}

function htmlNodeToMarkdown(
  node: Node,
  lists: readonly HtmlListContext[],
): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const children = () => htmlChildrenToMarkdown(element, lists);
  const block = (value: string) => {
    const normalized = normalizeMarkdown(value);

    return normalized ? `${normalized}\n\n` : "";
  };

  if (tag === "script" || tag === "style" || tag === "meta") return "";
  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b") {
    const text = normalizeMarkdown(children());

    return text ? `**${text}**` : "";
  }
  if (tag === "em" || tag === "i") {
    const text = normalizeMarkdown(children());

    return text ? `*${text}*` : "";
  }
  if (tag === "code") return inlineCode(children());
  if (tag === "pre") {
    return block(`\`\`\`\n${element.textContent ?? ""}\n\`\`\``);
  }
  if (tag === "a") {
    const text = normalizeMarkdown(children());
    const href = element.getAttribute("href");

    if (!text) return "";

    return href ? `[${text}](${href})` : text;
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));

    return block(`${"#".repeat(level)} ${children()}`);
  }
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
    return block(children());
  }
  if (tag === "blockquote") return block(indentLines(children(), "> "));
  if (tag === "ul" || tag === "ol") {
    return block(listToMarkdown(element, tag as "ul" | "ol", lists));
  }
  if (tag === "li") {
    const current = lists[lists.length - 1]?.kind;
    const prefix = current === "ol" ? "1. " : "- ";
    const nested = normalizeMarkdown(children());

    return nested ? `${listItemMarkdown(nested, prefix, lists.length)}\n` : "";
  }
  if (tag === "table") {
    return block(tableToMarkdown(element as HTMLTableElement));
  }

  return children();
}

export function htmlToMarkdown(html: string): string | null {
  if (typeof DOMParser === "undefined") return null;

  const document = new DOMParser().parseFromString(html, "text/html");
  const markdown = htmlChildrenToMarkdown(document.body, []);
  const normalized = normalizeMarkdown(markdown);

  return normalized.length > 0 ? normalized : null;
}

function insertAtSelection(args: {
  value: string;
  replacement: string;
  textarea: HTMLTextAreaElement;
}): { next: string; caret: number } {
  const start = args.textarea.selectionStart;
  const end = args.textarea.selectionEnd;
  const before = args.value.slice(0, start);
  const after = args.value.slice(end);

  return {
    next: `${before}${args.replacement}${after}`,
    caret: start + args.replacement.length,
  };
}

function restoreCaret(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  caret: number,
): void {
  window.requestAnimationFrame(() => {
    const textarea = textareaRef.current;

    if (!textarea) return;

    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });
}

export function TaskMarkdownEditor({
  value,
  labels,
  disabled = false,
  autoFocusOnMount = false,
  className,
  textareaClassName,
  onChange,
  onKeyDown,
  onSubmitShortcut,
  onCancelShortcut,
}: TaskMarkdownEditorProps): ReactElement {
  const [mode, setMode] = useState<TaskMarkdownEditorMode>("visual");
  const [richReady, setRichReady] = useState(false);
  const [richEditor, setRichEditor] = useState<Editor | null>(null);
  const [, refreshToolbar] = useReducer((revision: number) => revision + 1, 0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const markRichReady = useCallback(() => setRichReady(true), []);

  useEffect(() => {
    if (!autoFocusOnMount || mode !== "source") return;

    const textarea = textareaRef.current;

    if (!textarea) return;

    const caret = textarea.value.length;

    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [autoFocusOnMount, mode]);

  function onPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const html = event.clipboardData.getData("text/html");

    if (!html.trim()) return;

    const markdown = htmlToMarkdown(html);

    if (!markdown) return;

    event.preventDefault();

    const { next, caret } = insertAtSelection({
      value,
      replacement: markdown,
      textarea: event.currentTarget,
    });

    onChange(next);
    restoreCaret(textareaRef, caret);
  }

  function handleShortcut(event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    preventDefault: () => void;
  }): void {
    if (event.key === "Escape" && onCancelShortcut) {
      event.preventDefault();
      onCancelShortcut();

      return;
    }

    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      onSubmitShortcut
    ) {
      event.preventDefault();
      void onSubmitShortcut();
    }
  }

  return (
    <div
      className={clsx(
        "flex min-w-0 flex-col overflow-hidden rounded-md border border-line-soft bg-paper focus-within:border-amber",
        className,
      )}
    >
      <TaskMarkdownToolbar
        disabled={disabled || mode !== "visual" || !richReady}
        editor={mode === "visual" ? richEditor : null}
        labels={labels.toolbar}
        mode={mode}
        modeLabels={{ visual: labels.visual, source: labels.source }}
        onModeChange={setMode}
      />
      {mode === "source" ? (
        <textarea
          ref={textareaRef}
          aria-label={labels.textarea}
          className={clsx(
            "min-h-[110px] w-full resize-y border-0 bg-paper px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-ink outline-none disabled:cursor-not-allowed disabled:opacity-60",
            textareaClassName,
          )}
          disabled={disabled}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            handleShortcut(event);
            if (event.defaultPrevented) return;

            void onKeyDown?.(event);
          }}
          onPaste={onPaste}
        />
      ) : (
        <div className="relative min-h-[110px] bg-paper">
          {!richReady ? (
            <div className="absolute inset-0 z-[1] bg-paper px-3 py-2.5 font-mono text-[12px] text-mute">
              {labels.loading}
            </div>
          ) : null}
          <TaskRichMarkdownEditor
            autoFocusOnMount={autoFocusOnMount}
            disabled={disabled}
            placeholder={labels.empty}
            value={value}
            onCancelShortcut={onCancelShortcut}
            onChange={onChange}
            onEditorChange={setRichEditor}
            onReady={markRichReady}
            onSubmitShortcut={onSubmitShortcut}
            onToolbarStateChange={refreshToolbar}
          />
        </div>
      )}
    </div>
  );
}
