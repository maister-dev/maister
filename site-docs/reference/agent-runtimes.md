---
title: "Agent runtimes"
description: "Configure ACP runner profiles and understand readiness, credentials, and capability scoping."
---

MAIster delegates agent work through Agent Client Protocol adapters. A platform
runner profile selects an adapter family, model, provider settings, permission
policy, and child-process environment.

## One runtime catalog

Claude, Codex, Gemini, OpenCode, and MiMo profiles live in one governed runner
catalog. Model routing can use Anthropic, OpenAI, OpenRouter, and other
Anthropic- or OpenAI-compatible endpoints through provider settings. The same
product controls all of these runtime choices.

Every concrete runner profile must satisfy its adapter diagnostics and smoke
contract before launch. There is no silent fallback to a different adapter,
model, or provider.

## Runner selection

Selection resolves in this order:

1. explicit node runner;
2. Flow binding runner;
3. project default runner;
4. platform default runner.

The resolved profile is captured at launch so a later settings change cannot
alter an active session.

## Credentials

Agent CLIs and tokens live on the execution host under the account that runs the
supervisor. Store references such as `env:OPENAI_API_KEY` in platform settings;
store the actual value only in the supervisor environment.

## Capability scope

Each launch receives the capabilities declared for the project, Flow, node, and
agent family. Skills, MCP servers, tools, settings, environment profiles, and
restrictions are frozen for that session. A database record alone does not make
host-local capability files available on another execution host.
