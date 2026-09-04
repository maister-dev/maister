import { afterEach, describe, expect, it } from "vitest";

import { bootHost, cleanupRuntimeRoot, type BootedHost } from "./_fixtures/boot-host";

let host: BootedHost | undefined;

afterEach(async () => {
  await host?.stop();
  if (host) await cleanupRuntimeRoot(host.runtimeRoot);
  host = undefined;
});

describe("Stage B capability discovery", () => {
  it("keeps health v1 stable and advertises the durable event transport independently", async () => {
    host = await bootHost();
    const health = await fetch(`${host.url}/health`);
    const capabilities = await fetch(`${host.url}/capabilities`);

    expect((await health.json() as { host: { protocolVersion: number } }).host.protocolVersion).toBe(1);
    expect(await capabilities.json()).toEqual({
      dataPlaneVersion: "execution-host-data-plane.v1",
      eventStream: true,
      asyncPrompt: true,
      runtimeObjects: false,
      limits: {
        maxEventBytes: 1_048_576,
        maxObjectBytes: 536_870_912,
        maxReplayBatch: 500,
      },
    });
  });
});
