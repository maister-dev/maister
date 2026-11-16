import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  SystemdError,
  type SystemdDriver,
  type SystemdUnit,
} from "./systemd.ts";

export type HealthProbe =
  | Readonly<{ kind: "systemd"; expectedState: "active" }>
  | Readonly<{
      kind: "http";
      url: string;
      expectedStatus: number;
      expectedIdentity: string;
    }>;
type HealthState = "healthy" | "unhealthy" | "inconclusive";

export function validateHealthProbe(probe: HealthProbe): void {
  if (probe.kind === "systemd" && probe.expectedState === "active") return;
  if (probe.kind !== "http") throw new SystemdError("unsupported_config");
  const url = URL.parse(probe.url);

  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash ||
    probe.url.length > 2048 ||
    !Number.isInteger(probe.expectedStatus) ||
    probe.expectedStatus < 100 ||
    probe.expectedStatus > 599 ||
    !/^[ -~]{1,256}$/.test(probe.expectedIdentity)
  )
    throw new SystemdError("unsupported_config");
}

function httpHealth(
  probe: Extract<HealthProbe, { kind: "http" }>,
): Promise<HealthState> {
  const url = new URL(probe.url);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const outgoing = request(
      url,
      {
        method: "GET",
        agent: false,
        signal: AbortSignal.timeout(5000),
        maxHeaderSize: 8192,
      },
      (response) => {
        let bytes = 0;

        response.on("error", () => resolve("inconclusive"));
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16_384) {
            resolve("inconclusive");
            response.destroy();
          }
        });
        response.on("end", () => {
          const identity =
            response.headersDistinct["x-maister-health-identity"];

          resolve(
            response.statusCode === probe.expectedStatus &&
              identity?.length === 1 &&
              identity[0] === probe.expectedIdentity
              ? "healthy"
              : "unhealthy",
          );
        });
      },
    );

    outgoing.on("error", () => resolve("inconclusive"));
    outgoing.end();
  });
}

export async function checkHealth(
  manager: SystemdDriver,
  unit: SystemdUnit,
  probe: HealthProbe,
): Promise<HealthState> {
  if (probe.kind === "http") return httpHealth(probe);

  try {
    const observation = await manager.inspect(unit);

    if (observation.state === "active" && observation.invocationId !== null)
      return "healthy";
    if (observation.state === "inactive" || observation.state === "failed")
      return "unhealthy";

    return "inconclusive";
  } catch (error) {
    if (
      !(error instanceof SystemdError) ||
      error.reason !== "service_unavailable"
    )
      throw error;

    return "inconclusive";
  }
}
