import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import type {
  ExecutorAgent,
  McpServerInput,
  RunnerLaunch,
  StartSessionRequest,
} from "../src/types";

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  Readable,
  Writable,
  type Readable as NodeReadable,
  type Writable as NodeWritable,
} from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  listAdapterRuntimes,
  resolveAdapterBinary,
} from "../src/adapter-registry";
import { writeAdapterSmokeCache } from "../src/adapter-smoke-cache";
import { provisionRunnerLaunch } from "../src/runner-provisioner";
import { buildChildEnv } from "../src/spawn";

type SmokeStatus = "ok" | "skipped" | "error";

type SmokeResult = {
  adapter: ExecutorAgent;
  status: SmokeStatus;
  reason?: string;
  binary?: string;
  protocolVersion?: number;
  acpSessionId?: string;
};

type CliArgs = {
  readonly adapters: ExecutorAgent[];
  readonly cachePath?: string;
};

const noopClient: acp.Client = {
  async sessionUpdate() {
    // Smoke does not drive prompts; updates are ignored after transport parse.
  },
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
};

function allAdapters(): ExecutorAgent[] {
  return listAdapterRuntimes().map((runtime) => runtime.id);
}

function parseArgs(): CliArgs {
  const requested: string[] = [];
  let cachePath: string | undefined;
  const argv = process.argv.slice(2);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--cache") {
      const path = argv[index + 1];

      if (!path) throw new Error("--cache requires a file path");
      cachePath = path;
      index += 1;

      continue;
    }

    requested.push(value);
  }

  if (requested.length === 0) {
    return {
      adapters: ["gemini", "opencode", "mimo"],
      cachePath: cachePath ?? process.env.MAISTER_ADAPTER_SMOKE_CACHE_PATH,
    };
  }

  const valid = new Set(allAdapters());

  return {
    adapters: requested.map((value) => {
      if (!valid.has(value as ExecutorAgent)) {
        throw new Error(
          `Unknown adapter "${value}". Expected one of: ${allAdapters().join(", ")}`,
        );
      }

      return value as ExecutorAgent;
    }),
    cachePath: cachePath ?? process.env.MAISTER_ADAPTER_SMOKE_CACHE_PATH,
  };
}

async function executablePath(binary: string): Promise<string | null> {
  const candidates = binary.includes("/")
    ? [binary]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((part) => join(part, binary));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);

      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }

  return null;
}

function runnerFor(adapter: ExecutorAgent): RunnerLaunch {
  const geminiApiKeyEnv = process.env.GEMINI_API_KEY
    ? "GEMINI_API_KEY"
    : process.env.GOOGLE_API_KEY
      ? "GOOGLE_API_KEY"
      : undefined;
  const provider =
    adapter === "claude"
      ? { kind: "anthropic" as const }
      : adapter === "codex"
        ? { kind: "openai" as const }
        : adapter === "gemini"
          ? {
              kind: "google_gemini" as const,
              ...(geminiApiKeyEnv ? { apiKeyEnv: geminiApiKeyEnv } : {}),
            }
          : { kind: "agent_native" as const };

  return {
    version: 1,
    runnerId: `smoke-${adapter}`,
    adapter,
    capabilityAgent: adapter,
    model: `smoke-${adapter}`,
    provider,
    permissionPolicy: "default",
  };
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      child.off("spawn", onSpawn);
      reject(err);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };

    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }

  child.stdin?.destroy();
  child.stdout?.destroy();
}

async function smokeAdapter(adapter: ExecutorAgent): Promise<SmokeResult> {
  const runtime = getAdapterRuntime(adapter);
  const binaryResolution = resolveAdapterBinary({ adapter });
  const resolvedPath = await executablePath(binaryResolution.binary);

  if (!resolvedPath) {
    return {
      adapter,
      status: "skipped",
      reason: `binary not executable or not found on PATH: ${binaryResolution.binary}`,
      binary: binaryResolution.binary,
    };
  }

  const cwd = await mkdtemp(join(tmpdir(), `maister-acp-smoke-${adapter}-`));
  const runner = runnerFor(adapter);
  const provisioned = provisionRunnerLaunch(runner);
  const request: StartSessionRequest = {
    runId: `smoke-${adapter}`,
    projectSlug: "smoke",
    worktreePath: cwd,
    stepId: "smoke",
    executor: provisioned.executor,
    runner,
    mcpServers: [] satisfies McpServerInput[],
  };
  const childEnv = buildChildEnv(request, { ccrLayer: {} });
  const child = spawn(resolvedPath, runtime.defaultArgs, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "ignore"],
  });

  try {
    await waitForSpawn(child);

    if (!child.stdin || !child.stdout) {
      throw new Error("adapter child has no stdio");
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(
        child.stdin as NodeWritable,
      ) as unknown as NodeWritableStream<Uint8Array>,
      Readable.toWeb(
        child.stdout as NodeReadable,
      ) as unknown as NodeReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection(() => noopClient, stream);
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: clientCapabilitiesForAdapter(adapter),
    });
    const session = await connection.newSession({ cwd, mcpServers: [] });

    return {
      adapter,
      status: "ok",
      binary: resolvedPath,
      protocolVersion: init.protocolVersion,
      acpSessionId: session.sessionId,
    };
  } catch (err) {
    return {
      adapter,
      status: "error",
      binary: resolvedPath,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await terminate(child);
    await rm(cwd, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const results: SmokeResult[] = [];

  for (const adapter of args.adapters) {
    results.push(await smokeAdapter(adapter));
  }

  for (const result of results) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  if (args.cachePath) {
    await writeAdapterSmokeCache(
      args.cachePath,
      results.map((result) => ({
        adapter: result.adapter,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.protocolVersion
          ? { protocolVersion: result.protocolVersion }
          : {}),
      })),
    );
  }

  if (results.some((result) => result.status === "error")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
