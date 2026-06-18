import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { maisterYamlV2Schema } from "@/lib/config.schema";
import { serializeProjectConfig } from "@/lib/packages/yaml-writeback";

// ADR-093: serialize a DB-only project's config to a complete, schema-valid
// maister.yaml v2 (persist). Defaults are omitted; the result MUST round-trip
// the canonical schema.
describe("serializeProjectConfig", () => {
  it("emits a minimal schema-valid v2 config, omitting defaults", () => {
    const yaml = serializeProjectConfig({
      name: "My App",
      mainBranch: "main",
      branchPrefix: "maister/",
      defaultRunnerId: null,
      promotionMode: null,
    });
    const parsed = parse(yaml);

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.project).toEqual({ name: "My App" });
    expect(parsed.flows).toEqual([]);
    expect(parsed.packages).toBeUndefined();
    expect(() => maisterYamlV2Schema.parse(parsed)).not.toThrow();
  });

  it("emits non-default project fields", () => {
    const yaml = serializeProjectConfig({
      name: "App",
      mainBranch: "trunk",
      branchPrefix: "mai/",
      defaultRunnerId: "claude-code",
      promotionMode: "pull_request",
    });
    const parsed = parse(yaml);

    expect(parsed.project).toEqual({
      name: "App",
      main_branch: "trunk",
      branch_prefix: "mai/",
      default_runner: "claude-code",
      promotion: { mode: "pull_request" },
    });
    expect(() => maisterYamlV2Schema.parse(parsed)).not.toThrow();
  });

  it("emits attached flows and packages", () => {
    const yaml = serializeProjectConfig(
      {
        name: "App",
        mainBranch: "main",
        branchPrefix: "maister/",
        defaultRunnerId: null,
        promotionMode: null,
      },
      {
        flows: [{ id: "bugfix", source: "github.com/x/y", version: "v1.0.0" }],
        packages: [
          {
            id: "aif",
            source: "github.com/org/maister-plugins",
            version: "aif/v1.0.0",
            path: "packages/aif",
          },
        ],
      },
    );
    const parsed = parse(yaml);

    expect(parsed.flows).toHaveLength(1);
    expect(parsed.packages).toHaveLength(1);
    expect(() => maisterYamlV2Schema.parse(parsed)).not.toThrow();
  });
});
