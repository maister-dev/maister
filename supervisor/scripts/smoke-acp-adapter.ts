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
import { pathToFileURL } from "node:url";

import * as acp from "@agentclientprotocol/sdk";

import { resolveReadOnlySessionDecision } from "../src/acp-client";
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
  readOnlySession?: {
    status: SmokeStatus;
    reason?: string;
    protocolVersion?: number;
  };
};

type ReadOnlySessionSmokeResult = NonNullable<SmokeResult["readOnlySession"]>;

type SmokeAdapterOptions = {
  readonly readOnlySession?: boolean;
};

type CliArgs = {
  readonly adapters: ExecutorAgent[];
  readonly cachePath?: string;
  readonly readOnlySession: boolean;
};

type PermissionProbeObservation = {
  readonly kind: string | null;
  readonly decision: "allow" | "deny";
  readonly optionId: string | null;
};

const READ_ONLY_SESSION_PROBES = [
  {
    kind: "read",
    prompt:
      "MAIster read-only-session smoke probe permission-kind:read. Request permission for a harmless read/search/fetch operation in the temporary current working directory, then stop.",
  },
  {
    kind: "edit",
    prompt:
      "MAIster read-only-session smoke probe permission-kind:edit. Request permission for a harmless write/edit operation in the temporary current working directory. If permission is denied or cancelled, do not modify files and stop.",
  },
  {
    kind: "other",
    prompt:
      "MAIster read-only-session smoke probe permission-kind:other. Request permission with an ACP other/unknown kind if your test harness supports it, then stop.",
  },
] as const;

const READ_ONLY_ALLOWED_KINDS = new Set(["read", "search", "fetch", "think"]);
const WRITE_LIKE_KINDS = new Set([
  "edit",
  "write",
  "create",
  "delete",
  "move",
  "execute",
]);

const noopClient: acp.Client = {
  async sessionUpdate() {
    // Smoke does not drive prompts; updates are ignored after transport parse.
  },
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toolCallKind(toolCall: unknown): string | null {
  if (typeof toolCall !== "object" || toolCall === null) return null;
  if (!("kind" in toolCall)) return null;

  const kind = (toolCall as { readonly kind?: unknown }).kind;

  return typeof kind === "string" ? kind : null;
}

function createReadOnlyProbeClient(
  observations: PermissionProbeObservation[],
): acp.Client {
  return {
    async sessionUpdate() {
      // Smoke probes inspect permission decisions only; updates prove prompt flow.
    },
    async requestPermission(params) {
      const kind = toolCallKind(params.toolCall);
      const options = params.options.map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        name: option.name,
      }));
      const decision = resolveReadOnlySessionDecision(
        true,
        kind ? { kind } : {},
        options,
      );

      observations.push({
        kind,
        decision: decision?.decision ?? "deny",
        optionId: decision?.option?.optionId ?? null,
      });

      if (!decision?.option) return { outcome: { outcome: "cancelled" } };

      return {
        outcome: {
          outcome: "selected",
          optionId: decision.option.optionId,
        },
      };
    },
  };
}

function isUnknownPermissionKind(kind: string | null): boolean {
  return (
    kind === null ||
    (!READ_ONLY_ALLOWED_KINDS.has(kind) && !WRITE_LIKE_KINDS.has(kind))
  );
}

function observedDecisionSummary(
  observations: readonly PermissionProbeObservation[],
): string {
  if (observations.length === 0) return "none";

  return observations
    .map((observation) => {
      const kind = observation.kind ?? "missing";
      const option = observation.optionId ? `:${observation.optionId}` : "";

      return `${kind}:${observation.decision}${option}`;
    })
    .join(", ");
}

