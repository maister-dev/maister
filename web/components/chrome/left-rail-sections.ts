import type { LeftRailNavSection } from "@/components/chrome/left-rail-nav";
import type { GlobalRole } from "@/lib/db/schema";

type RailNavigationLabelKey =
  | "agents"
  | "inbox"
  | "mcps"
  | "observatory"
  | "projects"
  | "scheduler"
  | "settings"
  | "studio"
  | "users";

export function buildLeftRailSections(
  label: (key: RailNavigationLabelKey) => string,
  userRole: GlobalRole | undefined,
): LeftRailNavSection[] {
  const sections: LeftRailNavSection[] = [
    { id: "projects", label: label("projects"), href: "/", ready: true },
    { id: "inbox", label: label("inbox"), href: "/inbox", ready: true },
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
