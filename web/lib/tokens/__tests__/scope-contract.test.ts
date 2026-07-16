import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { PROJECT_ACTION_MIN } from "@/lib/authz";
import { PROJECT_ACTION_BY_SCOPE } from "@/lib/tokens/ext-handler";
import { ORCHESTRATOR_TOKEN_SCOPES } from "@/lib/agents/tokens";
import { AGENT_TOKEN_SCOPES, TOKEN_SCOPES } from "@/types/token-scopes";

describe("external token scope contract", () => {
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
    expect(PROJECT_ACTION_BY_SCOPE["experiments:read"]).toBe("readExperiments");
    expect(PROJECT_ACTION_BY_SCOPE["experiments:advise"]).toBe(
      "manageExperiments",
    );
  });

  it("grants only attached agent tokens the task-bound human-ask capability", () => {
    expect(TOKEN_SCOPES).toContain("hitl:request");
    expect(AGENT_TOKEN_SCOPES).toContain("hitl:request");
    expect(PROJECT_ACTION_BY_SCOPE["hitl:request"]).toBe("answerHitl");
  });

  it("maps runs:sync to promoteRun so ext == internal authz (never readBoard)", () => {
    expect(TOKEN_SCOPES).toContain("runs:sync");
    // ADR-140 blocker B1: runs:sync must NOT fall through to the readBoard
    // default — a user token acting cross-project clears the promote bar.
    expect(PROJECT_ACTION_BY_SCOPE["runs:sync"]).toBe("promoteRun");
    // NOT an ephemeral-agent capability — sync/reopen are human/project-token ops.
    expect(AGENT_TOKEN_SCOPES).not.toContain("runs:sync");
    // The ORCHESTRATOR set must be checked SEPARATELY, not inferred from the one
    // above: it only lacks `runs:sync` because it spreads AGENT_TOKEN_SCOPES and
    // then adds four scopes explicitly. Appending "runs:sync" to that explicit
    // list would fail nothing, and would hand a machine actor the force-push that
    // ADR-140's manual-only stance reserves for a deliberate human click.
    expect(ORCHESTRATOR_TOKEN_SCOPES).not.toContain("runs:sync");
    expect(ORCHESTRATOR_TOKEN_SCOPES).not.toContain("runs:reopen");
  });
});
