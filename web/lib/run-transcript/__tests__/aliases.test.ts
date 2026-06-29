import { describe, expect, it } from "vitest";

import {
  interpretScratchUpdate,
  interpretSessionUpdate,
  parseScratchMessageContent,
  parseTranscriptMessageContent,
} from "@/lib/run-transcript/transcript";
import * as scratchShim from "@/lib/scratch-runs/transcript";

// T-B1: the run-kind-agnostic transcript substrate has one canonical home
// (lib/run-transcript/transcript.ts) with generic aliases for the flow side and
// a scratch-runs re-export shim for back-compat. This guards both edges so a
// future refactor cannot silently fork the interpret/parse logic.
describe("run-transcript substrate aliases", () => {
  it("exposes generic aliases that are the SAME functions as the scratch names", () => {
    expect(interpretSessionUpdate).toBe(interpretScratchUpdate);
    expect(parseTranscriptMessageContent).toBe(parseScratchMessageContent);
  });

  it("re-exports the substrate through the scratch-runs back-compat shim", () => {
    expect(scratchShim.interpretScratchUpdate).toBe(interpretScratchUpdate);
    expect(scratchShim.parseScratchMessageContent).toBe(
      parseScratchMessageContent,
    );
    expect(scratchShim.interpretSessionUpdate).toBe(interpretSessionUpdate);
  });
});
