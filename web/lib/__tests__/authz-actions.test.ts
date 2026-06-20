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

describe("PROJECT_ACTION_MIN: manageSchedules", () => {
  it("requires the project member role for managing run schedules", () => {
    expect(PROJECT_ACTION_MIN.manageSchedules).toBe("member");
  });
});

describe("PROJECT_ACTION_MIN: launchUnattended", () => {
  it("requires the project member role to launch a non-supervised policy", () => {
    expect(PROJECT_ACTION_MIN.launchUnattended).toBe("member");
  });

  it("is at least as privileged as launchRun (a viewer can never launch it)", () => {
    const order = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

    expect(order[PROJECT_ACTION_MIN.launchUnattended]).toBeGreaterThanOrEqual(
      order[PROJECT_ACTION_MIN.launchRun],
    );
    expect(PROJECT_ACTION_MIN.launchUnattended).not.toBe("viewer");
  });
});
