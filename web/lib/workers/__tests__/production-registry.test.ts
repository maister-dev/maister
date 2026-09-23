import { describe, expect, it } from "vitest";

import { consensusDraftPromptOwners } from "@/lib/flows/graph/consensus/draft-prompt-owner";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import {
  composePromptOwnerRegistry,
  PRODUCTION_PROMPT_OWNER_REGISTRIES,
} from "@/lib/workers/runtime";

// The consensus owner integration suite drives `flowPromptOwners` and
// `consensusDraftPromptOwners` directly. This pins that the boot composition
// serves those exact adapters, so that proof is the production path's proof.
describe("production prompt-owner composition", () => {
  const composed = composePromptOwnerRegistry(
    PRODUCTION_PROMPT_OWNER_REGISTRIES,
  );

  it("applies consensus verifier and synthesis commands with the flow adapter", () => {
    expect(composed.get("flow_node_attempt")).toBe(
      flowPromptOwners.get("flow_node_attempt"),
    );
  });

  it("applies consensus draft turns with the draft-aware agent adapter", () => {
    expect(composed.get("agent_turn")).toBe(
      consensusDraftPromptOwners.get("agent_turn"),
    );
  });
});
