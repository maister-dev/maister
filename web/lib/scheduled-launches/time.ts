import { Temporal } from "@js-temporal/polyfill";

import { MaisterError } from "@/lib/errors-core";

import type { ScheduledLaunchDisambiguation } from "@/lib/scheduled-launches/types";

type ResolveScheduledLaunchTimeInput = {
  scheduledLocalTime: string;
  timezone: string;
  disambiguation?: ScheduledLaunchDisambiguation;
};

function toZonedDateTime(
  scheduledLocalTime: string,
  timezone: string,
  disambiguation: "earlier" | "later",
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from(
    `${scheduledLocalTime}[${timezone}]`,
    { disambiguation },
  );
}

export function resolveScheduledLaunchTime(
  input: ResolveScheduledLaunchTimeInput,
): Date {
  try {
    const local = Temporal.PlainDateTime.from(input.scheduledLocalTime);
    const earlier = toZonedDateTime(
      input.scheduledLocalTime,
      input.timezone,
      "earlier",
    );
    const later = toZonedDateTime(
      input.scheduledLocalTime,
      input.timezone,
      "later",
    );

    if (
      !earlier.toPlainDateTime().equals(local) ||
      !later.toPlainDateTime().equals(local)
    ) {
      throw new MaisterError(
        "CONFIG",
        "scheduled local time does not exist in the selected timezone",
      );
    }

    const isAmbiguous = earlier.epochNanoseconds !== later.epochNanoseconds;

    if (isAmbiguous && input.disambiguation === undefined) {
      throw new MaisterError(
        "CONFIG",
        "scheduled local time is ambiguous; choose earlier or later",
      );
    }

    const resolved =
      input.disambiguation === "later"
        ? later
        : input.disambiguation === "earlier"
          ? earlier
          : earlier;

    return new Date(Number(resolved.epochMilliseconds));
  } catch (error) {
    if (error instanceof MaisterError) throw error;

    throw new MaisterError(
      "CONFIG",
      "scheduled local time or timezone is invalid",
      { cause: error },
    );
  }
}
