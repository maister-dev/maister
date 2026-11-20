import assert from "node:assert/strict";
import { release } from "node:os";
import { performance } from "node:perf_hooks";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "../src/__tests__/_fixtures/boot-host";

type TimingDistribution = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  samplesMs: number[];
};

async function measureStartup(
  host: BootedHost,
  runId: string,
): Promise<number> {
  const fence = fenceFor(host, runId);
  const request = await createEnvelope(host, fence);
  const start = performance.now();
  const launched = await postJson(`${host.url}/sessions`, request);
  const elapsed = performance.now() - start;

  assert.equal(
    launched.status,
    201,
    "Expected the synthetic ACP launch to succeed",
  );
  assert.ok(launched.body.acpSessionId, "Expected a completed ACP handshake");

  const stopped = await postJson(
    `${host.url}/sessions/${launched.body.sessionId}`,
    envelope("session.delete", fence),
    "DELETE",
  );

  assert.equal(stopped.status, 204, "Expected the synthetic session to stop");

  return Math.round(elapsed * 10) / 10;
}

async function withHost<T>(run: (host: BootedHost) => Promise<T>): Promise<T> {
  const host = await bootHost();

  try {
    return await run(host);
  } finally {
    try {
      await host.stop();
    } finally {
      await cleanupRuntimeRoot(host.runtimeRoot);
    }
  }
}

function summarize(samplesMs: number[]): TimingDistribution {
  const ordered = [...samplesMs].sort((left, right) => left - right);

  return {
    count: samplesMs.length,
    p50Ms: ordered[Math.ceil(0.5 * ordered.length) - 1],
    p95Ms: ordered[Math.ceil(0.95 * ordered.length) - 1],
    samplesMs,
  };
}

/** Run from supervisor/ with an empty temporary HOME and no provider credentials. */
const freshHostSamples: number[] = [];

for (let index = 0; index < 20; index++) {
  freshHostSamples.push(
    await withHost((host) => measureStartup(host, `fresh-${index}`)),
  );
}

const reusedHostSamples = await withHost(async (host) => {
  await measureStartup(host, "warmup");
  const samples: number[] = [];

  for (let index = 0; index < 30; index++) {
    samples.push(await measureStartup(host, `repeat-${index}`));
  }

  return samples;
});

const report = {
  node: process.version,
  os: process.platform,
  kernel: release(),
  arch: process.arch,
  freshHostFirstLaunch: summarize(freshHostSamples),
  reusedHostNewLaunch: summarize(reusedHostSamples),
};

process.stdout.write(`${JSON.stringify(report)}\n`);
