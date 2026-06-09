/**
 * M27/T-C8b (mcp-management.md §6.2, normative bullet 6 + error taxonomy): a
 * REQUIRED mcp whose local-first WINNER record does not support the executor
 * agent cannot materialize → the launch gate refuses with EXECUTOR_UNAVAILABLE.
 * An unresolved required ref is owned by the unknown-ref gate (CONFIG); this
 * helper only flags agent-unsupported. Winner is picked by the SAME precedence
 * as resolution (project > platform > flow-package).
 */
import { describe, expect, it } from "vitest";

import { firstAgentUnsupportedRequiredMcp } from "@/lib/capabilities/resolver";

const r = (
  refId: string,
  source: string,
  agents: string[] | Record<string, unknown>,
) => ({
  capabilityRefId: refId,
  source,
  agents: agents as never,
});

describe("firstAgentUnsupportedRequiredMcp (T-C8b)", () => {
  it("returns null when there are no required refs", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        [],
        [r("x", "project", ["claude"])],
        "claude",
      ),
    ).toBeNull();
  });

  it("flags a required mcp whose winner record excludes the agent", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [r("github", "project", ["codex"])],
        "claude",
      ),
    ).toBe("github");
  });

  it("passes when the winner record supports the agent", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [r("github", "project", ["claude", "codex"])],
        "claude",
      ),
    ).toBeNull();
  });

  it("uses the LOCAL-FIRST winner's agents — a shadowed lower-precedence record does not rescue it", () => {
    // project github (codex-only) shadows flow-package github (claude+codex);
    // for a claude run the effective record is the project one → unsupported.
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [
          r("github", "flow-package", ["claude", "codex"]),
          r("github", "project", ["codex"]),
        ],
        "claude",
      ),
    ).toBe("github");
  });

  it("skips an unresolved required ref (unknown-ref gate owns CONFIG)", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(["ghost"], [], "claude"),
    ).toBeNull();
  });

  it("supports the object form of agents", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [r("github", "platform", { claude: { tier: "x" } })],
        "claude",
      ),
    ).toBeNull();
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github"],
        [r("github", "platform", { codex: {} })],
        "claude",
      ),
    ).toBe("github");
  });

  it("dedupes required refs", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["github", "github"],
        [r("github", "project", ["claude"])],
        "claude",
      ),
    ).toBeNull();
  });
});
