import "server-only";

import { MaisterError } from "@/lib/errors";

export function decodeRouteParam(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid ${label} route parameter encoding: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
