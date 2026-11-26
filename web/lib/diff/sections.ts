const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

// Strip only leading whitespace (for the startsWith filter) and trailing "\n"
// terminator(s) of git stdout — never a blanket trim(), so significant trailing
// spaces or a CRLF line's "\r" stay intact for byte-exact review anchoring.
export function splitSections(rawDiff: string): string[] {
  const leadingTrimmed = rawDiff.replace(/^\s+/, "");
  let end = leadingTrimmed.length;

  while (end > 0 && leadingTrimmed.charCodeAt(end - 1) === 10) {
    end -= 1;
  }

  const trimmed =
    end === leadingTrimmed.length
      ? leadingTrimmed
      : leadingTrimmed.slice(0, end);

  if (trimmed.length === 0) return [];

  return trimmed
    .split(/\n(?=diff --git )/)
    .filter((section) => section.startsWith("diff --git"));
}

// Decode git's C-quoted path format (`"..."`), including standard backslash
// escapes (`\"`, `\\`, `\t`, `\n`, etc.) and octal UTF-8 byte sequences
// (`\320\277...`). Unquoted inputs are returned unchanged.
export function unescapeGitQuotedPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw;
  }

  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;

  while (i < inner.length) {
    const ch = inner[i];

    if (ch === "\\") {
      if (i + 1 >= inner.length) {
        bytes.push(0x5c);
        i += 1;
        continue;
      }

      const next = inner[i + 1];

      if (next >= "0" && next <= "7") {
        let octalEnd = i + 2;

        while (
          octalEnd < inner.length &&
          octalEnd < i + 4 &&
          inner[octalEnd] >= "0" &&
          inner[octalEnd] <= "7"
        ) {
          octalEnd += 1;
        }

        const octal = inner.slice(i + 1, octalEnd);

        bytes.push(Number.parseInt(octal, 8) & 0xff);
        i = octalEnd;
        continue;
      }

      switch (next) {
        case "\\":
          bytes.push(0x5c);
          break;
        case '"':
          bytes.push(0x22);
          break;
        case "a":
          bytes.push(0x07);
          break;
        case "b":
          bytes.push(0x08);
          break;
        case "f":
          bytes.push(0x0c);
          break;
        case "n":
          bytes.push(0x0a);
          break;
        case "r":
          bytes.push(0x0d);
          break;
        case "t":
          bytes.push(0x09);
          break;
        case "v":
          bytes.push(0x0b);
          break;
        default: {
          const cp = inner.codePointAt(i + 1);
          const lit = cp !== undefined ? String.fromCodePoint(cp) : next;

          for (const b of utf8Encoder.encode(lit)) {
            bytes.push(b);
          }
          i += 1 + lit.length;
          continue;
        }
      }

      i += 2;
      continue;
    }

    const code = inner.charCodeAt(i);

    if (code < 0x80) {
      bytes.push(code);
      i += 1;
    } else {
      const cp = inner.codePointAt(i);
      const lit = cp !== undefined ? String.fromCodePoint(cp) : ch;

      for (const b of utf8Encoder.encode(lit)) {
        bytes.push(b);
      }
      i += lit.length;
    }
  }

  return utf8Decoder.decode(new Uint8Array(bytes));
}

export function repoRelPath(raw: string): string {
  const unescaped = unescapeGitQuotedPath(raw);

  if (unescaped.startsWith("a/") || unescaped.startsWith("b/")) {
    return unescaped.slice(2);
  }

  return unescaped;
}

function scanQuotedTokenEnd(input: string, start: number): number {
  let i = start + 1;

  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input[i] === '"') {
      return i;
    }
    i += 1;
  }

  return -1;
}

// Unified diff `--- `/`+++ ` headers append a literal `\t` (or `\t<timestamp>`)
// after paths containing spaces or in non-git patches. Strip only a trailing
// literal tab outside C-quoted paths so escaped `\t` inside quotes stays intact.
function stripUnifiedHeaderTrailingTab(raw: string): string {
  if (raw.startsWith('"')) {
    const endQuote = scanQuotedTokenEnd(raw, 0);

    if (endQuote !== -1 && raw[endQuote + 1] === "\t") {
      return raw.slice(0, endQuote + 1);
    }

    return raw;
  }

  const tabIdx = raw.indexOf("\t");

  return tabIdx === -1 ? raw : raw.slice(0, tabIdx);
}

