import type { EditorValidationResult } from "@/lib/flows/editor/validation";
import type { ReactElement } from "react";

export type EditorValidationSummaryLabels = {
  valid: string;
  title: string;
};

// M27/T-A7: inline validation surfacing. Provider-free, so it renders under
// renderToStaticMarkup. Each issue is a button that focuses the offending node
// (the editor wires onSelectNode → selection → side-form).
export function EditorValidationSummary({
  result,
  labels,
  onSelectNode,
}: {
  result: EditorValidationResult;
  labels: EditorValidationSummaryLabels;
  onSelectNode: (nodeId: string) => void;
}): ReactElement {
  if (result.ok) {
    return (
      <p
        className="rounded-lg border border-line bg-paper p-3 font-mono text-[10px] text-mute"
        data-testid="editor-validation-ok"
      >
        {labels.valid}
      </p>
    );
  }

  return (
    <div
      className="grid gap-1.5 rounded-lg border border-danger-line bg-danger-soft p-3"
      data-testid="editor-validation-issues"
    >
      <h4 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-danger">
        {labels.title} ({result.issues.length})
      </h4>
      <ul className="m-0 grid list-none gap-1 p-0">
        {result.issues.map((issue) => (
          <li
            key={`${issue.nodeId}:${issue.gateId ?? ""}:${issue.path}`}
            data-testid={`editor-issue-${issue.nodeId}${issue.gateId ? `:${issue.gateId}` : ""}`}
          >
            <button
              className="text-left font-mono text-[10.5px] leading-[1.4] text-danger hover:underline"
              type="button"
              onClick={() => onSelectNode(issue.nodeId)}
            >
              {issue.nodeId}
              {issue.gateId ? ` · ${issue.gateId}` : ""}: {issue.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
