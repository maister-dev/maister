import type {
  KnowledgeAccessRestriction,
  VaultRevisionRestriction,
} from "@/lib/company/types";

export type AgentMemoryAuthor =
  | Readonly<{ kind: "human"; userId: string }>
  | Readonly<{
      kind: "librarian";
      userId: string;
      turnId: string;
      cardId: string;
      operationId: string;
    }>
  | Readonly<{
      kind: "agent_session";
      agentId: string;
      runId: string;
      sessionKey: string;
      nodeAttemptId: string | null;
    }>
  | Readonly<{ kind: "operator_import"; userId: string }>;

export type AgentMemoryRestriction =
  | KnowledgeAccessRestriction
  | Readonly<{ kind: "legacy_project_private"; projectId: string }>;

export type AgentMemoryTreeDescriptor = Readonly<{
  paths: readonly string[];
  truncated: boolean;
  references?: readonly VaultRevisionRestriction[];
}>;

export type AgentMemoryHashFormat = "legacy-file-v1" | "vault-manifest-v1";
