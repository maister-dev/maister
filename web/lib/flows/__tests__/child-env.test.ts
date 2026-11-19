import { afterEach, describe, expect, it, vi } from "vitest";

import { childProcessEnv } from "@/lib/flows/child-env";

describe("childProcessEnv (ADR-153)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps allow-listed and plumbing vars, drops everything else", () => {
    vi.stubEnv("WEB_TIER_SENTINEL_SECRET", "leak-me");
    vi.stubEnv("DB_URL", "postgres://x");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-x");
    vi.stubEnv("LC_ALL", "en_US.UTF-8");
    vi.stubEnv("TMPDIR", "/tmp/maister-test");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/maister-agent.sock");

    const env = childProcessEnv();

    expect(env.WEB_TIER_SENTINEL_SECRET).toBeUndefined();
    expect(env.DB_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/tmp/maister-test");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("injects caller extras on top of the filtered env", () => {
    const env = childProcessEnv({ MAISTER_OUTPUT_FILE: "/runs/r1/out.json" });

    expect(env.MAISTER_OUTPUT_FILE).toBe("/runs/r1/out.json");
  });

  it("IT-ISO-05 keeps the allow-list when the retired inheritance flag is set", () => {
    vi.stubEnv("WEB_TIER_SENTINEL_SECRET", "leak-me");
    for (const raw of ["1", "true", "on", "yes", "TRUE", " on "]) {
      vi.stubEnv("MAISTER_CLI_INHERIT_ENV", raw);
      expect(childProcessEnv().WEB_TIER_SENTINEL_SECRET).toBeUndefined();
    }
  });

  it("retains the explicit output path when the retired flag is present", () => {
    vi.stubEnv("MAISTER_CLI_INHERIT_ENV", "1");
    vi.stubEnv("MAISTER_OUTPUT_FILE", "/stale/from/parent.json");

    const env = childProcessEnv({ MAISTER_OUTPUT_FILE: "/runs/r1/out.json" });

    expect(env.MAISTER_OUTPUT_FILE).toBe("/runs/r1/out.json");
  });
});
