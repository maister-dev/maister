import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

import live from "./playwright.live.config";

// Exercise the production Web and supervisor with a deterministic ACP peer.
// Each adapter alias points at the fixture so a runner change stays local.
const adapter = resolve("../supervisor/test/fixtures/checkout-journey-acp.mjs");
const servers = Array.isArray(live.webServer) ? live.webServer : [];

if (servers.length !== 2)
  throw new Error("Studio delivery needs the supervisor and Web fixtures");
const [supervisor, web] = servers;
const fixtureSettings = resolve(
  String(supervisor.env?.MAISTER_RUNTIME_ROOT),
  "checkout-fixture-settings",
);

export default defineConfig({
  ...live,
  projects: live.projects?.map((project) =>
    project.name === "setup"
      ? project
      : {
          ...project,
          name: "studio-delivery",
          testMatch:
            /(?:^|\/)(?:studio-catalog-delivery|flow-node-question)\.spec\.ts$/,
        },
  ),
  webServer: [
    {
      ...supervisor,
      env: {
        ...supervisor.env,
        CLAUDE_CONFIG_DIR: resolve(fixtureSettings, "claude"),
        CODEX_HOME: resolve(fixtureSettings, "codex"),
        GEMINI_CLI_HOME: resolve(fixtureSettings, "gemini"),
        OPENCODE_CONFIG_DIR: resolve(fixtureSettings, "opencode"),
        XDG_CONFIG_HOME: resolve(fixtureSettings, "xdg"),
        MAISTER_API_BASE_URL: String(live.use?.baseURL),
        MAISTER_ADAPTER_BINARY_CLAUDE: adapter,
        MAISTER_ADAPTER_BINARY_CODEX: adapter,
        MAISTER_ADAPTER_BINARY_GEMINI: adapter,
        MAISTER_ADAPTER_BINARY_OPENCODE: adapter,
        MAISTER_ADAPTER_BINARY_MIMO: adapter,
      },
    },
    web,
  ],
});
