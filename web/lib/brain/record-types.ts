export const KNOWLEDGE_KINDS = [
  "assertion",
  "observation",
  "decision",
  "procedure",
  "lesson",
  "state_fact",
  "direction",
] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeBasis = "observed" | "inferred" | "unknown";

export type KnowledgeAttribution = Readonly<{
  kind: "user" | "agent" | "system" | "legacy_unknown";
  id: string | null;
  runId: string | null;
  attemptId: string | null;
}>;

export type KnowledgeFreshness = Readonly<{
  state: "current" | "stale" | "unknown";
  applicability: "known" | "unknown";
  observedAt: string | null;
  sourceAt: string | null;
  capturedAt: string;
}>;
