import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { AgentTriggerSource } from "@/lib/agents/launch";
import type { CompanyConfigurationReference } from "@/lib/agents/trigger-attempt-types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type {
  ProjectCronAppointment,
  ProjectEventAppointment,
} from "@/lib/specialist-assignments/project-source-types";

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

type SpecialistReplacementWitness = {
  sourceRunId: string;
  assignmentRevision: number;
  contextRevision: number;
  ownerEpoch: number;
  resultSha256: string;
  sourceSha256: string;
};

export type ProjectSpecialistReplacement = SpecialistReplacementWitness & {
  assignmentId: string;
  inputRevision: number;
  inputSha256: string;
  cron?: ProjectCronAppointment;
  event?: ProjectEventAppointment;
};

export type ProjectAgentRetryRecipe = AgentRetryRecipeFields &
  (
    | { version: 1 }
    | {
        version: 2;
        strategy: AgentRetryStrategy;
        qualificationSha: string | null;
        replacement?: ProjectSpecialistReplacement;
      }
  );

export type CompanyAgentRetryRecipe = Omit<
  AgentRetryRecipeFields,
  "projectId" | "taskId" | "taskRevision" | "project"
> & {
  version: 3;
  strategy: "pre_work_retry";
  owner: { kind: "company"; companyId: string };
  projectId: null;
  taskId: null;
  taskRevision: null;
  project: null;
  specialistBinding: CompanyConfigurationReference;
  coordinatorFlowBinding: CompanyConfigurationReference | null;
  assignment: { id: string; inputRevision: number; inputSha256: string };
  replacement?: SpecialistReplacementWitness & { sessionsSha256?: string };
};

export type AgentRetryRecipe =
  ProjectAgentRetryRecipe | CompanyAgentRetryRecipe;

export function retryRecipeStrategy(
  recipe: AgentRetryRecipe,
): AgentRetryStrategy {
  return recipe.version !== 1 ? recipe.strategy : "pre_work_retry";
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
