---
title: "MCP servers, bindings, and secrets"
description: "Register MCP servers, resolve package requirements per project, use environment references, and test trust and readiness."
---

MAIster manages MCP at three scopes: an installation-wide server catalog, a
project's bindings and local servers, and requirements shipped by Flow packages.
A Flow refers to a logical MCP ID; the project decides which concrete server
implements it.

## Prerequisites

- Global `admin` access to create or trust platform MCP servers.
- Project `admin` or `owner` access to create bindings and overlays.
- Secret values available in the supervisor environment.

## Three scopes

| Scope | Owner | Purpose |
| --- | --- | --- |
| Platform | Global administrator | Reusable host-wide catalog of `stdio`, `sse`, and `http` servers. |
| Project | Project administrator | Explicit bindings, project-local servers, and per-project configuration overlays. |
| Flow package | Package author | Portable requirements or server templates, without installation-specific secrets. |

When no explicit binding exists, resolution follows project, platform, then
package precedence. An enabled binding overrides that precedence. A disabled
binding is an explicit opt-out and makes the logical reference unavailable in
that project.

## Keep secret values out of MAIster data

MCP environment and header entries are **name and value** pairs. A value is one
of two things, and nothing in between:

- a **reference** such as `env:GITHUB_TOKEN` — MAIster stores only the
  reference, and the execution host substitutes the value when it starts or
  connects to the MCP server. Set `GITHUB_TOKEN` in the supervisor service
  environment on every host that can run the MCP;
- a **literal** such as `FASTMCP_LOG_LEVEL=ERROR` — stored and used exactly as
  written, which is your statement that it is not a secret.

There is no substitution inside a value: `${HOME}` reaches the server as those
eight characters.

Use a reference for anything secret. Do not put an API key in `flow.yaml`, a
package file, a project form, a URL, or an argument. Client-visible snapshots
and logs keep a reference as a reference — the value behind it never appears in
them. A literal is visible to anyone who can read the catalog, so the form warns
you inline when a literal sits under a name that looks like a credential
(`*_TOKEN`, `*_API_KEY`, `Authorization`, …). It is a warning, not a refusal.

For a server that requires bearer authentication, use the **bearer token env**
field rather than writing an `Authorization` header yourself: give it an
`env:NAME` reference and the host composes `Authorization: Bearer <value>`.
Setting both is refused.

A project overlay changes the **value** a project uses for a slot the server
declares, and never the name — the name is the server's own contract. Two
projects can therefore point the same slot at different credentials, or one at a
plain literal such as a different `GH_HOST`, without cloning the server or
exposing either value.

## Register a platform MCP server

1. Open **MCPs** as a global administrator.
2. Add the logical ID and supported agent families.
3. Select `stdio`, `sse`, or `http` and fill in its command or URL fields.
   `sse` is legacy — it was deprecated by the MCP specification, and a Codex
   runner cannot use it at all. Prefer `http`.
4. Add the environment rows (for `stdio`) or header rows (for `sse`/`http`), and
   the bearer token env reference if the server needs one.
5. Leave the server untrusted until its source and command have been reviewed.
6. Trust and enable it.
7. Run **Test connection** and inspect the initialization result and latency.

An untrusted `stdio` server is visible but cannot execute or even be probed. A
failed probe records an actionable reason and releases any child process it
started.

## Resolve requirements in a project

Open **Project → MCPs**. The requirements ledger combines attached package
requirements, enabled Flow node requirements, and attached platform-agent
profiles. Each logical reference is classified as bound, automatically
resolved, unbound, misconfigured, or not ready.

For every unresolved required reference:

1. choose a compatible platform, project, or package target;
2. connect the binding;
3. add a project overlay when the target's default values do not fit — the
   overlay replaces a slot's value and keeps its name;
4. test the connection in the project context;
5. confirm that the requirement becomes ready.

Flow nodes distinguish required MCPs from additional ones. An unresolved
required MCP refuses launch. An unavailable additional MCP is omitted and
recorded as withheld so the Run explains the degraded capability set. A
transport the launching agent cannot use counts as unavailable: a required `sse`
server on a Codex runner refuses the launch before any workspace is created, and
an additional one is withheld with the reason shown on the Run.

## Use MCP from Flow Studio

In a node's settings, select MCP references from the package and project-aware
picker. Package definitions stay portable because they carry logical IDs and
environment references — prefilling a template from a platform server converts a
literal into a reference, so a shared package never carries one of your
values. The project binding and the execution host supply local
implementation details.

The resolved set is snapshotted into the Run. Later changes to a binding do not
change what an existing Run used.

## Failure signals

| Signal | What to check |
| --- | --- |
| Unbound | Connect the logical requirement to a target in Project → MCPs. |
| Misconfigured | Fix a missing slot or an overlay that names an undeclared environment/header field. |
| Not ready | Check transport, URL/command, environment references, supported adapter, and latest probe. |
| Untrusted | Review and trust the platform definition; there is no per-launch bypass. |
| Withheld | Open the Run's capability details to see why an optional server was excluded. |

## Related guides

- [Configure ACP runners](/administration/runners-and-models)
- [Flow Studio and packages](/studio/flow-studio-and-packages)
- [Flow manifest reference](/reference/flow-manifest)
