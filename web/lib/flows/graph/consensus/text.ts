import type { ArtifactTextBounds } from "@/lib/db/schema";

export const CONSENSUS_PROMPT_TEXT_CAP_BYTES = 64 * 1024;
export const CONSENSUS_DRAFT_OUTPUT_CAP_BYTES = 1024 * 1024;
export const CONSENSUS_GENERATION_OUTPUT_CAP_BYTES = 1024 * 1024;
export const CONSENSUS_EXCERPT_CAP_BYTES = 32_000;

export type ConsensusTextBounds = Readonly<ArtifactTextBounds>;

export type BoundedConsensusText = Readonly<{
  text: string;
  truncated: boolean;
  bounds: ConsensusTextBounds;
}>;

export type RetainedConsensusOutput = Readonly<{
  text: string;
  retainedBytes: number;
  droppedBytes: number;
  pendingHighSurrogate?: string;
}>;

/** Retain generation evidence up to its byte budget, counting later chunks. */
export function retainConsensusOutput(
  current: RetainedConsensusOutput,
  chunk: string,
  cap: number,
): RetainedConsensusOutput {
  const joined = `${current.pendingHighSurrogate ?? ""}${chunk}`;
  const last = joined.charCodeAt(joined.length - 1);
  const hasPendingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  const pendingHighSurrogate = hasPendingHighSurrogate
    ? joined.slice(-1)
    : undefined;
  const completeChunk = hasPendingHighSurrogate ? joined.slice(0, -1) : joined;

  if (current.droppedBytes > 0)
    return {
      text: current.text,
      retainedBytes: current.retainedBytes,
      droppedBytes:
        current.droppedBytes + Buffer.byteLength(completeChunk, "utf8"),
      ...(pendingHighSurrogate ? { pendingHighSurrogate } : {}),
    };
  let retainedBytes = current.retainedBytes;
  let retainedUnits = 0;

  for (const point of completeChunk) {
    const pointBytes = Buffer.byteLength(point, "utf8");

    if (retainedBytes + pointBytes > cap) break;
    retainedBytes += pointBytes;
    retainedUnits += point.length;
  }

  return {
    text: current.text + completeChunk.slice(0, retainedUnits),
    retainedBytes,
    droppedBytes:
      current.droppedBytes +
      Buffer.byteLength(completeChunk.slice(retainedUnits), "utf8"),
    ...(pendingHighSurrogate ? { pendingHighSurrogate } : {}),
  };
}

/** Flush a lone final surrogate as upstream text; a valid split pair was joined earlier. */
export function finishConsensusOutput(
  current: RetainedConsensusOutput,
  cap: number,
): RetainedConsensusOutput {
  const pending = current.pendingHighSurrogate;

  if (!pending) return current;
  const pendingBytes = Buffer.byteLength(pending, "utf8");

  return current.droppedBytes > 0 || current.retainedBytes + pendingBytes > cap
    ? {
        text: current.text,
        retainedBytes: current.retainedBytes,
        droppedBytes: current.droppedBytes + pendingBytes,
      }
    : {
        text: current.text + pending,
        retainedBytes: current.retainedBytes + pendingBytes,
        droppedBytes: current.droppedBytes,
      };
}

/** Keep the longest Unicode-code-point prefix that fits with its exact marker. */
export function boundConsensusText(
  value: string,
  cap: number,
): BoundedConsensusText {
  const bytes = Buffer.byteLength(value, "utf8");

  if (bytes <= cap)
    return {
      text: value,
      truncated: false,
      bounds: { bytes, retainedBytes: bytes, droppedBytes: 0, cap },
    };

  let retainedBytes = 0;
  let retainedUnits = 0;
  let prefixBytes = 0;
  let prefixUnits = 0;

  // prefix + marker never shrinks: each code point adds >= 1 byte while the
  // dropped count can lose at most one digit, so the first misfit ends the scan.
  for (const point of value) {
    prefixBytes += Buffer.byteLength(point, "utf8");
    prefixUnits += point.length;
    const droppedBytes = bytes - prefixBytes;
    const marker = `\n[consensus text truncated: dropped ${droppedBytes} UTF-8 bytes; cap ${cap} bytes]`;

    if (prefixBytes + Buffer.byteLength(marker, "utf8") > cap) break;
    retainedBytes = prefixBytes;
    retainedUnits = prefixUnits;
  }

  const droppedBytes = bytes - retainedBytes;
  const marker = `\n[consensus text truncated: dropped ${droppedBytes} UTF-8 bytes; cap ${cap} bytes]`;

  if (Buffer.byteLength(marker, "utf8") > cap)
    throw new RangeError(`consensus text cap ${cap} cannot fit its marker`);

  return {
    text: value.slice(0, retainedUnits) + marker,
    truncated: true,
    bounds: { bytes, retainedBytes, droppedBytes, cap },
  };
}

/** The stop reason a consensus owner records for a turn: the host's own value
 * when it settled, never an invented `end_turn`. */
export function consensusTurnStopReason(outcome: {
  state: string;
  response?: { stopReason?: unknown };
}): string {
  if (outcome.state !== "succeeded") return "host_failure";

  return typeof outcome.response?.stopReason === "string"
    ? outcome.response.stopReason
    : "stop_reason_unavailable";
}
