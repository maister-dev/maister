# MAIster

> Self-hosted execution and governance for reproducible AI-powered software
> delivery over private code.

[Website](https://imaister.dev) ·
[Public documentation](https://docs.imaister.dev) ·
[Getting started](docs/getting-started.md) ·
[Architecture](docs/architecture.md)

Coding agents can write code. MAIster makes the process around them repeatable:
versioned delivery flows, isolated workspaces, scoped capabilities, human
decisions, evidence gates, cost controls, and promotion to a pull request or
local target branch.

## The 60-second model

```text
Task → version-pinned Flow → isolated worktree → ACP coding agent
     → human input + evidence gates → review → PR or local merge
```

- **One control plane:** see projects, active workspaces, tasks, and requests
  for human input without babysitting a wall of terminals.
- **Reproducible process:** install and pin Flow packages that compose agents,
  CLI steps, gates, bounded rework, consensus, and orchestration.
- **Governed execution:** materialize only the capabilities a session needs,
  enforce guardrails at the Agent Client Protocol (ACP) boundary, and retain an
  auditable run ledger.
- **Evidence before delivery:** validate typed artifacts, readiness, diffs, and
  budgets before work reaches the target branch.

MAIster is designed for a technical owner or small engineering team operating
multiple private repositories and coding agents on its own infrastructure.

## What is here

| Area           | Purpose                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `web/`         | Next.js control plane, Postgres state, boards, review, and promotion    |
| `supervisor/`  | Fastify daemon that owns ACP sessions and agent processes               |
| `mcp/`         | MCP facade for governed agent access to MAIster operations              |
| `site/`        | EN/RU product website published at [imaister.dev](https://imaister.dev) |
| `site-docs/`   | EN/RU public product documentation                                      |
| `docs/`        | Engineering contracts, architecture, APIs, and operating details        |
| `.ai-factory/` | Plans, adversarial reviews, ADR context, and the design record          |

The web tier and supervisor run as separate Node processes on the same host and
communicate over HTTP and server-sent events. PostgreSQL is the durable control
plane store; run workspaces use Git worktrees. External ACP adapters remain the
agent runtimes.

## Quick start

Prerequisites: Node 24, pnpm, Git, Docker with Compose, and a coding agent
signed in on this host (Claude Code, Codex, Gemini CLI, OpenCode, or MiMo).
Only Postgres runs in Docker; the web tier and the supervisor run on the host
because they spawn agent CLIs and work on local git repositories. Linux and
macOS are supported; on Windows run everything inside WSL2 with Docker
Desktop's WSL integration.

One command clones the repository, installs dependencies, writes the env files
with a generated `AUTH_SECRET`, starts Postgres, applies the migrations, and
builds the MCP facade:

```bash
curl -fsSL https://imaister.dev/quickstart.sh | bash
```

The script is [`scripts/quickstart.sh`](scripts/quickstart.sh). Read it first if
you prefer, then run `./scripts/quickstart.sh` from a checkout; it never
overwrites an existing env file and is safe to repeat. Then start both host
processes:

```bash
cd maister
pnpm dev        # supervisor on :7777, web on :3000
```

Open `http://localhost:3000/login` and sign in as `admin@maister.local` with
the password `maister-admin`; the first login asks for a new one. Before the
first Run, open **Settings → ACP runners**: on a fresh install the first visit
registers a native runner for each adapter found on the host (for example
`claude-code`); wait for **Ready**. Then
add a repository under **Projects → Add project** (a manifest that names a
`default_runner` needs that runner **Ready** first).

<details>
<summary>The same steps by hand</summary>

```bash
git clone https://github.com/maister-dev/maister.git
cd maister
pnpm install --frozen-lockfile

cp .env.example .env
cp web/.env.sample web/.env.local
cp supervisor/.env.sample supervisor/.env

# Put the output in AUTH_SECRET in web/.env.local before starting the web tier.
openssl rand -base64 33

docker compose up -d --wait postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter @maister/mcp build
```

Then run the two processes in separate terminals:

```bash
pnpm --filter @maister/supervisor dev    # http://localhost:7777
pnpm --filter maister-web dev            # http://localhost:3000
```

</details>

The complete setup, adapter requirements, database workflow, and first-run
checks are in [Getting Started](docs/getting-started.md).

## Project status

MAIster is under active development and is already dogfooded for governed agent
delivery. It is suitable for evaluation and self-hosted experimentation, not a
turnkey production platform. Current productization gaps include stronger
process/container isolation, OIDC/SSO/MFA and organization administration,
automated backup/restore drills, notification routing, and broader end-to-end
qualification. See the [Product View](docs/PRODUCT_VIEW.md) for current scope.

## Coding agents

MAIster drives coding agents through the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) and its
vendor-neutral [SDK](https://github.com/agentclientprotocol/agent-client-protocol).
The supervisor spawns one adapter process per session and enforces
capabilities at that boundary.

| Agent                                                     | ACP adapter                                                                 | Status                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| [Claude Code](https://claude.com/product/claude-code)     | [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) | Ready by default                                |
| [Codex](https://github.com/openai/codex)                  | [codex-acp](https://github.com/agentclientprotocol/codex-acp)               | Ready by default                                |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | built in (`gemini --acp`)                                                   | Gated by adapter diagnostics and smoke evidence |
| [OpenCode](https://github.com/anomalyco/opencode)         | built in (`opencode acp`)                                                   | Gated by adapter diagnostics and smoke evidence |
| [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code)      | built in (`mimo acp`)                                                       | Gated by adapter diagnostics and smoke evidence |

Agents run with the authentication configured on the execution host, including
subscription-backed sessions. API providers such as Anthropic, OpenAI, and
Anthropic-compatible gateways are runner configuration, with secrets referenced
by environment variable name only.

## Packages and the methods behind them

Ready-made Flow packages live in
[maister-plugins](https://github.com/maister-dev/maister-plugins). Each package
is pinned by its own git tag and installs from **Settings → Package sources**.

| Package                                                                         | Built on                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aif`                                                                           | [AI Factory](https://github.com/lee-to/ai-factory): spec-driven delivery Flows (dev, bugfix, evolve, roadmap, init, loop, qa) with the vendored skills and agents                                                   |
| `pstack`                                                                        | [pstack](https://github.com/cursor/plugins/tree/main/pstack): evidence-first engineering Flows with typed result profiles and an Evaluation Method                                                                  |
| `superpowers`                                                                   | [Superpowers](https://github.com/obra/superpowers): governed Flows with structured design, verification, and review handoffs                                                                                        |
| `openspec`                                                                      | [OpenSpec](https://github.com/Fission-AI/OpenSpec): spec-driven change Flows with typed change and review handoffs                                                                                                  |
| `spec-kit`                                                                      | [Spec Kit](https://github.com/github/spec-kit): Spec-Driven Development Flows                                                                                                                                       |
| `bmad-bmm`                                                                      | [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD): planning and build Flows, upstream skills, and platform agents                                                                                         |
| `bmad-tea`                                                                      | [BMAD Test Architect](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise): quality Flows and the Murat agent                                                                                 |
| `bmad-cis`                                                                      | [BMAD Creative Intelligence Suite](https://github.com/bmad-code-org/bmad-module-creative-intelligence-suite): a governed discovery Flow and creative agents                                                         |
| `core`, `core-java`, `core-react`, `core-pg`, `core-skill-authoring`, `env-e2e` | First-party MAIster packages: triage, Project Brain, and evaluation agents; stack skills for Java, React, and PostgreSQL; skill authoring; an ephemeral docker-compose end-to-end environment as readiness evidence |

## Documentation

| Start here                                          | What it answers                                  |
| --------------------------------------------------- | ------------------------------------------------ |
| [Public docs](https://docs.imaister.dev)            | How to understand and operate MAIster            |
| [Getting Started](docs/getting-started.md)          | How to install, configure, and run locally       |
| [Configuration](docs/configuration.md)              | Environment, `maister.yaml`, and Flow contracts  |
| [Architecture](docs/architecture.md)                | Process boundaries and data flows                |
| [System analytics](docs/system-analytics/README.md) | Domain behavior and state machines               |
| [API contracts](docs/api/)                          | Web, supervisor, external API, and event schemas |

MAIster is built with [AI Factory](https://github.com/lee-to/ai-factory), and
the repository deliberately keeps that engineering record in
[`.ai-factory/`](.ai-factory/): implementation plans, reviews, and the reasoning
that shaped the current architecture. The same method ships as the `aif`
package above.

## Contributing and security

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow
the [Code of Conduct](CODE_OF_CONDUCT.md), and use the private route described
in [SECURITY.md](SECURITY.md) for vulnerabilities. Please do not open public
security issues.

## License

MAIster is available under the [MIT License](LICENSE).
