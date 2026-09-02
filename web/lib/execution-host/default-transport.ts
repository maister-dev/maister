import type { ExecutionHostTransport } from "./contracts";

import { createLocalDirectTransport } from "./transports/local-direct";

// The transport every implicit resolution uses when a caller injects none
// (registrar, client factory, recovery). Tests that exercise production paths
// without an injection seam (state transitions, routes, event consumers) point
// it at a fake host for the process; production never sets it.
let override: ExecutionHostTransport | null = null;

export function defaultTransport(): ExecutionHostTransport {
  return override ?? createLocalDirectTransport();
}

export function setDefaultTransportForTests(
  transport: ExecutionHostTransport | null,
): void {
  override = transport;
}
