import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { PROJECT_ACTION_MIN } from "@/lib/authz";
import { PROJECT_ACTION_BY_SCOPE } from "@/lib/tokens/ext-handler";
import { AGENT_TOKEN_SCOPES, TOKEN_SCOPES } from "@/types/token-scopes";

describe("experiment token scope contract", () => {
  it("registers session actions with the intended project-role minimums", () => {
    expect(PROJECT_ACTION_MIN.readExperiments).toBe("viewer");
    expect(PROJECT_ACTION_MIN.manageExperiments).toBe("member");
    expect(PROJECT_ACTION_MIN.concludeExperiments).toBe("member");
  });

  it("registers external experiment scopes and fixed agent-token access", () => {
    expect(TOKEN_SCOPES).toContain("experiments:read");
    expect(TOKEN_SCOPES).toContain("experiments:advise");
    expect(AGENT_TOKEN_SCOPES).toContain("experiments:read");
    expect(AGENT_TOKEN_SCOPES).toContain("experiments:advise");
  });

  it("maps experiment scopes to the matching project actions", () => {
    expect(PROJECT_ACTION_BY_SCOPE["experiments:read"]).toBe(
      "readExperiments",
    );
    expect(PROJECT_ACTION_BY_SCOPE["experiments:advise"]).toBe(
      "manageExperiments",
    );
  });
});
