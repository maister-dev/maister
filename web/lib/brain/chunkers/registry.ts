import { createHash } from "node:crypto";

import { parse } from "yaml";

import type {
  BrainChunkDraft,
  BrainSourceRange,
  BuiltInSourceKind,
  ChunkerInput,
  ChunkerResult,
} from "./types";

export type { BrainChunkDraft, ChunkerInput, ChunkerResult } from "./types";

const CHUNKER_VERSION = "1";
const TEXT_CHUNK_LIMIT = 4_000;

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
]);

const METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

export class ChunkerError extends Error {
  readonly sourcePath: string;
  readonly chunkerId: string;

  constructor(input: {
    sourcePath: string;
    chunkerId: string;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ChunkerError";
    this.sourcePath = input.sourcePath;
    this.chunkerId = input.chunkerId;
  }
}

export interface ChunkerRegistry {
  chunk(input: ChunkerInput): ChunkerResult;
}

export function createBuiltInChunkerRegistry(): ChunkerRegistry {
  return {
    chunk(input: ChunkerInput): ChunkerResult {
      const kind = input.kind ?? detectSourceKind(input.path);

      switch (kind) {
        case "html":
          return markdownResult(input.path, htmlToMarkdown(input.content), {
            sourceKind: "html",
          });
        case "markdown":
          return markdownResult(input.path, input.content, {
            sourceKind: "markdown",
          });
        case "openapi":
          return openApiResult(input);
        case "asyncapi":
          return asyncApiResult(input);
        case "sql":
          return sqlResult(input);
        case "flow_yaml":
          return flowYamlResult(input);
        case "package_yaml":
          return packageYamlResult(input);
        case "agent_md":
          return agentMarkdownResult(input);
        case "code":
          return codeResult(input);
        case "repo_file":
        case "text":
          return fallbackTextResult(input);
        default:
          return fallbackTextResult(input);
      }
    },
  };
}

export function detectSourceKind(path: string): BuiltInSourceKind {
  const lower = path.toLowerCase();
  const ext = extension(lower);

  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (lower.endsWith(".md")) return lower.endsWith("agent.md") ? "agent_md" : "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith("flow.yaml") || lower.endsWith("flow.yml")) return "flow_yaml";
  if (
    lower.endsWith("maister-package.yaml") ||
    lower.endsWith("maister-package.yml")
  ) {
    return "package_yaml";
  }
  if (lower.includes("asyncapi") && (ext === ".yaml" || ext === ".yml")) {
    return "asyncapi";
  }
  if (lower.includes("openapi") && (ext === ".yaml" || ext === ".yml")) {
    return "openapi";
  }

  return "text";
}

export function defaultChunkerIdForKind(kind: BuiltInSourceKind): string {
  switch (kind) {
    case "html":
    case "markdown":
      return "markdown";
    case "openapi":
      return "openapi";
    case "asyncapi":
      return "asyncapi";
    case "sql":
      return "sql";
    case "flow_yaml":
      return "flow_yaml";
    case "package_yaml":
      return "package_yaml";
    case "agent_md":
      return "agent_md";
    case "code":
      return "code";
    case "repo_file":
    case "text":
      return "fallback_text";
  }
}

function extension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");

  if (lastDot <= lastSlash) return "";

  return path.slice(lastDot);
}

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function lineRange(content: string, startLine: number): BrainSourceRange {
  const lineCount = Math.max(content.split("\n").length, 1);

  return { startLine, endLine: startLine + lineCount - 1 };
}

function makeChunk(input: {
  path: string;
  kind: string;
  title: string;
  content: string;
  sourceRange: BrainSourceRange;
  symbol?: string;
  metadata?: Record<string, unknown>;
  stableSeed?: string;
}): BrainChunkDraft {
  const symbol = input.symbol;
  const stableSeed =
    input.stableSeed ?? `${input.path}:${input.kind}:${symbol ?? input.title}`;

  return {
    kind: input.kind,
    title: input.title,
    path: input.path,
    symbol,
    content: input.content,
    metadata: input.metadata ?? {},
    sourceRange: input.sourceRange,
    stableId: `${input.path}#${input.kind}:${sha(stableSeed)}`,
  };
}

function result(
  chunkerId: string,
  chunks: BrainChunkDraft[],
): ChunkerResult {
  return { chunkerId, chunkerVersion: CHUNKER_VERSION, chunks };
}

