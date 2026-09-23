import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ getDb: () => null }));

import { decisionQueueGrants } from "@/lib/queries/visible-projects";

// Surfaces rendering decision-queue items (the /inbox list, the Desk) show an
// action-gated affordance only when the queue's own role floor clears that
// action. Derived from PROJECT_ACTION_MIN, never assumed per surface.
describe("decisionQueueGrants", () => {
  it("grants repository content to every reader the queue admits", () => {
    expect(decisionQueueGrants("readRepoFiles")).toBe(true);
    expect(decisionQueueGrants("readBoard")).toBe(true);
  });

  it("refuses an action whose floor is above the queue's member floor", () => {
    expect(decisionQueueGrants("editSettings")).toBe(false);
    expect(decisionQueueGrants("manageMembers")).toBe(false);
  });
});
