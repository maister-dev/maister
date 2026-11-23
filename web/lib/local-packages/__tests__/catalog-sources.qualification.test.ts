import { expect, it } from "vitest";

import {
  resolveCatalogSource,
  searchCatalog,
} from "@/lib/local-packages/catalog-sources";

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
