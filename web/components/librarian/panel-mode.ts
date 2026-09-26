// ADR-189 D4: the one rule that picks the panel's presentation. Pure, so the
// breakpoints are tested without a browser and every caller agrees on them.

export type LibrarianPanelMode = "docked" | "sheet" | "fullscreen";

export const LIBRARIAN_BREAKPOINTS = {
  md: 768,
  xl: 1280,
  "2xl": 1536,
} as const;

/** Routes whose own content needs the full width until `2xl`: the run
 * workbench's diff and the Studio canvases. */
export const LIBRARIAN_WIDE_ROUTE_PREFIXES = [
  "/runs/",
  "/studio/edit/",
  "/studio/local",
] as const;

export function isLibrarianWideRoute(pathname: string): boolean {
  return LIBRARIAN_WIDE_ROUTE_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

export function librarianPanelMode(input: {
  viewportWidth: number;
  pathname: string;
  hostComposerVisible: boolean;
}): LibrarianPanelMode {
  if (input.viewportWidth < LIBRARIAN_BREAKPOINTS.md) return "fullscreen";
  if (input.hostComposerVisible) return "sheet";
  if (
    isLibrarianWideRoute(input.pathname) &&
    input.viewportWidth < LIBRARIAN_BREAKPOINTS["2xl"]
  )
    return "sheet";
  if (input.viewportWidth < LIBRARIAN_BREAKPOINTS.xl) return "sheet";

  return "docked";
}
