export type MemoryLink = Readonly<{
  raw: string;
  kind: "note" | "task" | "run" | "brain" | "knowledge" | "repo" | "unresolved";
  target: string;
  fragment: string | null;
}>;

export type MemoryStructure = Readonly<{
  tags: readonly string[];
  aliases: readonly string[];
  headings: readonly string[];
  links: readonly MemoryLink[];
  body: string;
}>;

const maxYamlChars = 8192;
const maxMetadataItems = 64;
const maxLinks = 512;

function invalidYaml(): MaisterError {
  return new MaisterError(
    "CONFIG",
    "Memory frontmatter must contain bounded string lists for tags and aliases",
  );
}

export function memoryLookupKey(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function frontmatter(source: string) {
  const start = /^---\r?\n/.exec(source);
  if (!start) return { tags: [], aliases: [], body: source };
  const remaining = source.slice(start[0].length);
  const end = /^---[ \t]*(?:\r?\n|$)/m.exec(remaining);

  if (!end || end.index > maxYamlChars) throw invalidYaml();
  const doc = parseDocument(remaining.slice(0, end.index), {
    version: "1.2",
    uniqueKeys: true,
    prettyErrors: false,
    merge: false,
  });

  if (
    doc.errors.length ||
    doc.warnings.length ||
    (doc.contents !== null && !isMap(doc.contents))
  )
    throw invalidYaml();
  visit(doc, {
    Node(_, node) {
      if (
        isAlias(node) ||
        ("anchor" in node && node.anchor) ||
        ("tag" in node && node.tag)
      )
        throw invalidYaml();
    },
  });

  function list(key: "tags" | "aliases"): string[] {
    const seq = doc.get(key, true);
    if (seq === undefined) return [];
    if (!isSeq(seq) || seq.items.length > maxMetadataItems) throw invalidYaml();
    const values = new Map<string, string>();

    for (const item of seq.items) {
      if (!isScalar(item) || typeof item.value !== "string")
        throw invalidYaml();
      const clean = (key === "tags" ? item.value.replace(/^#/, "") : item.value)
        .normalize("NFC")
        .trim();
      const lookup = memoryLookupKey(clean);

      if (
        !lookup ||
        Buffer.byteLength(clean) > 192 ||
        (key === "tags" && lookup.length > 128) ||
        /[\p{Cc}\p{Cs}\[\]]/u.test(clean)
      )
        throw invalidYaml();
      if (!values.has(lookup))
        values.set(lookup, key === "tags" ? lookup : clean);
    }

    return [...values.values()];
  }

  return {
    tags: list("tags"),
    aliases: list("aliases"),
    body: remaining.slice(end.index + end[0].length),
  };
}

const entityForms = [
  { kind: "task", match: /^task:([A-Z][A-Z0-9_-]{0,63}-[1-9][0-9]{0,9})$/ },
  { kind: "run", match: /^run:([A-Za-z0-9_.-]{1,192})$/ },
  { kind: "brain", match: /^brain:item\/([A-Za-z0-9_.-]{1,192})$/ },
  {
    kind: "knowledge",
    match: /^knowledge:([A-Za-z0-9_.-]{1,192})@([1-9][0-9]{0,9})$/,
  },
  { kind: "repo", match: /^repo:([^#%\\:?]+)#L([1-9][0-9]{0,9})$/ },
] as const;

function linkFrom(raw: string): MemoryLink {
  const target = raw.normalize("NFC").trim();

  for (const entity of entityForms) {
    const parts = entity.match.exec(target);
    if (!parts) continue;
    if (
      entity.kind === "repo" &&
      parts[1]!
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      break;

    return {
      raw,
      kind: entity.kind,
      target: parts[1]!,
      fragment: parts[2] ?? null,
    };
  }
  const separator = target.indexOf("#");
  const name = separator < 0 ? target : target.slice(0, separator).trim();
  const heading =
    separator < 0 ? null : memoryLookupKey(target.slice(separator + 1));

  if (
    !name ||
    (!heading && separator >= 0) ||
    /[:%?\\|]/.test(name) ||
    name.split("/").some((part) => part === "." || part === "..")
  )
    return { raw, kind: "unresolved", target, fragment: null };

  return { raw, kind: "note", target: name, fragment: heading };
}

export function parseMemoryStructure(source: string): MemoryStructure {
  const { tags, aliases, body } = frontmatter(source);
  const headings = new Set<string>();
  const links = new Map<string, MemoryLink>();
  let fence: string | null = null;

  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (fence !== null) {
      if (
        marker &&
        marker[1]?.[0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1]!;
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading && headings.size < 512) headings.add(memoryLookupKey(heading));
    for (const [, raw] of line.matchAll(
      /(?<!\\)\[\[([^\[\]\r\n]{1,512})\]\]/g,
    )) {
      if (Buffer.byteLength(raw) > 512 || /[\p{Cc}\p{Cs}]/u.test(raw)) continue;
      if (links.size >= maxLinks && !links.has(raw))
        throw new MaisterError(
          "CONFIG",
          "Memory note has too many link targets",
        );
      if (!links.has(raw)) links.set(raw, linkFrom(raw));
    }
  }

  return {
    tags,
    aliases,
    headings: [...headings],
    links: [...links.values()],
    body,
  };
}
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";

import { MaisterError } from "@/lib/errors-core";
