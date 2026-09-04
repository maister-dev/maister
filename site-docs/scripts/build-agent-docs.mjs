import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const docsDirectory = path.resolve(scriptDirectory, "..");

/**
 * @typedef {{ title: string; description: string; body: string }} ParsedPage
 */

/**
 * @typedef {{ group: string; pages: ReadonlyArray<string> }} NavigationGroup
 */

/**
 * @typedef {{ language: string; groups: ReadonlyArray<NavigationGroup> }} NavigationLanguage
 */

/**
 * @typedef {{ name: string; description: string; navigation: { languages: ReadonlyArray<NavigationLanguage> } }} DocsConfig
 */

/**
 * @param {string} source
 * @param {string} sourcePath
 * @returns {ParsedPage}
 */
function parsePage(source, sourcePath) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    throw new Error(`Documentation page has no valid frontmatter: ${sourcePath}`);
  }

  const frontmatter = match[1];
  const title = frontmatter.match(/^title:\s*["'](.+)["']\s*$/m)?.[1];
  const description = frontmatter.match(/^description:\s*["'](.+)["']\s*$/m)?.[1];

  if (!title || !description) {
    throw new Error(`Documentation page is missing title or description: ${sourcePath}`);
  }

  return { body: match[2].trim(), description, title };
}

/**
 * @param {string} baseUrl
 * @param {string} pagePath
 * @returns {string}
 */
function markdownUrl(baseUrl, pagePath) {
  return `${baseUrl}/markdown/${pagePath}.md`;
}

/**
 * @param {unknown} value
 * @returns {DocsConfig}
 */
function assertDocsConfig(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("description" in value) ||
    typeof value.description !== "string" ||
    !("navigation" in value) ||
    typeof value.navigation !== "object" ||
    value.navigation === null ||
    !("languages" in value.navigation) ||
    !Array.isArray(value.navigation.languages)
  ) {
    throw new Error("docs.json has an invalid navigation structure");
  }

  return /** @type {DocsConfig} */ (value);
}

async function buildAgentDocs() {
  const outputDirectory = process.argv[2];
  const baseUrl = process.argv[3]?.replace(/\/$/, "");

  if (!outputDirectory || !baseUrl) {
    throw new Error("Usage: build-agent-docs.mjs <output-directory> <base-url>");
  }

  const configSource = await readFile(path.join(docsDirectory, "docs.json"), "utf8");
  const config = assertDocsConfig(JSON.parse(configSource));
  const indexSections = [`# ${config.name}`, `> ${config.description}`];
  const fullSections = [`# ${config.name} public documentation`, `Source: ${baseUrl}`];

  for (const language of config.navigation.languages) {
    indexSections.push(`## ${language.language.toUpperCase()}`);

    for (const group of language.groups) {
      indexSections.push(`### ${group.group}`);

      for (const pagePath of group.pages) {
        const sourcePath = path.join(docsDirectory, `${pagePath}.md`);
        const source = await readFile(sourcePath, "utf8");
        const page = parsePage(source, sourcePath);
        const publicMarkdownPath = path.join(outputDirectory, "markdown", `${pagePath}.md`);

        await mkdir(path.dirname(publicMarkdownPath), { recursive: true });
        await writeFile(publicMarkdownPath, source, "utf8");

        indexSections.push(
          `- [${page.title}](${markdownUrl(baseUrl, pagePath)}): ${page.description}`,
        );
        fullSections.push(
          `---\n\nSource: ${markdownUrl(baseUrl, pagePath)}\n\n# ${page.title}\n\n${page.body}`,
        );
      }
    }
  }

  await writeFile(path.join(outputDirectory, "llms.txt"), `${indexSections.join("\n\n")}\n`, "utf8");
  await writeFile(
    path.join(outputDirectory, "llms-full.txt"),
    `${fullSections.join("\n\n")}\n`,
    "utf8",
  );
}

await buildAgentDocs();
