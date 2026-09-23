import type { ArtifactLocator } from "@/lib/db/schema";
import type { ConsensusTextBounds } from "./text";

export type ConsensusLocatorMeta = Readonly<{
  partial: boolean;
  stopReason: string | null;
  reason: string | null;
  truncated: boolean;
  textBounds?: ConsensusTextBounds;
  inputTextBounds?: ConsensusTextBounds;
}>;

/** Byte bounds read from stored JSON; anything malformed is dropped, never
 * trusted, because the accounting it carries is shown as evidence. */
export function decodeConsensusTextBounds(
  value: unknown,
): ConsensusTextBounds | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { bytes, retainedBytes, droppedBytes, cap } = value as Record<
    string,
    unknown
  >;
  const counts = [bytes, retainedBytes, droppedBytes, cap];

  if (
    !counts.every(
      (count) =>
        typeof count === "number" && Number.isInteger(count) && count >= 0,
    ) ||
    (bytes as number) !== (retainedBytes as number) + (droppedBytes as number)
  )
    return undefined;

  return {
    bytes: bytes as number,
    retainedBytes: retainedBytes as number,
    droppedBytes: droppedBytes as number,
    cap: cap as number,
  };
}

/** The P0-5 metadata an inline consensus artifact may carry. Legacy locators
 * have none of it, which reads as "not recorded", never as a claim. */
export function decodeConsensusLocatorMeta(
  locator: ArtifactLocator | null | undefined,
): ConsensusLocatorMeta | null {
  if (locator?.kind !== "inline") return null;
  const textBounds = decodeConsensusTextBounds(locator.textBounds);
  const inputTextBounds = decodeConsensusTextBounds(locator.inputTextBounds);

  return {
    partial: locator.partial === true,
    stopReason:
      typeof locator.stopReason === "string" ? locator.stopReason : null,
    reason: typeof locator.reason === "string" ? locator.reason : null,
    truncated: locator.truncated === true,
    ...(textBounds ? { textBounds } : {}),
    ...(inputTextBounds ? { inputTextBounds } : {}),
  };
}
