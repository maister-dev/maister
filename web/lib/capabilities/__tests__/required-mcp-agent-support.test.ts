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

// ADR-177: the same precondition now also refuses a REQUIRED ref whose
// TRANSPORT the launch adapter cannot use. codex-acp throws `invalidRequest`
// for `sse` while BUILDING the session config, so one such server fails
// `session/new` for the whole session — refusing at launch, before any
// worktree or run row exists, is the only place that helps.
const withTransport = (
  refId: string,
  source: string,
  agents: string[],
  transport: "stdio" | "sse" | "http",
) => ({ ...r(refId, source, agents), material: { transport } });

describe("firstAgentUnsupportedRequiredMcp — transport (ADR-177)", () => {
  it("flags a required sse ref on a codex runner", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["legacy"],
        [withTransport("legacy", "platform", ["codex"], "sse")],
        "codex",
      ),
    ).toMatchObject({
      refId: "legacy",
      reason: "unsupported-transport",
      transport: "sse",
    });
  });

  it("passes a required http ref on a codex runner", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["vendor"],
        [withTransport("vendor", "platform", ["codex"], "http")],
        "codex",
      ),
    ).toBeNull();
  });

  it("passes a required sse ref on a claude runner — claude accepts sse", () => {
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["legacy"],
        [withTransport("legacy", "platform", ["claude"], "sse")],
        "claude",
      ),
    ).toBeNull();
  });

  it("reports the AGENT reason first when both would apply", () => {
    // `supported_agents` is the stronger statement: the operator said this
    // server is not for codex at all.
    expect(
      firstAgentUnsupportedRequiredMcp(
        ["legacy"],
        [withTransport("legacy", "platform", ["claude"], "sse")],
        "codex",
      ),
    ).toMatchObject({ reason: "unsupported-agent" });
  });
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
    ).toMatchObject({ refId: "github", reason: "unsupported-agent" });
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
    ).toMatchObject({ refId: "github", reason: "unsupported-agent" });
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
    ).toMatchObject({ refId: "github", reason: "unsupported-agent" });
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
