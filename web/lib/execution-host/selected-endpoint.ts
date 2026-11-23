import { EXECUTION_HOST_KEY_PATTERN } from "../../../runtime/execution-host-address";

import { MaisterError } from "@/lib/errors";

export type SelectedExecutionEndpoint = Readonly<{
  url: string;
  hostKey: string;
}>;

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
