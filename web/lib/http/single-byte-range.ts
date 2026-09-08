import { MaisterError } from "@/lib/errors";

const SINGLE_BYTE_RANGE = /^bytes=(\d+)-(\d*)$/;

export type ByteRange = Readonly<{ start: number; end?: number }>;
export type ByteRangeErrorMessages = Readonly<{
  syntax: string;
  bounds: string;
}>;

export function parseSingleByteRange(
  value: string | null,
  messages: ByteRangeErrorMessages,
): ByteRange | undefined {
  if (!value) return undefined;
  const match = SINGLE_BYTE_RANGE.exec(value);

  if (!match) {
    throw new MaisterError("PRECONDITION", messages.syntax, {
      details: { reason: "runtime_object_range_invalid" },
    });
  }

  const start = Number(match[1]);
  const end = match[2] === "" ? undefined : Number(match[2]);

  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start))
  ) {
    throw new MaisterError("PRECONDITION", messages.bounds, {
      details: { reason: "runtime_object_range_invalid" },
    });
  }

  return end === undefined ? { start } : { start, end };
}
