import "server-only";

import pino from "pino";

import {
  launchAgentRun,
  type LaunchAgentRunResult,
} from "@/lib/agents/launch";
import { EXPERIMENT_JUDGE_AGENT_ID } from "@/lib/experiments/constants";

const log = pino({
  name: "experiments-judge",
  level: process.env.LOG_LEVEL ?? "info",
});

export { EXPERIMENT_JUDGE_AGENT_ID };

export async function launchExperimentJudge(args: {
  projectId: string;
  taskId: string;
  experimentId: string;
  agentId?: string;
}): Promise<LaunchAgentRunResult> {
  const agentId = args.agentId ?? EXPERIMENT_JUDGE_AGENT_ID;
  const result = await launchAgentRun({
    agentId,
    projectId: args.projectId,
    taskId: args.taskId,
    workspace: "none",
    trigger: {
      source: "manual",
      payload: { experimentId: args.experimentId },
    },
  });

  log.info(
    {
      projectId: args.projectId,
      taskId: args.taskId,
      experimentId: args.experimentId,
      agentId,
      result,
    },
    "experiment judge dispatched",
  );

  return result;
}
