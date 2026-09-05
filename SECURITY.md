# Security Policy

MAIster executes coding agents against source repositories, launches local
processes, manages credentials by reference, and can promote Git branches.
Security reports deserve a private channel and enough context to reproduce the
problem safely.

## Supported versions

MAIster is under active development and does not yet publish stable release
lines. Security fixes target the current `master` branch. Older commits and local
deployments may not receive backports.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/maister-dev/maister/security/advisories/new)
whenever it is available. Do not disclose vulnerability details in a public
issue, discussion, pull request, commit message, or chat transcript.

If GitHub's private reporting form is unavailable, contact the maintainer
privately through [Telegram](https://t.me/HealthyWealthyAndWise). Send only a
short request to establish a secure reporting channel; do not send credentials,
private source code, or an exploit before the channel is agreed.

Include, when possible:

- the affected branch, commit, component, and deployment shape;
- the vulnerability class and likely impact;
- the minimum safe reproduction steps;
- whether exploitation requires authentication or a particular role;
- relevant configuration with secrets and private paths removed;
- a proof of concept or suggested fix, if safe to share;
- any disclosure deadline or coordination constraints.

## What to expect

The maintainer will acknowledge the report, validate the affected surface, and
coordinate remediation and disclosure. Status updates will be shared through
the private reporting channel. Please allow a reasonable remediation window
before public disclosure, especially when a fix affects multiple runtime
boundaries or requires users to rotate credentials.

Valid reports will be credited in the advisory unless the reporter prefers to
remain anonymous. This project does not currently operate a bug bounty program.

## Operational guidance

Treat every MAIster deployment as security-sensitive:

- run it only on infrastructure you control;
- keep the web tier, supervisor, database, agent adapters, and Git credentials
  patched and access-controlled;
- never expose the supervisor directly to untrusted networks;
- store secrets outside the repository and pass only environment references in
  MAIster configuration;
- review Flow packages, agent definitions, hooks, and MCP servers before
  trusting or enabling them;
- use least-privilege repository credentials and inspect evidence before
  promotion.

See [Deployment](docs/deployment.md), [Configuration](docs/configuration.md),
and the [architecture documentation](docs/architecture.md) for current system
boundaries and known productization gaps.
