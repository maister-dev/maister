/**
 * T1.1 — maisterCapabilitiesSchema: agent_definitions + env_profiles (M14)
 */
import { describe, expect, it } from "vitest";

import {
  maisterCapabilitiesSchema,
  type MaisterCapabilitiesConfig,
} from "@/lib/config.schema";

describe("maisterCapabilitiesSchema — M14 new capability kinds", () => {
  it("defaults agent_definitions and env_profiles to empty arrays when omitted", () => {
    const result = maisterCapabilitiesSchema.parse({});

    expect(result.agent_definitions).toEqual([]);
    expect(result.env_profiles).toEqual([]);
  });

  it("parses a config with agent_definitions entries", () => {
    const result = maisterCapabilitiesSchema.parse({
      agent_definitions: [
        {
          id: "my-agent",
          label: "My Agent",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: true,
        },
      ],
    });

    expect(result.agent_definitions).toHaveLength(1);
    expect(result.agent_definitions[0]).toMatchObject({
      id: "my-agent",
      kind: "agent_definition",
      source: "project",
      enforceability: "instructed",
      selected_by_default: true,
    });
  });

  it("parses a config with env_profiles entries carrying env key-value map", () => {
    const result = maisterCapabilitiesSchema.parse({
      env_profiles: [
        {
          id: "prod-keys",
          label: "Production Keys",
          source: "project",
          agents: ["claude", "codex"],
          enforceability: "instructed",
          selected_by_default: false,
          env: {
            ANTHROPIC_AUTH_TOKEN: "secret",
            OPENAI_API_KEY: "also-secret",
          },
        },
      ],
    });

    expect(result.env_profiles).toHaveLength(1);
    expect(result.env_profiles[0]).toMatchObject({
      id: "prod-keys",
      kind: "env_profile",
      env: { ANTHROPIC_AUTH_TOKEN: "secret", OPENAI_API_KEY: "also-secret" },
    });
  });

  it("rejects agent_definitions entry with missing id", () => {
    expect(() =>
      maisterCapabilitiesSchema.parse({
        agent_definitions: [{ label: "no-id" }],
      }),
    ).toThrow();
  });

  it("rejects env_profiles entry with non-string env value", () => {
    expect(() =>
      maisterCapabilitiesSchema.parse({
        env_profiles: [
          {
            id: "bad",
            env: { KEY: 42 as unknown as string },
          },
        ],
      }),
    ).toThrow();
  });

  it("MaisterCapabilitiesConfig type includes agent_definitions and env_profiles", () => {
    // Type-level check: if this compiles, the type export is correct.
    const cfg: MaisterCapabilitiesConfig = {
      mcps: [],
      skills: [],
      rules: [],
      restrictions: [],
      settings: [],
      tools: [],
      agent_definitions: [
        {
          id: "x",
          kind: "agent_definition",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: true,
        },
      ],
      env_profiles: [
        {
          id: "y",
          kind: "env_profile",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: false,
          env: { MY_KEY: "val" },
        },
      ],
    };

    expect(cfg.agent_definitions).toHaveLength(1);
    expect(cfg.env_profiles).toHaveLength(1);
  });
});
