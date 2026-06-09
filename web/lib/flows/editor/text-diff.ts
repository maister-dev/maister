/**
 * Minimal LCS-based unified line diff. Pure, dependency-free (the repo ships no
 * diff lib). Lines common to both sides are prefixed "  ", removals "- ",
 * additions "+ ". Identical inputs return "" (the empty-diff contract the
 * draft-vs-published view relies on).
 */
export function unifiedLineDiff(before: string, after: string): string {
  if (before === after) return "";
  if (before === "")
    return after
      .split("\n")
      .map((l) => `+ ${l}`)
      .join("\n");
  if (after === "")
    return before
      .split("\n")
      .map((l) => `- ${l}`)
      .join("\n");

  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }

  while (i < m) {
    out.push(`- ${a[i]}`);
    i += 1;
  }

  while (j < n) {
    out.push(`+ ${b[j]}`);
    j += 1;
  }

  return out.join("\n");
}
