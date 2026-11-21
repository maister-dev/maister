import "server-only";

import { MaisterError } from "@/lib/errors";
import { MAX_WAIT_SECONDS } from "@/lib/waits/contracts";

const DEFAULT_WAIT_SECONDS = 7 * 24 * 60 * 60;

export function maximumWaitSeconds(
  raw = process.env.MAISTER_MAX_WAIT_SECONDS,
): number {
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(raw);

  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    seconds > MAX_WAIT_SECONDS
  ) {
    throw new MaisterError(
      "CONFIG",
      "MAISTER_MAX_WAIT_SECONDS must be an integer between 1 and 2678400",
    );
  }

  return seconds;
}
