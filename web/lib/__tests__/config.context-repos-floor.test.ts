import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

// ADR-157: `settings.context_repos` materializes read-only sibling-repo
// checkouts, which only engines >= 3.4.0 do. Detect the declaration in the
// authored manifest and refuse with CONFIG before install — mirroring the
// ADR-154 MAISTER_FLOW_DIR floor. Only the three ACP-session node types may
// declare it; `cli`/`check` reject the key at the schema.

describe("ADR-157 — context_repos engine floor gate", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "context-repos-floor-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function load(
    manifest: unknown,
  ): Promise<{ ok: boolean; code?: string; message?: string }> {
    const path = join(workDir, "flow.yaml");

    await writeFile(path, stringifyYaml(manifest), "utf8");
    try {
      await loadFlowManifest(path);

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        code: isMaisterError(err) ? err.code : "UNKNOWN",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  type SessionNode = "ai_coding" | "judge" | "orchestrator";

  function manifest(opts: {
    engineMin?: string;
    nodeType?: SessionNode | "cli";
    contextRepos?: unknown;
  }): unknown {
    const nodeType = opts.nodeType ?? "ai_coding";
    const node: Record<string, unknown> = {
      id: "step",
      type: nodeType,
      transitions: { success: "done" },
    };

    if (nodeType === "cli") node.action = { command: "true" };
    else node.action = { prompt: "do the thing" };

    if (opts.contextRepos !== undefined) {
      node.settings = { context_repos: opts.contextRepos };
    }

    const compat = opts.engineMin ? { engine_min: opts.engineMin } : undefined;

    return {
      schemaVersion: 1,
      name: "context-repos-floor-fixture",
      ...(compat ? { compat } : {}),
      nodes: [node],
    };
  }

  const ONE_REPO = [{ project: "api-service", ref: "main" }];

  it("refuses a context_repos declaration below the 3.4.0 floor", async () => {
    const result = await load(
      manifest({ engineMin: "3.3.0", contextRepos: ONE_REPO }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
    expect(result.message).toContain("context_repos");
    expect(result.message).toContain("3.4.0");
  });

  it.each<SessionNode>(["ai_coding", "judge", "orchestrator"])(
    "accepts context_repos on a %s node at engine_min 3.4.0",
    async (nodeType) => {
      const result = await load(
        manifest({ engineMin: "3.4.0", nodeType, contextRepos: ONE_REPO }),
      );

      expect(result.ok).toBe(true);
    },
  );

  // cli/check are not ACP sessions, so the key has nowhere to land — their
  // `.strict()` settings schema is the enforcement, not the floor gate.
  it("rejects context_repos on a cli node outright", async () => {
    const result = await load(
      manifest({ engineMin: "3.4.0", nodeType: "cli", contextRepos: ONE_REPO }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
  });

  it("rejects more than 8 entries", async () => {
    const result = await load(
      manifest({
        engineMin: "3.4.0",
        contextRepos: Array.from({ length: 9 }, (_, i) => ({
          project: `sib-${i}`,
        })),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
  });

  it("rejects an unknown key inside an entry", async () => {
    const result = await load(
      manifest({
        engineMin: "3.4.0",
        contextRepos: [{ project: "api-service", branch: "main" }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
  });

  it("rejects an entry with an empty project slug", async () => {
    const result = await load(
      manifest({ engineMin: "3.4.0", contextRepos: [{ project: "" }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
  });

  // An empty array is a declaration of "none", not a missing key: it must not
  // trip the floor, because nothing gets mounted.
  it("leaves a manifest with no context_repos ungated at a low floor", async () => {
    const result = await load(manifest({ engineMin: "1.1.0" }));

    expect(result.ok).toBe(true);
  });
});
