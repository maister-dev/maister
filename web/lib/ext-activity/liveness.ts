import type {
  ActivityLiveness,
  ActivityRunStatus,
  ActivityThresholds,
} from "@/lib/ext-activity/types";

import {
  assistantActivitySilentAfterSeconds,
  assistantActivityStalledAfterSeconds,
  assistantActivityWaitingToolAfterSeconds,
} from "@/lib/instance-config";

export type DeriveActivityLivenessInput = {
  runStatus: ActivityRunStatus;
  now: Date;
  lastMeaningfulAt: Date | null;
  waitingOnHumanSince: Date | null;
  waitingOnToolSince: Date | null;
  endedAt?: Date | null;
  thresholds?: ActivityThresholds;
};

function ageMinutes(now: Date, since: Date | null): number | null {
  if (!since) return null;

  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
}

function thresholdsFromConfig(): ActivityThresholds {
  return {
    waitingToolAfterSeconds: assistantActivityWaitingToolAfterSeconds(),
    silentAfterSeconds: assistantActivitySilentAfterSeconds(),
    stalledAfterSeconds: assistantActivityStalledAfterSeconds(),
  };
}

function exceedsThreshold(
  now: Date,
  since: Date | null,
  seconds: number,
): boolean {
  if (!since) return false;

  return now.getTime() - since.getTime() >= seconds * 1000;
}

function inactiveLiveness(
  now: Date,
  since: Date | null,
  summary: string,
): ActivityLiveness {
  return {
    state: "inactive",
    summary,
    since,
    ageMinutes: ageMinutes(now, since),
  };
}

export function deriveActivityLiveness(
  input: DeriveActivityLivenessInput,
): ActivityLiveness {
  const thresholds = input.thresholds ?? thresholdsFromConfig();
  const terminalSince = input.endedAt ?? input.lastMeaningfulAt;

  switch (input.runStatus) {
    case "Pending":
      return inactiveLiveness(input.now, terminalSince, "pending start");
    case "WaitingOnChildren":
      return inactiveLiveness(
        input.now,
        terminalSince,
        "waiting on delegated runs",
      );
    case "Done":
      return inactiveLiveness(input.now, terminalSince, "completed");
    case "Failed":
      return inactiveLiveness(input.now, terminalSince, "failed");
    case "Crashed":
      return inactiveLiveness(input.now, terminalSince, "crashed");
    case "Abandoned":
      return inactiveLiveness(input.now, terminalSince, "abandoned");
  }

  if (input.waitingOnHumanSince) {
    const minutes = ageMinutes(input.now, input.waitingOnHumanSince);

    return {
      state: "waiting_on_human",
      summary:
        minutes === null
          ? "waiting on human"
          : `waiting on human for ${minutes} min`,
      since: input.waitingOnHumanSince,
      ageMinutes: minutes,
    };
  }

  if (
    input.waitingOnToolSince &&
    exceedsThreshold(
      input.now,
      input.waitingOnToolSince,
      thresholds.waitingToolAfterSeconds,
    )
  ) {
    const minutes = ageMinutes(input.now, input.waitingOnToolSince);

    return {
      state: "waiting_on_tool",
      summary:
        minutes === null
          ? "waiting on tool"
          : `waiting on tool for ${minutes} min`,
      since: input.waitingOnToolSince,
      ageMinutes: minutes,
    };
  }

  if (
    input.runStatus === "Running" &&
    exceedsThreshold(
      input.now,
      input.lastMeaningfulAt,
      thresholds.stalledAfterSeconds,
    )
  ) {
    const minutes = ageMinutes(input.now, input.lastMeaningfulAt);

    return {
      state: "stalled",
      summary: minutes === null ? "stalled" : `stalled for ${minutes} min`,
      since: input.lastMeaningfulAt,
      ageMinutes: minutes,
    };
  }

  if (
    exceedsThreshold(
      input.now,
      input.lastMeaningfulAt,
      thresholds.silentAfterSeconds,
    )
  ) {
    const minutes = ageMinutes(input.now, input.lastMeaningfulAt);

    return {
      state: "silent",
      summary: minutes === null ? "silent" : `silent for ${minutes} min`,
      since: input.lastMeaningfulAt,
      ageMinutes: minutes,
    };
  }

  return {
    state: "working",
    summary: "working",
    since: input.lastMeaningfulAt,
    ageMinutes: ageMinutes(input.now, input.lastMeaningfulAt),
  };
}
