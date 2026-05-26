import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const here = fileURLToPath(import.meta.url);
const emptyUrl = pathToFileURL(
  resolvePath(here, "..", "..", "node_modules", "server-only", "empty.js"),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: emptyUrl, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
