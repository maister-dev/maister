import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_RESERVE,
  resolveAutoReserve,
  resolveEdgeDrain,
  resolveMaxInFlightAuto,
  taskQueueSettingsSchema,
} from "./queue-settings";

const ENV_KEYS = [
  "MAISTER_TASK_QUEUE_EDGE_DRAIN",
  "MAISTER_TASK_QUEUE_AUTO_RESERVE",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("ADR-121 queue settings resolution", () => {
  it("edgeDrain: env-on + project NULL → true", () => {
    process.env.MAISTER_TASK_QUEUE_EDGE_DRAIN = "on";
    expect(resolveEdgeDrain({ taskQueueSettings: null })).toBe(true);
  });

  it("edgeDrain: project false overrides env on", () => {
    process.env.MAISTER_TASK_QUEUE_EDGE_DRAIN = "on";
    expect(resolveEdgeDrain({ taskQueueSettings: { edgeDrain: false } })).toBe(
      false,
    );
  });

  it("edgeDrain: project true overrides env off", () => {
    process.env.MAISTER_TASK_QUEUE_EDGE_DRAIN = "off";
    expect(resolveEdgeDrain({ taskQueueSettings: { edgeDrain: true } })).toBe(
      true,
    );
  });

  it("edgeDrain: defaults to true when env unset and project NULL", () => {
    expect(resolveEdgeDrain({ taskQueueSettings: null })).toBe(true);
  });

  it("edgeDrain: an absent project key falls back to env (NOT off)", () => {
    process.env.MAISTER_TASK_QUEUE_EDGE_DRAIN = "off";
    // settings present but edgeDrain key absent → env wins (not the false default).
    expect(
      resolveEdgeDrain({ taskQueueSettings: { maxInFlightAuto: 2 } }),
    ).toBe(false);
  });

  it("autoReserve: parses env, defaults to 2, accepts 0", () => {
    expect(resolveAutoReserve()).toBe(DEFAULT_AUTO_RESERVE);
    process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE = "3";
    expect(resolveAutoReserve()).toBe(3);
    process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE = "0";
    expect(resolveAutoReserve()).toBe(0);
    process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE = "garbage";
    expect(resolveAutoReserve()).toBe(DEFAULT_AUTO_RESERVE);
  });

  it("maxInFlightAuto: absent → unbounded (Infinity); set → value", () => {
    expect(resolveMaxInFlightAuto({ taskQueueSettings: null })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(
      resolveMaxInFlightAuto({ taskQueueSettings: { maxInFlightAuto: 4 } }),
    ).toBe(4);
  });

  it("schema: rejects unknown keys (.strict) and sub-1 maxInFlightAuto", () => {
    expect(taskQueueSettingsSchema.safeParse({ edgeDrain: true }).success).toBe(
      true,
    );
    expect(
      taskQueueSettingsSchema.safeParse({ maxInFlightAuto: 0 }).success,
    ).toBe(false);
    expect(taskQueueSettingsSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });
});
