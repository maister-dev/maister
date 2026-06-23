import { describe, expect, it } from "vitest";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import {
  nativeGuardScriptPath,
  resolveNativeHookMaterializer,
} from "@/lib/capabilities/native-hook-materializer";

// ADR-104 D7 (M40): the NativeHookMaterializer seam is a pure shape producer.
// Only claude has a native backend (P4 — a PreToolUse path-guard hook); every
// other adapter resolves to the no-op, and the universal supervisor ACP-seam
// interceptor is the sole enforcer. These tests pin both contracts.
describe("resolveNativeHookMaterializer — seam (ADR-104 D7)", () => {
  const GUARD = "/opt/maister/web/scripts/native-path-guard.mjs";
  const armed = {
    repetition: { max: 5 },
    pathGuard: { allowedPaths: ["src/**", "tests/**"] },
  };

  it("resolves a materializer for every adapter", () => {
    for (const adapter of ADAPTER_IDS) {
      const m = resolveNativeHookMaterializer(adapter);

      expect(m.adapter).toBe(adapter);
      expect(typeof m.buildSettingsHooks).toBe("function");
    }
  });

  it("non-claude adapters return undefined (no native backend)", () => {
    for (const adapter of ADAPTER_IDS) {
      if (adapter === "claude") continue;
      const m = resolveNativeHookMaterializer(adapter);

      expect(
        m.buildSettingsHooks({ hooksConfig: armed, guardScriptPath: GUARD }),
      ).toBeUndefined();
    }
  });

  it("claude builds a PreToolUse hook from the resolved pathGuard allowedPaths", () => {
    const hooks = resolveNativeHookMaterializer("claude").buildSettingsHooks({
      hooksConfig: armed,
      guardScriptPath: GUARD,
    });

    expect(hooks).toBeDefined();
    expect(hooks?.PreToolUse).toHaveLength(1);
    const entry = hooks?.PreToolUse[0];

    expect(entry?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(entry?.hooks[0].type).toBe("command");
    // allowedPaths ride the exec-form args (no shell), after the guard script.
    expect(entry?.hooks[0].args).toEqual([GUARD, "src/**", "tests/**"]);
  });

  it("claude returns undefined when pathGuard is not armed (liveness-only / no hooks)", () => {
    expect(
      resolveNativeHookMaterializer("claude").buildSettingsHooks({
        hooksConfig: { repetition: { max: 5 }, noProgress: { maxTurns: 15 } },
        guardScriptPath: GUARD,
      }),
    ).toBeUndefined();
    expect(
      resolveNativeHookMaterializer("claude").buildSettingsHooks({
        hooksConfig: undefined,
        guardScriptPath: GUARD,
      }),
    ).toBeUndefined();
  });
});

describe("nativeGuardScriptPath", () => {
  it("honors MAISTER_HOOK_GUARD_SCRIPT override, else resolves under cwd/scripts", () => {
    const prev = process.env.MAISTER_HOOK_GUARD_SCRIPT;

    try {
      process.env.MAISTER_HOOK_GUARD_SCRIPT = "/custom/guard.mjs";
      expect(nativeGuardScriptPath()).toBe("/custom/guard.mjs");

      delete process.env.MAISTER_HOOK_GUARD_SCRIPT;
      expect(nativeGuardScriptPath()).toMatch(
        /scripts\/native-path-guard\.mjs$/,
      );
    } finally {
      if (prev === undefined) delete process.env.MAISTER_HOOK_GUARD_SCRIPT;
      else process.env.MAISTER_HOOK_GUARD_SCRIPT = prev;
    }
  });
});