function parseDiffGitTokens(headerLine: string): {
  oldToken?: string;
  newToken?: string;
} {
  const prefix = "diff --git ";

  if (!headerLine.startsWith(prefix)) {
    const tokens = headerLine.split(" ");

    return { newToken: tokens[tokens.length - 1] ?? "" };
  }

  const rest = headerLine.slice(prefix.length);

  if (rest.startsWith('"')) {
    const endQuote = scanQuotedTokenEnd(rest, 0);

    if (endQuote !== -1) {
      const oldToken = rest.slice(0, endQuote + 1);
      const newToken =
        rest[endQuote + 1] === " " ? rest.slice(endQuote + 2) : undefined;

      return { oldToken, newToken };
    }
  }

  // An unquoted git path never contains `"` (git always C-quotes quotes), so
  // ` "` unambiguously separates an unquoted old path from a quoted new path.
  if (rest.endsWith('"')) {
    const sep = rest.indexOf(' "');

    if (sep !== -1) {
      return {
        oldToken: rest.slice(0, sep),
        newToken: rest.slice(sep + 1),
      };
    }
  }

  // Unquoted symmetric `a/<p> b/<p>` (handles spaces and even ` b/` inside `<p>`).
  if (rest.startsWith("a/") && rest.length % 2 === 1) {
    const mid = (rest.length - 1) / 2;

    if (
      rest[mid] === " " &&
      rest.startsWith("b/", mid + 1) &&
      rest.slice(2, mid) === rest.slice(mid + 3)
    ) {
      return {
        oldToken: rest.slice(0, mid),
        newToken: rest.slice(mid + 1),
      };
    }
  }

  const match = rest.match(/^(a\/.+) (b\/.+)$/);

  if (match) {
    return { oldToken: match[1], newToken: match[2] };
  }

  const tokens = headerLine.split(" ");

  return { newToken: tokens[tokens.length - 1] ?? "" };
}

// Extract only the file-header lines preceding the first `@@` hunk so callers
// can inspect `rename to`/`+++`/`---` without splitting multi-megabyte bodies.
export function extractHeaderBodyLines(section: string): string[] {
  const headerNl = section.indexOf("\n");

  if (headerNl === -1) return [];

  const lines: string[] = [];
  let pos = headerNl + 1;

  while (pos < section.length) {
    const nl = section.indexOf("\n", pos);
    const lineEnd = nl === -1 ? section.length : nl;
    const line = section.slice(pos, lineEnd);

    if (line.startsWith("@@") || line === "GIT binary patch") break;
    lines.push(line);
    if (line.startsWith("+++ ")) break;
    if (nl === -1) break;
    pos = nl + 1;
  }

  return lines;
}

export function parsePath(
  headerLine: string,
  bodyLines: readonly string[] = [],
): string {
  let plusPath: string | undefined;
  let renameToPath: string | undefined;
  let minusPath: string | undefined;

  for (const line of bodyLines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("+++ ")) {
      const candidate = stripUnifiedHeaderTrailingTab(line.slice(4));

      if (candidate !== "/dev/null") {
        plusPath = repoRelPath(candidate);
      }
    } else if (line.startsWith("rename to ")) {
      renameToPath = unescapeGitQuotedPath(line.slice("rename to ".length));
    } else if (line.startsWith("copy to ")) {
      renameToPath = unescapeGitQuotedPath(line.slice("copy to ".length));
    } else if (line.startsWith("--- ")) {
      const candidate = stripUnifiedHeaderTrailingTab(line.slice(4));

      if (candidate !== "/dev/null") {
        minusPath = repoRelPath(candidate);
      }
    }
  }

  if (plusPath !== undefined) return plusPath;
  if (renameToPath !== undefined) return renameToPath;
  if (minusPath !== undefined) return minusPath;

  const { newToken } = parseDiffGitTokens(headerLine);

  return repoRelPath(newToken ?? "");
}

export function parseOldPath(
  headerLine: string,
  bodyLines: readonly string[] = [],
): string | undefined {
  let renameFromPath: string | undefined;
  let minusPath: string | undefined;

  for (const line of bodyLines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("rename from ")) {
      renameFromPath = unescapeGitQuotedPath(line.slice("rename from ".length));
    } else if (line.startsWith("copy from ")) {
      renameFromPath = unescapeGitQuotedPath(line.slice("copy from ".length));
    } else if (line.startsWith("--- ")) {
      const candidate = stripUnifiedHeaderTrailingTab(line.slice(4));

      if (candidate !== "/dev/null") {
        minusPath = repoRelPath(candidate);
      }
    }
  }

  if (renameFromPath !== undefined) return renameFromPath;
  if (minusPath !== undefined) return minusPath;

  const { oldToken } = parseDiffGitTokens(headerLine);

  return oldToken !== undefined ? repoRelPath(oldToken) : undefined;
}

export function filterDiffByPath(
  rawDiff: string,
  includePath: (path: string, oldPath: string | undefined) => boolean,
): string {
  const kept = splitSections(rawDiff).filter((section) => {
    const headerNl = section.indexOf("\n");
    const headerLine = headerNl === -1 ? section : section.slice(0, headerNl);
    const bodyLines = extractHeaderBodyLines(section);
    const path = parsePath(headerLine, bodyLines);
    const oldPath = parseOldPath(headerLine, bodyLines);

    return includePath(path, oldPath);
  });

  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}
