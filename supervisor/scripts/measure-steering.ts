// ADR-182 T5.1 (D-E1): measure how a REAL adapter family treats a steer —
// opt-in (`MAISTER_MEASURE_STEERING=1`, real `claude-agent-acp` / `codex-acp`,
// provider credentials from the environment), never run by CI. Two scenarios
// per family:
//   1. tool: a prompt that runs `sleep 20` through the shell tool; on its first
//      `tool_call` update, steer "print STEERED". Records the outcome, the
//      `injected` latency, whether the in-flight tool completed or was aborted,
//      the order of STEERED and DONE in the reply, and every `_`-prefixed
//      extension frame the adapter sent (C17).
//   2. permission: a prompt that raises a permission; steer while it is
//      pending, then allow it. Records the outcome and whether the steered text
//      follows the permission's resolution.
// Prints one JSON line per family and a markdown table for `acp-runners.md`.

import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import type { ExecutorAgent, RunnerLaunch } from "../src/types";

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
import pino from "pino";

import { readSessionCapabilities, steerOnConnection } from "../src/acp-client";
import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  resolveAdapterBinary,
} from "../src/adapter-registry";
import { provisionRunnerLaunch } from "../src/runner-provisioner";
import { buildChildEnv } from "../src/spawn";

const logger = pino({ name: "measure-steering", level: "warn" });
const PROMPT_TIMEOUT_MS = 180_000;
const PERMISSION_HOLD_MS = 3_000;

type Frame = { at: number; kind: string; detail?: string };

type Scenario = {
  outcome: string;
  injectedLatencyMs: number | null;
  // Wall time of the whole prompt: a completed `sleep 20` needs >= 20 s.
  promptMs?: number;
  permissionRequests?: number;
  toolStatus?: string | null;
  replyOrder?: string;
  permissionResolved?: boolean;
  steeredAfterPermission?: boolean;
  extensionFrames: string[];
  error?: string;
};

type Measurement = {
  adapter: ExecutorAgent;
  measuredAt: string;
  advertised: boolean | null;
  tool?: Scenario;
  permission?: Scenario;
  skipped?: string;
};

