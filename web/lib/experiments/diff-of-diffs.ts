export type DiffOfDiffsInput =
  | string
  | {
      text: string;
      truncated?: boolean;
    };

export type DiffOfDiffsLine = {
  kind: "added" | "removed";
  line: string;
};

export type DiffOfDiffsResult = {
  identical: boolean;
  partial: boolean;
  lines: DiffOfDiffsLine[];
};

function inputText(input: DiffOfDiffsInput): string {
  return typeof input === "string" ? input : input.text;
}

function inputTruncated(input: DiffOfDiffsInput): boolean {
  return typeof input === "string" ? false : input.truncated === true;
}

function normalizeDiffLine(line: string): string | null {
  if (line.startsWith("diff --git ")) return null;
  if (line.startsWith("index ")) return null;
  if (line.startsWith("--- ")) return null;
  if (line.startsWith("+++ ")) return null;
  if (line.startsWith("@@ ")) return null;
  if (line === "\\ No newline at end of file") return null;

  return line.trimEnd();
}

function normalizedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(normalizeDiffLine)
    .filter((line): line is string => line !== null && line.length > 0);
}

function lcsTable(left: string[], right: string[]): number[][] {
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  return table;
}

function diffLines(left: string[], right: string[]): DiffOfDiffsLine[] {
  const table = lcsTable(left, right);
  const result: DiffOfDiffsLine[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ kind: "removed", line: left[i] });
      i += 1;
    } else {
      result.push({ kind: "added", line: right[j] });
      j += 1;
    }
  }

  while (i < left.length) {
    result.push({ kind: "removed", line: left[i] });
    i += 1;
  }

  while (j < right.length) {
    result.push({ kind: "added", line: right[j] });
    j += 1;
  }

  return result;
}

export function computeDiffOfDiffs(
  leftInput: DiffOfDiffsInput,
  rightInput: DiffOfDiffsInput,
): DiffOfDiffsResult {
  const left = normalizedLines(inputText(leftInput));
  const right = normalizedLines(inputText(rightInput));
  const lines = diffLines(left, right);

  return {
    identical: lines.length === 0,
    partial: inputTruncated(leftInput) || inputTruncated(rightInput),
    lines,
  };
}
