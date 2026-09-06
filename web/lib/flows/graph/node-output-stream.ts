import type { RawNodeOutputPayload } from "./node-output";

import { extractSentinelBlock } from "./node-output";

const OPEN = "```json maister:output";
const CLOSE = "```";

export type SentinelOutput = Readonly<{
  openMatch: number;
  closeMatch: number;
  line: string | null;
  inBlock: boolean;
  block: string | null;
  blockHasLine: boolean;
  payload: RawNodeOutputPayload;
}>;

export function emptySentinelOutput(): SentinelOutput {
  return {
    openMatch: 0,
    closeMatch: 0,
    line: "",
    inBlock: false,
    block: "",
    blockHasLine: false,
    payload: { kind: "absent" },
  };
}

// Match the existing whole-line fence grammar without retaining arbitrarily
// long whitespace. Position length + 1 means a final optional carriage return.
function advanceFence(position: number, marker: string, char: string): number {
  if (position < 0 || position > marker.length) return -1;
  if (position < marker.length)
    return char === marker[position] ? position + 1 : -1;
  if (char === " " || char === "\t") return position;

  return char === "\r" ? position + 1 : -1;
}

function appendBounded(
  current: string | null,
  part: string | null,
  maxBytes: number,
): string | null {
  // UTF-16 code units never exceed their UTF-8 byte length. This bounds storage
  // before allocation; the existing parser enforces the precise UTF-8 limit.
  return current !== null &&
    part !== null &&
    current.length + part.length <= maxBytes
    ? current + part
    : null;
}

function finishLine(state: SentinelOutput, maxBytes: number): SentinelOutput {
  const reset = { ...state, line: "", openMatch: 0, closeMatch: 0 };

  if (!state.inBlock) {
    return state.openMatch >= OPEN.length
      ? { ...reset, inBlock: true, block: "", blockHasLine: false }
      : reset;
  }
  if (state.closeMatch >= CLOSE.length) {
    const payload: RawNodeOutputPayload =
      state.block === null
        ? {
            kind: "invalid",
            reason: `maister:output block exceeds MAISTER_NODE_OUTPUT_MAX_BYTES (${maxBytes})`,
          }
        : extractSentinelBlock(`${OPEN}\n${state.block}\n${CLOSE}`, maxBytes);

    return {
      ...reset,
      inBlock: false,
      block: "",
      blockHasLine: false,
      payload,
    };
  }

  return {
    ...reset,
    block: appendBounded(
      state.block,
      state.line === null
        ? null
        : `${state.blockHasLine ? "\n" : ""}${state.line}`,
      maxBytes,
    ),
    blockHasLine: true,
  };
}

/** Consume original semantic text, independently of the stdout preview. Only
 * the current bounded line/block and last complete result are retained. An
 * oversized final block is invalid; an unterminated block cannot replace the
 * last complete one. Chunk boundaries do not change fence or JSON semantics.
 */
export function appendSentinelOutput(
  previous: SentinelOutput,
  chunk: string,
  maxBytes: number,
): SentinelOutput {
  let state = previous;
  let start = 0;
  let openMatch = state.openMatch;
  let closeMatch = state.closeMatch;

  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];

    if (char !== "\n") {
      openMatch = advanceFence(openMatch, OPEN, char);
      closeMatch = advanceFence(closeMatch, CLOSE, char);
      continue;
    }
    state = finishLine(
      {
        ...state,
        openMatch,
        closeMatch,
        line: appendBounded(state.line, chunk.slice(start, index), maxBytes),
      },
      maxBytes,
    );
    openMatch = 0;
    closeMatch = 0;
    start = index + 1;
  }

  return {
    ...state,
    openMatch,
    closeMatch,
    line: appendBounded(state.line, chunk.slice(start), maxBytes),
  };
}

export function finishSentinelOutput(
  state: SentinelOutput,
  maxBytes: number,
): RawNodeOutputPayload {
  return finishLine(state, maxBytes).payload;
}
