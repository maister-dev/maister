import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { SessionRegistry, RegistryEntry } from "./registry";

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { createAcpConnection, sendPromptOnConnection } from "./acp-client";
import { attachCost } from "./cost";
import { attachHeartbeat } from "./heartbeat";
import { spawnSession } from "./spawn";
import {
  httpStatusForCode,
  isSupervisorError,
  SendPromptRequestSchema,
  StartSessionRequestSchema,
  SupervisorError,
  type SessionEvent,
} from "./types";

const DEFAULT_KILL_GRACE_MS = 5_000;

export type SpawnOverrides = {
  binary?: string;
  preArgs?: string[];
};

export type RegisterRoutesOptions = {
  app: FastifyInstance;
  registry: SessionRegistry;
  logger: Logger;
  runtimeRoot: string;
  killGraceMs?: number;
  spawnOverrides?: SpawnOverrides;
};

type SessionIdParams = { Params: { id: string } };

export function registerRoutes(opts: RegisterRoutesOptions): void {
  const { app, registry, logger, runtimeRoot } = opts;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  app.setErrorHandler((err, _req, reply) => {
    if (isSupervisorError(err)) {
      const status = httpStatusForCode(err.code);

      reply.status(status).send({ code: err.code, message: err.message });

      return;
    }

    if (err instanceof ZodError) {
      const message = err.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");

      reply.status(409).send({ code: "PRECONDITION", message });

      return;
    }

    const message = err instanceof Error ? err.message : String(err);

    logger.error({ err: message }, "unhandled-error");
    reply.status(500).send({ code: "ACP_PROTOCOL", message });
  });

  app.post("/sessions", async (req, reply) => {
    const parsed = StartSessionRequestSchema.parse(req.body);
    const sessionId = randomUUID();
    const { child, emitter, record, acpStdoutTap } = await spawnSession({
      sessionId,
      request: parsed,
      runtimeRoot,
      logger,
      binaryOverride: opts.spawnOverrides?.binary,
      preArgs: opts.spawnOverrides?.preArgs,
    });

    registry.register(record, child, emitter);
    attachHeartbeat({ sessionId, child, registry, logger });
    await attachCost({
      sessionId,
      runtimeRoot,
      projectSlug: parsed.projectSlug,
      runId: parsed.runId,
      emitter,
      logger,
    });

    if (!child.stdin) {
      throw new SupervisorError("SPAWN", "child has no stdin for ACP");
    }

    const { connection, acpSessionId } = await createAcpConnection({
      stdin: child.stdin,
      stdoutSource: acpStdoutTap,
      sessionId,
      worktreePath: parsed.worktreePath,
      record,
      emitter,
      logger,
    });

    registry.attachAcp(sessionId, connection, acpSessionId);

    logger.info(
      {
        sessionId,
        runId: parsed.runId,
        pid: record.pid,
        acpSessionId,
        status: 201,
      },
      "http POST /sessions",
    );
    reply.status(201).send({ sessionId, pid: record.pid, acpSessionId });
  });

  app.post<SessionIdParams>("/sessions/:id/prompt", async (req, reply) => {
    const entry = registry.get(req.params.id);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }
    if (entry.record.status !== "live") {
      reply
        .status(409)
        .send({ code: "PRECONDITION", message: "session not live" });

      return;
    }
    if (!entry.connection || !entry.acpSessionId) {
      reply
        .status(409)
        .send({
          code: "PRECONDITION",
          message: "session has no ACP connection",
        });

      return;
    }

    const body = SendPromptRequestSchema.parse(req.body);
    const resp = await sendPromptOnConnection(
      entry.connection,
      {
        acpSessionId: entry.acpSessionId,
        stepId: body.stepId,
        prompt: body.prompt,
      },
      logger,
    );

    logger.info(
      {
        sessionId: req.params.id,
        stepId: body.stepId,
        stopReason: resp.stopReason,
        status: 200,
      },
      "http POST /sessions/:id/prompt",
    );
    reply.status(200).send({ stopReason: resp.stopReason, meta: resp._meta });
  });

  app.delete<SessionIdParams>("/sessions/:id", async (req, reply) => {
    const entry = registry.get(req.params.id);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    registry.markIntentionalShutdown(req.params.id);
    entry.child.kill("SIGTERM");
    const exited = await waitForExit(entry, killGraceMs);

    if (!exited) {
      logger.warn(
        { sessionId: req.params.id, killGraceMs },
        "sigterm-grace-expired-sigkill",
      );
      entry.child.kill("SIGKILL");
    }

    logger.info(
      { sessionId: req.params.id, status: 204 },
      "http DELETE /sessions/:id",
    );
    reply.status(204).send();
  });

  app.get("/sessions", async (_req, reply) => {
    reply.send(registry.list());
  });

  app.get<SessionIdParams>("/sessions/:id/stream", (req, reply) => {
    const sessionId = req.params.id;
    const entry = registry.get(sessionId);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    const lastEventId = Number(req.headers["last-event-id"] ?? 0);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();

    logger.debug({ sessionId, lastEventId }, "sse-connect");

    let highestSent = lastEventId;
    let terminalSent = false;
    const send = (event: SessionEvent) => {
      if (terminalSent) return;
      if (event.monotonicId <= highestSent) return;

      highestSent = event.monotonicId;
      const payload = `id: ${event.monotonicId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

      reply.raw.write(payload);

      if (event.type === "session.exited" || event.type === "session.crashed") {
        terminalSent = true;
        reply.raw.end();
      }
    };

    const unsubscribe = registry.subscribe(sessionId, send);

    req.raw.on("close", () => {
      unsubscribe();
      logger.debug(
        { sessionId, reason: "client-disconnect" },
        "sse-disconnect",
      );
    });

    for (const buffered of registry.snapshotEvents(sessionId)) {
      send(buffered);
    }

    if (!terminalSent && entry.record.status === "exited") {
      send({
        type: "session.exited",
        sessionId,
        monotonicId: entry.record.monotonicId,
        exitCode: entry.record.exitCode ?? 0,
      });
    } else if (!terminalSent && entry.record.status === "crashed") {
      send({
        type: "session.crashed",
        sessionId,
        monotonicId: entry.record.monotonicId,
        exitCode: entry.record.exitCode ?? null,
        signal: entry.record.signal ?? null,
      });
    }
  });

  app.post<SessionIdParams>("/sessions/:id/checkpoint", (req, reply) => {
    if (!registry.has(req.params.id)) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    logger.info(
      { sessionId: req.params.id, status: 202 },
      "http POST /sessions/:id/checkpoint (stub M3)",
    );
    reply.status(202).send({ status: "deferred", milestone: "M8" });
  });

  app.post<SessionIdParams>("/sessions/:id/input", (_req, reply) => {
    reply.status(501).send({
      code: "ACP_PROTOCOL",
      message: "Not implemented in M3 — see M7",
    });
  });
}

async function waitForExit(
  entry: RegistryEntry,
  timeoutMs: number,
): Promise<boolean> {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    return true;
  }

  return new Promise<boolean>((resolveP) => {
    const timer = setTimeout(() => resolveP(false), timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveP(true);
    };

    entry.child.once("exit", onExit);
  });
}
