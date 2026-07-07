import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { runSessions } from "@/lib/db/schema";

describe("database schema shape", () => {
  it("stores durable runner-resolution warnings on run_sessions", () => {
    const columns = getTableColumns(runSessions);

    expect(columns).toHaveProperty("resolutionWarning");
    expect(columns.resolutionWarning.name).toBe("resolution_warning");
  });
});
