// ADR-167 D5 amendment (2026-09-23) drift guard. The create ACK now writes the
// incarnation as `created`, so a prompt-admission site that still requires
// exactly `active` refuses every prompt issued before lifecycle projection —
// one call AFTER the fence wait admitted it. The node path is proven end to end
// in `prompt-admission-incarnation.integration.test.ts`; this pins that no
// admission site drifts back to its own state literal.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ADMISSION_SITES = [
  "lib/execution-host/prompt-incarnation.ts",
  "lib/execution-host/ledger.ts",
  "lib/flows/graph/node-prompt-owner.ts",
  "lib/flows/graph/prompt-owner.ts",
  "lib/flows/graph/consensus/prompt-owner.ts",
  "lib/services/gate-chat-prompt-owner.ts",
  "lib/runs/sync-prompt-owner.ts",
  "lib/scratch-runs/prompt-owner.ts",
  "lib/agents/prompt-owner.ts",
  "lib/agents/launch.ts",
  "lib/agents/turn-claim.ts",
] as const;

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

describe("prompt admission incarnation states", () => {
  it.each(ADMISSION_SITES)(
    "%s reads the shared allow-list, never an `active` literal",
    (file) => {
      const text = source(file);

      expect(text).not.toMatch(
        /runSessionIncarnations\.state,\s*"active"|incarnation\??\.state === "active"/,
      );
      expect(text).toContain("ADMISSIBLE_PROMPT_INCARNATION_STATES");
    },
  );
});
