// ADR-164: the `/health` body a mocked `checkSupervisorHealth` must return so
// the execution-host registrar can register the (fake) local host. Tests that
// mock `@/lib/supervisor-client` at the module level spread this in; the
// identity is fixed so repeated registrations `touch` one row.

export const TEST_HOST_IDENTITY = {
  hostKey: "eh_test0000000000000000000000000000",
  bootId: "0f0e0d0c-0b0a-4908-8706-050403020100",
  protocolVersion: 1 as const,
};

export type ReadySupervisorHealth = {
  kind: "ready";
  health: {
    status: "ready";
    host: typeof TEST_HOST_IDENTITY;
    version: string;
    uptimeMs: number;
    checkedAt: string;
    sessions: { live: number; exited: number; crashed: number };
  };
};

export function readySupervisorHealth(
  overrides: Partial<ReadySupervisorHealth["health"]> = {},
): ReadySupervisorHealth {
  return {
    kind: "ready",
    health: {
      status: "ready",
      host: TEST_HOST_IDENTITY,
      version: "0.0.1",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
      ...overrides,
    },
  };
}