// The adapter's own default model is measured: the script never calls
// `session/set_config_option`, so `model` below only satisfies the schema.
function runnerFor(adapter: ExecutorAgent): RunnerLaunch {
  return {
    version: 1,
    runnerId: `measure-${adapter}`,
    adapter,
    capabilityAgent: adapter,
    model: `measure-${adapter}`,
    provider:
      adapter === "claude"
        ? { kind: "anthropic" as const }
        : adapter === "codex"
          ? { kind: "openai" as const }
          : { kind: "agent_native" as const },
    permissionPolicy: "default",
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

function textOf(update: Record<string, unknown>): string {
  const content = update.content as
    | { type?: string; text?: string }
    | undefined;

  return content?.type === "text" ? (content.text ?? "") : "";
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        PROMPT_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function measureAdapter(adapter: ExecutorAgent): Promise<Measurement> {
  const measuredAt = new Date().toISOString();
  const binary = await executablePath(resolveAdapterBinary({ adapter }).binary);

  if (!binary)
    return {
      adapter,
      measuredAt,
      advertised: null,
      skipped: "binary not found",
    };
  const cwd = await mkdtemp(
    join(tmpdir(), `maister-steer-measure-${adapter}-`),
  );
  const provisioned = provisionRunnerLaunch(runnerFor(adapter));
  const child: ChildProcess = spawn(
    binary,
    getAdapterRuntime(adapter).defaultArgs,
    {
      cwd,
      env: buildChildEnv({ executor: provisioned.executor }),
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const frames: Frame[] = [];
  let onToolCall: ((toolCallId: string) => void) | null = null;
  let onPermission: (() => Promise<void>) | null = null;
  const toolStatus = new Map<string, string>();
  let permissionRequests = 0;
  const client: acp.Client = {
    async sessionUpdate(params) {
      const update = params.update as unknown as Record<string, unknown>;
      const kind = String(update.sessionUpdate);

      frames.push({ at: performance.now(), kind, detail: textOf(update) });
      if (kind === "tool_call" && typeof update.toolCallId === "string") {
        toolStatus.set(update.toolCallId, String(update.status ?? "pending"));
        onToolCall?.(update.toolCallId);
      }
      if (kind === "tool_call_update" && typeof update.toolCallId === "string")
        toolStatus.set(
          update.toolCallId,
          String(update.status ?? toolStatus.get(update.toolCallId)),
        );
    },
    async requestPermission(params) {
      frames.push({ at: performance.now(), kind: "request_permission" });
      permissionRequests += 1;
      await onPermission?.();
      const allow =
        params.options.find((option) => option.kind.startsWith("allow")) ??
        params.options[0];

      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async extNotification(method) {
      frames.push({ at: performance.now(), kind: `ext:${method}` });
    },
    async extMethod(method) {
      frames.push({ at: performance.now(), kind: `ext:${method}` });

      return {};
    },
  };

  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(
        child.stdin as NodeWritable,
      ) as unknown as NodeWritableStream<Uint8Array>,
      Readable.toWeb(
        child.stdout as NodeReadable,
      ) as unknown as NodeReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection(() => client, stream);
    const init = await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilitiesForAdapter(adapter),
      }),
      "initialize",
    );
    const advertised = readSessionCapabilities(init).steering.supported;

    if (!advertised)
      return { adapter, measuredAt, advertised, skipped: "not advertised" };
    const steer = async (text: string, since: number) => {
      const started = performance.now();
      const attempt = await steerOnConnection(
        connection,
        {
          adapter,
          acpSessionId: session.sessionId,
          contentBlocks: [{ type: "text", text }],
        },
        logger,
      );

      return {
        outcome:
          attempt.kind === "refused" ? attempt.adapterOutcome : attempt.kind,
        latencyMs: Math.round(performance.now() - started),
        sinceTrigger: Math.round(started - since),
      };
    };
    const extensionFrames = () =>
      [...new Set(frames.map((frame) => frame.kind))].filter((kind) =>
        kind.startsWith("ext:_"),
      );
    const reply = (from: number) =>
      frames
        .filter(
          (frame) => frame.at >= from && frame.kind === "agent_message_chunk",
        )
        .map((frame) => frame.detail ?? "")
        .join("");
    let session = await withTimeout(
      connection.newSession({ cwd, mcpServers: [] }),
      "newSession",
    );
    // Scenario 1: steer on the first tool call of a long shell command.
    let toolScenario: Scenario;

    {
      const began = performance.now();
      let steered: Promise<{ outcome: string; latencyMs: number }> | null =
        null;
      let firstTool: string | null = null;

      permissionRequests = 0;
      onToolCall = (toolCallId) => {
        if (steered) return;
        firstTool = toolCallId;
        steered = steer("Print the word STEERED before anything else.", began);
      };
      try {
        await withTimeout(
          connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: "text",
                text: "Run `sleep 20` with your shell tool, then print DONE.",
              },
            ],
          }),
          "tool prompt",
        );
        const result = steered
          ? await (steered as Promise<{ outcome: string; latencyMs: number }>)
          : { outcome: "no_tool_call", latencyMs: null };
        const text = reply(began);
        const steeredAt = text.indexOf("STEERED");
        const doneAt = text.lastIndexOf("DONE");

        toolScenario = {
          outcome: result.outcome,
          injectedLatencyMs:
            result.outcome === "injected" ? result.latencyMs : null,
          promptMs: Math.round(performance.now() - began),
          permissionRequests,
          toolStatus: firstTool ? (toolStatus.get(firstTool) ?? null) : null,
          replyOrder:
            steeredAt < 0
              ? "no STEERED"
              : doneAt < 0
                ? "STEERED, no DONE"
                : steeredAt < doneAt
                  ? "STEERED before DONE"
                  : "DONE before STEERED",
          extensionFrames: extensionFrames(),
        };
      } catch (err) {
        toolScenario = {
          outcome: "error",
          injectedLatencyMs: null,
          extensionFrames: extensionFrames(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
      onToolCall = null;
    }
    // Scenario 2: steer while a permission is pending, then allow it.
    session = await withTimeout(
      connection.newSession({ cwd, mcpServers: [] }),
      "newSession",
    );
    let permissionScenario: Scenario;

    {
      const began = performance.now();
      let steered: { outcome: string; latencyMs: number } | null = null;
      let resolvedAt = 0;

      permissionRequests = 0;

      onPermission = async () => {
        if (steered) return;
        steered = await steer("Also print PERMISSION-STEERED.", began);
        await new Promise((resolve) => setTimeout(resolve, PERMISSION_HOLD_MS));
        resolvedAt = performance.now();
      };
      try {
        await withTimeout(
          connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: "text",
                text: "Use your shell tool to run `touch /tmp/maister-steer-probe-$$` (a path outside this directory, so it needs approval), then print WRITTEN.",
              },
            ],
          }),
          "permission prompt",
        );
        const result = steered as { outcome: string; latencyMs: number } | null;
        const after = resolvedAt ? reply(resolvedAt) : "";

        permissionScenario = {
          outcome: result?.outcome ?? "no_permission",
          injectedLatencyMs:
            result?.outcome === "injected" ? result.latencyMs : null,
          promptMs: Math.round(performance.now() - began),
          permissionRequests,
          permissionResolved: resolvedAt > 0,
          steeredAfterPermission: after.includes("PERMISSION-STEERED"),
          extensionFrames: extensionFrames(),
        };
      } catch (err) {
        permissionScenario = {
          outcome: "error",
          injectedLatencyMs: null,
          extensionFrames: extensionFrames(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      adapter,
      measuredAt,
      advertised,
      tool: toolScenario,
      permission: permissionScenario,
    };
  } catch (err) {
    return {
      adapter,
      measuredAt,
      advertised: null,
      skipped: err instanceof Error ? err.message : String(err),
    };
  } finally {
    child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  }
}