function summarizeReadOnlyProbe(
  protocolVersion: number,
  observations: readonly PermissionProbeObservation[],
): ReadOnlySessionSmokeResult {
  const readAllowed = observations.some(
    (observation) =>
      observation.kind !== null &&
      READ_ONLY_ALLOWED_KINDS.has(observation.kind) &&
      observation.decision === "allow",
  );
  const writeDenied = observations.some(
    (observation) =>
      observation.kind !== null &&
      WRITE_LIKE_KINDS.has(observation.kind) &&
      observation.decision === "deny",
  );
  const unknownDenied = observations.some(
    (observation) =>
      isUnknownPermissionKind(observation.kind) &&
      observation.decision === "deny",
  );
  const missing = [
    ...(readAllowed ? [] : ["read allow"]),
    ...(writeDenied ? [] : ["write deny"]),
    ...(unknownDenied ? [] : ["unknown-kind deny"]),
  ];

  if (missing.length === 0) {
    return { status: "ok", protocolVersion };
  }

  return {
    status: "error",
    protocolVersion,
    reason: `read-only-session prompt probe did not observe ${missing.join(
      ", ",
    )}; observed ${observedDecisionSummary(observations)}`,
  };
}

async function smokeReadOnlySession(args: {
  readonly adapter: ExecutorAgent;
  readonly connection: acp.ClientSideConnection;
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly observations: readonly PermissionProbeObservation[];
}): Promise<ReadOnlySessionSmokeResult> {
  try {
    for (const probe of READ_ONLY_SESSION_PROBES) {
      await args.connection.prompt({
        sessionId: args.sessionId,
        prompt: [{ type: "text", text: probe.prompt }],
      });
    }
  } catch (err) {
    return {
      status: "error",
      protocolVersion: args.protocolVersion,
      reason: `${args.adapter} read-only-session prompt probe failed: ${errorMessage(
        err,
      )}`,
    };
  }

  return summarizeReadOnlyProbe(args.protocolVersion, args.observations);
}

function allAdapters(): ExecutorAgent[] {
  return listAdapterRuntimes().map((runtime) => runtime.id);
}

function parseArgs(): CliArgs {
  const requested: string[] = [];
  let cachePath: string | undefined;
  let readOnlySession = false;
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

    if (value === "--read-only-session") {
      readOnlySession = true;

      continue;
    }

    requested.push(value);
  }

  if (requested.length === 0) {
    return {
      adapters: ["gemini", "opencode", "mimo"],
      cachePath: cachePath ?? process.env.MAISTER_ADAPTER_SMOKE_CACHE_PATH,
      readOnlySession,
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
    readOnlySession,
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

export async function smokeAdapter(
  adapter: ExecutorAgent,
  options: SmokeAdapterOptions = {},
): Promise<SmokeResult> {
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
  const permissionObservations: PermissionProbeObservation[] = [];
  const client = options.readOnlySession
    ? createReadOnlyProbeClient(permissionObservations)
    : noopClient;

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
    const connection = new acp.ClientSideConnection(() => client, stream);
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: clientCapabilitiesForAdapter(adapter),
    });
    const session = await connection.newSession({ cwd, mcpServers: [] });
    const readOnlySession = options.readOnlySession
      ? await smokeReadOnlySession({
          adapter,
          connection,
          sessionId: session.sessionId,
          protocolVersion: init.protocolVersion,
          observations: permissionObservations,
        })
      : undefined;

    return {
      adapter,
      status: "ok",
      binary: resolvedPath,
      protocolVersion: init.protocolVersion,
      acpSessionId: session.sessionId,
      ...(readOnlySession ? { readOnlySession } : {}),
    };
  } catch (err) {
    return {
      adapter,
      status: "error",
      binary: resolvedPath,
      reason: errorMessage(err),
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
    const result = await smokeAdapter(adapter, {
      readOnlySession: args.readOnlySession,
    });

    results.push(result);
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
        ...(result.readOnlySession
          ? { readOnlySession: result.readOnlySession }
          : {}),
      })),
    );
  }

  if (
    results.some(
      (result) =>
        result.status === "error" || result.readOnlySession?.status === "error",
    )
  ) {
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];

  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
