import { isScratchTranscriptClearCommand } from "@/lib/scratch-runs/commands";

export type UserTextSegment =
  | {
      kind: "text";
      text: string;
      start: number;
      end: number;
    }
  | {
      kind: "skills";
      text: string;
      start: number;
      end: number;
      count: number;
      ordinal: number;
    };

const explanation =
  "When the task or agent instructions require a packaged skill, read its SKILL.md using the workspace-relative path below. Use this copy for the packaged instructions and resolve its companion files relative to SKILL.md.";

export function isLongUserText(text: string): boolean {
  return text.length > 2000 || text.split(/\r\n|\n|\r/).length > 12;
}

export function repeatedUserIds(
  messages: readonly {
    id: string;
    role: string;
    content: string;
    preview?: unknown;
  }[],
): ReadonlySet<string> {
  const seen = new Map<string, string>();
  const repeated = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user") continue;
    if (isScratchTranscriptClearCommand(message.content)) {
      seen.clear();
      continue;
    }
    if (message.preview || !isLongUserText(message.content)) continue;
    if (seen.has(message.content)) repeated.add(message.id);
    else seen.set(message.content, message.id);
  }

  return repeated;
}

export function splitUserText(text: string): readonly UserTextSegment[] {
  const lines = Array.from(text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g))
    .filter((match) => match[0].length > 0)
    .map((match) => ({
      text: match[0].replace(/[\r\n]+$/, ""),
      start: match.index,
      end: match.index + match[0].length,
    }));
  const parts: UserTextSegment[] = [];
  let cursor = 0;
  let ordinal = 0;
  let fence: { character: string; size: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);

    if (marker) {
      if (!fence) fence = { character: marker[1][0], size: marker[1].length };
      else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.size &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line.text)
      )
        fence = null;
      continue;
    }
    if (
      fence ||
      line.text !== "## Packaged skills" ||
      lines[i + 1]?.text !== explanation
    )
      continue;
    let endIndex = i + 2;
    let count = 0;
    let valid = true;

    while (
      endIndex < lines.length &&
      /^\s*[-*+]\s/.test(lines[endIndex].text)
    ) {
      if (
        !/^- [a-zA-Z0-9][a-zA-Z0-9._:-]*: `[^`\r\n]+\/SKILL\.md`$/.test(
          lines[endIndex].text,
        )
      )
        valid = false;
      count += 1;
      endIndex += 1;
    }
    if (!valid || count === 0) continue;
    const end = lines[endIndex - 1].end;

    if (line.start > cursor)
      parts.push({
        kind: "text",
        text: text.slice(cursor, line.start),
        start: cursor,
        end: line.start,
      });
    parts.push({
      kind: "skills",
      text: text.slice(line.start, end),
      start: line.start,
      end,
      count,
      ordinal,
    });
    ordinal += 1;
    cursor = end;
    i = endIndex - 1;
  }
  if (cursor < text.length || parts.length === 0)
    parts.push({
      kind: "text",
      text: text.slice(cursor),
      start: cursor,
      end: text.length,
    });

  return parts;
}
