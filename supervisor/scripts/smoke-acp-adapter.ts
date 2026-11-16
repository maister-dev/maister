import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import type { ExecutorAgent, RunnerLaunch } from "../src/types";

import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  Readable,
  Writable,
  type Readable as NodeReadable,
  type Writable as NodeWritable,
} from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as acp from "@agentclientprotocol/sdk/unstable";

import {
  connectAcpClient,
  type AcpClientHandlers,
  type AcpConnection,
} from "../src/acp-connection";
import {
  readSessionCapabilities,
  resolveReadOnlySessionDecision,
} from "../src/acp-client";
import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  listAdapterRuntimes,
  resolveAdapterBinary,
} from "../src/adapter-registry";
import { extractToolIdentity } from "../src/guardrail-hooks";
import { claudeToolArbitrationMeta } from "../src/claude-tool-arbitration";
import {
  invalidateAdapterReadOnlySmokeCache,
  writeAdapterSmokeCache,
} from "../src/adapter-smoke-cache";
import { withAdapterSmokeCacheLock } from "../src/adapter-smoke-cache-lock";
import { provisionRunnerLaunch } from "../src/runner-provisioner";
import { buildChildEnv } from "../src/spawn";
import { readSessionModels } from "../src/session-models";
import { RunnerLaunchSchema } from "../src/types";

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
  capabilityEnforcement?: {
    status: SmokeStatus;
    reason?: string;
    protocolVersion?: number;
  };
  // ADR-182: the family's `initialize` steering advertisement.
  steering?: { supported: boolean };
};

type ReadOnlySessionSmokeResult = NonNullable<SmokeResult["readOnlySession"]>;
type CapabilityEnforcementSmokeResult = NonNullable<
  SmokeResult["capabilityEnforcement"]
>;

type SmokeAdapterOptions = {
  readonly readOnlySession?: boolean;
  readonly capabilityEnforcement?: boolean;
  readonly runner?: RunnerLaunch;
};

type CliArgs = {
  readonly adapters: ExecutorAgent[];
  readonly cachePath?: string;
  readonly readOnlySession: boolean;
  readonly capabilityEnforcement: boolean;
  readonly runnerPath?: string;
  readonly runner?: RunnerLaunch;
};

type PermissionProbeObservation = {
  readonly kind: string | null;
  readonly decision: "allow" | "deny";
  readonly optionId: string | null;
};

