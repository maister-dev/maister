import { describe, expect, it } from "vitest";

import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import {
  composePromptOwnerRegistry,
  createProductionPromptOwnerRegistries,
} from "@/lib/workers/runtime";

// The consensus owner integration suite drives `flowPromptOwners` and
// `createConsensusDraftPromptOwners` directly. This pins that the boot composition
// serves those exact adapters, so that proof is the production path's proof.
describe("production prompt-owner composition", () => {
  const registries = createProductionPromptOwnerRegistries();
  const composed = composePromptOwnerRegistry(registries);

  it("applies consensus verifier and synthesis commands with the flow adapter", () => {
    expect(composed.get("flow_node_attempt")).toBe(
      flowPromptOwners.get("flow_node_attempt"),
    );
  });

  it("applies consensus draft turns with the draft-aware agent adapter", () => {
    expect(composed.get("agent_turn")).toBe(registries[1].get("agent_turn"));
  });
});
