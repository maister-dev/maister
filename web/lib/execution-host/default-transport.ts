import type { ExecutionHostTransport } from "./contracts";
import type { SelectedExecutionEndpoint } from "./selected-endpoint";
import type { ExecutionHost } from "@/lib/db/schema";
import type { Db } from "./db";

import { createLocalDirectTransport } from "./transports/local-direct";
import { configuredAdditionalExecutionEndpoints, configuredExecutionEndpointForHost } from "./selected-endpoint";
import { getHostById } from "./hosts";

import { configuredEventStreamLagAgeMs } from "@/lib/instance-config";
import { MaisterError } from "@/lib/errors";

// The transport every implicit resolution uses when a caller injects none
// (registrar, client factory, recovery). Tests that exercise production paths
// without an injection seam (state transitions, routes, event consumers) point
// it at a fake host for the process; production never sets it.
let override: ExecutionHostTransport | null = null;

export function defaultTransport(): ExecutionHostTransport {
  return (
    override ??
    createLocalDirectTransport({ lagAgeMs: configuredEventStreamLagAgeMs() })
  );
}

export function pinnedExecutionHostTransport(endpoint: SelectedExecutionEndpoint): ExecutionHostTransport {
  return createLocalDirectTransport({ endpoint, lagAgeMs: configuredEventStreamLagAgeMs() });
}

/** Legacy and default assignments use the existing adapter, peers use their own origin. */
export function transportForExecutionHost(
  host: Pick<ExecutionHost, "hostKey" | "transport">,
  defaultHostTransport: ExecutionHostTransport = defaultTransport(),
): ExecutionHostTransport {
  if (host.transport.role !== "secondary") return defaultHostTransport;
  const peer = configuredAdditionalExecutionEndpoints().find((endpoint) => endpoint.hostKey === host.hostKey);
  if (!peer)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "The assigned supervisor no longer has a configured endpoint", {
      details: { reason: "host_identity_mismatch", hostKey: host.hostKey },
    });
  return pinnedExecutionHostTransport(peer);
}

export async function transportForSelectedHostId(db: Db, hostId: string): Promise<ExecutionHostTransport> {
  const host = await getHostById(db, hostId);
  if (!host || host.retiredAt || !configuredExecutionEndpointForHost(host.hostKey))
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "The selected supervisor no longer has its registered endpoint", {
      details: { reason: "host_identity_mismatch", hostId },
    });
  return transportForExecutionHost(host);
}

export function setDefaultTransportForTests(
  transport: ExecutionHostTransport | null,
): void {
  override = transport;
}