function tableRow(m: Measurement): string {
  if (m.skipped)
    return `| ${m.adapter} | ${m.advertised === false ? "no" : "?"} | not measured (${m.skipped}, ${m.measuredAt.slice(0, 10)}) | | | |`;
  const tool = m.tool as Scenario;
  const permission = m.permission as Scenario;

  return `| ${m.adapter} | yes | ${tool.outcome}${tool.injectedLatencyMs !== null ? ` (${tool.injectedLatencyMs} ms)` : ""} | tool ${tool.toolStatus ?? "?"} after ${tool.promptMs ?? "?"} ms, ${tool.replyOrder ?? tool.error ?? "?"} | ${permission.outcome}${permission.permissionResolved ? ", permission resolved" : ""}${permission.steeredAfterPermission ? ", steered text after it" : ""} | ${[...new Set([...tool.extensionFrames, ...permission.extensionFrames])].join(", ") || "none"} |`;
}

async function main(): Promise<void> {
  if (process.env.MAISTER_MEASURE_STEERING !== "1") {
    process.stderr.write(
      "measure-steering runs REAL adapters against a provider; set MAISTER_MEASURE_STEERING=1 to opt in.\n",
    );
    process.exitCode = 2;

    return;
  }
  const adapters = (
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : ["claude", "codex"]
  ) as ExecutorAgent[];
  const results: Measurement[] = [];

  for (const adapter of adapters) {
    const result = await measureAdapter(adapter);

    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  process.stdout.write(
    [
      "",
      "| Family | Advertised | Steer on a running tool call | Tool / reply order | Steer during a pending permission | Extension frames |",
      "| --- | --- | --- | --- | --- | --- |",
      ...results.map(tableRow),
      "",
    ].join("\n"),
  );
}

void main();
