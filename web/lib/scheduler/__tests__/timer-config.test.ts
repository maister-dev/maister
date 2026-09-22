import { afterEach, describe, expect, it } from "vitest";

import { readSchedulerClockStatus } from "@/lib/scheduler/timer-config";

describe("scheduler clock configuration", () => {
  afterEach(() => {
    delete process.env.MAISTER_SCHEDULER_TIMER_ENABLED;
    delete process.env.MAISTER_CRON_TOKEN;
  });

  it.each([
    [{}, "fallback_timer", true],
    [{ MAISTER_CRON_TOKEN: "secret" }, "external_tick", false],
    [{ MAISTER_SCHEDULER_TIMER_ENABLED: "true" }, "fallback_timer", true],
    [
      {
        MAISTER_SCHEDULER_TIMER_ENABLED: "true",
        MAISTER_CRON_TOKEN: "secret",
      },
      "fallback_timer",
      true,
    ],
    [
      {
        MAISTER_SCHEDULER_TIMER_ENABLED: "false",
        MAISTER_CRON_TOKEN: "secret",
      },
      "external_tick",
      false,
    ],
    [{ MAISTER_SCHEDULER_TIMER_ENABLED: "false" }, "missing_tick", false],
    [{ MAISTER_SCHEDULER_TIMER_ENABLED: "" }, "fallback_timer", true],
  ] as const)("resolves %j to %s", (env, driver, enabled) => {
    expect(readSchedulerClockStatus(env)).toMatchObject({
      driver,
      fallbackTimerEnabled: enabled,
    });
  });

  it("rejects nonempty values outside the literal boolean contract", () => {
    expect(() =>
      readSchedulerClockStatus({ MAISTER_SCHEDULER_TIMER_ENABLED: "TRUE" }),
    ).toThrow(/MAISTER_SCHEDULER_TIMER_ENABLED/);
  });
});
