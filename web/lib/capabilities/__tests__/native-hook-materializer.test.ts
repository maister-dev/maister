import { describe, expect, it } from "vitest";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { resolveNativeHookMaterializer } from "@/lib/capabilities/native-hook-materializer";

// ADR-104 D7 (M40): the NativeHookMaterializer seam ships with the universal
// core registering a NO-OP for every adapter — the supervisor ACP-seam
// interceptor is the sole enforcer in P1. The claude PreToolUse materializer
// registers later (P4, spike-gated). These tests pin the no-op contract so the
// universal path is provably unaffected.
describe("resolveNativeHookMaterializer — P1 no-op registry (ADR-104 D7)", () => {
  it("resolves a materializer for every adapter", () => {
    for (const adapter of ADAPTER_IDS) {
      const m = resolveNativeHookMaterializer(adapter);

      expect(m.adapter).toBe(adapter);
      expect(typeof m.materialize).toBe("function");
    }
  });

  it("materialize is a no-op (returns false) for every adapter", () => {
    const hooksConfig = {
      repetition: { max: 5 },
      pathGuard: { allowedPaths: ["src/**"] },
    };

    for (const adapter of ADAPTER_IDS) {
      const m = resolveNativeHookMaterializer(adapter);

      expect(m.materialize({ hooksConfig, worktreePath: "/tmp/wt" })).toBe(
        false,
      );
    }
  });

  it("materialize is a no-op even with no hooksConfig", () => {
    for (const adapter of ADAPTER_IDS) {
      const m = resolveNativeHookMaterializer(adapter);

      expect(
        m.materialize({ hooksConfig: undefined, worktreePath: "/tmp/wt" }),
      ).toBe(false);
    }
  });
});
