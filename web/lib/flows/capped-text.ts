// ADR-165 (T5.3): the ONE bounded text accumulator for agent stdout capture.
// Extracted verbatim from `runner-agent.ts` so the flow-node path and the
// standalone-agent path share it — a second copy would be the shape where one
// side's cap silently drifts from the other's and a sentinel block that fits on
// one path is truncated away on the other.

/** Default capture ceiling (1 MiB), matching the flow-node path's historic cap. */
export const STDOUT_CAP_BYTES = 1_000_000;

/**
 * Append `chunk` to `buf`, keeping the FIRST `cap` characters.
 *
 * Keeping the head rather than the tail is deliberate and load-bearing for the
 * sentinel contract: a `maister:output` block whose closing fence was pushed
 * past the cap is not a properly-fenced block, so it reads as ABSENT — which is
 * a state the caller handles — instead of as a truncated block that would parse
 * into a plausible-looking wrong value.
 */
export function appendCapped(
  buf: string,
  chunk: string,
  cap: number = STDOUT_CAP_BYTES,
): string {
  if (buf.length + chunk.length > cap) {
    const remaining = Math.max(0, cap - buf.length);

    return buf + chunk.slice(0, remaining);
  }

  return buf + chunk;
}

/** True when `buf` has reached its ceiling, so later chunks were dropped. */
export function isCappedTextTruncated(
  buf: string,
  cap: number = STDOUT_CAP_BYTES,
): boolean {
  return buf.length >= cap;
}
