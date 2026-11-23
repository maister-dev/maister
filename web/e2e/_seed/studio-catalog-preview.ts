import type { PinnedCatalogSource } from "@/lib/local-packages/catalog-sources";

import { previewCatalogImport } from "@/lib/local-packages/catalog-operation";

// Playwright supplies a reviewed upstream fixture at the network boundary.
// Apply, edit, commit, cut and project adoption use the running web service.
async function main(): Promise<void> {
  const [root, project, actor, kind, destination] = process.argv.slice(2);
  const source: PinnedCatalogSource =
    kind === "skill"
      ? {
          kind: "skill",
          sourceId: "anthropic-skills",
          selector: "skills/design",
          publisher: "anthropics",
          sourceUrl:
            "https://github.com/anthropics/skills/tree/fixture/skills/design",
          name: "design",
          pin: "a".repeat(40),
          files: {
            "SKILL.md":
              "---\nname: design\ndescription: Review designs.\n---\nRead companion.md\n",
            "companion.md": "Fixture journey",
          },
          configuration: [],
          notices: [],
        }
      : {
          kind: "mcp",
          sourceId: "mcp-registry",
          selector: "com.example/design@1.0.0",
          publisher: "com.example",
          name: "design",
          pin: "1.0.0",
          sourceUrl:
            "https://registry.modelcontextprotocol.io/v0.1/servers/com.example%2Fdesign/versions/1.0.0",
          files: {},
          notices: [],
          configuration: ["Streamable HTTP", "https://example.com/mcp"],
          mcp: {
            id: "design",
            transport: "http",
            url: "https://example.com/mcp",
          },
        };
  const result = await previewCatalogImport(
    { workingDir: root, packageId: project, actorId: actor },
    source,
    destination,
  );

  process.stdout.write(JSON.stringify(result));
}
void main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
  process.exitCode = 1;
});
