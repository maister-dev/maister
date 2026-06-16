export const RAIL_SECTION_IDS = [
  "projects",
  "inbox",
  "studio",
  "agents",
  "mcps",
  "users",
  "scheduler",
  "settings",
] as const;

export type RailSectionId = (typeof RAIL_SECTION_IDS)[number];

function normalizedPathname(pathname: string | null): string {
  if (!pathname) return "/";

  const path = pathname.split(/[?#]/, 1)[0] || "/";

  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

function isPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function railSectionForPathname(
  pathname: string | null,
): RailSectionId | null {
  const path = normalizedPathname(pathname);

  if (
    path === "/" ||
    isPathPrefix(path, "/projects") ||
    isPathPrefix(path, "/runs") ||
    isPathPrefix(path, "/scratch-runs")
  ) {
    return "projects";
  }

  if (isPathPrefix(path, "/inbox")) return "inbox";
  if (isPathPrefix(path, "/studio") || isPathPrefix(path, "/flows")) {
    return "studio";
  }
  if (isPathPrefix(path, "/agents")) return "agents";
  if (isPathPrefix(path, "/mcps")) return "mcps";
  if (isPathPrefix(path, "/admin/users")) return "users";
  if (isPathPrefix(path, "/admin/scheduler")) return "scheduler";
  if (isPathPrefix(path, "/settings")) return "settings";

  return null;
}
