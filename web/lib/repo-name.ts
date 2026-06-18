// Client-safe core of repo-source.ts `deriveRepoName`. Pure — no `server-only`,
// no `node:*` imports — so the Add-project form (a Client Component) can prefill
// the project-name field from the entered Git URL. `repo-source.ts` wraps this
// with a throwing variant for the server path, so the rule is single-sourced.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function deriveRepoNameSafe(url: string): string | null {
  const scpPath = /^[^/@]+@[^/:]+:(.+)$/.exec(url);
  const pathPart = scpPath
    ? scpPath[1]
    : url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = pathPart.split("/");
  const last = segments[segments.length - 1] ?? "";
  const name = last.replace(/\.git$/, "");

  if (!SAFE_SEGMENT.test(name) || name === "." || name === "..") {
    return null;
  }

  return name;
}