// ADR-130: a single capability_guard probe observation — the tool identity the seam
// surfaced (name + MCP server), the kind, and the synchronous decision latency.
type CapabilityProbeObservation = {
  readonly kind: string | null;
  readonly name: string | null;
  readonly mcpServer: string | null;
  readonly latencyMs: number;
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
const SMOKE_OPERATION_TIMEOUT_MS = 10_000;
const SMOKE_TEARDOWN_GRACE_MS = 2_000;

// ADR-130 capability_guard smoke (DES-8): prove `requestPermission` fires per
// write, benign shell and ordinary/read-only MCP call under default policy;
// `params.toolCall`
// carries a stable tool identity — a plain tool name and an MCP
// `mcp__<server>__<tool>` name whose server is resolvable. The hints retain the
// fixture adapter contract; real adapters receive executable, isolated probes.
const CAPABILITY_ENFORCEMENT_PROBES = [
  {
    toolName: "Bash",
    prompt:
      "MAIster capability-enforcement smoke probe tool-name:Bash permission-kind:execute. Use your shell tool to create only ./capability-probe.txt containing probe. This is an isolated temporary directory. If permission is denied or cancelled, stop immediately without another tool or method.",
  },
  {
    prompt:
      "MAIster capability-enforcement smoke probe tool-name:mcp__maister__hitl_list permission-kind:other. Call the configured maister MCP tool hitl_list exactly once with {}. It is a harmless isolated probe, not a real Inbox. If permission is denied or cancelled, stop immediately. Do not simulate the tool result.",
    toolName: "mcp__maister__hitl_list",
  },
  {
    toolName: "Bash",
    prompt:
      "MAIster capability-enforcement smoke probe tool-name:Bash permission-kind:execute. Use your Bash tool to run exactly true once. Do not write a file or use another command. If permission is denied or cancelled, stop immediately without another tool or method.",
  },
  {
    toolName: "mcp__maister__probe_read",
    prompt:
      "MAIster capability-enforcement smoke probe tool-name:mcp__maister__probe_read permission-kind:read. Call the configured maister MCP tool probe_read exactly once with {}. It is an isolated read-only probe with no real data. If permission is denied or cancelled, stop immediately. Do not simulate its output.",
  },
] as const;

const noopClient: AcpClientHandlers = {
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

async function withSmokeTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number = SMOKE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toolCallKind(toolCall: unknown): string | null {
  if (typeof toolCall !== "object" || toolCall === null) return null;
  if (!("kind" in toolCall)) return null;

  const kind = (toolCall as { readonly kind?: unknown }).kind;

  return typeof kind === "string" ? kind : null;
}

function createReadOnlyProbeClient(
  observations: PermissionProbeObservation[],
): AcpClientHandlers {
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

function createCapabilityEnforcementProbeClient(
  observations: CapabilityProbeObservation[],
): AcpClientHandlers {
  return {
    async sessionUpdate() {
      // Smoke probes inspect the permission request only.
    },
    async requestPermission(params) {
      const started = performance.now();
      const identity = extractToolIdentity(params.toolCall);

      if (identity.name === "ToolSearch" && identity.mcpServer === null) {
        const allow = params.options.find(
          (option) => option.kind === "allow_once",
        );

        return allow
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
      const denyOption = params.options.find(
        (option) => option.kind === "reject_once",
      )?.optionId;

      observations.push({
        kind: toolCallKind(params.toolCall),
        name: identity.name,
        mcpServer: identity.mcpServer,
        latencyMs: performance.now() - started,
      });

      // Never persist an allow rule or execute the requested mutation. Reaching
      // the callback is the evidence; the controlled tool is denied inline.
      if (!denyOption) return { outcome: { outcome: "cancelled" } };

      return { outcome: { outcome: "selected", optionId: denyOption } };
    },
  };
}

export function summarizeCapabilityEnforcementProbe(
  protocolVersion: number,
  observations: readonly CapabilityProbeObservation[],
): CapabilityEnforcementSmokeResult {
  const firedForEveryProbe =
    observations.length >= CAPABILITY_ENFORCEMENT_PROBES.length;
  // `identitySurfaced` proves the seam SEES a non-null identity per probe — NOT that a
  // plain tool name is a STABLE identifier (vs a per-call human `title` that would never
  // match an allow-list). Stability is operator-verified from the observed names in the
  // failure reason below: claude surfaces the stable `_meta.claudeCode.toolName`; a
  // `title`-only adapter must be inspected before its `ok` is cached (ADR-130, M2). The
  // MCP probe is stronger — `mcpResolved` requires the `mcp__<server>__<tool>` structure.
  const identitySurfaced =
    observations.length > 0 && observations.every((o) => o.name !== null);
  const mcpResolved = observations.some((o) => o.mcpServer !== null);
  const missing = [
    ...(firedForEveryProbe ? [] : ["requestPermission per probe"]),
    ...(identitySurfaced ? [] : ["a stable tool identity on every call"]),
    ...(mcpResolved ? [] : ["a resolvable MCP server namespace"]),
  ];

  if (missing.length === 0) {
    return { status: "ok", protocolVersion };
  }

  const observed = observations
    .map((o) => `${o.kind ?? "?"}:${o.name ?? "no-identity"}`)
    .join(", ");

  return {
    status: "error",
    protocolVersion,
    reason: `capability-enforcement prompt probe did not observe ${missing.join(
      ", ",
    )}; observed ${observed || "none"}`,
  };
}

async function smokeCapabilityEnforcement(args: {
  readonly adapter: ExecutorAgent;
  readonly connection: AcpConnection;
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly observations: readonly CapabilityProbeObservation[];
}): Promise<CapabilityEnforcementSmokeResult> {
  try {
    for (const probe of CAPABILITY_ENFORCEMENT_PROBES) {
      const start = args.observations.length;

      await withSmokeTimeout(
        args.connection.prompt({
          sessionId: args.sessionId,
          prompt: [{ type: "text", text: probe.prompt }],
        }),
        `${args.adapter} capability permission probe`,
        60_000,
      );
      if (
        !args.observations
          .slice(start)
          .some((observation) => observation.name === probe.toolName)
      ) {
        return {
          status: "error",
          protocolVersion: args.protocolVersion,
          reason: `${args.adapter} capability probe for ${probe.toolName} did not reach requestPermission`,
        };
      }
    }
  } catch (err) {
    return {
      status: "error",
      protocolVersion: args.protocolVersion,
      reason: `${args.adapter} capability-enforcement prompt probe failed: ${errorMessage(
        err,
      )}`,
    };
  }

  return summarizeCapabilityEnforcementProbe(
    args.protocolVersion,
    args.observations,
  );
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
  readonly connection: AcpConnection;
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly observations: readonly PermissionProbeObservation[];
}): Promise<ReadOnlySessionSmokeResult> {
  try {
    for (const probe of READ_ONLY_SESSION_PROBES) {
      await withSmokeTimeout(
        args.connection.prompt({
          sessionId: args.sessionId,
          prompt: [{ type: "text", text: probe.prompt }],
        }),
        `${args.adapter} ${probe.kind} permission probe`,
      );
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
  let capabilityEnforcement = false;
  let runnerPath: string | undefined;
  const argv = process.argv.slice(2);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--runner") {
      runnerPath = argv[index + 1];
      if (!runnerPath)
        throw new Error("--runner requires a RunnerLaunch JSON path");
      index += 1;

      continue;
    }

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

    if (value === "--capability-enforcement") {
      capabilityEnforcement = true;

      continue;
    }

    requested.push(value);
  }

  if (requested.length === 0) {
    return {
      adapters: ["gemini", "opencode", "mimo"],
      cachePath: cachePath ?? process.env.MAISTER_ADAPTER_SMOKE_CACHE_PATH,
      readOnlySession,
      capabilityEnforcement,
      runnerPath,
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
    capabilityEnforcement,
    runnerPath,
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

function childIsDead(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isMissingProcess(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === "ESRCH"
  );
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (err) {
    if (!isMissingProcess(err)) throw err;
  }
}

function waitForChildExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (childIsDead(child)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);

    child.once("exit", onExit);
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  try {
    if (childIsDead(child)) return;

    signalChild(child, "SIGTERM");
    if (await waitForChildExit(child, SMOKE_TEARDOWN_GRACE_MS)) return;

    signalChild(child, "SIGKILL");
    if (await waitForChildExit(child, SMOKE_TEARDOWN_GRACE_MS)) return;

    throw new Error("smoke adapter child did not exit after SIGKILL");
  } finally {
    child.stdin?.destroy();
    child.stdout?.destroy();
  }
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

  const runner = options.runner ?? runnerFor(adapter);

  if (
    runner.adapter !== adapter ||
    runner.capabilityAgent !== adapter ||
    runner.permissionPolicy !== "default"
  ) {
    throw new Error(
      "smoke runner must match the adapter and use default permissions",
    );
  }
  const provisioned = provisionRunnerLaunch(runner);
  const childEnv = buildChildEnv({ executor: provisioned.executor });
  const cwd = await mkdtemp(join(tmpdir(), `maister-acp-smoke-${adapter}-`));

  if (adapter === "claude" && options.capabilityEnforcement) {
    await mkdir(join(cwd, ".claude"));
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { defaultMode: "default" },
        ...(options.runner
          ? { model: runner.model, availableModels: [runner.model] }
          : {}),
      }),
    );
  }
  const child = spawn(resolvedPath, runtime.defaultArgs, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const permissionObservations: PermissionProbeObservation[] = [];
  const capabilityObservations: CapabilityProbeObservation[] = [];
  const client = options.capabilityEnforcement
    ? createCapabilityEnforcementProbeClient(capabilityObservations)
    : options.readOnlySession
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
    const connection = connectAcpClient(stream, client);
    const init = await withSmokeTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilitiesForAdapter(adapter),
      }),
      `${adapter} initialize`,
    );
    const session = await withSmokeTimeout(
      connection.newSession({
        ...(adapter === "claude" &&
        (options.capabilityEnforcement || options.readOnlySession)
          ? { _meta: claudeToolArbitrationMeta() }
          : {}),
        cwd,
        mcpServers: options.capabilityEnforcement
          ? [
              {
                name: "maister",
                command: process.execPath,
                args: [
                  "--import",
                  import.meta.resolve("tsx"),
                  fileURLToPath(
                    new URL("./smoke-capability-server.ts", import.meta.url),
                  ),
                ],
                env: [],
              },
            ]
          : [],
      }),
      `${adapter} newSession`,
    );

    if (options.runner && runtime.modelChannel === "set_session_model") {
      const models = readSessionModels(session);

      if (!models.configId)
        throw new Error("smoke adapter exposes no model configuration option");
      await withSmokeTimeout(
        connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: models.configId,
          value: runner.model,
        }),
        `${adapter} configured model`,
      );
    }
    const readOnlySession =
      options.readOnlySession && !options.capabilityEnforcement
        ? await smokeReadOnlySession({
            adapter,
            connection,
            sessionId: session.sessionId,
            protocolVersion: init.protocolVersion,
            observations: permissionObservations,
          })
        : undefined;
    const capabilityEnforcement = options.capabilityEnforcement
      ? await smokeCapabilityEnforcement({
          adapter,
          connection,
          sessionId: session.sessionId,
          protocolVersion: init.protocolVersion,
          observations: capabilityObservations,
        })
      : undefined;

    return {
      adapter,
      status: "ok",
      binary: resolvedPath,
      protocolVersion: init.protocolVersion,
      acpSessionId: session.sessionId,
      steering: readSessionCapabilities(init).steering,
      ...(readOnlySession ? { readOnlySession } : {}),
      ...(capabilityEnforcement ? { capabilityEnforcement } : {}),
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

async function smokeAndCache(args: CliArgs): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];

  for (const adapter of args.adapters) {
    if (args.cachePath && args.readOnlySession) {
      await invalidateAdapterReadOnlySmokeCache(args.cachePath, adapter);
    }

    const result = await smokeAdapter(adapter, {
      readOnlySession: args.readOnlySession,
      capabilityEnforcement: args.capabilityEnforcement,
      runner: args.runner,
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
        ...(result.capabilityEnforcement
          ? { capabilityEnforcement: result.capabilityEnforcement }
          : {}),
        ...(result.steering ? { steering: result.steering } : {}),
      })),
    );
  }

  return results;
}

async function main(): Promise<void> {
  const parsed = parseArgs();
  const runner = parsed.runnerPath
    ? RunnerLaunchSchema.parse(
        JSON.parse(await readFile(parsed.runnerPath, "utf8")),
      )
    : undefined;

  if (
    runner &&
    (parsed.adapters.length !== 1 || parsed.adapters[0] !== runner.adapter)
  ) {
    throw new Error("--runner requires exactly its matching adapter argument");
  }
  const args: CliArgs = { ...parsed, runner };
  const results = args.cachePath
    ? await withAdapterSmokeCacheLock(args.cachePath, () => smokeAndCache(args))
    : await smokeAndCache(args);

  if (
    results.some(
      (result) =>
        result.status === "error" ||
        result.readOnlySession?.status === "error" ||
        result.capabilityEnforcement?.status === "error",
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
