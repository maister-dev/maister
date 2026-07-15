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

export type ScheduledLaunchTimeDescription = {
  earlierAt: string;
  isAmbiguous: boolean;
  laterAt: string;
  resolvedAt: string;
};

export function describeScheduledLaunchTime(
  input: ResolveScheduledLaunchTimeInput,
): ScheduledLaunchTimeDescription {
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

    return {
      earlierAt: new Date(Number(earlier.epochMilliseconds)).toISOString(),
      isAmbiguous,
      laterAt: new Date(Number(later.epochMilliseconds)).toISOString(),
      resolvedAt: new Date(Number(resolved.epochMilliseconds)).toISOString(),
    };
  } catch (error) {
    if (error instanceof MaisterError) throw error;

    throw new MaisterError(
      "CONFIG",
      "scheduled local time or timezone is invalid",
      { cause: error },
    );
  }
}

export function resolveScheduledLaunchTime(
  input: ResolveScheduledLaunchTimeInput,
): Date {
  return new Date(describeScheduledLaunchTime(input).resolvedAt);
}
