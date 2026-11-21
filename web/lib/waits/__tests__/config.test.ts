import { afterEach, expect, it, vi } from "vitest";

import { maximumWaitSeconds } from "@/lib/waits/config";

afterEach(() => vi.unstubAllEnvs());

it("bounds the web startup wait lifetime with a seven-day default", () => {
  vi.stubEnv("MAISTER_MAX_WAIT_SECONDS", undefined);
  expect(maximumWaitSeconds()).toBe(604800);

  vi.stubEnv("MAISTER_MAX_WAIT_SECONDS", "2678400");
  expect(maximumWaitSeconds()).toBe(2678400);
});

it.each(["", "0", "2.5", "2678401", "7d"])(
  "refuses %j as a boot-time wait cap",
  (value) => {
    vi.stubEnv("MAISTER_MAX_WAIT_SECONDS", value);
    expect(() => maximumWaitSeconds()).toThrow(
      expect.objectContaining({ code: "CONFIG" }),
    );
  },
);
