# Project list

**Route:** `/projects` · **Status:** Implemented · **Source:** `web/app/(app)/projects/page.tsx`

Project cards show the name, localized running/idle status, human and agent
counts, backlog task count, currently running run count, and a compact
“Needs attention · N” link. The attention count combines pending project
requests and workspaces with PR conflicts. Retained terminal workspaces do
not increase the running count.

“Open project” is the primary action. “Technical information” toggles one
project's technical section through `?technical=<slug>`, preserving refresh and
browser back/forward behavior. It contains workspaces, branches, Git lifecycle
actions, conflict indicators, recent merges and links to Flow packages, MCP,
agent settings and Git settings. These details are absent until opened.

Data and visibility reuse `getPortfolio`; mutations retain their existing
server-side authorization. Copy is available in English and Russian.
