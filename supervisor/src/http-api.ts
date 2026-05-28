import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { SessionRegistry, RegistryEntry } from "./registry";

import { randomUUID } from "node:crypto";

import { z, ZodError } from "zod";

import { createAcpConnection, sendPromptOnConnection } from "./acp-client";
import { type CcrManager } from "./ccr-manager";
import { attachCost } from "./cost";
import { attachHeartbeat } from "./heartbeat";
import { pendingPermissions } from "./pending-permissions";
import { spawnSession } from "./spawn";
import {
  httpStatusForCode,
  isSupervisorError,
  SendPromptRequestSchema,
  StartSessionRequestSchema,
  SupervisorError,
  type SessionEvent,
} from "./types";

const InputBodySchema = z
  .object({
    kind: z.literal("permission"),
    action: z.enum(["select", "cancel"]),
    requestId: z.string().uuid(),
    optionId: z.string().min(1).optional(),
    reason: z.string().min(1).max(256).optional(),
  })
  .refine((b) => (b.action === "select" ? Boolean(b.optionId) : true), {
    message: "optionId is required when action='select'",
    path: ["optionId"],
  });

export type InputBody = z.infer<typeof InputBodySchema>;

const DEFAULT_KILL_GRACE_MS = 5_000;

export type SpawnOverrides = {
  binary?: string;
  preArgs?: string[];
  ccrManager?: CcrManager;
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
    const { child, emitter, record, acpStdoutTap, eventsLog } =
      await spawnSession({
        sessionId,
        request: parsed,
        runtimeRoot,
        logger,
        binaryOverride: opts.spawnOverrides?.binary,
        preArgs: opts.spawnOverrides?.preArgs,
        ccrManager: opts.spawnOverrides?.ccrManager,
      });

    registry.register(record, child, emitter, { eventsLog });
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
      reply.status(409).send({
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

  app.post<SessionIdParams>("/sessions/:id/input", (req, reply) => {
    const sessionId = req.params.id;
    const startedAt = Date.now();
    const parsed = InputBodySchema.safeParse(req.body);

    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");

      logger.warn(
        { sessionId, status: 409, message },
        "input route: validation failed",
      );
      reply.status(409).send({ code: "PRECONDITION", message });

      return;
    }

    const body = parsed.data;

    if (!registry.has(sessionId)) {
      logger.warn(
        { sessionId, action: body.action, requestId: body.requestId },
        "input route: unknown session",
      );
      reply
        .status(404)
        .send({ code: "NEEDS_INPUT", message: "unknown session" });

      return;
    }

    let ok: boolean;
    let outcome: "ok" | "missing";

    if (body.action === "select") {
      ok = pendingPermissions.resolve(
        sessionId,
        body.requestId,
        body.optionId as string,
      );
    } else {
      ok = pendingPermissions.cancel(
        sessionId,
        body.requestId,
        body.reason ?? "client-cancelled",
      );
    }

    outcome = ok ? "ok" : "missing";
    const latencyMs = Date.now() - startedAt;

    logger.info(
      {
        sessionId,
        action: body.action,
        requestId: body.requestId,
        latencyMs,
        outcome,
      },
      "http POST /sessions/:id/input",
    );

    if (!ok) {
      reply.status(404).send({
        code: "NEEDS_INPUT",
        message: "no pending permission with that requestId",
      });

      return;
    }

    reply.status(200).send({ ok: true });
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
