import pino from "pino";

import { boundConsensusText, type BoundedConsensusText } from "./text";

const log = pino({
  name: "consensus-text",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ConsensusTextOwner = Readonly<{
  runId: string;
  nodeAttemptId: string;
  round: number;
  role: string;
  participantId: string;
  generationId?: string;
}>;

/** Bound one consensus text slot; every actual cut is a WARN without the body. */
export function boundLoggedConsensusText(
  value: string,
  cap: number,
  owner: ConsensusTextOwner,
): BoundedConsensusText {
  const bounded = boundConsensusText(value, cap);

  if (bounded.truncated)
    log.warn(
      {
        ...owner,
        bytes: bounded.bounds.bytes,
        cap: bounded.bounds.cap,
        droppedBytes: bounded.bounds.droppedBytes,
      },
      "consensus-text-truncated",
    );

  return bounded;
}
