export const WORKSPACE_INPUT_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_INPUT_MAX_FILES = 255;
export const WORKSPACE_INPUT_MANIFEST_MAX_BYTES = 262_144;
export const WORKSPACE_INPUT_MANIFEST_NAME = ".workspace-inputs.json";

export function isWorkspaceInputPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    path
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_.-]{1,128}$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          ![".git", WORKSPACE_INPUT_MANIFEST_NAME].includes(part.toLowerCase()),
      )
  );
}

export function hasWorkspaceInputPathCollision(
  paths: readonly string[],
): boolean {
  const unique = new Set(paths.map((path) => path.toLowerCase()));

  if (unique.size !== paths.length) return true;
  return [...unique].some((path) => {
    const parts = path.split("/");

    return parts.some(
      (_, index) => index > 0 && unique.has(parts.slice(0, index).join("/")),
    );
  });
}
