import config from "./playwright.config";

const webServer = config.webServer;

if (!webServer || Array.isArray(webServer)) {
  throw new Error("Expected the repository's single web server fixture");
}

export default {
  ...config,
  timeout: 360_000,
  projects: config.projects?.map((project) => project.name === "setup"
    ? { ...project, testMatch: /status-smoke\.local\.setup\.ts$/ }
    : project),
  webServer: {
    ...webServer,
    command: "exec node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port $PORT",
    stdout: "pipe",
    url: undefined,
    port: Number(process.env.E2E_PORT ?? 3100),
  },
};
