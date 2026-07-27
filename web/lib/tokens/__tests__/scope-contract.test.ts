import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { EVALUATION_JUDGE_TOKEN_SCOPES } from "@/lib/agents/tokens";
import { PROJECT_ACTION_BY_SCOPE } from "@/lib/tokens/ext-handler";
import { ORCHESTRATOR_TOKEN_SCOPES } from "@/lib/agents/tokens";
import { PROJECT_ACTION_MIN } from "@/lib/authz";
import { AGENT_TOKEN_SCOPES, TOKEN_SCOPES } from "@/types/token-scopes";

// T-C8b (ADR-152 D16): the agent-memory scope moves with FIVE sites, not four.
// The fifth is mandatory because resolveProjectAction ends in `?? "readBoard"` —
// an unmapped WRITE scope would silently resolve to the viewer-level action.
describe("T-C8b — agent_memory:write is registered across all five sites", () => {
  it("is in TOKEN_SCOPES and in the fixed AGENT_TOKEN_SCOPES grant list", () => {
    expect(TOKEN_SCOPES).toContain("agent_memory:write");
    expect(AGENT_TOKEN_SCOPES).toContain("agent_memory:write");
  });

  it("maps to the dedicated `writeAgentMemory` action — explicitly NOT the readBoard fallback", () => {
    expect(PROJECT_ACTION_BY_SCOPE["agent_memory:write"]).toBe(
      "writeAgentMemory",
    );
    expect(PROJECT_ACTION_BY_SCOPE["agent_memory:write"]).not.toBe("readBoard");
  });

  it("`writeAgentMemory` is a real ProjectAction with minimum `member`", () => {
    expect(PROJECT_ACTION_MIN).toHaveProperty("writeAgentMemory");
    expect(
      PROJECT_ACTION_MIN["writeAgentMemory" as keyof typeof PROJECT_ACTION_MIN],
    ).toBe("member");
  });

  it("does NOT reuse the Brain write axis — one grant must not open two stores", () => {
    expect(PROJECT_ACTION_BY_SCOPE["agent_memory:write"]).not.toBe(
      "writeBrain",
    );
    expect(PROJECT_ACTION_BY_SCOPE["memory:write"]).toBe("writeBrain");
  });
});

describe("external token scope contract", () => {
  it("no longer registers the retired experiment scopes (ADR-150)", () => {
    expect(TOKEN_SCOPES).not.toContain("experiments:read");
    expect(TOKEN_SCOPES).not.toContain("experiments:advise");
    expect(AGENT_TOKEN_SCOPES).not.toContain("experiments:read");
    expect(AGENT_TOKEN_SCOPES).not.toContain("experiments:advise");
  });

  it("no longer maps the retired experiment scopes to a project action", () => {
    expect(PROJECT_ACTION_BY_SCOPE["experiments:read"]).toBeUndefined();
    expect(PROJECT_ACTION_BY_SCOPE["experiments:advise"]).toBeUndefined();
  });

  it("grants only attached agent tokens the task-bound human-ask capability", () => {
    expect(TOKEN_SCOPES).toContain("hitl:request");
    expect(AGENT_TOKEN_SCOPES).toContain("hitl:request");
    expect(PROJECT_ACTION_BY_SCOPE["hitl:request"]).toBe("answerHitl");
  });

  it("maps runs:sync to promoteRun so ext == internal authz (never readBoard)", () => {
    expect(TOKEN_SCOPES).toContain("runs:sync");
    // ADR-141 blocker B1: runs:sync must NOT fall through to the readBoard
    // default — a user token acting cross-project clears the promote bar.
    expect(PROJECT_ACTION_BY_SCOPE["runs:sync"]).toBe("promoteRun");
    // NOT an ephemeral-agent capability — sync/reopen are human/project-token ops.
    expect(AGENT_TOKEN_SCOPES).not.toContain("runs:sync");
    // The ORCHESTRATOR set must be checked SEPARATELY, not inferred from the one
    // above: it only lacks `runs:sync` because it spreads AGENT_TOKEN_SCOPES and
    // then adds four scopes explicitly. Appending "runs:sync" to that explicit
    // list would fail nothing, and would hand a machine actor the force-push that
    // ADR-141's manual-only stance reserves for a deliberate human click.
    expect(ORCHESTRATOR_TOKEN_SCOPES).not.toContain("runs:sync");
    expect(ORCHESTRATOR_TOKEN_SCOPES).not.toContain("runs:reopen");
  });

  // ADR-145 (Evaluation Lab) D10/D12: the attempt-bound evaluator judge scopes.
  it("registers the four attempt-bound evaluator judge scopes", () => {
    expect(TOKEN_SCOPES).toContain("evaluations:context:read");
    expect(TOKEN_SCOPES).toContain("evaluations:evidence:read");
    expect(TOKEN_SCOPES).toContain("evaluations:objective:read");
    expect(TOKEN_SCOPES).toContain("evaluations:result:submit");
  });

  it("keeps evaluator judge scopes OUT of the general agent-token set (no browse, no task/comment mutation)", () => {
    for (const scope of EVALUATION_JUDGE_TOKEN_SCOPES) {
      expect(AGENT_TOKEN_SCOPES).not.toContain(scope);
    }
  });

  it("scopes a judge attempt token to exactly the four evaluator scopes, disjoint from agent mutation scopes", () => {
    expect([...EVALUATION_JUDGE_TOKEN_SCOPES].sort()).toEqual(
      [
        "evaluations:context:read",
        "evaluations:evidence:read",
        "evaluations:objective:read",
        "evaluations:result:submit",
      ].sort(),
    );
    // A judge can read its bound snapshot and submit one result — nothing else.
    expect(EVALUATION_JUDGE_TOKEN_SCOPES).not.toContain("tasks:read");
    expect(EVALUATION_JUDGE_TOKEN_SCOPES).not.toContain("comments:create");
    expect(EVALUATION_JUDGE_TOKEN_SCOPES).not.toContain("runs:launch");
  });
});
