"use client";

import type { ReactElement } from "react";

import { useCallback } from "react";

import { CodeEditor } from "@/components/flows/code-editor";
import { shellLintDiagnostics } from "@/lib/flows/shell-lint";

export interface ScriptArtifactEditorLabels {
  editorAriaLabel: string;
  trustBannerTitle: string;
  trustBanner: string;
}

export interface ScriptArtifactEditorProps {
  content: string;
  readOnly?: boolean;
  labels: ScriptArtifactEditorLabels;
  onChange: (next: string) => void;
}

// Script/setup body editor (spec §7.7): the shared shell CodeMirror with the
// §6.3 heuristic lint surfaced as WARN diagnostics through the editor's own
// `@codemirror/lint` gutter, plus an informational exec/trust banner. The banner
// is honest, static copy — authored content never executes until explicit
// executable trust, so no live `execTrust` value is needed here.
export function ScriptArtifactEditor({
  content,
  readOnly = false,
  labels,
  onChange,
}: ScriptArtifactEditorProps): ReactElement {
  const lintSource = useCallback(
    (text: string) => shellLintDiagnostics(text),
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <p
        className="rounded-md border border-amber-line bg-amber-soft px-3 py-2 text-[12px] text-amber"
        data-testid="script-exec-trust-banner"
        role="note"
      >
        <span className="font-medium">{labels.trustBannerTitle}</span>{" "}
        {labels.trustBanner}
      </p>

      <CodeEditor
        ariaLabel={labels.editorAriaLabel}
        kind="script"
        lintSource={lintSource}
        readOnly={readOnly}
        value={content}
        onChange={onChange}
      />
    </div>
  );
}
