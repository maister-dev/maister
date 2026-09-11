// `UT-NAV-04` (ADR-171 D4) — `railSectionForPathname` is TOTAL over the app's
// route prefixes, and `/` resolves to `home`.
//
// Before this milestone the classifier collapsed four prefixes onto `projects`:
// `/`, `/projects`, `/runs` and `/scratch-runs`. Two of those collapses were
// deliberate and survive; the `/` one was the overload ADR-171 exists to undo.
//
// "Total" means every prefix has a DECIDED answer — and `null` ("nothing
// highlighted") is one of them, for surfaces reached from the user menu rather
// than the rail. So the gate is checked against the filesystem: every route
// segment under `app/(app)` must appear in the declared table below, which
// makes a new page a failure here until somebody writes down what it highlights.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RAIL_SECTION_IDS,
  railSectionForPathname,
  type RailSectionId,
} from "@/components/chrome/left-rail-route";

const WEB_ROOT = path.resolve(__dirname, "../../..");

/** Every prefix the app serves, and the section it must highlight. */
const PREFIXES: Array<[string, RailSectionId | null]> = [
  ["/", "home"],
  ["/projects", "projects"],
  ["/projects/acme", "projects"],
  ["/projects/acme/tasks/7", "projects"],
  ["/projects/new", "projects"],
  // Deliberate and retained (D4): a run belongs to a project.
  ["/runs", "projects"],
  ["/runs/run-1", "projects"],
  ["/scratch-runs", "projects"],
  ["/scratch-runs/new", "projects"],
  ["/work", "work"],
  ["/activity", "activity"],
  ["/inbox", "inbox"],
  ["/studio", "studio"],
  ["/studio/packages", "studio"],
  // Flow Studio serves two prefixes; both highlight the one rail section.
  ["/flows", "studio"],
  ["/flows/new", "studio"],
  ["/observatory", "observatory"],
  ["/agents", "agents"],
  ["/mcps", "mcps"],
  ["/admin/users", "users"],
  ["/admin/scheduler", "scheduler"],
  ["/settings", "settings"],
  ["/settings/evaluations", "settings"],
  // Reached from the user menu, not the rail: nothing is highlighted, and that
  // is the decided answer rather than an omission.
  ["/account", null],
  ["/account/password", null],
  // No page of its own; only `/admin/users` and `/admin/scheduler` exist.
  ["/admin", null],
  // Outside the app shell entirely.
  ["/login", null],
  ["/change-password", null],
];

/** Top-level URL segments `app/(app)` actually serves. */
function appSegments(): string[] {
  const root = path.join(WEB_ROOT, "app/(app)");
  const segments: string[] = [];

  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);

    if (!statSync(full).isDirectory()) continue;
    // Route groups and private folders are not URL segments.
    if (entry.startsWith("(") || entry.startsWith("_") || entry.startsWith("@")) {
      continue;
    }
    if (entry === "__tests__" || entry === "api") continue;
    segments.push(entry);
  }

  return segments.sort();
}

describe("UT-NAV-04 railSectionForPathname", () => {
  it("maps / to home, not to projects", () => {
    expect(railSectionForPathname("/")).toBe("home");
  });

  it("classifies every declared prefix", () => {
    for (const [pathname, section] of PREFIXES) {
      expect(railSectionForPathname(pathname), pathname).toBe(section);
    }
  });

  it("normalizes a query, a hash and a trailing slash before classifying", () => {
    expect(railSectionForPathname("/work?stage=Promoted")).toBe("work");
    expect(railSectionForPathname("/activity#top")).toBe("activity");
    expect(railSectionForPathname("/projects/")).toBe("projects");
    expect(railSectionForPathname(null)).toBe("home");
  });

  it("is total over the segments app/(app) serves", () => {
    const declared = new Set(PREFIXES.map(([pathname]) => pathname));
    const undeclared = appSegments().filter(
      (segment) => !declared.has(`/${segment}`),
    );

    expect(undeclared).toEqual([]);
  });

  it("returns only ids the rail knows about", () => {
    for (const [pathname] of PREFIXES) {
      const section = railSectionForPathname(pathname);

      if (section !== null) expect(RAIL_SECTION_IDS).toContain(section);
    }
  });
});
