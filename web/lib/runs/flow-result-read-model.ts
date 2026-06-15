import "server-only";

import pino from "pino";

import {
  buildFlowRunResultDto,
  type BuildFlowRunResultDtoInput,
  type FlowRunResultDto,
} from "@/lib/runs/flow-result-dto";

const log = pino({
  name: "flow-result-read-model",
  level: process.env.LOG_LEVEL ?? "info",
});

export function buildFlowRunResultReadModel(
  input: BuildFlowRunResultDtoInput,
): FlowRunResultDto {
  const dto = buildFlowRunResultDto(input);

  log.debug(
    {
      runId: dto.run.runId,
      projectId: dto.run.projectId,
      runKind: dto.run.runKind,
      graphPresent: dto.graph.kind === "ready",
      nodeCount: dto.graph.nodeCount,
      selectedNodeId: dto.graph.selectedNodeId,
    },
    "[flow-result-read-model] built",
  );

  for (const code of dto.degradations) {
    log.warn(
      {
        runId: dto.run.runId,
        projectId: dto.run.projectId,
        runKind: dto.run.runKind,
        code,
      },
      "[flow-result-read-model] degraded optional data",
    );
  }

  return dto;
}
