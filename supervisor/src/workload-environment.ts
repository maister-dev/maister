import type { ExecutorAgent } from "./types";

import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SupervisorError } from "./types";

const startupNames: ReadonlySet<string> = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
]);

const reservedNames: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "CDPATH",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ENV",
  "GEMINI_CLI_HOME",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "ZDOTDIR",
]);

const facadeNames: ReadonlySet<string> = new Set([
  "MAISTER_API_BASE_URL",
  "MAISTER_PROJECT_TOKEN",
]);

const configurationHomes: Readonly<
  Partial<Record<ExecutorAgent, { name: string; prefix: string }>>
> = {
  codex: { name: "CODEX_HOME", prefix: "codex-home-" },
  opencode: { name: "OPENCODE_CONFIG_DIR", prefix: "opencode-home-" },
  mimo: { name: "XDG_CONFIG_HOME", prefix: "mimo-home-" },
};

function isReserved(name: string): boolean {
  const normalized = name.toUpperCase();

  return (
    startupNames.has(normalized) ||
    reservedNames.has(normalized) ||
    /^(?:LC_|XDG_|SSH_|LD_|DYLD_|GIT_|MAISTER_)/.test(normalized) ||
    /(?:^|_)PROXY$/.test(normalized)
  );
}

function refuseEnvironment(name?: string): never {
  throw new SupervisorError(
    "PRECONDITION",
    "Workload environment entry is reserved or invalid",
    {
      details: {
        reason: "workload_environment_reserved",
        ...(name === undefined ? {} : { field: name }),
      },
    },
  );
}

export function workloadBaseEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const [name, value] = entry;

      return (
        typeof value === "string" &&
        !value.startsWith("()") &&
        (startupNames.has(name) || /^LC_[A-Z_]+$/.test(name))
      );
    }),
  );
}

export function assertReferenceSource(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuseEnvironment();
  if (
    isReserved(name) ||
    /^(?:DB_URL|DATABASE_URL|AUTH_SECRET|NEXTAUTH_SECRET|POSTGRES_.+)$/i.test(
      name,
    )
  ) {
    refuseEnvironment(name);
  }
}

export function assertExplicitEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  allowed: ReadonlySet<string> = new Set(),
): void {
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuseEnvironment();
    if (value.includes("\0") || (isReserved(name) && !allowed.has(name))) {
      refuseEnvironment(name);
    }
  }
}

export function assertMcpEnvironment(
  env: Readonly<Record<string, string>> | undefined,
): void {
  assertExplicitEnvironment(env, facadeNames);
}

export function assertAdapterEnvironment(
  input: Readonly<{
    agent: ExecutorAgent;
    env?: Readonly<Record<string, string>>;
    workspace?: { cwd: string; runId: string };
  }>,
): void {
  const home = configurationHomes[input.agent];
  const homePath = home && input.env?.[home.name];

  if (!home || homePath === undefined || !input.workspace) {
    assertExplicitEnvironment(input.env);

    return;
  }

  const root = join(
    input.workspace.cwd,
    ".maister",
    "capabilities",
    input.workspace.runId,
  );
  const local = relative(root, homePath);
  const parts = local.split(sep);

  if (
    !isAbsolute(homePath) ||
    resolve(homePath) !== homePath ||
    parts.includes("..") ||
    parts.length > 2 ||
    !basename(homePath).startsWith(home.prefix)
  ) {
    refuseEnvironment(home.name);
  }

  assertExplicitEnvironment(input.env, new Set([home.name]));
}
