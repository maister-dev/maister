import type { StartSessionRequest } from "../types";

import { describe, expect, it } from "vitest";

import { buildChildEnv } from "../spawn";

function makeRequest(
  over: Partial<StartSessionRequest> = {},
): StartSessionRequest {
  return {
    runId: "run-1",
    projectSlug: "demo",
    worktreePath: process.cwd(),
    stepId: "step-1",
    executor: { agent: "claude", model: "claude-sonnet-4-6" },
    ...over,
  };
}

describe("buildChildEnv — env layering precedence", () => {
  it("includes process.env as the baseline layer", () => {
    process.env.MAISTER_BCE_BASELINE = "baseline-value";

    try {
      const env = buildChildEnv(makeRequest(), { ccrLayer: {} });

      expect(env.MAISTER_BCE_BASELINE).toBe("baseline-value");
    } finally {
      delete process.env.MAISTER_BCE_BASELINE;
    }
  });

  it("ccrLayer overrides process.env on key collision", () => {
    process.env.MAISTER_BCE_COLLIDE = "from-process";

    try {
      const env = buildChildEnv(makeRequest(), {
        ccrLayer: { MAISTER_BCE_COLLIDE: "from-ccr" },
      });

      expect(env.MAISTER_BCE_COLLIDE).toBe("from-ccr");
    } finally {
      delete process.env.MAISTER_BCE_COLLIDE;
    }
  });

  it("executor.env overrides ccrLayer on key collision", () => {
    const env = buildChildEnv(
      makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { SHARED_KEY: "from-executor" },
        },
      }),
      { ccrLayer: { SHARED_KEY: "from-ccr" } },
    );

    expect(env.SHARED_KEY).toBe("from-executor");
  });

  it("adapterLaunch.env overrides executor.env on key collision", () => {
    const env = buildChildEnv(
      makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { SHARED_KEY: "from-executor" },
        },
        adapterLaunch: { env: { SHARED_KEY: "from-adapter" } },
      }),
      { ccrLayer: {} },
    );

    expect(env.SHARED_KEY).toBe("from-adapter");
  });

  it("sets MAISTER_CAPABILITY_PROFILE_PATH when capabilityProfilePath is present", () => {
    const profilePath = `${process.cwd()}/profile.json`;
    const env = buildChildEnv(
      makeRequest({ capabilityProfilePath: profilePath }),
      { ccrLayer: {} },
    );

    expect(env.MAISTER_CAPABILITY_PROFILE_PATH).toBe(profilePath);
  });

  it("omits MAISTER_CAPABILITY_PROFILE_PATH when capabilityProfilePath is absent", () => {
    delete process.env.MAISTER_CAPABILITY_PROFILE_PATH;

    const env = buildChildEnv(makeRequest(), { ccrLayer: {} });

    expect("MAISTER_CAPABILITY_PROFILE_PATH" in env).toBe(false);
  });

  it("adapterLaunch.env overrides MAISTER_CAPABILITY_PROFILE_PATH on collision", () => {
    const env = buildChildEnv(
      makeRequest({
        capabilityProfilePath: `${process.cwd()}/profile.json`,
        adapterLaunch: {
          env: { MAISTER_CAPABILITY_PROFILE_PATH: "from-adapter" },
        },
      }),
      { ccrLayer: {} },
    );

    expect(env.MAISTER_CAPABILITY_PROFILE_PATH).toBe("from-adapter");
  });

  it("empty ccrLayer is a no-op (no spurious keys added beyond the other layers)", () => {
    const profilePath = `${process.cwd()}/profile.json`;
    const withEmpty = buildChildEnv(
      makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { A: "1" },
        },
        capabilityProfilePath: profilePath,
        adapterLaunch: { env: { B: "2" } },
      }),
      { ccrLayer: {} },
    );

    const expected: NodeJS.ProcessEnv = {
      ...process.env,
      A: "1",
      MAISTER_CAPABILITY_PROFILE_PATH: profilePath,
      B: "2",
    };

    expect(withEmpty).toEqual(expected);
  });
});
