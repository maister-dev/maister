"use client";

import type { ReactElement, ReactNode } from "react";
import type { Editor } from "@tiptap/react";

import {
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  BoldIcon,
  CodeBracketIcon,
  CodeBracketSquareIcon,
  EyeIcon,
  H1Icon,
  H2Icon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  MinusIcon,
  NumberedListIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

export type TaskMarkdownEditorMode = "visual" | "source";

export type TaskMarkdownToolbarLabels = {
  undo: string;
  redo: string;
  heading1: string;
  heading2: string;
  quote: string;
  bold: string;
  italic: string;
  inlineCode: string;
  codeBlock: string;
  bulletList: string;
  numberedList: string;
  link: string;
  linkPrompt: string;
  divider: string;
};

type ToolbarButtonProps = {
  label: string;
  disabled: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
};

export type TaskMarkdownToolbarProps = {
  mode: TaskMarkdownEditorMode;
  modeLabels: Record<TaskMarkdownEditorMode, string>;
  labels: TaskMarkdownToolbarLabels;
  editor: Editor | null;
  disabled?: boolean;
  onModeChange: (mode: TaskMarkdownEditorMode) => void;
};

function ToolbarButton({
  label,
  disabled,
  active = false,
  onClick,
  children,
}: ToolbarButtonProps): ReactElement {
  return (
    <button
      aria-label={label}
      className={clsx(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-45",
        active
          ? "border-amber bg-amber text-paper"
          : "border-line bg-paper text-mute hover:border-amber hover:text-amber",
      )}
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ToolbarGroup({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line-soft bg-paper/80 px-0.5 py-0.5">
      {children}
    </div>
  );
}

function setLink(editor: Editor, label: string): void {
  const currentHref = editor.getAttributes("link").href;
  const nextHref = window.prompt(
    label,
    typeof currentHref === "string" ? currentHref : "",
  );

  if (nextHref === null) return;

  const href = nextHref.trim();

  if (!href) {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();

    return;
  }

  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

export function TaskMarkdownToolbar({
  mode,
  modeLabels,
  labels,
  editor,
  disabled = false,
  onModeChange,
}: TaskMarkdownToolbarProps): ReactElement {
  const locked = disabled || !editor;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft bg-ivory px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <ToolbarGroup>
          <ToolbarButton
            disabled={locked}
            label={labels.undo}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            disabled={locked}
            label={labels.redo}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <ArrowUturnRightIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarGroup>
          <ToolbarButton
            active={editor?.isActive("heading", { level: 1 }) ?? false}
            disabled={locked}
            label={labels.heading1}
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 1 }).run()
            }
          >
            <H1Icon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor?.isActive("heading", { level: 2 }) ?? false}
            disabled={locked}
            label={labels.heading2}
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            <H2Icon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor?.isActive("blockquote") ?? false}
            disabled={locked}
            label={labels.quote}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            <span className="font-serif text-[16px] leading-none">&quot;</span>
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarGroup>
          <ToolbarButton
            active={editor?.isActive("bold") ?? false}
            disabled={locked}
            label={labels.bold}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <BoldIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor?.isActive("italic") ?? false}
            disabled={locked}
            label={labels.italic}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <ItalicIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor?.isActive("code") ?? false}
            disabled={locked}
            label={labels.inlineCode}
            onClick={() => editor?.chain().focus().toggleCode().run()}
          >
            <CodeBracketIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor?.isActive("codeBlock") ?? false}
            disabled={locked}
            label={labels.codeBlock}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          >
            <CodeBracketSquareIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarGroup>
          <ToolbarButton
            active={editor?.isActive("bulletList") ?? false}
            disabled={locked}
            label={labels.bulletList}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <ListBulletIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor?.isActive("orderedList") ?? false}
            disabled={locked}
            label={labels.numberedList}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <NumberedListIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarGroup>
          <ToolbarButton
            active={editor?.isActive("link") ?? false}
            disabled={locked}
            label={labels.link}
            onClick={() => {
              if (editor) setLink(editor, labels.linkPrompt);
            }}
          >
            <LinkIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            disabled={locked}
            label={labels.divider}
            onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          >
            <MinusIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </ToolbarGroup>
      </div>

      <div className="ml-auto inline-grid shrink-0 grid-cols-2 rounded-md border border-line bg-paper p-0.5">
        {(["visual", "source"] as const).map((item) => (
          <button
            key={item}
            aria-label={modeLabels[item]}
            aria-pressed={mode === item}
            className={clsx(
              "inline-flex h-6 w-6 items-center justify-center rounded-[5px] transition",
              mode === item
                ? "bg-amber text-paper"
                : "text-mute hover:text-ink",
            )}
            title={modeLabels[item]}
            type="button"
            onClick={() => onModeChange(item)}
          >
            {item === "visual" ? (
              <EyeIcon className="h-3.5 w-3.5" />
            ) : (
              <CodeBracketIcon className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">{modeLabels[item]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
