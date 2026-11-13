import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { getuid } from "node:process";
import { stripVTControlCharacters } from "node:util";

import type { ServiceObservation } from "./restart-journal.ts";

export type SystemdUnit = Readonly<{
  scope: "system" | "user";
  user: string | null;
  unit: string;
}>;
export type SystemdBinaries = Readonly<{
  systemctl: string;
  journalctl: string;
}>;
type LogExcerpt = Readonly<{ text: string; truncated: boolean }>;

export class SystemdError extends Error {
  readonly reason:
    | "unsupported_config"
    | "service_unavailable"
    | "logs_unavailable"
    | "service_job_pending";

  constructor(reason: SystemdError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

export function checkUnit(config: SystemdUnit): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/.test(config.unit))
    throw new SystemdError("unsupported_config");
  if (config.scope === "system" && config.user === null) return;
  if (config.scope === "user" && getuid && config.user === String(getuid()))
    return;
  throw new SystemdError("unsupported_config");
}

function unitEnvironment(unit: SystemdUnit): NodeJS.ProcessEnv {
  if (unit.scope === "system") return { LANG: "C" };
  const runtime = `/run/user/${unit.user}`;

  return {
    LANG: "C",
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}

type CommandResult = Readonly<{
  succeeded: boolean;
  stdout: string;
  truncated: boolean;
}>;

function run(
  binary: string,
  args: readonly string[],
  unit: SystemdUnit,
  timeout: number,
  maxBuffer: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { env: unitEnvironment(unit), timeout, maxBuffer, killSignal: "SIGKILL" },
      (error, stdout) => {
        resolve({
          succeeded: error === null,
          stdout,
          truncated: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      },
    );
  });
}

function sanitize(text: string, secrets: readonly string[]): string {
  const withoutSecrets = secrets.reduce(
    (value, secret) => value.replaceAll(secret, "[redacted]"),
    stripVTControlCharacters(text),
  );

  return withoutSecrets
    .replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(
      /\b(?:authorization|cookie|set-cookie)\s*[:=][^\n]*/gi,
      "[redacted]",
    )
    .replace(
      /\b(?:[a-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key))\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "[redacted]",
    )
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.\-]+/gi, "[redacted]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[redacted]",
    )
    .replace(
      /(?<![A-Za-z0-9/])(?:[A-Za-z]:)?[\\/][^\s<>"'(),;\x60]+/g,
      "[redacted]",
    );
}

export type SystemdDriver = Readonly<{
  requireQuiescent?(unit: SystemdUnit): Promise<void>;
  inspect(unit: SystemdUnit): Promise<ServiceObservation>;
  restart(unit: SystemdUnit): Promise<"received" | "uncertain">;
  logs(unit: SystemdUnit): Promise<LogExcerpt>;
}>;

/** Limit the subprocess environment and call only the configured unit with fixed arguments. */
export function createSystemdDriver(
  binaries: SystemdBinaries,
  secrets: readonly string[],
): SystemdDriver {
  if (
    !isAbsolute(binaries.systemctl) ||
    !isAbsolute(binaries.journalctl) ||
    secrets.some((value) => !value)
  )
    throw new SystemdError("unsupported_config");

  return {
    async requireQuiescent(unit: SystemdUnit): Promise<void> {
      checkUnit(unit);
      const result = await run(
        binaries.systemctl,
        [
          `--${unit.scope}`,
          "--no-pager",
          "--all",
          "show",
          "--property=Id",
          "--property=Job",
          "--",
          unit.unit,
        ],
        unit,
        3000,
        4096,
      );
      const lines = result.stdout.split("\n");

      if (!result.succeeded || !lines.includes(`Id=${unit.unit}`))
        throw new SystemdError("service_unavailable");
      if (!lines.includes("Job=0"))
        throw new SystemdError("service_job_pending");
    },
    async inspect(unit: SystemdUnit): Promise<ServiceObservation> {
      checkUnit(unit);
      const result = await run(
        binaries.systemctl,
        [
          `--${unit.scope}`,
          "--no-pager",
          "show",
          "--property=Id",
          "--property=LoadState",
          "--property=ActiveState",
          "--property=InvocationID",
          "--",
          unit.unit,
        ],
        unit,
        5000,
        16_384,
      );
      const lines = result.stdout.split("\n");
      const activeState = lines
        .find((line) => line.startsWith("ActiveState="))
        ?.slice(12);
      const invocation = lines
        .find((line) => line.startsWith("InvocationID="))
        ?.slice(13);

      if (
        !result.succeeded ||
        !lines.includes(`Id=${unit.unit}`) ||
        !lines.includes("LoadState=loaded")
      )
        throw new SystemdError("service_unavailable");

      return {
        state:
          activeState === "active" ||
          activeState === "inactive" ||
          activeState === "failed"
            ? activeState
            : "unknown",
        invocationId:
          invocation &&
          /^[a-f0-9]{32}$/.test(invocation) &&
          invocation !== "0".repeat(32)
            ? invocation
            : null,
      };
    },
    async restart(unit: SystemdUnit): Promise<"received" | "uncertain"> {
      checkUnit(unit);
      const result = await run(
        binaries.systemctl,
        [
          `--${unit.scope}`,
          "--no-pager",
          "--job-mode=fail",
          "restart",
          "--",
          unit.unit,
        ],
        unit,
        45_000,
        16_384,
      );

      return result.succeeded ? "received" : "uncertain";
    },
    async logs(unit: SystemdUnit): Promise<LogExcerpt> {
      checkUnit(unit);
      const limit = 262_144;
      const result = await run(
        binaries.journalctl,
        [
          `--${unit.scope}`,
          "--no-pager",
          "--quiet",
          "--output=cat",
          "--since=-10min",
          "--lines=200",
          `--unit=${unit.unit}`,
        ],
        unit,
        5000,
        limit,
      );

      if (!result.succeeded && !result.truncated)
        throw new SystemdError("logs_unavailable");
      const lines = result.stdout.split("\n");

      if (result.truncated || lines.at(-1) === "") lines.pop();
      const sanitized = sanitize(lines.slice(0, 200).join("\n"), secrets);
      const bytes = Buffer.from(sanitized);

      return {
        text:
          bytes.length <= limit
            ? sanitized
            : bytes.subarray(0, limit - 3).toString("utf8"),
        truncated:
          result.truncated || lines.length >= 200 || bytes.length > limit,
      };
    },
  };
}
