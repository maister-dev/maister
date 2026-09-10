import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startHeartbeatWatcher } from "../heartbeat";
import { resolveLogLevel } from "../main";
import { SessionRegistry } from "../registry";

// An idle supervisor keeps ticking forever. Logging the tick when there is
// nothing to check turns `pnpm dev` into a scrolling wall with no diagnostic
// value, and the level default has to match the documented dev/prod split.
describe("supervisor log level", () => {
  it("keeps the documented development default", () => {
    expect(resolveLogLevel({})).toBe("debug");
    expect(resolveLogLevel({ NODE_ENV: "development" })).toBe("debug");
  });

  it("uses the documented production default", () => {
    expect(resolveLogLevel({ NODE_ENV: "production" })).toBe("info");
  });

  it("lets an explicit level win everywhere", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "warn" })).toBe("warn");
    expect(
      resolveLogLevel({ LOG_LEVEL: "trace", NODE_ENV: "production" }),
    ).toBe("trace");
  });
});

describe("heartbeat observability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function watcherWithSpy(): {
    stop: () => void;
    debug: ReturnType<typeof vi.fn>;
    registry: SessionRegistry;
  } {
    const logger = pino({ level: "silent" });
    const debug = vi.fn();
    const registry = new SessionRegistry(logger);
    const spyLogger = { ...logger, debug } as unknown as typeof logger;

    return {
      debug,
      registry,
      stop: startHeartbeatWatcher({
        registry,
        logger: spyLogger,
        intervalMs: 1_000,
      }),
    };
  }

  it("says nothing while no session is live", () => {
    const { stop, debug } = watcherWithSpy();

    try {
      vi.advanceTimersByTime(10_000);

      expect(debug).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
