import { z } from "zod";

import { EXECUTION_HOST_KEY_PATTERN } from "../../../runtime/execution-host-address";

import { MaisterError } from "@/lib/errors";

export type SelectedExecutionEndpoint = Readonly<{
  url: string;
  hostKey: string;
  maxConcurrentRuns?: number;
  draining?: boolean;
}>;

export type AdditionalExecutionEndpoint = SelectedExecutionEndpoint & Readonly<{
  displayName: string;
  projectIds?: readonly string[];
}>;

const projectIdsSchema = z
  .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/))
  .max(10_000);
const additionalEndpointsSchema = z.array(z.strictObject({
  url: z.string().max(2048),
  hostKey: z.string().regex(EXECUTION_HOST_KEY_PATTERN),
  displayName: z.string().trim().min(1).max(128),
  projectIds: projectIdsSchema.optional(),
  maxConcurrentRuns: z.int().min(1).max(1_000).optional(),
  draining: z.boolean().optional(),
})).max(1);

/** Without a project list the existing single-endpoint configuration applies instance-wide. */
export function selectedEndpointAllowsProject(projectId: string, hostKey?: string): boolean {
  const raw = process.env.MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS;
  try {
    if (raw !== undefined && !projectIdsSchema.parse(JSON.parse(raw)).includes(projectId))
      return false;
  } catch (cause) {
    throw new MaisterError(
      "CONFIG",
      "MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS must contain a JSON array of project IDs",
      { cause },
    );
  }
  if (!hostKey) return true;
  const peer = configuredAdditionalExecutionEndpoints().find((candidate) => candidate.hostKey === hostKey);
  return peer?.projectIds === undefined || peer.projectIds.includes(projectId);
}

/** Deferred Flow setup follows the project's addressed execution boundary. */
export function projectFlowSetupOwner(projectId: string): "manager" | "selectedHost" {
  return configuredSelectedExecutionEndpoint() && selectedEndpointAllowsProject(projectId)
    ? "selectedHost"
    : "manager";
}

export function configuredSelectedExecutionEndpoint(): SelectedExecutionEndpoint | null {
  const hostKey = process.env.MAISTER_SELECTED_EXECUTION_HOST_KEY;

  if (hostKey === undefined) return null;
  if (!EXECUTION_HOST_KEY_PATTERN.test(hostKey)) {
    throw new MaisterError(
      "CONFIG",
      "MAISTER_SELECTED_EXECUTION_HOST_KEY must be the stable key from supervisor health",
    );
  }

  const url = supervisorOrigin(process.env.MAISTER_SUPERVISOR_URL);
  if (!url) {
    throw new MaisterError(
      "CONFIG",
      "MAISTER_SUPERVISOR_URL must name the selected supervisor's HTTP(S) origin",
    );
  }

  const capacity = process.env.MAISTER_SELECTED_EXECUTION_HOST_MAX_CONCURRENT_RUNS;
  const drain = process.env.MAISTER_SELECTED_EXECUTION_HOST_DRAIN;
  const maxConcurrentRuns = capacity === undefined ? undefined : Number(capacity);
  if (capacity !== undefined && (!/^[1-9]\d{0,3}$/u.test(capacity) || Number(capacity) > 1_000))
    throw new MaisterError("CONFIG", "MAISTER_SELECTED_EXECUTION_HOST_MAX_CONCURRENT_RUNS must be an integer from 1 to 1000");
  if (drain !== undefined && drain !== "0" && drain !== "1")
    throw new MaisterError("CONFIG", "MAISTER_SELECTED_EXECUTION_HOST_DRAIN must be 0 or 1");
  return { url, hostKey, maxConcurrentRuns, draining: drain === "1" };
}

function supervisorOrigin(address: string | undefined): string | null {
  const url = address ? URL.parse(address) : null;
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return url.origin;
}

export function configuredAdditionalExecutionEndpoints(): readonly AdditionalExecutionEndpoint[] {
  const raw = process.env.MAISTER_ADDITIONAL_EXECUTION_HOSTS;
  if (!raw) return [];

  let peers: z.infer<typeof additionalEndpointsSchema>;
  try {
    peers = additionalEndpointsSchema.parse(JSON.parse(raw));
  } catch (cause) {
    throw new MaisterError("CONFIG", "MAISTER_ADDITIONAL_EXECUTION_HOSTS must contain an array of up to one trusted supervisor descriptor", { cause });
  }
  const primary = configuredSelectedExecutionEndpoint();
  if (peers.length && !primary)
    throw new MaisterError("CONFIG", "Additional supervisors require a pinned default supervisor");
  return peers.map((peer) => {
    const url = supervisorOrigin(peer.url);
    if (!url || url === primary?.url || peer.hostKey === primary?.hostKey)
      throw new MaisterError("CONFIG", "An additional supervisor needs its own HTTP(S) origin and stable key");
    return { ...peer, url };
  });
}

export function configuredExecutionEndpointForHost(hostKey: string): SelectedExecutionEndpoint | null {
  const primary = configuredSelectedExecutionEndpoint();
  if (primary?.hostKey === hostKey) return primary;
  return configuredAdditionalExecutionEndpoints().find((peer) => peer.hostKey === hostKey) ?? null;
}
