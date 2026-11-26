import { afterEach, expect, it, vi } from "vitest";

import {
  resolveCatalogSource,
  searchCatalog,
} from "@/lib/local-packages/catalog-sources";

afterEach(() => vi.unstubAllEnvs());

it("qualifies the global skills.sh search and pinned Git preview without configured repositories", async () => {
  vi.stubEnv("MAISTER_STUDIO_CATALOG_REPOS", "[]");
  vi.stubEnv("AUTH_SECRET", "local-catalog-qualification");
  const query = await searchCatalog({ kind: "skill", q: "find-skills" });
  const item = query.results.find(
    (skill) =>
      skill.sourceId === "skills.sh" &&
      skill.publisher === "vercel-labs/skills" &&
      skill.name === "find-skills",
  );

  expect(item).toBeDefined();
  const preview = await resolveCatalogSource({
    kind: "skill",
    sourceId: "skills.sh",
    selector: item!.resultId,
  });

  expect(preview.pin).toMatch(/^[a-f0-9]{40}$/);
  expect(preview.sourceUrl).toBe(
    `https://github.com/vercel-labs/skills/tree/${preview.pin}/skills/find-skills`,
  );
  expect(preview.files["SKILL.md"]).toMatch(/\bname: find-skills\b/);
  const exact = await searchCatalog({
    kind: "skill",
    q: "https://skills.sh/vercel-labs/skills/find-skills",
    scope: "skills.sh",
  });

  expect(exact.results).toEqual([
    expect.objectContaining({
      canonicalSkillId: preview.selector,
      sourceId: "skills.sh",
    }),
  ]);
  const updated = await resolveCatalogSource({
    kind: "skill",
    sourceId: "skills.sh",
    selector: preview.selector,
  });

  expect(updated).toEqual(preview);
});

it("resolves the released Anthropic frontend design skill and an official Registry HTTP record", async () => {
  const skills = await searchCatalog({
    kind: "skill",
    q: "https://skills.sh/anthropics/skills/frontend-design",
  });

  expect(skills.results).toContainEqual(
    expect.objectContaining({
      sourceId: "anthropic-skills",
      resultId: "skills/frontend-design",
    }),
  );
  const source = await resolveCatalogSource({
    kind: "skill",
    sourceId: "anthropic-skills",
    selector: "skills/frontend-design",
  });

  expect(source.pin).toMatch(/^[a-f0-9]{40}$/);
  expect(source.files["SKILL.md"]).toContain("frontend-design");
  expect(source.notices).toContain("LICENSE.txt");
  const servers = await searchCatalog({
    kind: "mcp",
    q: "learning-printables",
  });
  const item = servers.results.find(
    (r) => r.name === "ai.sageteacher/learning-printables",
  );

  expect(item).toBeDefined();
  const server = await resolveCatalogSource({
    kind: "mcp",
    sourceId: "mcp-registry",
    selector: item!.resultId,
  });

  expect(server.mcp).toMatchObject({
    transport: "http",
    url: "https://www.sageteacher.ai/mcp/printables",
  });
  process.stdout.write(
    JSON.stringify({
      skillPin: source.pin,
      registryId: item!.resultId,
      files: Object.keys(source.files),
    }) + "\n",
  );
});
