import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";

import { outputBufferStats } from "../../bounded-acp-stream";
import { RuntimeObjectRegistry } from "../../runtime-objects";

import {
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  createSession,
  createEnvelope,
  postJson,
  envelope,
  fenceFor,
} from "./boot-host";

const collect = global.gc;

assert(collect, "run the output memory qualification with --expose-gc");
const outputDirectory = process.argv[2];

assert(outputDirectory, "provide an artifact directory");
const inspector = new Session();

inspector.connect();
await new Promise<void>((resolve, reject) =>
  inspector.post(
    "HeapProfiler.startSampling",
    { samplingInterval: 16384 },
    (error) => (error ? reject(error) : resolve()),
  ),
);
const host = await bootHost({ fixtureArgs: ["--hang", "--lines", "0"] });
const originalCapture = RuntimeObjectRegistry.prototype.captureSessionContent;
let baseline = process.memoryUsage();
let peakBytes = 0;
let maxReservedBytes = 0;
let captures = 0;
let snapshotWritten = false;
let peakUsage = baseline;

try {
  const sessions = [];

  for (let index = 0; index < 20; index += 1) {
    const runId = `memory-${index}`;

    sessions.push({ runId, ...(await createSession(host, { runId })) });
  }
  assert.equal(outputBufferStats().producers, 20);
  const refused = await postJson(
    `${host.url}/sessions`,
    await createEnvelope(host, { runId: "memory-over-capacity" }),
  );

  assert.equal(refused.status, 503);
  assert.equal(outputBufferStats().producers, 20);
  // Warm installed SDK, HTTP and publisher code before measuring retained
  // output. The sampling profile also records transient allocation stacks.
  await completePrompt(
    host,
    sessions[0].sessionId,
    envelope("session.prompt", fenceFor(host, sessions[0].runId), {
      stepId: "warm",
      prompt: 'fixture-output:{"bytes":65537}',
    }),
  );
  collect();
  baseline = process.memoryUsage();
  RuntimeObjectRegistry.prototype.captureSessionContent = function (input) {
    collect();
    const usage = process.memoryUsage();
    const retained =
      Math.max(0, usage.heapUsed - baseline.heapUsed) +
      Math.max(0, usage.arrayBuffers - baseline.arrayBuffers);

    if (retained > peakBytes) {
      peakBytes = retained;
      peakUsage = usage;
    }
    if (retained > 12 * 1024 * 1024 && !snapshotWritten) {
      snapshotWritten = true;
      writeHeapSnapshot(
        join(outputDirectory, "s1-2-memory-overflow.heapsnapshot"),
      );
    }
    maxReservedBytes = Math.max(
      maxReservedBytes,
      outputBufferStats().reservedBytes,
    );
    captures += 1;

    return originalCapture.call(this, input);
  };
  for (let wave = 0; wave < 2; wave += 1) {
    const results = await Promise.all(
      sessions.map(({ sessionId, runId }) =>
        completePrompt(
          host,
          sessionId,
          envelope("session.prompt", fenceFor(host, runId), {
            stepId: `wave-${wave}`,
            prompt: 'fixture-output:{"frameBytes":1048576,"escaped":true}',
          }),
        ),
      ),
    );

    results.forEach((result) =>
      assert.equal(result.status, 200, JSON.stringify(result.body)),
    );
  }
  assert.equal(captures, 80);
  const chat = await completePrompt(
    host,
    sessions[0].sessionId,
    envelope("session.prompt", fenceFor(host, sessions[0].runId), {
      stepId: "gate-chat-memory",
      prompt: 'fixture-output:{"bytes":65537}',
    }),
  );

  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert(
    host.registry
      .snapshotEvents(sessions[0].sessionId)
      .some(
        (event) =>
          event.type === "session.content" &&
          event.eventType === "session.chat_turn",
      ),
  );
  const refusedChat = await completePrompt(
    host,
    sessions[0].sessionId,
    envelope("session.prompt", fenceFor(host, sessions[0].runId), {
      stepId: "gate-chat-capacity",
      prompt: 'fixture-output:{"frameBytes":1048576}',
    }),
  );

  assert.equal(refusedChat.status, 500);
  assert.deepEqual((refusedChat.body as { details: unknown }).details, {
    reason: "required_output_incomplete",
    outputFailure: "producer_retained_limit",
  });
  const sibling = await completePrompt(
    host,
    sessions[1].sessionId,
    envelope("session.prompt", fenceFor(host, sessions[1].runId), {
      stepId: "sibling",
      prompt: "still live",
    }),
  );

  assert.equal(sibling.status, 200);
  assert.equal(captures, 85);
  await writeFile(
    join(outputDirectory, "s1-2-memory.json"),
    JSON.stringify(
      {
        node: process.version,
        producers: sessions.length,
        waves: 2,
        captures,
        peakRetainedOutputBytes: peakBytes,
        maxReservedBytes,
        baseline,
        peakUsage,
      },
      null,
      2,
    ),
  );
  assert(
    peakBytes < 10 * 1024 * 1024,
    `retained output exceeded 10 MiB: ${peakBytes}`,
  );
  assert(maxReservedBytes <= 10 * 1024 * 1024);
} finally {
  RuntimeObjectRegistry.prototype.captureSessionContent = originalCapture;
  await host.stop();
  await cleanupRuntimeRoot(host.runtimeRoot);
  const profile = await new Promise<unknown>((resolve, reject) =>
    inspector.post("HeapProfiler.stopSampling", (error, result) =>
      error ? reject(error) : resolve(result.profile),
    ),
  );

  await writeFile(
    join(outputDirectory, "s1-2-memory.heapprofile"),
    JSON.stringify(profile),
  );
  inspector.disconnect();
}
assert.equal(outputBufferStats().producers, 0);
assert.equal(outputBufferStats().decoderQueued, 0);
