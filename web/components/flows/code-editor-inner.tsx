"use client";

import type { CodeEditorKind } from "./code-editor";
import type { Diagnostic } from "@codemirror/lint";
import type { TagStyle } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { LintDiagnostic } from "@/lib/flows/authored-lint";
import type { EditorView } from "@codemirror/view";
import type { ReactElement } from "react";

import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { linter } from "@codemirror/lint";
import { EditorView as CmEditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import { authoredFlowAutocomplete } from "@/lib/flows/authored-complete";
import { authoredFlowLinter } from "@/lib/flows/authored-lint";
import { useTheme } from "@/lib/theme";

// Forest chrome + token palette mirroring `styles/globals.css` `.light` /
// `.dark`. The token colors feed `createTheme`'s HighlightStyle so syntax tokens
// render as colored spans that recolor on a light/dark toggle.
const FOREST_LIGHT = {
  background: "#e9e7e1",
  foreground: "#0c120d",
  caret: "#588157",
  selection: "#d3e3d6",
  selectionMatch: "#dae0d0",
  gutterBackground: "#e9e7e1",
  gutterForeground: "#64724c",
  gutterBorder: "#dad7cd",
  lineHighlight: "#f0efeb",
} as const;

const FOREST_DARK = {
  background: "#141f1a",
  foreground: "#edefe8",
  caret: "#96b795",
  selection: "#172419",
  selectionMatch: "#233323",
  gutterBackground: "#141f1a",
  gutterForeground: "#859865",
  gutterBorder: "#1f2e26",
  lineHighlight: "#0c120d",
} as const;

const FOREST_TOKENS_LIGHT = {
  keyword: "#3a5a40",
  string: "#588157",
  comment: "#9a958c",
  number: "#466645",
  property: "#344e41",
  meta: "#64724c",
} as const;

const FOREST_TOKENS_DARK = {
  keyword: "#7aaa83",
  string: "#96b795",
  comment: "#6a655c",
  number: "#b9cfb9",
  property: "#75a38c",
  meta: "#859865",
} as const;

function forestTokenStyles(mode: "light" | "dark"): TagStyle[] {
  const c = mode === "light" ? FOREST_TOKENS_LIGHT : FOREST_TOKENS_DARK;

  return [
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: c.keyword },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: [t.comment, t.lineComment, t.blockComment], color: c.comment },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: c.number,
    },
    {
      tag: [t.propertyName, t.definition(t.propertyName), t.labelName],
      color: c.property,
    },
    { tag: [t.meta, t.punctuation, t.separator], color: c.meta },
  ];
}

function forestTheme(mode: "light" | "dark"): Extension {
  const palette = mode === "light" ? FOREST_LIGHT : FOREST_DARK;

  return createTheme({
    theme: mode,
    settings: {
      ...palette,
      fontFamily:
        'var(--font-jetbrains), ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    },
    styles: forestTokenStyles(mode),
  });
}

function languageExtension(kind: CodeEditorKind): Extension | null {
  switch (kind) {
    case "flow":
    case "manifest":
      return yaml();
    case "schema":
      return json();
    case "skill":
    case "rule":
    case "readme":
    case "agent_definition":
      return markdown();
    case "script":
    case "setup":
      return StreamLanguage.define(shell);
    default:
      return null;
  }
}

function toCmDiagnostic(diagnostic: LintDiagnostic): Diagnostic {
  return {
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
  };
}

function buildExtensions(
  kind: CodeEditorKind,
  lintSource?: (text: string) => LintDiagnostic[],
): Extension[] {
  const extensions: Extension[] = [CmEditorView.lineWrapping];
  const language = languageExtension(kind);

  if (language) extensions.push(language);

  const lintKind =
    kind === "flow" ? "flow" : kind === "schema" ? "json" : "other";

  extensions.push(authoredFlowLinter(lintKind));

  if (lintSource) {
    extensions.push(
      linter((view: EditorView): readonly Diagnostic[] =>
        lintSource(view.state.doc.toString()).map(toCmDiagnostic),
      ),
    );
  }

  if (kind === "flow") {
    extensions.push(authoredFlowAutocomplete());
  }

  return extensions;
}

export interface CodeEditorInnerProps {
  value: string;
  kind: CodeEditorKind;
  readOnly: boolean;
  ariaLabel?: string;
  lintSource?: (text: string) => LintDiagnostic[];
  onChange: (next: string) => void;
}

export default function CodeEditorInner({
  value,
  kind,
  readOnly,
  ariaLabel,
  lintSource,
  onChange,
}: CodeEditorInnerProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const mode = resolvedTheme === "light" ? "light" : "dark";
  const extensions = useMemo(
    () => buildExtensions(kind, lintSource),
    [kind, lintSource],
  );
  const theme = useMemo(() => forestTheme(mode), [mode]);

  return (
    <CodeMirror
      aria-label={ariaLabel}
      basicSetup={{ lineNumbers: true, foldGutter: false }}
      editable={!readOnly}
      extensions={extensions}
      readOnly={readOnly}
      theme={theme}
      value={value}
      onChange={onChange}
    />
  );
}
