import type {
  StreamLagArithmetic,
  StreamLagDiagnostic,
} from "@/types/execution-host-observability";

const MAX_SEQUENCE = (1n << 63n) - 1n;
const CANONICAL_SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;

export const LAG_BACKLOG_THRESHOLD = 100n;
export const LAG_CONSECUTIVE_SWEEPS = 3;

function parseSequence(value: string | null): bigint {
  if (value === null) return -1n;
  if (!CANONICAL_SEQUENCE.test(value)) {
    throw new RangeError(`sequence ${JSON.stringify(value)} is not canonical`);
  }
  const parsed = BigInt(value);

  if (parsed > MAX_SEQUENCE) {
    throw new RangeError(
      `sequence ${JSON.stringify(value)} exceeds signed BIGINT`,
    );
  }

  return parsed;
}

function nonnegativeDistance(a: bigint, b: bigint): string {
  return (a > b ? a - b : 0n).toString();
}

export function calculateStreamLag(
  input: Readonly<{
    headSequence: string | null;
    lastReceivedSequence: string | null;
    lastContiguousSequence: string | null;
    lastAckConfirmedSequence: string | null;
  }>,
): StreamLagArithmetic {
  const head = parseSequence(input.headSequence);
  const received = parseSequence(input.lastReceivedSequence);
  const contiguous = parseSequence(input.lastContiguousSequence);
  const acknowledged = parseSequence(input.lastAckConfirmedSequence);
  const diagnostics: StreamLagDiagnostic[] = [];

  if (head < received) diagnostics.push("host_head_behind_manager");
  if (contiguous > received) diagnostics.push("contiguous_ahead_of_received");
  if (acknowledged > contiguous) diagnostics.push("ack_ahead_of_contiguous");

  return {
    hostToManager: head < received ? null : nonnegativeDistance(head, received),
    contiguityGap:
      contiguous > received ? null : nonnegativeDistance(received, contiguous),
    ackConfirmation:
      acknowledged > contiguous
        ? null
        : nonnegativeDistance(contiguous, acknowledged),
    diagnostics,
  };
}

export function calculateConsumerBacklog(
  input: Readonly<{
    runHorizonSequence: string | null;
    lastRunSequence: string | null;
  }>,
): string {
  return nonnegativeDistance(
    parseSequence(input.runHorizonSequence),
    parseSequence(input.lastRunSequence),
  );
}