function markdownResult(
  path: string,
  content: string,
  metadata: Record<string, unknown>,
): ChunkerResult {
  const chunks = splitMarkdownSections(path, content).map((section) =>
    makeChunk({
      path,
      kind: "markdown_section",
      title: section.title,
      symbol: section.title,
      content: section.content,
      sourceRange: lineRange(section.content, section.startLine),
      metadata,
      stableSeed: section.title,
    }),
  );

  return result("markdown", chunks);
}

function splitMarkdownSections(
  path: string,
  content: string,
): Array<{ title: string; content: string; startLine: number }> {
  const lines = content.split("\n");
  const headings: Array<{ index: number; title: string }> = [];

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());

    if (match) headings.push({ index, title: match[2].trim() });
  });

  if (headings.length === 0) {
    return [
      {
        title: path,
        content: content.trim(),
        startLine: 1,
      },
    ];
  }

  return headings.map((heading, index) => {
    const next = headings[index + 1]?.index ?? lines.length;
    const body = lines.slice(heading.index, next).join("\n").trim();

    return {
      title: heading.title,
      content: body,
      startLine: heading.index + 1,
    };
  });
}

function htmlToMarkdown(content: string): string {
  return content
    .replace(/<h1[^>]*>(.*?)<\/h1>/gis, "# $1\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gis, "## $1\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gis, "### $1\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gis, "$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseYamlObject(input: ChunkerInput, chunkerId: string): unknown {
  try {
    return parse(input.content);
  } catch (cause) {
    throw new ChunkerError({
      sourcePath: input.path,
      chunkerId,
      message: `Failed to parse ${input.path} as ${chunkerId}`,
      cause,
    });
  }
}

function openApiResult(input: ChunkerInput): ChunkerResult {
  const doc = parseYamlObject(input, "openapi") as {
    paths?: Record<string, Record<string, { operationId?: string }>>;
  };
  const chunks: BrainChunkDraft[] = [];

  for (const [apiPath, operations] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations ?? {})) {
      if (!METHODS.has(method.toLowerCase())) continue;
      const symbol = operation.operationId ?? `${method.toUpperCase()} ${apiPath}`;

      chunks.push(
        makeChunk({
          path: input.path,
          kind: "openapi_operation",
          title: symbol,
          symbol,
          content: `${method.toUpperCase()} ${apiPath}\n${JSON.stringify(operation)}`,
          sourceRange: lineRange(input.content, 1),
          metadata: { method, apiPath },
          stableSeed: `${method}:${apiPath}`,
        }),
      );
    }
  }

  return result("openapi", chunks.length > 0 ? chunks : [fallbackChunk(input)]);
}

function asyncApiResult(input: ChunkerInput): ChunkerResult {
  const doc = parseYamlObject(input, "asyncapi") as {
    channels?: Record<string, Record<string, { operationId?: string }>>;
  };
  const chunks: BrainChunkDraft[] = [];

  for (const [channel, operations] of Object.entries(doc.channels ?? {})) {
    for (const [opName, operation] of Object.entries(operations ?? {})) {
      const symbol = operation.operationId ?? `${opName} ${channel}`;

      chunks.push(
        makeChunk({
          path: input.path,
          kind: "asyncapi_operation",
          title: symbol,
          symbol,
          content: `${opName} ${channel}\n${JSON.stringify(operation)}`,
          sourceRange: lineRange(input.content, 1),
          metadata: { channel, operation: opName },
          stableSeed: `${opName}:${channel}`,
        }),
      );
    }
  }

  return result("asyncapi", chunks.length > 0 ? chunks : [fallbackChunk(input)]);
}

function sqlResult(input: ChunkerInput): ChunkerResult {
  const statements = input.content
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const chunks = statements.map((statement, index) =>
    makeChunk({
      path: input.path,
      kind: "sql_statement",
      title: statement.split("\n")[0]?.slice(0, 120) ?? `SQL ${index + 1}`,
      symbol: `statement_${index + 1}`,
      content: `${statement};`,
      sourceRange: lineRange(statement, 1),
      metadata: { ordinal: index },
      stableSeed: `${index}:${statement}`,
    }),
  );

  return result("sql", chunks.length > 0 ? chunks : [fallbackChunk(input)]);
}

function flowYamlResult(input: ChunkerInput): ChunkerResult {
  const doc = parseYamlObject(input, "flow_yaml") as {
    nodes?: Array<{ id?: string; type?: string }>;
  };
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const chunks = nodes.map((node, index) => {
    const id = node.id ?? `node_${index + 1}`;

    return makeChunk({
      path: input.path,
      kind: "flow_node",
      title: id,
      symbol: id,
      content: JSON.stringify(node),
      sourceRange: lineRange(input.content, 1),
      metadata: { type: node.type ?? "unknown", ordinal: index },
      stableSeed: id,
    });
  });

  return result("flow_yaml", chunks.length > 0 ? chunks : [fallbackChunk(input)]);
}

