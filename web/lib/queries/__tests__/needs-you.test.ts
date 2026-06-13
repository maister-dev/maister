import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/queries/portfolio", () => ({
  getCrossProjectHitlInbox: vi.fn(),
}));
vi.mock("@/lib/queries/inbox", () => ({
  getUnreadInboxCount: vi.fn(),
}));

import { getUnreadInboxCount } from "@/lib/queries/inbox";
import { getNeedsYouCount } from "@/lib/queries/needs-you";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";

describe("getNeedsYouCount", () => {
  it("sums respondable HITL count and unread inbox count", async () => {
    vi.mocked(getCrossProjectHitlInbox).mockResolvedValue({
      items: [],
      count: 3,
    });
    vi.mocked(getUnreadInboxCount).mockResolvedValue(2);

    await expect(getNeedsYouCount("u1", "admin")).resolves.toBe(5);
  });

  it("is zero when nothing is pending", async () => {
    vi.mocked(getCrossProjectHitlInbox).mockResolvedValue({
      items: [],
      count: 0,
    });
    vi.mocked(getUnreadInboxCount).mockResolvedValue(0);

    await expect(getNeedsYouCount("u1", "member")).resolves.toBe(0);
  });

  it("passes userId and role through to both scoped queries", async () => {
    vi.mocked(getCrossProjectHitlInbox).mockResolvedValue({
      items: [],
      count: 1,
    });
    vi.mocked(getUnreadInboxCount).mockResolvedValue(4);

    await getNeedsYouCount("user-42", "member");

    expect(getCrossProjectHitlInbox).toHaveBeenCalledWith("user-42", "member");
    expect(getUnreadInboxCount).toHaveBeenCalledWith("user-42", "member");
  });
});
