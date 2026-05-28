import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import pino from "pino";

import {
  createPendingPermissions,
  type AcpPermissionOutcome,
} from "../pending-permissions";
import { SupervisorError } from "../types";

const silentLogger = pino({ level: "silent" });
const TIMEOUT_MS = 200;

type DeferredCapture = {
  promise: Promise<AcpPermissionOutcome>;
  resolved: AcpPermissionOutcome | null;
  rejected: Error | null;
  resolve: (outcome: AcpPermissionOutcome) => void;
  reject: (err: Error) => void;
};

function makeDeferred(): DeferredCapture {
  const capture: DeferredCapture = {
    promise: Promise.resolve({ outcome: "cancelled" }),
    resolved: null,
    rejected: null,
    resolve: () => undefined,
    reject: () => undefined,
  };

  capture.promise = new Promise<AcpPermissionOutcome>((res, rej) => {
    capture.resolve = (outcome) => {
      capture.resolved = outcome;
      res(outcome);
    };
    capture.reject = (err) => {
      capture.rejected = err;
      rej(err);
    };
  });
  capture.promise.catch(() => undefined);

  return capture;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingPermissionRegistry", () => {
  it("register then resolve settles with selected outcome, returns true once", async () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const d = makeDeferred();

    reg.register("s1", "r1", { resolve: d.resolve, reject: d.reject });

    expect(reg.resolve("s1", "r1", "allow")).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(d.resolved).toEqual({ outcome: "selected", optionId: "allow" });
    expect(reg.resolve("s1", "r1", "allow")).toBe(false);
    expect(reg.size("s1")).toBe(0);
  });

  it("register then cancel settles with cancelled outcome, prevents further resolve", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const d = makeDeferred();

    reg.register("s2", "r2", { resolve: d.resolve, reject: d.reject });
    expect(reg.cancel("s2", "r2", "DB_PERSIST_FAILED")).toBe(true);
    expect(d.resolved).toEqual({ outcome: "cancelled" });
    expect(reg.cancel("s2", "r2", "again")).toBe(false);
    expect(reg.resolve("s2", "r2", "allow")).toBe(false);
  });

  it("register then reject settles with thrown SupervisorError, prevents further actions", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const d = makeDeferred();

    reg.register("s3", "r3", { resolve: d.resolve, reject: d.reject });
    expect(
      reg.reject("s3", "r3", new SupervisorError("CRASH", "explicit")),
    ).toBe(true);
    expect(d.rejected).toBeInstanceOf(SupervisorError);
    expect((d.rejected as SupervisorError).code).toBe("CRASH");
    expect(reg.resolve("s3", "r3", "allow")).toBe(false);
    expect(reg.cancel("s3", "r3", "x")).toBe(false);
  });

  it("times out with HITL_TIMEOUT exactly once after timeoutMs", async () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const d = makeDeferred();

    reg.register("s4", "r4", { resolve: d.resolve, reject: d.reject });
    expect(d.rejected).toBeNull();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 10);

    expect(d.rejected).toBeInstanceOf(SupervisorError);
    expect((d.rejected as SupervisorError).code).toBe("HITL_TIMEOUT");
    expect(reg.resolve("s4", "r4", "allow")).toBe(false);
  });

  it("resolve/cancel/reject on unknown ids return false without throwing", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });

    expect(reg.resolve("nope", "nope", "allow")).toBe(false);
    expect(reg.cancel("nope", "nope", "x")).toBe(false);
    expect(reg.reject("nope", "nope", new Error("e"))).toBe(false);
  });

  it("purgeSession rejects all pending with CRASH and removes inner Map", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const a = makeDeferred();
    const b = makeDeferred();

    reg.register("s5", "r-a", { resolve: a.resolve, reject: a.reject });
    reg.register("s5", "r-b", { resolve: b.resolve, reject: b.reject });

    expect(reg.size("s5")).toBe(2);
    reg.purgeSession("s5");
    expect(a.rejected).toBeInstanceOf(SupervisorError);
    expect((a.rejected as SupervisorError).code).toBe("CRASH");
    expect(b.rejected).toBeInstanceOf(SupervisorError);
    expect(reg.size("s5")).toBe(0);
    expect(reg.resolve("s5", "r-a", "allow")).toBe(false);
  });

  it("register collision rejects the prior deferred and registers the new one", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const first = makeDeferred();
    const second = makeDeferred();

    reg.register("s6", "r6", { resolve: first.resolve, reject: first.reject });
    reg.register("s6", "r6", {
      resolve: second.resolve,
      reject: second.reject,
    });

    expect(first.rejected).toBeInstanceOf(SupervisorError);
    expect(reg.resolve("s6", "r6", "allow")).toBe(true);
    expect(second.resolved).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("cross-session isolation: resolve in session A leaves session B untouched", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const a = makeDeferred();
    const b = makeDeferred();

    reg.register("sA", "rX", { resolve: a.resolve, reject: a.reject });
    reg.register("sB", "rX", { resolve: b.resolve, reject: b.reject });

    expect(reg.resolve("sA", "rX", "allow")).toBe(true);
    expect(a.resolved).toEqual({ outcome: "selected", optionId: "allow" });
    expect(b.resolved).toBeNull();
    expect(b.rejected).toBeNull();
    expect(reg.size("sB")).toBe(1);
  });

  it("totalSize reflects sum across sessions", () => {
    const reg = createPendingPermissions({
      logger: silentLogger,
      timeoutMs: TIMEOUT_MS,
    });
    const d1 = makeDeferred();
    const d2 = makeDeferred();
    const d3 = makeDeferred();

    reg.register("sA", "r1", { resolve: d1.resolve, reject: d1.reject });
    reg.register("sB", "r1", { resolve: d2.resolve, reject: d2.reject });
    reg.register("sB", "r2", { resolve: d3.resolve, reject: d3.reject });

    expect(reg.totalSize()).toBe(3);
    expect(reg.size("sA")).toBe(1);
    expect(reg.size("sB")).toBe(2);
  });
});
