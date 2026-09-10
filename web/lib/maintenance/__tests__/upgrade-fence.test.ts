import { afterEach, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  UPGRADE_MAINTENANCE_ENV,
  assertUpgradeMaintenanceAllows,
  upgradeMaintenanceEngaged,
} from "@/lib/maintenance/upgrade-fence";

const originalValue = process.env[UPGRADE_MAINTENANCE_ENV];

function setFence(value: string | undefined): void {
  if (value === undefined) delete process.env[UPGRADE_MAINTENANCE_ENV];
  else process.env[UPGRADE_MAINTENANCE_ENV] = value;
}

afterEach(() => {
  setFence(originalValue);
});

describe("upgrade maintenance fence", () => {
  it("stays disengaged when the operator has not enabled it", () => {
    setFence(undefined);

    expect(upgradeMaintenanceEngaged()).toBe(false);
    expect(() => assertUpgradeMaintenanceAllows("prompt_turn")).not.toThrow();
  });

  it.each(["1", "true", "TRUE", " on ", "yes"])(
    "engages on the operator value %j",
    (raw) => {
      setFence(raw);

      expect(upgradeMaintenanceEngaged()).toBe(true);
    },
  );

  it.each(["", "0", "false", "off", "no", "maybe"])(
    "stays disengaged on the value %j",
    (raw) => {
      setFence(raw);

      expect(upgradeMaintenanceEngaged()).toBe(false);
    },
  );

  it("refuses a fenced operation with a typed reason and the operation name", () => {
    setFence("1");

    let refusal: unknown;

    try {
      assertUpgradeMaintenanceAllows("destructive_gc");
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(MaisterError);
    expect(refusal).toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "upgrade_maintenance_fence",
        operation: "destructive_gc",
      },
    });
    expect((refusal as MaisterError).message).toContain(
      UPGRADE_MAINTENANCE_ENV,
    );
  });

  it("names every fenced operation of the drain boundary", () => {
    setFence("1");

    for (const operation of [
      "run_admission",
      "prompt_turn",
      "scheduler_tick",
      "destructive_gc",
    ] as const) {
      expect(() => assertUpgradeMaintenanceAllows(operation)).toThrow(
        MaisterError,
      );
    }
  });
});
