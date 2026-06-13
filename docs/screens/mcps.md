# MCP servers (platform)

- **Type:** screen (admin).
- **Route:** `/mcps` (global admin only).
- **Status:** Planned (this branch — WI-2).
- **Source:** `web/app/(app)/mcps/page.tsx` (new), reusing `McpServersPanel`
  + `McpServerModal`.

## JTBD

When I administer the platform, I want to see and manage every host-wide MCP
server and whether each is actually ready — so I can keep the shared tool
catalog healthy without digging through settings.

> Roles & capabilities, Navigation, Layout & regions, States, Data & APIs,
> i18n, and Linked artifacts are filled when WI-2 lands. See
> [`README.md`](README.md) for the template; behavior lives in
> [`../system-analytics/mcp-management.md`](../system-analytics/mcp-management.md).
