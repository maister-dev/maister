import { MaisterError } from "@/lib/errors-core";

export const MEMORY_ROOT = "/memories";
export const MEMORY_INDEX = "/memories/index.md";

const invalidPathCharacter = /[%\\?#:\p{Cc}\p{Cs}]/u;
const encoder = new TextEncoder();

export function canonicalMemoryPath(path: string): string {
  const canonical = path.normalize("NFC");
  const components = canonical.slice(MEMORY_ROOT.length + 1).split("/");

  if (
    canonical !== MEMORY_ROOT &&
    (!canonical.startsWith(`${MEMORY_ROOT}/`) ||
      encoder.encode(canonical).length > 512 ||
      components.length > 16 ||
      invalidPathCharacter.test(canonical) ||
      components.some(
        (component) =>
          component === "" || component === "." || component === "..",
      ))
  ) {
    throw new MaisterError("CONFIG", "Invalid memory path");
  }

  return canonical;
}

export function memoryNotePath(path: string): string {
  const canonical = canonicalMemoryPath(path);

  if (!canonical.endsWith(".md"))
    throw new MaisterError("CONFIG", "Memory notes must have a .md extension");

  return canonical;
}

export function mutableMemoryPath(path: string): string {
  const canonical = canonicalMemoryPath(path);

  if (canonical === MEMORY_ROOT)
    throw new MaisterError("CONFIG", "The memory root is read-only");

  return canonical;
}

export function isUnderMemoryPath(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}/`);
}
