import type { StartSessionRequest } from "../types";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildChildEnv } from "../spawn";

function makeRequest(
  over: Partial<StartSessionRequest> = {},
): StartSessionRequest {
  return {
    executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
    stepId: "step-1",
    executor: { agent: "claude", model: "claude-sonnet-4-6" },
    ...over,
  };
}

describe("buildChildEnv — env layering precedence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("IT-ISO-05 projects host tool startup without ambient credentials or sockets", () => {
    vi.stubEnv("MAISTER_BCE_BASELINE", "baseline-value");
    vi.stubEnv("ANTHROPIC_API_KEY", "host-secret");
    vi.stubEnv("SSH_AUTH_SOCK", "/example/ssh-agent.sock");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid");
    vi.stubEnv("LC_ALL", "C");

    const env = buildChildEnv(makeRequest());

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.LC_ALL).toBe("C");
    expect(env).not.toHaveProperty("MAISTER_BCE_BASELINE");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
  });

  it.each(["HOME", "PATH", "https_proxy", "NODE_OPTIONS", "CODEX_HOME"])(
    "refuses an adapter launch override of %s before spawning",
    (name) => {
      expect(() =>
        buildChildEnv(
          makeRequest({ adapterLaunch: { env: { [name]: "synthetic" } } }),
        ),
      ).toThrow(
        expect.objectContaining({
          code: "PRECONDITION",
          details: { reason: "workload_environment_reserved", field: name },
        }),
      );
    },
  );

  it("keeps the Codex capability home only for its adopted Run", () => {
    const workspace = { cwd: process.cwd(), runId: "run-home" };
    const home = `${workspace.cwd}/.maister/capabilities/run-home/codex-home-fixture`;
    const request = makeRequest({
      executor: { agent: "codex", model: "default" },
      adapterLaunch: { env: { CODEX_HOME: home } },
    });

    expect(buildChildEnv(request, { workspace }).CODEX_HOME).toBe(home);
    expect(() =>
      buildChildEnv(request, {
        workspace: { ...workspace, runId: "sibling" },
      }),
    ).toThrow(expect.objectContaining({ code: "PRECONDITION" }));
  });

  it("executor.env overrides process.env on key collision", () => {
    process.env.SHARED_KEY = "from-process";
    const env = buildChildEnv(
      makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { SHARED_KEY: "from-executor" },
        },
      }),
    );

    expect(env.SHARED_KEY).toBe("from-executor");
    delete process.env.SHARED_KEY;
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
    );

    expect(env.SHARED_KEY).toBe("from-adapter");
  });

  it.each([
    { allow: ["mcp__maister__stand_operation_observe"], expected: "false" },
    { allow: ["ToolSearch"], expected: "true" },
  ])(
    "uses direct Claude tools when the strict profile excludes discovery: $allow",
    ({ allow, expected }) => {
      const env = buildChildEnv(
        makeRequest({
          adapterLaunch: { env: { ENABLE_TOOL_SEARCH: "true" } },
          enforcementProfile: {
            tools: { allow },
            enforcedClasses: ["tools"],
            escalationThreshold: 3,
          },
        }),
      );

      expect(env.ENABLE_TOOL_SEARCH).toBe(expected);
    },
  );

  it("sets MAISTER_CAPABILITY_PROFILE_PATH from the server-derived runtime object path", () => {
    const profilePath = `${process.cwd()}/profile.json`;
    const instructionsPath = `${process.cwd()}/instructions.md`;
    const env = buildChildEnv(makeRequest(), {
      capabilityProfilePath: profilePath,
      capabilityInstructionsPath: instructionsPath,
    });

    expect(env.MAISTER_CAPABILITY_PROFILE_PATH).toBe(profilePath);
    expect(env.MAISTER_CAPABILITY_INSTRUCTIONS_PATH).toBe(instructionsPath);
  });

  it("omits MAISTER_CAPABILITY_PROFILE_PATH when capabilityProfilePath is absent", () => {
    delete process.env.MAISTER_CAPABILITY_PROFILE_PATH;

    const env = buildChildEnv(makeRequest());

    expect("MAISTER_CAPABILITY_PROFILE_PATH" in env).toBe(false);
  });

  it("refuses a spoofed server-derived path even without an output object", () => {
    const profilePath = `${process.cwd()}/profile.json`;
    const instructionsPath = `${process.cwd()}/instructions.md`;

    expect(() =>
      buildChildEnv(
        makeRequest({
          adapterLaunch: {
            env: {
              MAISTER_CAPABILITY_PROFILE_PATH: "from-adapter",
              MAISTER_CAPABILITY_INSTRUCTIONS_PATH: "from-adapter",
              MAISTER_PLAN_DOCUMENT_FILE: "from-adapter",
            },
          },
        }),
        {
          capabilityProfilePath: profilePath,
          capabilityInstructionsPath: instructionsPath,
          outputPaths: {
            MAISTER_PLAN_DOCUMENT_FILE: `${process.cwd()}/plan.md`,
          },
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "PRECONDITION",
        details: {
          reason: "workload_environment_reserved",
          field: "MAISTER_CAPABILITY_PROFILE_PATH",
        },
      }),
    );
  });

  it("adds no spurious keys beyond the configured layers", () => {
    const profilePath = `${process.cwd()}/profile.json`;
    const withEmpty = buildChildEnv(
      makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { A: "1" },
        },
        adapterLaunch: { env: { B: "2" } },
      }),
      { capabilityProfilePath: profilePath },
    );

    expect(withEmpty).toMatchObject({
      A: "1",
      MAISTER_CAPABILITY_PROFILE_PATH: profilePath,
      B: "2",
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
    });
    expect(withEmpty).not.toHaveProperty("MAISTER_CONTEXT_REPOS");
  });
});
