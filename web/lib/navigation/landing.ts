/**
 * The post-sign-in landing route (`NAV-02`, ADR-171 D5).
 *
 * ONE clause of ADR-171, resolved ONCE per sign-in, so `/` never forks by role
 * twice — once in the router and again inside the page. A member who navigates
 * to `/` deliberately still gets the Desk; this only decides where a sign-in
 * that asked for no particular destination lands.
 *
 * Pure: no session, no database, no clock.
 */

import type { GlobalRole } from "@/lib/db/schema";

/** The Desk. An admin's first question is "what needs me across everything". */
export const ADMIN_LANDING_ROUTE = "/";
/** The work table. A member's Desk is mostly this anyway — skip the hop. */
export const MEMBER_LANDING_ROUTE = "/work";

/**
 * "Non-admin" is `role !== "admin"`, which covers BOTH `member` and `viewer`
 * (D5). Spelling it as the negation rather than listing the two roles means a
 * fourth role lands on `/work` rather than on a route nobody chose for it.
 */
export function landingRouteForRole(role: GlobalRole): string {
  return role === "admin" ? ADMIN_LANDING_ROUTE : MEMBER_LANDING_ROUTE;
}

/**
 * The destination a sign-in should use. An explicit deep link is honoured
 * verbatim; only the bare default — which is what both a direct visit to
 * `/login` and a proxy bounce off `/` produce — forks by role.
 */
export function resolveLandingRoute(
  requested: string | null | undefined,
  role: GlobalRole,
): string {
  const target = requested?.trim();

  if (!target || target === ADMIN_LANDING_ROUTE) {
    return landingRouteForRole(role);
  }

  return target;
}
