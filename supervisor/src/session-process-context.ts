import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

import { SupervisorError } from "./types";

export type HostProcessContext = Readonly<{
  osBootIdentity: string;
  pidNamespace: string;
}>;

/** Positive OS identity, independent of a Supervisor restart or its in-memory registry. */
export function readHostProcessContext(): HostProcessContext {
  try {
    const boot =
      process.platform === "linux"
        ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
        : process.platform === "darwin"
          ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
              encoding: "utf8",
              timeout: 5_000,
              maxBuffer: 4096,
            }).trim()
          : null;

    if (
      !boot ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        boot,
      )
    ) {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        "Host OS boot identity is unavailable; physical process retirement cannot be verified",
        {
          details: { reason: "process_identity_unavailable" },
        },
      );
    }
    const namespace =
      process.platform === "linux"
        ? readlinkSync("/proc/self/ns/pid")
        : "darwin";

    if (
      process.platform === "linux" &&
      !/^pid:\[[1-9][0-9]{0,19}\]$/.test(namespace)
    ) {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        "Host PID namespace is unavailable; physical process retirement cannot be verified",
        {
          details: { reason: "process_identity_unavailable" },
        },
      );
    }

    return { osBootIdentity: boot.toLowerCase(), pidNamespace: namespace };
  } catch (cause) {
    if (cause instanceof SupervisorError) throw cause;
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "Host process identity cannot be read; restore OS identity access before recovering execution",
      {
        cause,
        details: { reason: "process_identity_unavailable" },
      },
    );
  }
}
