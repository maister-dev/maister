import { afterEach, describe, expect, it, vi } from "vitest";

import { hookEnvDefaults, resolveHooksConfig } from "@/lib/flows/hooks-config";

const DEFAULTS = {
  repetitionMax: 5,
  noProgressTurns: 15,
  defaultWritablePaths: undefined,
};

describe("resolveHooksConfig — two-tier default (ADR-108 D4)", () => {
  it("supervised + no hooks → undefined (nothing auto-arms)", () => {
    expect(
      resolveHooksConfig({
        hooks: undefined,
        preset: "supervised",
        defaults: DEFAULTS,
      }),
    ).toBeUndefined();
  });

  it("absent preset → treated as non-unattended (fail-safe to opt-in)", () => {
    expect(
      resolveHooksConfig({
        hooks: undefined,
        preset: undefined,
        defaults: DEFAULTS,
      }),
    ).toBeUndefined();
  });

  it("unattended + no hooks → seeds both liveness breakers from defaults", () => {
    expect(
      resolveHooksConfig({
        hooks: undefined,
        preset: "unattended",
        defaults: DEFAULTS,
      }),
    ).toEqual({ repetition: { max: 5 }, noProgress: { maxTurns: 15 } });
  });

  it("unattended + hooks.disabled:true → undefined (per-node opt-out)", () => {
    expect(
      resolveHooksConfig({
        hooks: { disabled: true },
        preset: "unattended",
        defaults: DEFAULTS,
      }),
    ).toBeUndefined();
  });

  it("supervised + explicit repetition → only that breaker (no noProgress seed)", () => {
    expect(
      resolveHooksConfig({
        hooks: { repetition: { max: 8 } },
        preset: "supervised",
        defaults: DEFAULTS,
      }),
    ).toEqual({ repetition: { max: 8 } });
  });

  it("unattended + explicit repetition → explicit wins, noProgress still seeded", () => {
    expect(
      resolveHooksConfig({
        hooks: { repetition: { max: 8 } },
        preset: "unattended",
        defaults: DEFAULTS,
      }),
    ).toEqual({ repetition: { max: 8 }, noProgress: { maxTurns: 15 } });
  });

  it("pathGuard with explicit allowedPaths → used verbatim (opt-in)", () => {
    expect(
      resolveHooksConfig({
        hooks: { pathGuard: { allowedPaths: ["src/**"] } },
        preset: "supervised",
        defaults: DEFAULTS,
      }),
    ).toEqual({ pathGuard: { allowedPaths: ["src/**"] } });
  });

  it("pathGuard opt-in without paths → env default writable paths", () => {
    expect(
      resolveHooksConfig({
        hooks: { pathGuard: {} },
        preset: "supervised",
        defaults: { ...DEFAULTS, defaultWritablePaths: ["a/**", "b/**"] },
      }),
    ).toEqual({ pathGuard: { allowedPaths: ["a/**", "b/**"] } });
  });

  it("pathGuard opt-in without paths + no env default → worktree-root sentinel", () => {
    expect(
      resolveHooksConfig({
        hooks: { pathGuard: {} },
        preset: "supervised",
        defaults: DEFAULTS,
      }),
    ).toEqual({ pathGuard: { allowedPaths: ["**"] } });
  });
});

describe("hookEnvDefaults — env reading (host/service-env only)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 5 / 15 / undefined when env unset", () => {
    vi.stubEnv("MAISTER_HOOK_REPETITION_MAX", "");
    vi.stubEnv("MAISTER_HOOK_NO_PROGRESS_TURNS", "");
    vi.stubEnv("MAISTER_HOOK_DEFAULT_WRITABLE_PATHS", "");

    expect(hookEnvDefaults()).toEqual({
      repetitionMax: 5,
      noProgressTurns: 15,
      defaultWritablePaths: undefined,
    });
  });

  it("reads positive ints + comma-split (trimmed) paths from env", () => {
    vi.stubEnv("MAISTER_HOOK_REPETITION_MAX", "3");
    vi.stubEnv("MAISTER_HOOK_NO_PROGRESS_TURNS", "20");
    vi.stubEnv("MAISTER_HOOK_DEFAULT_WRITABLE_PATHS", "src/**, tests/** ");

    expect(hookEnvDefaults()).toEqual({
      repetitionMax: 3,
      noProgressTurns: 20,
      defaultWritablePaths: ["src/**", "tests/**"],
    });
  });

  it("falls back to defaults on non-positive / invalid env", () => {
    vi.stubEnv("MAISTER_HOOK_REPETITION_MAX", "0");
    vi.stubEnv("MAISTER_HOOK_NO_PROGRESS_TURNS", "-5");

    expect(hookEnvDefaults()).toMatchObject({
      repetitionMax: 5,
      noProgressTurns: 15,
    });
  });
});
