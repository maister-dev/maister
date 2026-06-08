import type { Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { linter } from "@codemirror/lint";
import { parse as parseYaml, YAMLParseError } from "yaml";

import { flowYamlV1Schema } from "@/lib/config.schema";

export type LintDiagnostic = {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
};

export type AuthoredLintKind = "flow" | "json" | "other";

// `yaml` reports 1-based `{line, col}`; CodeMirror diagnostics are char offsets.
function lineColToOffset(text: string, line: number, col: number): number {
  let offset = 0;
  let currentLine = 1;

  while (currentLine < line) {
    const nextNewline = text.indexOf("\n", offset);

    if (nextNewline === -1) {
      return Math.min(text.length, offset + Math.max(0, col - 1));
    }

    offset = nextNewline + 1;
    currentLine += 1;
  }

  return Math.min(text.length, offset + Math.max(0, col - 1));
}

function yamlParseDiagnostic(
  text: string,
  err: YAMLParseError,
): LintDiagnostic {
  const linePos = err.linePos;

  if (linePos && linePos.length > 0) {
    const from = lineColToOffset(text, linePos[0].line, linePos[0].col);
    const to =
      linePos.length === 2
        ? lineColToOffset(text, linePos[1].line, linePos[1].col)
        : from;

    return {
      from,
      to: Math.max(from, to),
      severity: "error",
      message: err.message,
    };
  }

  return {
    from: 0,
    to: text.length,
    severity: "error",
    message: err.message,
  };
}

export function flowYamlDiagnostics(text: string): LintDiagnostic[] {
  let parsed: unknown;

  try {
    parsed = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      return [yamlParseDiagnostic(text, err)];
    }

    return [
      {
        from: 0,
        to: text.length,
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  const result = flowYamlV1Schema.safeParse(parsed);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => ({
    from: 0,
    to: text.length,
    severity: "error" as const,
    message: `${issue.path.join(".")}: ${issue.message}`,
  }));
}

export function jsonDiagnostics(text: string): LintDiagnostic[] {
  try {
    JSON.parse(text);

    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offset = jsonErrorOffset(message, text);

    return [
      {
        from: offset,
        to: offset,
        severity: "error",
        message,
      },
    ];
  }
}

// V8's SyntaxError message carries a trailing "at position N"; use it for a
// precise marker, falling back to the buffer start when absent.
function jsonErrorOffset(message: string, text: string): number {
  const match = /at position (\d+)/.exec(message);

  if (!match) {
    return 0;
  }

  const position = Number.parseInt(match[1], 10);

  if (Number.isNaN(position)) {
    return 0;
  }

  return Math.min(text.length, Math.max(0, position));
}

function toCmDiagnostic(diagnostic: LintDiagnostic): Diagnostic {
  return {
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
  };
}

export function authoredFlowLinter(kind: AuthoredLintKind): Extension {
  return linter((view: EditorView): readonly Diagnostic[] => {
    const text = view.state.doc.toString();

    if (kind === "flow") {
      return flowYamlDiagnostics(text).map(toCmDiagnostic);
    }

    if (kind === "json") {
      return jsonDiagnostics(text).map(toCmDiagnostic);
    }

    return [];
  });
}
