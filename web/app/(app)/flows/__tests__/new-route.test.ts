import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import NewFlowPage from "../new/page";

describe("/flows/new", () => {
  it("retires DB-authored draft creation by redirecting to the canonical Studio wizard", async () => {
    mocks.requireActiveSession.mockResolvedValue({ id: "u1", role: "member" });

    await NewFlowPage();

    expect(mocks.requireActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith("/studio/packages?create=flow");
  });
});
