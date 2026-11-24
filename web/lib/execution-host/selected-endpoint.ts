import { z } from "zod";

import { EXECUTION_HOST_KEY_PATTERN } from "../../../runtime/execution-host-address";

import { MaisterError } from "@/lib/errors";

export type SelectedExecutionEndpoint = Readonly<{
  url: string;
  hostKey: string;
}>;

const projectIdsSchema = z
  .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/))
  .max(10_000);

/** Without a project list the existing single-endpoint configuration applies instance-wide. */
export function selectedEndpointAllowsProject(projectId: string): boolean {
  const raw = process.env.MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS;
  if (raw === undefined) return true;
  try {
    return projectIdsSchema.parse(JSON.parse(raw)).includes(projectId);
  } catch (cause) {
    throw new MaisterError(
      "CONFIG",
      "MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS must contain a JSON array of project IDs",
      { cause },
    );
  }
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

  const address = process.env.MAISTER_SUPERVISOR_URL;
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
    throw new MaisterError(
      "CONFIG",
      "MAISTER_SUPERVISOR_URL must name the selected supervisor's HTTP(S) origin",
    );
  }

  return { url: url.origin, hostKey };
}
