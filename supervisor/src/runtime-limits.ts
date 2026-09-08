// Protocol maxima stay fixed; resource policies may be reduced by an explicit
// deployment or test fixture, subject to the same boot validation.
export const CONTROL_EVENT_MAX_BYTES = 16 * 1024;
export const EMERGENCY_EVENT_ROWS = 64;
export const EMERGENCY_EVENT_BYTES =
  EMERGENCY_EVENT_ROWS * CONTROL_EVENT_MAX_BYTES;
export const PRODUCER_BASE_CONTROL_ROWS = 18;
export const MAX_DECLARED_OUTPUT_BINDINGS = 32;
export const MAX_RECEIPT_BODY_BYTES = 2 * 1024 * 1024;
export const SQLITE_WRITE_HEADROOM_BYTES = 8 * 1024 * 1024;

export type RuntimeLimits = Readonly<{
  eventLowBytes: number;
  eventSoftBytes: number;
  eventHardBytes: number;
  eventLowRows: number;
  eventSoftRows: number;
  eventHardRows: number;
  eventControlBytes: number;
  eventControlRows: number;
  eventAckGraceMs: number;
  stateMaxBytes: number;
  objectLowBytes: number;
  objectSoftBytes: number;
  objectMaxBytes: number;
  runtimeMinFreeBytes: number;
}>;

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  eventLowBytes: 320 * 1024 * 1024,
  eventSoftBytes: 400 * 1024 * 1024,
  eventHardBytes: 512 * 1024 * 1024,
  eventLowRows: 64_000,
  eventSoftRows: 80_000,
  eventHardRows: 100_000,
  eventControlBytes: 16 * 1024 * 1024,
  eventControlRows: 1024,
  eventAckGraceMs: 24 * 60 * 60 * 1000,
  stateMaxBytes: 2 * 1024 * 1024 * 1024,
  objectLowBytes: 6 * 1024 * 1024 * 1024,
  objectSoftBytes: 8 * 1024 * 1024 * 1024,
  objectMaxBytes: 10 * 1024 * 1024 * 1024,
  runtimeMinFreeBytes: 1024 * 1024 * 1024,
});

const ENV_KEYS: Readonly<Record<keyof RuntimeLimits, string>> = {
  eventLowBytes: "MAISTER_EVENT_OUTBOX_LOW_BYTES",
  eventSoftBytes: "MAISTER_EVENT_OUTBOX_SOFT_BYTES",
  eventHardBytes: "MAISTER_EVENT_OUTBOX_HARD_BYTES",
  eventLowRows: "MAISTER_EVENT_OUTBOX_LOW_ROWS",
  eventSoftRows: "MAISTER_EVENT_OUTBOX_SOFT_ROWS",
  eventHardRows: "MAISTER_EVENT_OUTBOX_HARD_ROWS",
  eventControlBytes: "MAISTER_EVENT_OUTBOX_CONTROL_BYTES",
  eventControlRows: "MAISTER_EVENT_OUTBOX_CONTROL_ROWS",
  eventAckGraceMs: "MAISTER_EVENT_ACK_GRACE_MS",
  stateMaxBytes: "MAISTER_EXECUTION_HOST_STATE_MAX_BYTES",
  objectLowBytes: "MAISTER_RUNTIME_OBJECT_LOW_BYTES",
  objectSoftBytes: "MAISTER_RUNTIME_OBJECT_SOFT_BYTES",
  objectMaxBytes: "MAISTER_RUNTIME_OBJECT_MAX_BYTES",
  runtimeMinFreeBytes: "MAISTER_RUNTIME_MIN_FREE_BYTES",
};

export class RuntimeLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeLimitsError";
  }
}

export function validateRuntimeLimits(limits: RuntimeLimits): RuntimeLimits {
  const keys = Object.keys(DEFAULT_RUNTIME_LIMITS) as Array<
    keyof RuntimeLimits
  >;

  if (Object.keys(limits).length !== keys.length)
    throw new RuntimeLimitsError(
      "runtime limits must contain exactly the supported settings",
    );
  for (const key of keys) {
    const value = limits[key];

    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RuntimeLimitsError(`${key} must be a positive safe integer`);
    }
  }
  for (const [low, soft, hard] of [
    [limits.eventLowBytes, limits.eventSoftBytes, limits.eventHardBytes],
    [limits.eventLowRows, limits.eventSoftRows, limits.eventHardRows],
    [limits.objectLowBytes, limits.objectSoftBytes, limits.objectMaxBytes],
  ] as const) {
    if (!(low < soft && soft < hard)) {
      throw new RuntimeLimitsError(
        "resource thresholds must satisfy low < soft < hard",
      );
    }
  }
  if (
    limits.eventControlRows <
      EMERGENCY_EVENT_ROWS + PRODUCER_BASE_CONTROL_ROWS ||
    !Number.isSafeInteger(limits.eventControlRows * CONTROL_EVENT_MAX_BYTES) ||
    limits.eventControlBytes < limits.eventControlRows * CONTROL_EVENT_MAX_BYTES
  ) {
    throw new RuntimeLimitsError(
      "event control capacity must fund the emergency floor and a producer wallet at 16 KiB per row",
    );
  }
  const minimumStateBytes =
    limits.eventHardBytes +
    limits.eventControlBytes +
    sqliteControlHeadroomBytes(limits) +
    SQLITE_WRITE_HEADROOM_BYTES;

  if (
    !Number.isSafeInteger(minimumStateBytes) ||
    limits.stateMaxBytes <= minimumStateBytes ||
    !Number.isSafeInteger(
      limits.runtimeMinFreeBytes + limits.stateMaxBytes + limits.objectMaxBytes,
    )
  ) {
    throw new RuntimeLimitsError(
      "host state capacity must exceed the event partitions plus reserved write headroom; combined filesystem budgets must be safe integers",
    );
  }

  return Object.freeze({ ...limits });
}

export function runtimeLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeLimits {
  const overrides: Partial<Record<keyof RuntimeLimits, number>> = {};

  for (const key of Object.keys(ENV_KEYS) as Array<keyof RuntimeLimits>) {
    const value = env[ENV_KEYS[key]];

    if (value === undefined) continue;
    if (!/^[1-9][0-9]{0,15}$/.test(value)) {
      throw new RuntimeLimitsError(
        `${ENV_KEYS[key]} must contain a positive safe integer`,
      );
    }
    overrides[key] = Number(value);
  }

  return validateRuntimeLimits({ ...DEFAULT_RUNTIME_LIMITS, ...overrides });
}

export function producerWalletRows(outputBindingCount: number): number {
  if (
    !Number.isSafeInteger(outputBindingCount) ||
    outputBindingCount < 0 ||
    outputBindingCount > MAX_DECLARED_OUTPUT_BINDINGS
  ) {
    throw new RuntimeLimitsError(
      "producer output bindings must be between 0 and 32",
    );
  }

  return PRODUCER_BASE_CONTROL_ROWS + outputBindingCount;
}

/** Event pages, index/WAL overhead, and one bounded terminal receipt per wallet. */
export function sqliteControlHeadroomBytes(limits: RuntimeLimits): number {
  const wallets = Math.floor(
    (limits.eventControlRows - EMERGENCY_EVENT_ROWS) /
      PRODUCER_BASE_CONTROL_ROWS,
  );

  return (
    2 * limits.eventControlBytes +
    limits.eventControlRows * 64 * 1024 +
    wallets * (2 * MAX_RECEIPT_BODY_BYTES + 64 * 1024)
  );
}
