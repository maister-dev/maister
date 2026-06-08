"use client";

import type { ReactElement } from "react";

import dynamic from "next/dynamic";
import { useState } from "react";

// CodeMirror needs the DOM (measurement, selection) → ssr:false. Next 16 forbids
// ssr:false inside a Server Component, so the heavy editor loads through this
// thin client wrapper; the (possibly server-rendered) parent passes only
// serializable props.
const CodeEditorInner = dynamic(() => import("./code-editor-inner"), {
  ssr: false,
});

export type CodeEditorKind =
  | "flow"
  | "schema"
  | "skill"
  | "rule"
  | "readme"
  | "agent_definition"
  | "script"
  | "setup"
  | "asset"
  | "template";

export interface CodeEditorProps {
  value: string;
  kind: CodeEditorKind;
  name?: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  ariaLabel?: string;
}

// Two shapes:
//  - forms mode (`name` set): a hidden <input name={name}> ALWAYS renders (even
//    before the dynamic editor hydrates) carrying the live buffer, so a Server
//    Action reading `requireFormRawString(formData, name)` keeps working.
//  - controlled mode (`onChange` set, no `name`): pure value/onChange; the
//    parent owns the buffer (e.g. package-files-editor's draftFiles).
export function CodeEditor({
  value,
  kind,
  name,
  onChange,
  readOnly = false,
  ariaLabel,
}: CodeEditorProps): ReactElement {
  const [buffer, setBuffer] = useState(value);

  const handleChange = (next: string): void => {
    setBuffer(next);
    onChange?.(next);
  };

  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-ivory focus-within:border-amber"
      data-testid="code-editor"
    >
      {name ? <input name={name} type="hidden" value={buffer} /> : null}
      <CodeEditorInner
        ariaLabel={ariaLabel}
        kind={kind}
        readOnly={readOnly}
        value={buffer}
        onChange={handleChange}
      />
    </div>
  );
}
