import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MaisterError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

export type SchedulerCommandResult = {
  commandKind: "http_ping" | "console_ping";
  ok: boolean;
  status?: number;
  output?: string;
};

export async function runCommandJob(
  target: Record<string, unknown>,
): Promise<SchedulerCommandResult> {
  const commandKind = stringProp(target, "commandKind") ?? "http_ping";

  if (commandKind === "http_ping") {
    return httpPing(target);
  }
  if (commandKind === "console_ping") {
    return consolePing(target);
  }

  throw new MaisterError(
    "CONFIG",
    `unsupported scheduler commandKind: ${commandKind}`,
  );
}

async function httpPing(
  target: Record<string, unknown>,
): Promise<SchedulerCommandResult> {
  const url = stringProp(target, "url");

  if (!url) {
    throw new MaisterError("CONFIG", "http_ping target.url is required");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new MaisterError(
      "CONFIG",
      "http_ping target.url must be a valid URL",
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new MaisterError(
      "CONFIG",
      "http_ping target.url must use the http or https scheme",
    );
  }

  const timeoutMs = numberProp(target, "timeoutMs") ?? 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });

    return {
      commandKind: "http_ping",
      ok: response.ok,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function consolePing(
  target: Record<string, unknown>,
): Promise<SchedulerCommandResult> {
  const host = stringProp(target, "host");

  if (!host || !isSafePingHost(host)) {
    throw new MaisterError(
      "CONFIG",
      "console_ping target.host must be a hostname or IP literal without option-like labels",
    );
  }

  const { stdout } = await execFileAsync("ping", ["-c", "1", host], {
    timeout: numberProp(target, "timeoutMs") ?? 5_000,
    maxBuffer: 8_192,
  });

  return {
    commandKind: "console_ping",
    ok: true,
    output: stdout.slice(0, 1_000),
  };
}

function stringProp(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

function numberProp(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isSafePingHost(host: string): boolean {
  if (host.length > 253) return false;
  if (host.startsWith("-")) return false;
  if (host.includes("..")) return false;

  return host.split(".").every((label) => {
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label);
  });
}
