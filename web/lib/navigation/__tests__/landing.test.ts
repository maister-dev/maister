// `UT-NAV-02` (ADR-171 D5) — the landing route forks ONCE, by `role !== "admin"`.
//
// `E2E-NAV-02` proves two real sign-ins land on different routes. This owns the
// shape of the rule: viewer is covered by the same branch as member (the ADR's
// words, and the bug if someone writes `role === "member"`), and an explicit
// deep link is never overridden by it.

import { describe, expect, it } from "vitest";

import {
  ADMIN_LANDING_ROUTE,
  landingRouteForRole,
  MEMBER_LANDING_ROUTE,
  resolveLandingRoute,
} from "@/lib/navigation/landing";

describe("UT-NAV-02 landingRouteForRole", () => {
  it("sends an admin to the Desk", () => {
    expect(landingRouteForRole("admin")).toBe("/");
  });

  it("sends BOTH non-admin roles to /work, not just member", () => {
    // A `role === "member"` test would pass for member and silently drop a
    // viewer onto the Desk. D5 says `role !== "admin"`.
    expect(landingRouteForRole("member")).toBe("/work");
    expect(landingRouteForRole("viewer")).toBe("/work");
  });

  it("names the two routes as constants the caller cannot mistype", () => {
    expect(ADMIN_LANDING_ROUTE).toBe("/");
    expect(MEMBER_LANDING_ROUTE).toBe("/work");
  });
});

describe("UT-NAV-02 resolveLandingRoute", () => {
  it("forks when the sign-in asked for nothing in particular", () => {
    for (const requested of [undefined, null, "", "  ", "/"]) {
      expect(resolveLandingRoute(requested, "member"), String(requested)).toBe(
        "/work",
      );
      expect(resolveLandingRoute(requested, "admin"), String(requested)).toBe(
        "/",
      );
    }
  });

  it("honours an explicit deep link for every role", () => {
    // A member following a link to a run must reach the run, not the work
    // table — the fork is a DEFAULT, not a redirect.
    for (const role of ["admin", "member", "viewer"] as const) {
      expect(resolveLandingRoute("/runs/run-1", role)).toBe("/runs/run-1");
      expect(resolveLandingRoute("/projects/acme", role)).toBe(
        "/projects/acme",
      );
      expect(resolveLandingRoute("/inbox", role)).toBe("/inbox");
    }
  });

  it("treats a deep link to /work as itself, not as the default", () => {
    expect(resolveLandingRoute("/work", "admin")).toBe("/work");
  });
});
