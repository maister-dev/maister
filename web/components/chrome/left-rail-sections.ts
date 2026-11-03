import type { LeftRailNavSection } from "@/components/chrome/left-rail-nav";
import type { GlobalRole } from "@/lib/db/schema";

type RailNavigationLabelKey =
  | "activityFeed"
  | "agents"
  | "home"
  | "inbox"
  | "knowledge"
  | "mcps"
  | "observatory"
  | "projects"
  | "scheduler"
  | "executionHost"
  | "settings"
  | "studio"
  | "users"
  | "work";

export function buildLeftRailSections(
  label: (key: RailNavigationLabelKey) => string,
  userRole: GlobalRole | undefined,
): LeftRailNavSection[] {
  // The ADR-172 spine gains native Knowledge (ADR-200) after Inbox;
  // the administrator-only destinations remain in the tail.
  const sections: LeftRailNavSection[] = [
    { id: "home", label: label("home"), href: "/", ready: true },
    {
      id: "projects",
      label: label("projects"),
      // The portfolio, not home (ADR-172 D3). `/` is the Desk.
      href: "/projects",
      ready: true,
    },
    { id: "work", label: label("work"), href: "/work", ready: true },
    {
      id: "activity",
      // `nav.activity` is already the project board's Activity TAB label;
      // this is the cross-project feed, so it gets its own key.
      label: label("activityFeed"),
      href: "/activity",
      ready: true,
    },
    { id: "inbox", label: label("inbox"), href: "/inbox", ready: true },
    {
      id: "knowledge",
      label: label("knowledge"),
      href: "/knowledge",
      ready: true,
    },
    { id: "studio", label: label("studio"), href: "/studio", ready: true },
    {
      id: "observatory",
      label: label("observatory"),
      href: "/observatory",
      ready: true,
    },
  ];

  if (userRole !== "admin") return sections;

  return [
    ...sections,
    { id: "agents", label: label("agents"), href: "/agents", ready: true },
    { id: "mcps", label: label("mcps"), href: "/mcps", ready: true },
    {
      id: "users",
      label: label("users"),
      href: "/admin/users",
      ready: true,
    },
    {
      id: "executionHost",
      label: label("executionHost"),
      href: "/admin/execution-host",
      ready: true,
    },
    {
      id: "scheduler",
      label: label("scheduler"),
      href: "/admin/scheduler",
      ready: true,
    },
    {
      id: "settings",
      label: label("settings"),
      href: "/settings",
      ready: true,
    },
  ];
}
