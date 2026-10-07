import type { ContainerRuntimeClientStrategyResult } from "testcontainers/build/container-runtime/strategies/types.js";

import { createRequire } from "node:module";

import { ConfigurationStrategy } from "testcontainers/build/container-runtime/strategies/configuration-strategy.js";
import { NpipeSocketStrategy } from "testcontainers/build/container-runtime/strategies/npipe-socket-strategy.js";
import { RootlessUnixSocketStrategy } from "testcontainers/build/container-runtime/strategies/rootless-unix-socket-strategy.js";
import { TestcontainersHostStrategy } from "testcontainers/build/container-runtime/strategies/testcontainers-host-strategy.js";
import { UnixSocketStrategy } from "testcontainers/build/container-runtime/strategies/unix-socket-strategy.js";

type DockerDaemonClient = Readonly<{
  info: (options: Readonly<{ abortSignal: AbortSignal }>) => Promise<unknown>;
}>;
type DockerDaemonConstructor = new (
  options: ContainerRuntimeClientStrategyResult["dockerOptions"],
) => DockerDaemonClient;
export type DockerDaemonEvidence = Readonly<{
  serverVersion: string;
  strategy: string;
}>;

// testcontainers 10.28.0 declares these strategies but exposes no daemon-only
// public probe. Reuse its own configuration resolution and Dockerode dependency
// instead of copying socket, properties, TLS or Docker CLI context selection.
const sdkRequire = createRequire(
  createRequire(import.meta.url).resolve("testcontainers"),
);
const dockerConstructor: unknown = sdkRequire("dockerode");

if (typeof dockerConstructor !== "function")
  throw new Error(
    "installed Testcontainers Dockerode constructor is unavailable",
  );
const DockerDaemon = dockerConstructor as DockerDaemonConstructor;

async function contactConfiguredDaemon(
  signal: AbortSignal,
): Promise<DockerDaemonEvidence> {
  const strategies = [
    new TestcontainersHostStrategy(),
    new ConfigurationStrategy(),
    new UnixSocketStrategy(),
    new RootlessUnixSocketStrategy(),
    new NpipeSocketStrategy(),
  ];

  for (const strategy of strategies) {
    signal.throwIfAborted();
    const result = await strategy.getResult();

    signal.throwIfAborted();
    if (!result) continue;
    // A selected endpoint is authoritative: an unreachable configured target
    // cannot become permission to try another daemon.
    const info = await new DockerDaemon(result.dockerOptions).info({
      abortSignal: signal,
    });

    signal.throwIfAborted();
    if (
      typeof info !== "object" ||
      info === null ||
      !("ServerVersion" in info) ||
      typeof info.ServerVersion !== "string" ||
      info.ServerVersion.length === 0
    )
      throw new Error("Docker /info did not provide a server version");

    return { serverVersion: info.ServerVersion, strategy: strategy.getName() };
  }

  throw new Error("no configured Testcontainers daemon endpoint is available");
}

/** Abort the real Engine request; late strategy discovery cannot contact Docker. */
export async function probeContainerRuntimeDaemon(
  signal: AbortSignal,
): Promise<DockerDaemonEvidence> {
  signal.throwIfAborted();
  let rejectAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(signal.reason);
        signal.addEventListener("abort", rejectAbort, { once: true });
      }),
      contactConfiguredDaemon(signal),
    ]);
  } finally {
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
  }
}
