export type BuiltInSourceKind =
  | "repo_file"
  | "markdown"
  | "html"
  | "openapi"
  | "asyncapi"
  | "sql"
  | "flow_yaml"
  | "package_yaml"
  | "agent_md"
  | "code"
  | "text";

export interface BrainSourceRange {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface BrainChunkDraft {
  kind: string;
  title: string;
  path: string;
  symbol: string | undefined;
  content: string;
  metadata: Record<string, unknown>;
  sourceRange: BrainSourceRange;
  stableId: string;
}

export interface ChunkerInput {
  path: string;
  content: string;
  kind?: BuiltInSourceKind;
}

export interface ChunkerResult {
  chunkerId: string;
  chunkerVersion: string;
  chunks: BrainChunkDraft[];
}
