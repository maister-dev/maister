#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFile, open, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const args = process.argv.slice(2);
let lines = 3;
let exitCode = 0;
let hang = false;
let controlledExit = false;
let hangInitialize = false;
let hangNewSession = false;
let hangPrompt = false;
let hangPermission = false;
let exitDelayMs = 0;
let emitUsage = false;
let supportsResume = false;
let invocationLog;
let controlledPrompt = false;
let releasePrompt;
// ADR-182 steering fixture: advertise `_meta.steering.supported`, register the
// `_session/steering` extension request and script its answer. `auto` behaves
// like a host-honouring adapter: `injected` while a prompt runs, otherwise
// `promptRequired`. Without --steering the method is not registered at all.
let steering = false;
let steerOutcome = "auto";
let steerDelayMs = 0;
let steerEcho = false;
let promptInFlight = false;
const steerQueue = [];
let unownedTurn;
const outputWrites = [];
const sizedOutputWrites = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--lines") {
    lines = Number.parseInt(args[++i], 10);
  } else if (arg === "--exit-code") {
    exitCode = Number.parseInt(args[++i], 10);
  } else if (arg === "--hang") {
    hang = true;
  } else if (arg === "--controlled-exit") {
    controlledExit = true;
    hang = true;
  } else if (arg === "--hang-initialize") {
    hangInitialize = true;
  } else if (arg === "--hang-new-session") {
    hangNewSession = true;
  } else if (arg === "--hang-prompt") {
    hangPrompt = true;
  } else if (arg === "--hang-permission") {
    hangPermission = true;
  } else if (arg === "--exit-delay-ms") {
    exitDelayMs = Number.parseInt(args[++i], 10);
  } else if (arg === "--emit-usage") {
    emitUsage = true;
  } else if (arg === "--supports-resume") {
    supportsResume = true;
  } else if (arg === "--invocation-log") {
    invocationLog = args[++i];
    if (!invocationLog) throw new Error("--invocation-log requires a path");
  } else if (arg === "--controlled-prompt") {
    controlledPrompt = true;
  } else if (arg === "--write-env") {
    outputWrites.push({ envName: args[++i], content: args[++i] });
  } else if (arg === "--write-env-bytes") {
    sizedOutputWrites.push({ envName: args[++i], sizeBytes: Number(args[++i]) });
  } else if (arg === "--steering") {
    steering = true;
  } else if (arg === "--steer-outcome") {
    steerOutcome = args[++i];
    if (!["auto", "injected", "promptRequired", "startedNewTurn", "failed", "hang"].includes(steerOutcome))
      throw new Error(`unknown --steer-outcome ${steerOutcome}`);
  } else if (arg === "--steer-delay-ms") {
    steerDelayMs = Number.parseInt(args[++i], 10);
  } else if (arg === "--steer-echo") {
    steerEcho = true;
  }
}

