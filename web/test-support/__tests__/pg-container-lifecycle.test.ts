import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContainerRuntimeClient: vi.fn<() => Promise<void>>(),
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

    start(): Promise<never> {
      return mocks.start();
    }
  }

  return { PostgreSqlContainer };
});

vi.mock("testcontainers", () => ({
  getContainerRuntimeClient: mocks.getContainerRuntimeClient,
}));

import {
  startBarePostgresTestDb,
  TestDatabaseDockerUnavailableError,
} from "../pg-container";

describe("shared Testcontainers database helper lifecycle", () => {
  beforeEach(() => {
    mocks.getContainerRuntimeClient.mockResolvedValue(undefined);
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
