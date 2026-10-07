import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeContainerRuntimeDaemon:
    vi.fn<() => Promise<{ serverVersion: string; strategy: string }>>(),
  getContainerRuntimeClient:
    vi.fn<
      () => Promise<{ info: { containerRuntime: { serverVersion: string } } }>
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
    mocks.probeContainerRuntimeDaemon.mockResolvedValue({
      serverVersion: "lifecycle-control",
      strategy: "lifecycle-control",
    });
    mocks.getContainerRuntimeClient.mockResolvedValue({
      info: { containerRuntime: { serverVersion: "lifecycle-control" } },
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
});
