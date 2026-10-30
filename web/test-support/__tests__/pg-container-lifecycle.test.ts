import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeContainerRuntimeDaemon:
    vi.fn<() => Promise<{ serverVersion: string; strategy: string }>>(),
  getContainerRuntimeClient: vi.fn<
    () => Promise<{
      info: { containerRuntime: { serverVersion: string } };
      container: { dockerode: { listContainers: () => Promise<never[]> } };
    }>
  >(),
  start: vi.fn<() => Promise<never>>(),
}));

vi.mock("@testcontainers/postgresql", () => {
  class PostgreSqlContainer {
    withDatabase(): this {
      return this;
    }

    withUsername(): this {
      return this;
    }

    withPassword(): this {
      return this;
    }

    withTmpFs(): this {
      return this;
    }

    withCommand(): this {
      return this;
    }

    withLabels(): this {
      return this;
    }

    start(): Promise<never> {
      return mocks.start();
    }
  }

  return { PostgreSqlContainer };
});

vi.mock("testcontainers", () => ({
  getContainerRuntimeClient: mocks.getContainerRuntimeClient,
}));

vi.mock("../docker-runtime-probe", () => ({
  probeContainerRuntimeDaemon: mocks.probeContainerRuntimeDaemon,
}));

import {
  startBarePostgresTestDb,
  TestDatabaseDockerUnavailableError,
} from "../pg-container";

describe("shared Testcontainers database helper lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeContainerRuntimeDaemon.mockResolvedValue({
      serverVersion: "lifecycle-control",
      strategy: "lifecycle-control",
    });
    mocks.getContainerRuntimeClient.mockResolvedValue({
      info: { containerRuntime: { serverVersion: "lifecycle-control" } },
      container: { dockerode: { listContainers: async () => [] } },
    });
    mocks.start.mockRejectedValue(
      new Error("Docker daemon stopped after probe"),
    );
  });

  it("maps a post-probe container startup failure to the Docker-boundary error", async () => {
    const error = await startBarePostgresTestDb({
      databaseName: "test_support_start_failure",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TestDatabaseDockerUnavailableError);
    expect(error).toMatchObject({
      lane: "integration",
      safeCause: "Docker daemon stopped after probe",
    });
  });
  it("retries only a cleaned port-binding timeout and raises the last failure", async () => {
    const last = new Error("Docker stopped on second allocation");

    mocks.start
      .mockRejectedValueOnce(
        new Error(
          "Timed out after 30000ms while waiting for container ports to be bound to the host",
        ),
      )
      .mockRejectedValueOnce(last);
    const error = await startBarePostgresTestDb({
      databaseName: "port_retry_last_error",
    }).catch((caught: unknown) => caught);

    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ cause: last, safeCause: last.message });
  });

  it("never retries an allocation whose removal cannot be proven", async () => {
    mocks.start.mockRejectedValueOnce(
      new Error(
        "Timed out after 30000ms while waiting for container ports to be bound to the host",
      ),
    );
    mocks.getContainerRuntimeClient.mockResolvedValue({
      info: { containerRuntime: { serverVersion: "lifecycle-control" } },
      container: {
        dockerode: {
          listContainers: async () => {
            throw new Error("Docker allocation inventory denied");
          },
        },
      },
    });
    await expect(
      startBarePostgresTestDb({ databaseName: "cleanup_refusal" }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
