import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const nextArtifactsDir = join(scriptDir, "..", ".next");

await rm(nextArtifactsDir, { recursive: true, force: true });
console.log("Removed Next.js build artifacts", { target: nextArtifactsDir });