async function logInvocation(entry) {
  if (!invocationLog) return;
  await appendFile(invocationLog, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function steerText(prompt) {
  return (prompt ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function never() {
  return new Promise(() => {});
}

class LifecycleAgent {
  constructor(connection) {
    this.connection = connection;
    this.resumed = false;
    // Registered only when advertised: the SDK wires an extension handler iff
    // the agent object defines `extMethod`.
    if (steering) this.extMethod = (method, params) => this.steer(method, params);
  }

  async steer(method, params) {
    if (method !== "_session/steering")
      throw acp.RequestError.methodNotFound(method);
    const idleBehavior = params?._meta?.steering?.idleBehavior ?? null;
    const text = steerText(params?.prompt);

    if (steerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, steerDelayMs));
    if (steerOutcome === "hang") return never();
    if (steerEcho) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
      });
    }
    const outcome =
      steerOutcome === "auto"
        ? promptInFlight ? "injected" : "promptRequired"
        : steerOutcome;

    if (outcome === "injected") steerQueue.push(text);
    if (outcome === "startedNewTurn") this.startUnownedTurn(params.sessionId);
    await logInvocation({
      sessionId: params.sessionId,
      method: "_session/steering",
      requestSha256: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
      idleBehavior,
      outcome,
    });
    if (outcome === "failed") return { outcome: "failed" };

    return outcome === "promptRequired"
      ? { outcome, reason: "noRunningTurn" }
      : { outcome };
  }

  // A turn nobody owns: chunks every 50 ms until `session/cancel` arrives, and
  // (with --hang-permission) a permission request the host must release.
  startUnownedTurn(sessionId) {
    let stopped = false;
    let count = 0;
    const timer = setInterval(() => {
      if (stopped) return;
      count += 1;
      void this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `unowned:${count}` } },
      });
    }, 50);

    unownedTurn = () => {
      stopped = true;
      clearInterval(timer);
      unownedTurn = undefined;
    };
    if (hangPermission) {
      void this.connection
        .requestPermission({
          sessionId,
          toolCall: { toolCallId: "unowned-permission", title: "unowned write", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        })
        .then((decision) => logInvocation({ sessionId, method: "unowned/permission", outcome: decision.outcome.outcome }))
        .catch(() => undefined);
    }
  }

  async initialize() {
    if (hangInitialize) return never();

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        ...(supportsResume ? { sessionCapabilities: { resume: {} } } : {}),
      },
      ...(steering ? { _meta: { steering: { supported: true } } } : {}),
    };
  }

  async newSession() {
    if (hangNewSession) return never();

    return { sessionId: `mock-${randomUUID()}` };
  }

  async loadSession() {
    this.resumed = true;
    return {};
  }

  async resumeSession(request) {
    if (request.sessionId === "fixture-missing-session")
      throw new acp.RequestError(
        -32000,
        "session not found: fixture-missing-session",
      );
    this.resumed = true;
    return {};
  }

  async closeSession() {
    return {};
  }

  async listSessions() {
    return { sessions: [] };
  }

  async setSessionMode() {
    return {};
  }

  async setSessionConfigOption() {
    return { configOptions: [] };
  }

  async authenticate() {
    return {};
  }

  async cancel(params) {
    if (steering) {
      await logInvocation({ sessionId: params?.sessionId, method: "session/cancel", unowned: Boolean(unownedTurn) });
      if (unownedTurn) {
        unownedTurn();

        return;
      }
    }
    if (controlledPrompt && releasePrompt) releasePrompt("cancelled");
  }

  async prompt(params) {
    promptInFlight = true;
    try {
      return await this.runPrompt(params);
    } finally {
      promptInFlight = false;
    }
  }

  // Emitted only after the steer was acknowledged (the controlled prompt holds
  // until released), so transcript order is the host's acceptance order.
  async drainSteers(sessionId) {
    while (steerQueue.length > 0) {
      const text = steerQueue.shift();

      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `steered:${text}` } },
      });
    }
  }

  async runPrompt(params) {
    // Install the release before publishing the reached witness to the test.
    const held = controlledPrompt ? new Promise((resolve) => {
      if (releasePrompt) throw new Error("controlled prompt already owns the adapter");
      releasePrompt = (value) => { releasePrompt = undefined; resolve(value); };
    }) : undefined;
    if (invocationLog) {
      await appendFile(invocationLog, `${JSON.stringify({
        pid: process.pid,
        sessionId: params.sessionId,
        method: "session/prompt",
        requestSha256: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
      })}\n`);
    }
    if (controlledPrompt) {
      const outcome = await held;
      if (outcome === "cancelled") return { stopReason: "cancelled" };
    }
    await this.drainSteers(params.sessionId);
    // Exercise real ACP framing without putting megabyte arguments in argv.
    const fixtureText = params.prompt.find(
      (block) => block.type === "text",
    )?.text;
    const fixtureLine = fixtureText?.split("\n").find((line) => line.startsWith("fixture-output:"));
    if (fixtureLine) {
      // Flow nodes may surround the fixture line with resume and run context.
      const spec = JSON.parse(fixtureLine.slice("fixture-output:".length));
      if (spec.failMessage) throw new acp.RequestError(-32603, spec.failMessage);
      if (spec.usageTokens) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "" },
            model: "claude-sonnet-4-6",
            usage: { input_tokens: spec.usageTokens, output_tokens: 0 },
          },
        });
      }
      if (spec.permission && (!spec.hookTrip || !this.resumed || spec.permissionOnResume)) {
        const decisions = await Promise.all(Array.from({ length: spec.parallelPermission && !this.resumed ? 2 : 1 }, (_, index) => this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: `owned-permission-${index}`, title: "fixture write", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        })));
        if (decisions.some((decision) => decision.outcome.outcome !== "selected" || decision.outcome.optionId !== "allow"))
          throw new acp.RequestError(-32603, "fixture permission was not allowed");
      }
      if (spec.frameBytes) {
        const notification = {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "" },
            },
          },
        };
        const overhead = Buffer.byteLength(JSON.stringify(notification) + "\n");
        const available = spec.frameBytes - overhead;
        notification.params.update.content.text = spec.escaped
          ? "é" + "\\".repeat(Math.floor((available - 2) / 2)) + "x".repeat((available - 2) % 2)
          : "x".repeat(available);
        for (let index = 0; index < (spec.frames ?? 1); index += 1) {
          await new Promise((resolve, reject) =>
            process.stdout.write(JSON.stringify(notification) + "\n", (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        }
        return { stopReason: "end_turn" };
      }
      const glyph = spec.multibyte ? "é" : "x";
      const text =
        glyph.repeat(Math.floor(spec.bytes / Buffer.byteLength(glyph))) +
        "x".repeat(spec.bytes % Buffer.byteLength(glyph)) +
        (spec.text ?? "");
      const chunks =
        spec.chunkSize && !spec.tool
          ? Array.from(
              { length: Math.ceil(text.length / spec.chunkSize) },
              (_, index) => text.slice(index * spec.chunkSize, (index + 1) * spec.chunkSize),
            )
          : [text];
      for (const chunk of chunks) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: spec.tool
            ? {
                sessionUpdate: "tool_call",
                toolCallId: "large-tool",
                title: "fixture output",
                kind: "read",
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: chunk } }],
              }
            : {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: chunk },
              },
        });
      }
      if (spec.terminalDelayMs) await new Promise((resolve) => setTimeout(resolve, spec.terminalDelayMs));
      await this.drainSteers(params.sessionId);
      return {
        stopReason: spec.stopReason ?? "end_turn",
        ...(spec.usageTokens ? { usage: { input_tokens: spec.usageTokens, output_tokens: 0 } } : {}),
        ...(spec.responseMeta ? { _meta: spec.responseMeta } : {}),
      };
    }
    for (const output of outputWrites) {
      const outputPath = process.env[output.envName];

      if (!outputPath) {
        throw new Error(
          `missing required output environment ${output.envName}`,
        );
      }
      await writeFile(outputPath, output.content, {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    for (const output of sizedOutputWrites) {
      const outputPath = process.env[output.envName];

      if (!outputPath || !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 0)
        throw new Error("invalid bounded output fixture configuration");
      const handle = await open(outputPath, "w", 0o600);
      const bytes = Buffer.alloc(65536, 120);

      try {
        for (let offset = 0; offset < output.sizeBytes;) {
          const result = await handle.write(bytes, 0, Math.min(bytes.length, output.sizeBytes - offset));

          if (result.bytesWritten === 0) throw new Error("fixture output write made no progress");
          offset += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
    }

    for (let i = 0; i < lines; i += 1) {
      const isLast = i === lines - 1;

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `line ${i}` },
          ...(isLast && emitUsage
            ? {
                model: "claude-sonnet-4-6",
                usage: {
                  input_tokens: 100,
                  output_tokens: 200,
                  cache_creation_input_tokens: 5000,
                  cache_read_input_tokens: 0,
                },
              }
            : {}),
        },
      });
    }

    // ADR-166 F10: park the turn on an OPEN permission request so an eviction
    // lands while the deferred is pending; the outcome is irrelevant (the
    // eviction SIGTERMs us), so the turn stays open afterwards.
    if (hangPermission) {
      await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-1",
          title: "write file",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });

      return never();
    }

    // ADR-166 F6: keep the turn open forever so an eviction lands mid-prompt.
    if (hangPrompt) return never();

    if (!hang) {
      setTimeout(() => process.exit(exitCode), 10);
    }

    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new acp.AgentSideConnection(
  (connToAgent) => new LifecycleAgent(connToAgent),
  stream,
);

// --exit-delay-ms: hold the process open after SIGTERM so a test can prove an
// eviction is awaited (nothing spawns beside a dying lower-epoch session).
process.on("SIGTERM", () => setTimeout(() => process.exit(143), exitDelayMs));
process.on("SIGINT", () => process.exit(130));
// Lifecycle tests release this barrier only after prompt receipt completion.
if (controlledExit) process.on("SIGUSR2", () => process.exit(exitCode));
// A test-owned adapter barrier. No elapsed delay opens the completion window.
if (controlledPrompt) process.on("SIGUSR1", () => releasePrompt?.("complete"));

setInterval(() => {}, 1 << 30);
