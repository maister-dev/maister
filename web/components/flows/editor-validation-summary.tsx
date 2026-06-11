import type { EditorValidationResult } from "@/lib/flows/editor/validation";
import type { ArtifactContentIssue } from "@/lib/flows/artifact-validate";
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

export type ArtifactContentIssuesLabels = {
  clean: string;
  blockTitle: string;
  warnTitle: string;
};

// T4.2: inline surface for per-kind artifact CONTENT validation. Renders the
// SAME `validateArtifactContent` output the server BLOCK-gate consumes (here:
// BLOCK + WARN, grouped by severity). Provider-free (renders under
// renderToStaticMarkup). The server hard-gate is authoritative; this is UX only.
export function ArtifactContentIssues({
  issues,
  labels,
}: {
  issues: readonly ArtifactContentIssue[];
  labels: ArtifactContentIssuesLabels;
}): ReactElement {
  const blocks = issues.filter((issue) => issue.severity === "block");
  const warns = issues.filter((issue) => issue.severity === "warn");

  if (blocks.length === 0 && warns.length === 0) {
    return (
      <p
        className="rounded-lg border border-line bg-paper p-3 font-mono text-[10px] text-mute"
        data-testid="artifact-content-ok"
      >
        {labels.clean}
      </p>
    );
  }

  return (
    <div className="grid gap-2" data-testid="artifact-content-issues">
      {blocks.length > 0 ? (
        <ArtifactIssueGroup
          issues={blocks}
          severity="block"
          title={labels.blockTitle}
        />
      ) : null}
      {warns.length > 0 ? (
        <ArtifactIssueGroup
          issues={warns}
          severity="warn"
          title={labels.warnTitle}
        />
      ) : null}
    </div>
  );
}

function ArtifactIssueGroup({
  issues,
  severity,
  title,
}: {
  issues: readonly ArtifactContentIssue[];
  severity: "block" | "warn";
  title: string;
}): ReactElement {
  const isBlock = severity === "block";

  return (
    <div
      className={
        isBlock
          ? "grid gap-1.5 rounded-lg border border-danger-line bg-danger-soft p-3"
          : "grid gap-1.5 rounded-lg border border-line bg-paper p-3"
      }
      data-testid={`artifact-content-${severity}`}
    >
      <h4
        className={
          isBlock
            ? "font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-danger"
            : "font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute"
        }
      >
        {title} ({issues.length})
      </h4>
      <ul className="m-0 grid list-none gap-1 p-0">
        {issues.map((issue, index) => (
          <li
            key={`${issue.severity}:${issue.code}:${issue.path}:${index}`}
            className={
              isBlock
                ? "font-mono text-[10.5px] leading-[1.4] text-danger"
                : "font-mono text-[10.5px] leading-[1.4] text-mute"
            }
            data-testid={`artifact-issue-${issue.code}`}
          >
            {issue.path} · {issue.code}: {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
