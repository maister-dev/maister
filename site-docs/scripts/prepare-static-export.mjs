import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const exportDirectory = process.argv[2];

if (!exportDirectory) {
  throw new TypeError("Expected the exported documentation directory as the first argument");
}

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? findHtmlFiles(entryPath) : [entryPath];
    }),
  );

  return nestedFiles.flat().filter((filePath) => filePath.endsWith(".html"));
}

function localeForFile(filePath) {
  const relativePath = path.relative(exportDirectory, filePath);
  return relativePath === "ru.html" || relativePath.startsWith(`ru${path.sep}`) ? "ru" : "en";
}

function setDocumentLocale(source, locale, filePath) {
  const htmlLanguagePattern = /<html lang="[^"]*"/;
  if (!htmlLanguagePattern.test(source)) {
    throw new Error(`Unable to set the document language in ${filePath}`);
  }

  return source.replace(htmlLanguagePattern, `<html lang="${locale}"`);
}

function markSearchableContent(source, filePath) {
  const contentPattern = /(<div\b[^>]*\bid="content")([^>]*>)/;
  if (!contentPattern.test(source)) {
    throw new Error(`Unable to identify the searchable documentation content in ${filePath}`);
  }

  return source.replace(contentPattern, "$1 data-pagefind-body$2");
}

const htmlFiles = await findHtmlFiles(exportDirectory);

await Promise.all(
  htmlFiles.map(async (filePath) => {
    const source = await readFile(filePath, "utf8");
    const localizedSource = setDocumentLocale(source, localeForFile(filePath), filePath);
    await writeFile(filePath, markSearchableContent(localizedSource, filePath), "utf8");
  }),
);

console.log(`Prepared ${htmlFiles.length} localized HTML pages for static search`);
