// T2.1 — ACP probe source. Drives the real mock adapter
// (test/fixtures/mock-acp-models.mjs) through `node`, asserting the model list
// is parsed AND the deferred-release invariant: the child is SIGTERMed on EVERY
// exit path (success, session/new rejection, timeout). Also covers the
// openai_compatible → "skipped" degradation (no spawn).
import type { ModelCatalogDraft, ResolveContext } from "../types";

import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAcpProbeSource } from "./acp-probe";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../test/fixtures/mock-acp-models.mjs");
const ctx: ResolveContext = { logger: pino({ level: "silent" }) };

const claudeDraft: ModelCatalogDraft = {
  adapter: "claude",
  provider: { kind: "anthropic" },
};

function spyingSpawn(): {
  spawnImpl: typeof realSpawn;
  children: ChildProcess[];
} {
  const children: ChildProcess[] = [];
  const spawnImpl = ((
    command: string,
    args: readonly string[],
    options: Parameters<typeof realSpawn>[2],
  ) => {
    const child = realSpawn(command, args as string[], options);

    vi.spyOn(child, "kill");
    children.push(child);

    return child;
  }) as unknown as typeof realSpawn;

  return { spawnImpl, children };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createAcpProbeSource", () => {
  it("declines CCR-routed drafts (that is the CCR source's job)", () => {
    const source = createAcpProbeSource();

    expect(
      source.supports({ ...claudeDraft, router: "ccr", sidecarId: "x" }),
    ).toBe(false);
    expect(source.supports(claudeDraft)).toBe(true);
  });

  it("reads availableModels from session/new and SIGTERMs the child (happy path)", async () => {
    vi.stubEnv("MOCK_ACP_MODELS_MODE", "ok");
    const { spawnImpl, children } = spyingSpawn();
    const source = createAcpProbeSource({
      spawnImpl,
      binaryOverride: "node",
      preArgs: [fixture],
    });

    const { models, status } = await source.resolve(claudeDraft, ctx);

    expect(models.map((m) => m.id)).toEqual(["glm-5.1", "glm-5"]);
    expect(models[0]).toEqual({
      id: "glm-5.1",
      displayName: "GLM-5.1",
      origins: ["acp_probe"],
    });
    expect(status).toEqual({ kind: "acp_probe", status: "ok", count: 2 });
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("SIGTERMs the child when session/new rejects (deferred-release regression)", async () => {
    vi.stubEnv("MOCK_ACP_MODELS_MODE", "reject-newsession");
    const { spawnImpl, children } = spyingSpawn();
    const source = createAcpProbeSource({
      spawnImpl,
      binaryOverride: "node",
      preArgs: [fixture],
    });

    const { models, status } = await source.resolve(claudeDraft, ctx);

    expect(models).toEqual([]);
    expect(status.status).toBe("error");
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("times out and SIGTERMs the child when the adapter never answers", async () => {
    vi.stubEnv("MOCK_ACP_MODELS_MODE", "hang-newsession");
    const { spawnImpl, children } = spyingSpawn();
    const source = createAcpProbeSource({
      spawnImpl,
      binaryOverride: "node",
      preArgs: [fixture],
      timeoutMs: 400,
    });

    const { status } = await source.resolve(claudeDraft, ctx);

    expect(status.status).toBe("error");
    expect(status.reason).toContain("timed out");
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM (no orphan)", async () => {
    vi.stubEnv("MOCK_ACP_MODELS_MODE", "ignore-sigterm");
    const { spawnImpl, children } = spyingSpawn();
    const source = createAcpProbeSource({
      spawnImpl,
      binaryOverride: "node",
      preArgs: [fixture],
      teardownGraceMs: 200,
    });

    // Models are read before teardown, so the probe still succeeds.
    const { status } = await source.resolve(claudeDraft, ctx);

    expect(status.status).toBe("ok");

    const child = children[0];

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    // The contract is "no orphaned child MUST remain": assert the process
    // actually exited, not merely that a signal was sent.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("degrades to skipped for openai_compatible (cannot provision a direct probe)", async () => {
    const { spawnImpl, children } = spyingSpawn();
    const source = createAcpProbeSource({
      spawnImpl,
      binaryOverride: "node",
      preArgs: [fixture],
    });

    const { models, status } = await source.resolve(
      {
        adapter: "codex",
        provider: {
          kind: "openai_compatible",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiKeyEnv: "ZAI_API_KEY",
        },
      },
      ctx,
    );

    expect(models).toEqual([]);
    expect(status.status).toBe("skipped");
    // No spawn happened — provisioning failed before the probe could run.
    expect(children).toHaveLength(0);
  });

  it("probes Gemini, OpenCode, and MiMo now that the compatibility smoke gate is lifted", async () => {
    const { spawnImpl, children } = spyingSpawn();
    const source = createAcpProbeSource({
      spawnImpl,
      binaryOverride: "node",
      preArgs: [fixture],
      timeoutMs: 1_000,
    });

    // Keyless Gemini provisions without an env ref, so the probe runs.
    const gemini = await source.resolve(
      {
        adapter: "gemini",
        provider: { kind: "google_gemini" },
      },
      ctx,
    );
    const opencode = await source.resolve(
      {
        adapter: "opencode",
        provider: { kind: "agent_native" },
      },
      ctx,
    );
    const mimo = await source.resolve(
      {
        adapter: "mimo",
        provider: { kind: "agent_native" },
      },
      ctx,
    );

    // The gate is lifted: each adapter now attempts a real spawn instead of
    // short-circuiting to "skipped: pending compatibility smoke".
    expect(children).toHaveLength(3);
    for (const result of [gemini, opencode, mimo]) {
      expect(result.status.status).not.toBe("skipped");
    }
  });
});
