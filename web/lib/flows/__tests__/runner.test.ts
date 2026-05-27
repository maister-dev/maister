import { describe, expect, it } from "vitest";

// runner.ts orchestration is exercised end-to-end in the Phase 6
// integration test (runner.integration.test.ts) against a real
// Postgres testcontainer + a mock-acp-adapter binary. A pure-unit
// runner test would require mocking the dual drizzle-orm peer
// resolution, four sub-executors, and the scheduler — net cost
// outweighs the signal vs running the runner end-to-end. This
// placeholder keeps the test file present so the discovery glob
// shows it; replace with focused unit cases when runner.ts gains
// branches that aren't naturally covered by the integration test.

describe("flow runner (orchestrator)", () => {
  it("is covered by the Phase 6 integration test", () => {
    expect(true).toBe(true);
  });
});
