import type { ExecutorAgent } from "./types";

const hostPlumbing = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "NODE_ENV",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
]);
const adapterVariables: Readonly<
  Partial<Record<ExecutorAgent, readonly string[]>>
> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
  ],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  gemini: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GEMINI_CLI_HOME",
  ],
  opencode: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"],
};

/** Only host plumbing and the selected adapter's conventional ambient settings. */
export function workspaceAdapterEnvironment(
  adapter: ExecutorAgent,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    ...hostPlumbing,
    ...(adapterVariables[adapter] ?? []),
  ]);

  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        value !== undefined &&
        !value.startsWith("()") &&
        (allowed.has(name) || /^LC_[A-Z_]+$/.test(name)),
    ),
  );
}
