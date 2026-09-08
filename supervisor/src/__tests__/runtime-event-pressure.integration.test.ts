import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_LIMITS,
  validateRuntimeLimits,
} from "../runtime-limits";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  envelope,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const PRESSURE_LIMITS = validateRuntimeLimits({
  ...DEFAULT_RUNTIME_LIMITS,
  eventLowRows: 8,
  eventSoftRows: 20,
  eventHardRows: 32,
});
let host: BootedHost | undefined;

afterEach(async () => {
  if (!host) return;
  await host.stop();
  await cleanupRuntimeRoot(host.runtimeRoot);
  host = undefined;
});

describe("AT-02 real ACP pipe pressure", () => {
  it("refuses a second prompt before ACP dispatch while the producer owns an accepted turn", async () => {
    host = await bootHost({ fixtureArgs: ["--hang-prompt", "--lines", "0"] });
    const runId = `one-turn-${randomUUID()}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );

    expect(created.status).toBe(201);
    const sessionId = String(created.body.sessionId);
    const sibling = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );

    expect(sibling.status).toBe(201);
    expect(
      host.registry.get(String(sibling.body.sessionId))!.record.logPath,
    ).not.toBe(host.registry.get(sessionId)!.record.logPath);

    const first = envelope(
      "session.prompt",
      { hostKey: host.hostState.hostKey, runId },
      { stepId: "first", prompt: "first" },
    );
    const second = envelope(
      "session.prompt",
      { hostKey: host.hostState.hostKey, runId },
      { stepId: "second", prompt: "second" },
    );

    expect(
      (await postJson(`${host.url}/sessions/${sessionId}/prompts`, first))
        .status,
    ).toBe(202);
    const refused = await postJson(
      `${host.url}/sessions/${sessionId}/prompts`,
      second,
    );

    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe("command_in_progress");
    expect(host.hostState.getReceipt(second.command.id)).toBeNull();
    expect(host.registry.get(sessionId)?.record.activePromptCommandId).toBe(
      first.command.id,
    );
    expect(
      (
        await postJson(`${host.url}/sessions/${sessionId}/prompts`, first)
      ).headers.get("x-maister-command-replayed"),
    ).toBe("true");
  });

  it("resumes the same producer through repeated ACK/grace/prune cycles without losing semantic frames", async () => {
    let clock = Date.now();

    host = await bootHost({
      limits: PRESSURE_LIMITS,
      now: () => new Date(clock),
      fixtureArgs: ["--hang"],
    });
    const runId = `resume-${randomUUID()}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );

    expect(created.status).toBe(201);
    const sessionId = String(created.body.sessionId);
    const record = host.registry.get(sessionId)!.record;
    let updates = 0;
    const unsubscribe = host.hostState.subscribeRuntimeEvents((row) => {
      if (
        row.envelope.eventType === "session.update" &&
        row.envelope.hostSessionId === sessionId
      )
        updates += 1;
    });
    const prompt = envelope(
      "session.prompt",
      { hostKey: host.hostState.hostKey, runId },
      {
        stepId: "resume-turn",
        prompt: `fixture-output:${JSON.stringify({ frameBytes: 4096, frames: 40 })}`,
      },
    );
    const admitted = await postJson(
      `${host.url}/sessions/${sessionId}/prompts`,
      prompt,
    );

    expect(admitted.status).toBe(202);
    let cycles = 0;

    while (host.hostState.getReceipt(prompt.command.id)?.phase === "accepted") {
      await expect
        .poll(
          () =>
            record.outputPaused ||
            host!.hostState.getReceipt(prompt.command.id)?.phase !== "accepted",
          { timeout: 5000 },
        )
        .toBe(true);
      if (!record.outputPaused) break;
      const stats = host.hostState.runtimeEventOutboxStats();
      const rows = host.hostState.pendingRuntimeEvents(stats.streamId);

      host.hostState.ackRuntimeEvents(stats.streamId, rows.at(-1)!.sequence);
      expect(record.outputPaused).toBe(true);
      expect(host.hostState.runtimeEventOutboxStats().retainedBytes).toBe(
        stats.retainedBytes,
      );
      clock += PRESSURE_LIMITS.eventAckGraceMs + 1;
      host.hostState.pruneAcknowledgedRuntimeEvents(
        new Date(clock - PRESSURE_LIMITS.eventAckGraceMs),
      );
      cycles += 1;
      expect(cycles).toBeLessThan(20);
    }
    unsubscribe();
    expect(cycles).toBeGreaterThan(1);
    expect(updates).toBe(40);
    expect(host.hostState.getReceipt(prompt.command.id)).toMatchObject({
      phase: "completed",
      httpStatus: 200,
    });
    expect(record.outputFailure).toBeUndefined();
    expect(record.status).toBe("live");
    expect(
      host.hostState.runtimeEventOutboxStats().budget.reservedRegularRows,
    ).toBe(0);
  });

  it("seals the captured unsequenced segment before checkpoint/session/prompt terminal evidence", async () => {
    host = await bootHost({ limits: PRESSURE_LIMITS, fixtureArgs: ["--hang"] });
    const runId = `pressure-${randomUUID()}`;
    const create = await createEnvelope(host, { runId });
    const created = await postJson(`${host.url}/sessions`, create);

    expect(created.status).toBe(201);
    const sessionId = String(created.body.sessionId);
    const record = host.registry.get(sessionId)!.record;
    const prompt = envelope(
      "session.prompt",
      { hostKey: host.hostState.hostKey, runId },
      {
        stepId: "pressure-turn",
        prompt: `fixture-output:${JSON.stringify({ frameBytes: 65_536, frames: 128 })}`,
      },
    );
    const admitted = await postJson(
      `${host.url}/sessions/${sessionId}/prompts`,
      prompt,
    );

    expect(admitted.status).toBe(202);
    await expect
      .poll(() => record.outputPaused, { timeout: 10_000 })
      .toBe(true);
    const before = host.hostState.runtimeEventOutboxStats();

    expect(before.budget.pressured).toBe(true);
    expect(before.retainedCount).toBeLessThanOrEqual(
      PRESSURE_LIMITS.eventHardRows,
    );
    const refusal = await postJson(
      `${host.url}/sessions/${sessionId}/prompts`,
      envelope(
        "session.prompt",
        {
          hostKey: host.hostState.hostKey,
          runId,
        },
        { stepId: "refused-turn", prompt: "must not execute" },
      ),
    );

    expect(refusal.status).toBe(409);
    expect(refusal.body.details.reason).toBe("event_outbox_backpressure");
    const checkpointCommand = envelope("session.checkpoint", {
      hostKey: host.hostState.hostKey,
      runId,
    });
    const checkpoint = await postJson(
      `${host.url}/sessions/${sessionId}/checkpoint`,
      checkpointCommand,
    );

    expect(checkpoint.status).toBe(200);
    await expect
      .poll(() => host!.hostState.getReceipt(prompt.command.id)?.phase, {
        timeout: 10_000,
      })
      .toBe("rejected");
    const receipt = host.hostState.getReceipt(prompt.command.id)!;

    expect(receipt.body).toMatchObject({
      details: { reason: "required_output_incomplete" },
    });
    const rows = [] as ReturnType<typeof host.hostState.runtimeEventsAfter>;
    let cursor: string | null = null;

    for (;;) {
      const page = host.hostState.runtimeEventsAfter(
        host.hostState.getRuntimeEventStreamId(),
        cursor,
      );

      if (page.length === 0) break;
      rows.push(...page);
      cursor = page.at(-1)!.sequence;
    }
    const segment = rows.find(
      (row) =>
        row.envelope.eventType === "runtime_object.available" &&
        (row.envelope.payload as Record<string, unknown>).stdoutSegment,
    );

    expect(segment).toBeDefined();
    const payload = segment!.envelope.payload as {
      objectId: string;
      sha256: string;
      sizeBytes: number;
      stdoutSegment: {
        commandId: string;
        firstLogByteOffset: number;
        capturedBytes: number;
        completeFrames: number;
        trailingFrameBytes: number;
      };
    };

    expect(payload.stdoutSegment.commandId).toBe(prompt.command.id);
    expect(payload.stdoutSegment.completeFrames).toBeGreaterThan(0);
    expect(payload.stdoutSegment.capturedBytes).toBe(payload.sizeBytes);
    const content = await fetch(
      `${host.url}/runtime-objects/${payload.objectId}/content`,
    );
    const bytes = Buffer.from(await content.arrayBuffer());

    expect(content.status).toBe(200);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      payload.sha256,
    );
    const rawLog = await readFile(record.logPath);

    expect(bytes).toEqual(
      rawLog.subarray(
        payload.stdoutSegment.firstLogByteOffset,
        payload.stdoutSegment.firstLogByteOffset +
          payload.stdoutSegment.capturedBytes,
      ),
    );
    expect(bytes.filter((byte) => byte === 10)).toHaveLength(
      payload.stdoutSegment.completeFrames,
    );
    for (const terminal of rows.filter(
      (row) =>
        row.envelope.eventType === "session.exited" ||
        (row.envelope.eventType === "session.command" &&
          (row.envelope.payload as Record<string, unknown>).phase ===
            "completed"),
    )) {
      expect(BigInt(terminal.sequence)).toBeGreaterThan(
        BigInt(segment!.sequence),
      );
    }
    expect(
      host.hostState.runtimeEventOutboxStats().budget.reservedControlRows,
    ).toBe(0);
    expect(
      host.hostState.runtimeEventOutboxStats().budget.reservedRegularRows,
    ).toBe(0);
    const replay = await postJson(
      `${host.url}/sessions/${sessionId}/checkpoint`,
      checkpointCommand,
    );

    expect(replay.body).toEqual(checkpoint.body);
    expect(replay.headers.get("x-maister-command-replayed")).toBe("true");
  });
});
