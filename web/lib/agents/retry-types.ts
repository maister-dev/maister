import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { AgentTriggerSource } from "@/lib/agents/launch";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

export type AgentRetryStrategy = "pre_work_retry" | "fresh_qualification";

type AgentRetryRecipeFields = {
  scheduledRequestSnapshot?: ScheduledAgentRequestSnapshot;
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
  contextDigest: string;
  project: {
    mainBranch: string;
    branchPrefix: string | null;
    branchBase: string | null;
  };
};

export type AgentRetryRecipe = AgentRetryRecipeFields &
  (
    | { version: 1 }
    | {
        version: 2;
        strategy: AgentRetryStrategy;
        qualificationSha: string | null;
      }
  );

export function retryRecipeStrategy(
  recipe: AgentRetryRecipe,
): AgentRetryStrategy {
  return recipe.version === 2 ? recipe.strategy : "pre_work_retry";
}

export type AgentRetryAllocation = {
  version: 1;
  generation: number;
  resources: Array<{
    kind: "worktree" | "plain_directory" | "ephemeral_checkout";
    path: string;
    repositoryPath: string;
    branch: string | null;
    provenanceDigest: string;
    baseCommit: string | null;
    preservation?: {
      branch: string | null;
      commit: string | null;
      outcome: string;
    };
  }>;
  disposition: "armed" | "released" | "exhausted";
  revision: number;
  attempts: number;
  dueAt: string | null;
  errorCode: string | null;
  rearmReceipt?: { requestKey: string; expectedRevision: number };
};

export type AgentRetryClaim = {
  intentId: string;
  owner: string;
  fence: number;
};
