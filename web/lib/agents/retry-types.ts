import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { AgentTriggerSource } from "@/lib/agents/launch";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

export type AgentRetryRecipe = {
  version: 1;
  agentId: string;
  projectId: string;
  taskId: string | null;
  taskRevision: number | null;
  definition: EffectiveAgentDefinition;
  configuration: Record<string, string | number | boolean>;
  trigger: {
    source: AgentTriggerSource;
    eventId: number | null;
    payload: Record<string, unknown> | null;
  };
  runner: RunnerSnapshot;
  policy: ExecutionPolicy;
};

export type AgentRetryAllocation = {
  version: 1;
  generation: number;
  resources: Array<{
    kind: "worktree" | "plain_directory" | "ephemeral_checkout";
    path: string;
    repositoryPath: string;
    branch: string | null;
    provenanceDigest: string;
  }>;
  disposition: "armed" | "released" | "exhausted";
  revision: number;
  attempts: number;
  dueAt: string | null;
  errorCode: string | null;
};
