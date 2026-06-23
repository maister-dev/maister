"use client";

import type { ReactElement } from "react";
import type { Editor } from "@tiptap/react";

import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";

export type TaskRichMarkdownEditorProps = {
  value: string;
  disabled: boolean;
  autoFocusOnMount: boolean;
  placeholder: string;
  onChange: (next: string) => void;
  onSubmitShortcut?: () => void | Promise<void>;
  onCancelShortcut?: () => void;
  onEditorChange?: (editor: Editor | null) => void;
  onReady?: () => void;
  onToolbarStateChange?: () => void;
};

function codeLanguage(className: string | null): string | null {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");

  return match?.[1]?.toLowerCase() ?? null;
}

function syncCodeBlockLanguages(editor: Editor): void {
  editor.view.dom.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    const language = codeLanguage(code?.getAttribute("class") ?? null);

    if (language) {
      pre.dataset.language = language;
    } else {
      delete pre.dataset.language;
    }
  });
}

export default function TaskRichMarkdownEditor({
  value,
  disabled,
  autoFocusOnMount,
  placeholder,
  onChange,
  onSubmitShortcut,
  onCancelShortcut,
  onEditorChange,
  onReady,
  onToolbarStateChange,
}: TaskRichMarkdownEditorProps): ReactElement {
  const appliedValueRef = useRef(value);
  const submitShortcutRef = useRef(onSubmitShortcut);
  const cancelShortcutRef = useRef(onCancelShortcut);
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          autolink: true,
          openOnClick: false,
          protocols: ["http", "https", "mailto"],
        },
        strike: false,
        underline: false,
      }),
      Markdown.configure({
        markedOptions: {
          breaks: false,
          gfm: true,
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    [placeholder],
  );
  const editor = useEditor({
    autofocus: autoFocusOnMount ? "end" : false,
    content: value,
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: {
        "aria-label": placeholder,
        class: "task-markdown-rich-content",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape" && cancelShortcutRef.current) {
          event.preventDefault();
          cancelShortcutRef.current();

          return true;
        }

        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          submitShortcutRef.current
        ) {
          event.preventDefault();
          void submitShortcutRef.current();

          return true;
        }

        return false;
      },
    },
    extensions,
    immediatelyRender: false,
    onUpdate: ({ editor: updatedEditor }) => {
      syncCodeBlockLanguages(updatedEditor);
      const next = updatedEditor.getMarkdown();

      appliedValueRef.current = next;
      onChange(next);
      onToolbarStateChange?.();
    },
    onSelectionUpdate: () => onToolbarStateChange?.(),
    onTransaction: ({ editor: transactionEditor }) => {
      syncCodeBlockLanguages(transactionEditor);
      onToolbarStateChange?.();
    },
  });

  useEffect(() => {
    submitShortcutRef.current = onSubmitShortcut;
    cancelShortcutRef.current = onCancelShortcut;
  }, [onCancelShortcut, onSubmitShortcut]);

  useEffect(() => {
    if (!editor) return;

    syncCodeBlockLanguages(editor);
    onReady?.();
    onEditorChange?.(editor);

    return () => onEditorChange?.(null);
  }, [editor, onEditorChange, onReady]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || value === appliedValueRef.current) return;

    editor.commands.setContent(value, {
      contentType: "markdown",
      emitUpdate: false,
    });
    appliedValueRef.current = value;
    syncCodeBlockLanguages(editor);
  }, [editor, value]);

  return (
    <div className="task-markdown-rich-editor">
      <EditorContent editor={editor} />
    </div>
  );
}
