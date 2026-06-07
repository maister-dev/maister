import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { PROJECT_ACTION_MIN } from "@/lib/authz";

describe("PROJECT_ACTION_MIN: manageMembers", () => {
  it("requires the project admin role for managing members", () => {
    expect(PROJECT_ACTION_MIN.manageMembers).toBe("admin");
  });

  it("leaves existing action minimums unchanged", () => {
    expect(PROJECT_ACTION_MIN.readBoard).toBe("viewer");
    expect(PROJECT_ACTION_MIN.createTask).toBe("member");
    expect(PROJECT_ACTION_MIN.editSettings).toBe("admin");
  });
});
