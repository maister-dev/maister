// `UT-NAV-05` (ADR-172 D3) — every inbound navigation to `/` is classified.
//
// `/` used to mean one thing. It now means two: the Desk and, via `/projects`,
// the portfolio. A call site that meant "the portfolio" and still points at `/`
// lands the reader on a plausible-looking page that is silently the wrong one,
// and no test that merely asserts a 200 can see it.
//
// So the gate reads the TREE rather than trusting a list: it enumerates every
// `href="/"`, `redirect("/")` and `router.push("/")` in the app and asserts the
// inventory is exactly the declared set. A NEW call site is a failure until
// somebody writes down which home it meant.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

/**
 * D3's table, as data. `intent` is what the call site MEANS; `target` is where
 * it must therefore point. The two columns are separate on purpose — a site
 * whose intent is "the portfolio" but whose target is `/` is the defect, and
 * collapsing them into one column would make that unrepresentable.
 */
const HOME_LINKS = [
  {
    file: "app/(app)/admin/execution-host/forbidden.tsx",
    intent: "home",
    target: "/",
  },
  { file: "app/(auth)/layout.tsx", intent: "home", target: "/" },
  { file: "app/change-password/actions.ts", intent: "home", target: "/" },
  { file: "app/change-password/page.tsx", intent: "home", target: "/" },
  { file: "components/chrome/top-nav.tsx", intent: "home", target: "/" },
  {
    file: "components/feedback/error-fallback.tsx",
    intent: "home",
    target: "/",
  },
  // An already-signed-in visitor to `/login` is bounced home. Not a sign-in, so
  // the `NAV-02` landing fork does not apply — see `landingRouteForRole`.
  { file: "proxy.ts", intent: "home", target: "/" },
] as const;

/** Sites whose intent is the PORTFOLIO, and which must therefore not be `/`. */
const PORTFOLIO_LINKS = [
  {
    file: "components/projects/new-project-form.tsx",
    needle: 'router.push("/projects")',
  },
  {
    file: "components/chrome/left-rail-sections.ts",
    needle: 'href: "/projects"',
  },
] as const;

/**
 * Files that name a root link as test DATA rather than navigating anywhere — an
 * assertion about another file's markup is not a call site.
 */
const ASSERTION_ONLY = new Set([
  "components/feedback/__tests__/error-fallback.test.ts",
  "lib/navigation/__tests__/home-links.test.ts",
]);

// `new URL("/", ...)` is included because the proxy navigates that way and an
// inventory that silently excludes one navigation idiom is not an inventory.
// The `"/"` is anchored: `new URL("/login", ...)` must not match.
const ROOT_NAVIGATION =
  /href="\/"|href=\{"\/"\}|redirect\("\/"\)|router\.push\("\/"\)|new URL\("\/"/u;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }

    if (/\.(ts|tsx)$/u.test(entry)) yield full;
  }
}

function rootNavigationSites(): string[] {
  const hits: string[] = [];

  for (const dir of ["app", "components", "lib", "e2e"]) {
    for (const file of sourceFiles(path.join(WEB_ROOT, dir))) {
      const rel = path.relative(WEB_ROOT, file).split(path.sep).join("/");

      if (ASSERTION_ONLY.has(rel)) continue;
      if (ROOT_NAVIGATION.test(readFileSync(file, "utf8"))) hits.push(rel);
    }
  }

  // The request proxy sits at the web root, outside every scanned directory,
  // and it is the one site that navigates to `/` without a component.
  for (const root of ["proxy.ts", "auth.ts", "auth.config.ts"]) {
    if (ROOT_NAVIGATION.test(readFileSync(path.join(WEB_ROOT, root), "utf8"))) {
      hits.push(root);
    }
  }

  return hits.sort();
}

describe("UT-NAV-05 inbound links to /", () => {
  it("has exactly the declared call sites, and no undeclared one", () => {
    expect(rootNavigationSites()).toEqual(
      HOME_LINKS.map((link) => link.file).sort(),
    );
  });

  it("keeps every 'home' call site on /", () => {
    for (const link of HOME_LINKS) {
      const source = readFileSync(path.join(WEB_ROOT, link.file), "utf8");

      expect(link.intent).toBe("home");
      expect(source, link.file).toMatch(ROOT_NAVIGATION);
      expect(link.target).toBe("/");
    }
  });

  it("sends every 'portfolio' call site to /projects instead", () => {
    for (const link of PORTFOLIO_LINKS) {
      const source = readFileSync(path.join(WEB_ROOT, link.file), "utf8");

      expect(source, link.file).toContain(link.needle);
      expect(source, link.file).not.toMatch(ROOT_NAVIGATION);
    }
  });

  it("leaves no e2e spec asserting the portfolio without ever naming /projects", () => {
    // The sweep this task owes: a spec that was left on `goto("/")` and still
    // looks for the portfolio. The marker is the portfolio's own `h1`
    // ("Projects.") — NOT its onboarding or empty-state testids, since
    // `EDGE-NAV-01` has the Desk render those very components.
    //
    // The check is "names `/projects` somewhere", not "navigates to `/` nowhere":
    // `desk.spec.ts` legitimately starts at `/`, clicks the Desk | Projects
    // switch, and asserts the portfolio at the other end. A file-level "visits
    // `/` and mentions the heading" rule cannot tell that apart from the
    // regression, and flagged the correct spec when it was first written.
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(WEB_ROOT, "e2e"))) {
      const rel = path.relative(WEB_ROOT, file).split(path.sep).join("/");
      const source = readFileSync(file, "utf8");

      if (!/"Projects\."/u.test(source)) continue;
      if (!source.includes("/projects")) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});
