export type SiteConfig = typeof siteConfig;

export const siteConfig = {
  name: "MAIster",
  description:
    "The control plane for AI-powered software delivery — multi-project portfolio, ACP-driven runs, structured HITL.",
  navItems: [
    { label: "Portfolio", href: "/" },
    { label: "Observatory", href: "/observatory" },
    { label: "Projects", href: "/projects" },
    { label: "Settings", href: "/settings" },
  ],
  navMenuItems: [
    { label: "Portfolio", href: "/" },
    { label: "Observatory", href: "/observatory" },
    { label: "Projects", href: "/projects" },
    { label: "Settings", href: "/settings" },
    { label: "Sign out", href: "/api/auth/signout" },
  ],
  links: {
    github: "https://github.com/kanischev/mAIster",
  },
};