function packageYamlResult(input: ChunkerInput): ChunkerResult {
  const doc = parseYamlObject(input, "package_yaml") as {
    flows?: Array<{ id?: string }>;
    agents?: Array<{ id?: string }>;
  };
  const entries = [
    ...(doc.flows ?? []).map((entry) => ({ ...entry, entryKind: "flow" })),
    ...(doc.agents ?? []).map((entry) => ({ ...entry, entryKind: "agent" })),
  ];
  const chunks = entries.map((entry, index) => {
    const id = entry.id ?? `${entry.entryKind}_${index + 1}`;

    return makeChunk({
      path: input.path,
      kind: "package_entry",
      title: id,
      symbol: id,
      content: JSON.stringify(entry),
      sourceRange: lineRange(input.content, 1),
      metadata: { entryKind: entry.entryKind, ordinal: index },
      stableSeed: `${entry.entryKind}:${id}`,
    });
  });

  return result("package_yaml", chunks.length > 0 ? chunks : [fallbackChunk(input)]);
}

function agentMarkdownResult(input: ChunkerInput): ChunkerResult {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(input.content);
  const body = match ? match[2] : input.content;
  const frontmatter = match ? parseYamlObject(
    { ...input, content: match[1], kind: "agent_md" },
    "agent_md",
  ) : {};
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();

  return result("agent_md", [
    makeChunk({
      path: input.path,
      kind: "agent_doc",
      title: h1 ?? input.path,
      symbol:
        typeof frontmatter === "object" &&
        frontmatter !== null &&
        "id" in frontmatter
          ? String(frontmatter.id)
          : h1,
      content: body.trim(),
      sourceRange: lineRange(input.content, 1),
      metadata: { frontmatter },
      stableSeed: `${input.path}:${h1 ?? ""}`,
    }),
  ]);
}

function codeResult(input: ChunkerInput): ChunkerResult {
  const lines = input.content.split("\n");
  const symbols: Array<{ line: number; symbol: string }> = [];

  lines.forEach((line, index) => {
    const match =
      /\bfunction\s+([A-Za-z0-9_]+)/.exec(line) ??
      /\bdef\s+([A-Za-z0-9_]+)/.exec(line) ??
      /\bfn\s+([A-Za-z0-9_]+)/.exec(line) ??
      /\bfunc\s+([A-Za-z0-9_]+)/.exec(line) ??
      /\bclass\s+([A-Za-z0-9_]+)/.exec(line);

    if (match) symbols.push({ line: index, symbol: match[1] });
  });

  const chunks =
    symbols.length > 0
      ? symbols.map((symbol, index) => {
          const next = symbols[index + 1]?.line ?? lines.length;
          const content = lines.slice(symbol.line, next).join("\n").trim();

          return makeChunk({
            path: input.path,
            kind: "code_symbol",
            title: symbol.symbol,
            symbol: symbol.symbol,
            content,
            sourceRange: lineRange(content, symbol.line + 1),
            metadata: { language: extension(input.path).slice(1) },
            stableSeed: symbol.symbol,
          });
        })
      : [fallbackChunk(input, { kind: "code_symbol" })];

  return result("code", chunks);
}

function fallbackTextResult(input: ChunkerInput): ChunkerResult {
  const chunks: BrainChunkDraft[] = [];

  for (let offset = 0; offset < input.content.length; offset += TEXT_CHUNK_LIMIT) {
    const content = input.content.slice(offset, offset + TEXT_CHUNK_LIMIT).trim();

    if (!content) continue;
    chunks.push(
      makeChunk({
        path: input.path,
        kind: "text",
        title: input.path,
        content,
        sourceRange: lineRange(content, 1),
        metadata: { fallback: true, ordinal: chunks.length },
        stableSeed: `${offset}:${content}`,
      }),
    );
  }

  return result("fallback_text", chunks.length > 0 ? chunks : [fallbackChunk(input)]);
}

function fallbackChunk(
  input: ChunkerInput,
  opts: { kind?: string } = {},
): BrainChunkDraft {
  const content = input.content.trim();

  return makeChunk({
    path: input.path,
    kind: opts.kind ?? "text",
    title: input.path,
    content,
    sourceRange: lineRange(content, 1),
    metadata: { fallback: true },
    stableSeed: content,
  });
}
