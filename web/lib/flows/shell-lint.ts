import type { LintDiagnostic } from "@/lib/flows/authored-lint";

// Heuristic shell lint (spec §6.3): a BOUNDED, deterministic, pure-JS rule set.
// NO shellcheck binary, no child process. Every finding is WARN severity — these
// are advisory smells, not an authoritative parse. Distinct `rule` per check.

export type ShellLintRule =
  | "missing_shebang"
  | "rm_rf_unquoted_var"
  | "unquoted_var_dangerous"
  | "legacy_backticks"
  | "missing_set_e";

export interface ShellLintFinding {
  line: number;
  column?: number;
  message: string;
  rule: ShellLintRule;
}

const MESSAGES: Record<ShellLintRule, string> = {
  missing_shebang:
    "Missing shebang — line 1 should start with #! (e.g. #!/usr/bin/env bash).",
  rm_rf_unquoted_var:
    'rm -rf on an unquoted variable — quote it ("$VAR") to avoid catastrophic deletion on an empty value.',
  unquoted_var_dangerous:
    'Unquoted variable in a path-mutating command — quote it ("$VAR") to guard against word-splitting and globbing.',
  legacy_backticks:
    "Legacy backtick command substitution — prefer $( … ) for nesting and readability.",
  missing_set_e:
    "No `set -e` — the script keeps running after a failed command; add `set -e` (or `set -euo pipefail`).",
};

// Path-mutating / destructive commands whose unquoted `$VAR` args are a common
// foot-gun. `rm -rf $VAR` is the sharpest case and gets its own dedicated rule.
const DANGEROUS_COMMANDS = [
  "cd",
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "mkdir",
  "rmdir",
  "dd",
];

// True when an unquoted `$name` / `${name}` expansion appears anywhere in the
// line. Quote state is tracked char-by-char (single + double quotes); a `$` seen
// outside any quote and followed by a name char or `{` is an unquoted expansion.
function hasUnquotedExpansion(line: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === "\\") {
      i += 1;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === "$" && !inSingle && !inDouble) {
      const next = line[i + 1];

      if (next === "{" || (next !== undefined && /[A-Za-z_]/.test(next))) {
        return true;
      }
    }
  }

  return false;
}

// Strip a trailing `#` comment, but only a `#` that is OUTSIDE single/double
// quotes AND starts a word (line start or preceded by whitespace) — matching
// shell's own comment rule. Quote state is tracked char-by-char, mirroring
// `hasUnquotedExpansion`, so an in-quote `#` (e.g. `echo "a # b"`) is never
// mistaken for a comment.
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === "\\") {
      i += 1;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === "#" && !inSingle && !inDouble) {
      const prev = line[i - 1];

      if (i === 0 || prev === " " || prev === "\t") {
        return line.slice(0, i);
      }
    }
  }

  return line;
}

function strippedLeadingCommand(line: string): string | null {
  const match = /^\s*([A-Za-z_][\w-]*)/.exec(line);

  return match ? match[1] : null;
}

function isRmRf(line: string): boolean {
  return /^\s*rm\b/.test(line) && /\s-[A-Za-z]*[rf][A-Za-z]*\b/.test(line);
}

function hasBacktickPair(line: string): boolean {
  return /`[^`]*`/.test(line);
}

function hasSetE(line: string): boolean {
  // `set -e`, `set -eu`, `set -euo pipefail`, `set -o errexit`, etc.
  return (
    /^\s*set\s+-[A-Za-z]*e[A-Za-z]*\b/.test(line) ||
    /^\s*set\s+-o\s+errexit\b/.test(line)
  );
}

// A shebang can itself request errexit: `#!/bin/bash -e`,
// `#!/bin/bash -euo pipefail`, `#!/usr/bin/env -S bash -euo pipefail`, or the
// long `-o errexit` form. When present, the script does not need a `set -e`.
function shebangHasErrexit(line: string): boolean {
  if (!line.startsWith("#!")) return false;

  return (
    /(^|\s)-[A-Za-z]*e[A-Za-z]*(\s|$)/.test(line) ||
    /(^|\s)-o\s+errexit\b/.test(line)
  );
}

export function shellLintFindings(source: string): ShellLintFinding[] {
  const lines = source.split("\n");
  const findings: ShellLintFinding[] = [];

  if (!lines[0]?.startsWith("#!")) {
    findings.push({
      line: 1,
      message: MESSAGES.missing_shebang,
      rule: "missing_shebang",
    });
  }

  let sawSetE = shebangHasErrexit(lines[0] ?? "");

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = stripComment(raw);

    if (hasSetE(raw)) sawSetE = true;

    const rmRf = isRmRf(line);

    if (rmRf && hasUnquotedExpansion(line)) {
      findings.push({
        line: lineNumber,
        message: MESSAGES.rm_rf_unquoted_var,
        rule: "rm_rf_unquoted_var",
      });
    }

    const command = strippedLeadingCommand(line);

    if (
      !rmRf &&
      command !== null &&
      DANGEROUS_COMMANDS.includes(command) &&
      hasUnquotedExpansion(line)
    ) {
      findings.push({
        line: lineNumber,
        message: MESSAGES.unquoted_var_dangerous,
        rule: "unquoted_var_dangerous",
      });
    }

    if (hasBacktickPair(raw)) {
      findings.push({
        line: lineNumber,
        message: MESSAGES.legacy_backticks,
        rule: "legacy_backticks",
      });
    }
  });

  if (!sawSetE) {
    findings.push({
      line: 1,
      message: MESSAGES.missing_set_e,
      rule: "missing_set_e",
    });
  }

  return findings;
}

function lineStartOffset(source: string, line: number): number {
  let offset = 0;
  let current = 1;

  while (current < line) {
    const nextNewline = source.indexOf("\n", offset);

    if (nextNewline === -1) return source.length;

    offset = nextNewline + 1;
    current += 1;
  }

  return offset;
}

// Map findings → the SAME `LintDiagnostic` shape the existing `@codemirror/lint`
// pipeline (authored-lint.ts) consumes, so shell smells render in the editor's
// lint gutter exactly like flow/json diagnostics. Each spans its whole line.
export function shellLintDiagnostics(source: string): LintDiagnostic[] {
  return shellLintFindings(source).map((finding) => {
    const from = lineStartOffset(source, finding.line);
    const lineText = source.split("\n")[finding.line - 1] ?? "";
    const to = Math.min(source.length, from + lineText.length);

    return {
      from,
      to: Math.max(from, to),
      severity: "warning" as const,
      message: finding.message,
    };
  });
}
